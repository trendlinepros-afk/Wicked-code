// Electron main process: window, IPC, model lifecycle, agent runs.
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session } = require('electron')
const path = require('path')
const { Config, PROVIDERS } = require('./config.cjs')
const { Ollama } = require('./ollama.cjs')
const { ModelManager, parseModelId } = require('./modelManager.cjs')
const { getGpuStats } = require('./gpu.cjs')
const { listCloudModels, testApiKey } = require('./providers.cjs')
const { runAgent } = require('./agent.cjs')
const { Vault, setupVault, inspectVault } = require('./vault.cjs')

let win = null
let config
let ollama
let models
let vault
const runs = new Map() // runId -> AbortController
const approvals = new Map() // requestId -> resolve
const pulls = new Map() // model name -> AbortController

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0e13',
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

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => fn(...args))
}

function registerIpc() {
  // ----- settings -----
  handle('settings:get', () => config.publicSettings())
  handle('settings:set', (key, value) => {
    const allowed = ['ollamaUrl', 'idleUnloadSeconds', 'permissionMode', 'useVaultMemory', 'contextLength']
    if (!allowed.includes(key)) throw new Error('Setting not editable: ' + key)
    config.set(key, value)
    return config.publicSettings()
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
  handle('ollama:status', async () => ({ running: await ollama.isRunning(), url: config.get('ollamaUrl') }))
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
  handle('model:set', async (id) => {
    config.set('selectedModel', id)
    await models.setModel(id)
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
  handle('model:touch', () => models.touch())

  handle('gpu:stats', async () => {
    const stats = await getGpuStats(() => ollama.ps())
    try {
      models.reconcile(await ollama.ps())
    } catch {
      /* ollama offline */
    }
    return stats
  })

  // ----- agent -----
  handle('agent:run', async ({ runId, mode, modelId, history, folders }) => {
    const { provider, model } = parseModelId(modelId)
    const ac = new AbortController()
    runs.set(runId, ac)
    if (modelId !== models.current) await models.setModel(modelId)
    models.beginBusy()
    const emit = (type, payload = {}) => send('agent:event', { runId, type, ...payload })
    try {
      const memory = config.get('useVaultMemory') ? await vault.readMemory() : null
      const produced = await runAgent({
        mode,
        provider,
        model,
        history,
        folders: folders || [],
        memory,
        apiKey: provider === 'ollama' ? null : config.getApiKey(provider),
        ollama,
        numCtx: Number(config.get('contextLength')) || 0,
        permissionMode: config.get('permissionMode'),
        signal: ac.signal,
        emit,
        requestApproval: (call) =>
          new Promise((resolve) => {
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
      models.endBusy()
    }
  })
  handle('agent:stop', (runId) => runs.get(runId)?.abort())
  handle('agent:approve', (requestId, allowed) => {
    approvals.get(requestId)?.(!!allowed)
    approvals.delete(requestId)
  })
}

app.whenReady().then(() => {
  config = new Config(app.getPath('userData'), safeStorage)
  ollama = new Ollama(() => config.get('ollamaUrl'))
  vault = new Vault(() => config.get('vaultPath'))
  models = new ModelManager({
    ollama,
    idleSeconds: () => Number(config.get('idleUnloadSeconds')) || 30,
    initialModel: config.get('selectedModel'),
  })
  models.on('state', (s) => send('model:state', s))
  setInterval(() => models.tick(), 1000)

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

let quitting = false
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
