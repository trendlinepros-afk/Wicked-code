// Electron main process: window, IPC, model lifecycle, agent runs.
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, nativeTheme } = require('electron')
const path = require('path')
const { Config, PROVIDERS } = require('./config.cjs')
const { Ollama } = require('./ollama.cjs')
const { ModelManager, parseModelId } = require('./modelManager.cjs')
const { getGpuStats } = require('./gpu.cjs')
const { listCloudModels, testApiKey } = require('./providers.cjs')
const { runAgent } = require('./agent.cjs')
const { Vault, setupVault, inspectVault } = require('./vault.cjs')
const { Updater } = require('./updater.cjs')
const { ProcessManager } = require('./processes.cjs')
const { GitHub, repoInfo, slugify } = require('./github.cjs')
const { OllamaLauncher } = require('./ollamaLauncher.cjs')
const os = require('os')

// Pin the settings folder so it never changes between versions; app updates don't touch it.
app.setPath('userData', path.join(app.getPath('appData'), 'Wicked Code'))

let win = null
let config
let ollama
let models
let vault
let updater
let processes
let github
let launcher
let quitting = false
const runs = new Map() // runId -> AbortController
const approvals = new Map() // requestId -> resolve
const runAllowAll = new Set() // runIds where the user chose "allow all for this session"
const pulls = new Map() // model name -> AbortController

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function applyTheme() {
  const t = config.get('theme')
  nativeTheme.themeSource = t === 'light' || t === 'dark' ? t : 'system'
  if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0f0e13' : '#f7f6fa')
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0e13' : '#f7f6fa',
    title: 'Wicked Code',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // Open external links in the user's browser rather than inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

/**
 * Load a local page in a hidden browser window and report what happened: title, visible text,
 * console messages, page errors and failed requests. Used by the agent's browser_check tool.
 */
async function browserCheck({ url, waitMs = 1500, script }) {
  const check = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition: 'wicked-check', sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const consoleLines = []
  const failed = []
  check.webContents.on('console-message', (e) => {
    const msg = String(e.message ?? '')
    if (msg.includes('Electron Security Warning')) return // Electron's own dev warning, not the page's
    const src = e.sourceId ? ` (${String(e.sourceId).split('/').pop()}:${e.lineNumber})` : ''
    if (consoleLines.length < 80) consoleLines.push(`[${e.level}] ${msg}${src}`)
  })
  check.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => failed.push(`${failedUrl}: ${desc} (${code})`))
  check.webContents.session.webRequest.onCompleted((d) => {
    if (d.statusCode >= 400 && failed.length < 40) failed.push(`${d.method} ${d.url} → HTTP ${d.statusCode}`)
  })
  check.webContents.session.webRequest.onErrorOccurred((d) => {
    if (failed.length < 40) failed.push(`${d.method} ${d.url} → ${d.error}`)
  })
  try {
    const loaded = check.loadURL(url).then(() => null, (e) => String(e.message || e))
    const loadError = await Promise.race([loaded, new Promise((r) => setTimeout(() => r('Timed out after 30s waiting for the page to load'), 30_000))])
    await new Promise((r) => setTimeout(r, Math.min(Math.max(waitMs, 0), 20_000)))
    const page = await check.webContents
      .executeJavaScript(`({ title: document.title, url: location.href, text: (document.body && document.body.innerText || '').slice(0, 6000), elements: document.querySelectorAll('*').length })`)
      .catch((e) => ({ title: '', url, text: '', elements: 0, error: String(e.message || e) }))
    let scriptResult = null
    if (script) {
      scriptResult = await check.webContents
        .executeJavaScript(`Promise.resolve((async () => (${script}))()).then((v) => { try { return JSON.stringify(v, null, 2) } catch { return String(v) } })`)
        .catch((e) => 'Script error: ' + String(e.message || e))
      await new Promise((r) => setTimeout(r, 300))
    }
    return [
      loadError ? `LOAD ERROR: ${loadError}` : `Loaded ${page.url}`,
      `Title: ${page.title || '(none)'} · ${page.elements} elements`,
      scriptResult !== null ? `\n--- script result ---\n${scriptResult}` : '',
      `\n--- console (${consoleLines.length}) ---\n${consoleLines.join('\n') || '(no console output)'}`,
      `\n--- failed requests (${failed.length}) ---\n${failed.join('\n') || '(none)'}`,
      `\n--- visible text ---\n${page.text || '(page is blank)'}`,
    ].join('\n')
  } finally {
    check.destroy()
  }
}

function cloneRoot() {
  return config.get('cloneRoot') || path.join(os.homedir(), 'Wicked Code Repos')
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => fn(...args))
}

function registerIpc() {
  // ----- settings -----
  handle('settings:get', () => ({ ...config.publicSettings(), cloneRootResolved: cloneRoot() }))
  handle('settings:set', (key, value) => {
    const allowed = [
      'ollamaUrl', 'idleUnloadSeconds', 'permissionMode', 'useVaultMemory', 'contextLength', 'theme',
      'maxAgentSteps', 'autoLoadOnType', 'autoStartOllama', 'stopOllamaOnExit', 'cloneRoot', 'favoriteModels',
    ]
    if (!allowed.includes(key)) throw new Error('Setting not editable: ' + key)
    config.set(key, value)
    if (key === 'theme') applyTheme()
    return { ...config.publicSettings(), cloneRootResolved: cloneRoot() }
  })
  handle('apiKeys:set', (provider, key) => {
    config.setApiKey(provider, (key || '').trim())
    return config.publicSettings()
  })
  handle('apiKeys:test', (provider, key) => testApiKey(provider, (key || '').trim() || config.getApiKey(provider)))

  // ----- dialogs / shell -----
  handle('dialog:pickFolder', async (title) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('shell:openPath', (p) => shell.openPath(p))

  // ----- vault -----
  handle('vault:inspect', (p) => inspectVault(p))
  handle('vault:set', async (p) => {
    const info = inspectVault(p)
    if (!info.exists) throw new Error('That folder does not exist.')
    await setupVault(p)
    config.set('vaultPath', p)
    return config.publicSettings()
  })
  handle('vault:openMemory', async () => shell.openPath(vault.memoryPath()))
  handle('sessions:list', () => vault.list())
  handle('sessions:load', (id) => vault.load(id))
  handle('sessions:save', (s) => vault.save(s))
  handle('sessions:delete', (id) => vault.remove(id))

  // ----- models -----
  handle('ollama:status', async () => ({ running: await ollama.isRunning(), url: config.get('ollamaUrl'), launcher: launcher.state }))
  handle('ollama:start', () => launcher.ensure())

  // ----- GitHub -----
  handle('github:user', () => github.user())
  handle('github:test', (token) => github.user((token || '').trim() || github.token()))
  handle('github:repos', () => github.listRepos())
  handle('github:branches', (fullName) => github.branches(fullName))
  handle('github:clone', ({ fullName, baseBranch, newBranch }) => github.clone({ fullName, cloneRoot: cloneRoot(), baseBranch, newBranch }))
  handle('github:repoInfo', (dir) => repoInfo(dir))
  handle('github:suggestBranch', (title) => `wicked/${slugify(title)}-${Date.now().toString(36).slice(-4)}`)

  // ----- background processes -----
  handle('processes:list', () => processes.list())
  handle('processes:stop', (id) => processes.stop(id))
  handle('models:listLocal', async () => {
    if (!(await ollama.isRunning())) return { running: false, models: [] }
    return { running: true, models: await ollama.list() }
  })
  handle('models:listCloud', async () => {
    const out = []
    await Promise.all(
      PROVIDERS.map(async (p) => {
        const key = config.getApiKey(p)
        if (!key) return
        for (const m of await listCloudModels(p, key)) out.push({ id: `${p}:${m}`, provider: p, model: m })
      }),
    )
    return out
  })
  handle('models:pull', async (name) => {
    if (pulls.has(name)) throw new Error(`${name} is already downloading.`)
    const ac = new AbortController()
    pulls.set(name, ac)
    try {
      await ollama.pull(
        name,
        (o) => send('models:pull-progress', { name, status: o.status, completed: o.completed || 0, total: o.total || 0 }),
        ac.signal,
      )
      send('models:pull-progress', { name, status: 'success', completed: 1, total: 1, done: true })
    } catch (e) {
      const cancelled = ac.signal.aborted
      send('models:pull-progress', { name, status: cancelled ? 'cancelled' : 'error', error: cancelled ? null : String(e.message || e), done: true })
      if (!cancelled) throw e
    } finally {
      pulls.delete(name)
    }
  })
  handle('models:cancelPull', (name) => pulls.get(name)?.abort())
  handle('models:delete', async (name) => {
    if (models.current === `ollama:${name}`) await models.unload()
    await ollama.delete(name)
  })
  handle('models:setNotes', (name, text) => {
    const notes = { ...config.get('modelNotes') }
    if (text) notes[name] = text
    else delete notes[name]
    config.set('modelNotes', notes)
  })

  // ----- active model lifecycle -----
  handle('model:state', () => models.state())
  handle('model:set', async (id, opts) => {
    config.set('selectedModel', id)
    await models.setModel(id, { load: opts?.load !== false })
    return models.state()
  })
  handle('model:load', async () => {
    models.touch()
    await models.load()
    return models.state()
  })
  handle('model:unload', async () => {
    await models.unload()
    return models.state()
  })
  handle('model:touch', () => {
    // Typing counts as activity (resets the idle timer); it only loads the model if that setting is on.
    if (config.get('autoLoadOnType') === false) models.lastActivity = Date.now()
    else models.touch()
  })

  handle('gpu:stats', async () => {
    const stats = await getGpuStats(() => ollama.ps())
    try {
      models.reconcile(await ollama.ps())
    } catch {
      /* ollama offline */
    }
    return stats
  })

  // ----- app info + updates -----
  handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, platform: process.platform }))
  handle('updater:state', () => updater.state)
  handle('updater:check', () => updater.check())
  handle('updater:install', async () => {
    // Free VRAM before the app quits to install.
    quitting = true
    if (models.isLocal() && models.status === 'loaded') {
      await Promise.race([models.unload(), new Promise((r) => setTimeout(r, 3000))])
    }
    return updater.install()
  })

  // ----- agent -----
  handle('agent:run', async ({ runId, mode, modelId, history, folders, sessionId, autoApprove }) => {
    const { provider, model } = parseModelId(modelId)
    const ac = new AbortController()
    runs.set(runId, ac)
    if (modelId !== models.current) await models.setModel(modelId)
    models.beginBusy()
    const emit = (type, payload = {}) => send('agent:event', { runId, type, ...payload })
    try {
      const memory = config.get('useVaultMemory') ? await vault.readMemory() : null
      if (autoApprove) runAllowAll.add(runId)
      const ghToken = config.getApiKey('github')
      const info = mode === 'code' && folders?.[0] ? await repoInfo(folders[0]) : null
      const ghTools = info && ghToken ? { info, createPullRequest: (args) => github.createPullRequest(folders[0], args) } : null
      const produced = await runAgent({
        owner: sessionId,
        processes: mode === 'code' ? processes : null,
        browserCheck: mode === 'code' ? browserCheck : null,
        github: ghTools,
        env: github.authEnv(),
        maxSteps: Number(config.get('maxAgentSteps')) || 100,
        mode,
        provider,
        model,
        history,
        folders: folders || [],
        memory,
        apiKey: provider === 'ollama' ? null : config.getApiKey(provider),
        ollama,
        numCtx: Number(config.get('contextLength')) || 0,
        keepAlive: models.keepAlive(),
        permissionMode: config.get('permissionMode'),
        signal: ac.signal,
        emit,
        requestApproval: (call) =>
          new Promise((resolve) => {
            if (runAllowAll.has(runId)) return resolve(true)
            const requestId = `${runId}:${call.id}`
            approvals.set(requestId, resolve)
            ac.signal.addEventListener('abort', () => resolve(false), { once: true })
            emit('approval', { requestId, call })
          }),
      })
      return { messages: produced, aborted: ac.signal.aborted }
    } catch (e) {
      if (ac.signal.aborted) return { messages: [], aborted: true }
      throw e
    } finally {
      runs.delete(runId)
      runAllowAll.delete(runId)
      models.endBusy()
    }
  })
  handle('agent:stop', (runId) => runs.get(runId)?.abort())
  handle('agent:approve', (requestId, allowed) => {
    // allowed: true | false | 'all' (approve this and everything else for the rest of the run)
    if (allowed === 'all') {
      const runId = requestId.slice(0, requestId.indexOf(':'))
      runAllowAll.add(runId)
      // Release any other approvals already waiting in this run.
      for (const [id, resolve] of approvals) {
        if (id.startsWith(runId + ':')) {
          resolve(true)
          approvals.delete(id)
        }
      }
    }
    approvals.get(requestId)?.(!!allowed)
    approvals.delete(requestId)
  })
}

app.whenReady().then(() => {
  config = new Config(app.getPath('userData'), safeStorage)
  applyTheme()
  ollama = new Ollama(() => config.get('ollamaUrl'))
  vault = new Vault(() => config.get('vaultPath'))
  models = new ModelManager({
    ollama,
    idleSeconds: () => {
      const v = Number(config.get('idleUnloadSeconds'))
      return Number.isFinite(v) && v >= 0 ? v : 30 // 0 = never
    },
    initialModel: config.get('selectedModel'),
  })
  models.on('state', (s) => send('model:state', s))
  setInterval(() => models.tick(), 1000)
  updater = new Updater({
    supported: app.isPackaged,
    currentVersion: app.getVersion(),
    getAutoUpdater: () => require('electron-updater').autoUpdater,
  })
  updater.on('status', (s) => send('updater:status', s))
  processes = new ProcessManager()
  processes.on('change', (list) => send('processes:changed', list))
  github = new GitHub(() => config.getApiKey('github'))
  launcher = new OllamaLauncher({
    ollama,
    getUrl: () => config.get('ollamaUrl'),
    logFile: path.join(app.getPath('userData'), 'ollama.log'),
  })
  launcher.on('state', (s) => send('ollama:launcher', s))
  if (config.get('autoStartOllama') !== false) launcher.ensure()

  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'"],
        },
      })
    })
  }

  registerIpc()
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

function cleanupOnExit() {
  processes?.stopAll()
  if (config?.get('stopOllamaOnExit') !== false) launcher?.stop()
}

app.on('will-quit', cleanupOnExit)

app.on('before-quit', async (e) => {
  if (quitting || !models || !models.isLocal() || models.status !== 'loaded') return
  // Free VRAM on exit.
  e.preventDefault()
  quitting = true
  await Promise.race([models.unload(), new Promise((r) => setTimeout(r, 3000))])
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
