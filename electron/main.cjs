// Electron main process: window, IPC, model lifecycle, agent runs.
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, nativeTheme, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const { Config, PROVIDERS } = require('./config.cjs')
const { Ollama } = require('./ollama.cjs')
const { ModelManager, parseModelId } = require('./modelManager.cjs')
const { getGpuStats } = require('./gpu.cjs')
const { listCloudModels, testApiKey } = require('./providers.cjs')
const { runAgent, needsApproval } = require('./agent.cjs')
const { Vault, setupVault, inspectVault } = require('./vault.cjs')
const { Updater } = require('./updater.cjs')
const { generateTitle } = require('./titles.cjs')
const { extractFiles } = require('./attachments.cjs')
const { ProcessManager } = require('./processes.cjs')
const { GitHub, repoInfo, slugify } = require('./github.cjs')
const { OllamaLauncher } = require('./ollamaLauncher.cjs')
const os = require('os')
const { initLog, log, logFile } = require('./log.cjs')

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
const titleRuns = new Set() // AbortControllers for chat-naming requests
const approvals = new Map() // requestId -> resolve
const runPermissions = new Map() // runId -> permission mode of that chat ('ask' | 'auto-edits' | 'auto-all'); can change mid-run
const approvalCalls = new Map() // requestId -> { runId, name } of the tool call waiting for approval
const pulls = new Map() // model name -> AbortController

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function applyTheme() {
  const t = config.get('theme')
  nativeTheme.themeSource = t === 'light' || t === 'dark' ? t : 'system'
  if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0f0e13' : '#f7f6fa')
}

/** Ctrl+U: stop everything that's using the model and unload it from VRAM right now. */
async function forceUnload() {
  log('model', 'force unload (Ctrl+U)', { status: models.status, runs: runs.size })
  for (const ac of runs.values()) ac.abort()
  for (const ac of titleRuns) ac.abort()
  for (const [id, resolve] of approvals) {
    resolve(false)
    approvals.delete(id)
    approvalCalls.delete(id)
  }
  let loaded = []
  try {
    loaded = (await ollama.ps()).map((m) => m.name)
  } catch {
    /* ollama offline */
  }
  await models.forceUnload(loaded)
  send('model:forced', { unloaded: loaded.length ? loaded : models.isLocal() ? [parseModelId(models.current).model] : [] })
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
  // Ctrl+U (Cmd+U on macOS): force-unload the model, even mid-reply. Caught here so it works
  // whatever has focus inside the window (including the message box).
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && !input.shift && input.key.toLowerCase() === 'u') {
      e.preventDefault()
      forceUnload()
    }
  })
  // Right-click menu: spelling suggestions + "Add to dictionary" for misspelled words, and the usual
  // Cut / Copy / Paste / Select all.
  win.webContents.on('context-menu', (_e, params) => {
    const wc = win.webContents
    const items = []
    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions.slice(0, 6)
      for (const s of suggestions) items.push({ label: s, click: () => wc.replaceMisspelling(s) })
      if (!suggestions.length) items.push({ label: 'No spelling suggestions', enabled: false })
      items.push(
        { type: 'separator' },
        { label: `Add “${params.misspelledWord}” to dictionary`, click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
        { type: 'separator' },
      )
    }
    if (params.isEditable) {
      const f = params.editFlags
      items.push(
        { label: 'Undo', role: 'undo', enabled: f.canUndo },
        { label: 'Redo', role: 'redo', enabled: f.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: f.canCut },
        { label: 'Copy', role: 'copy', enabled: f.canCopy },
        { label: 'Paste', role: 'paste', enabled: f.canPaste },
        { type: 'separator' },
        { label: 'Select all', role: 'selectAll', enabled: f.canSelectAll },
      )
    } else if (params.selectionText.trim()) {
      items.push({ label: 'Copy', role: 'copy' })
    }
    if (params.linkURL && /^https?:/.test(params.linkURL)) {
      if (items.length) items.push({ type: 'separator' })
      items.push({ label: 'Open link in browser', click: () => shell.openExternal(params.linkURL) })
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })
  // Spell-check in the user's language (Windows/macOS use the OS spell checker automatically).
  if (process.platform !== 'darwin') {
    const langs = session.defaultSession.availableSpellCheckerLanguages
    const want = [app.getLocale(), 'en-US'].filter((l, i, a) => langs.includes(l) && a.indexOf(l) === i)
    if (want.length) session.defaultSession.setSpellCheckerLanguages(want)
  }

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

/**
 * Options used for every local model load and chat. Loading and chatting with identical options
 * avoids a reload on the first message, and capping CPU threads leaves a core free so Windows stays
 * responsive even when part of a model runs on the CPU.
 */
function ollamaRunOptions() {
  const logical = os.cpus().length || 4
  return {
    num_ctx: Number(config.get('contextLength')) || 8192,
    num_thread: Math.max(2, Math.floor(logical / 2) - 1),
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

  // ----- attachments (drag & drop / 📎 / paste) -----
  /** Extract + add small thumbnails for images (shown in the composer and chat). */
  const extractWithThumbs = async (paths) => {
    const out = await extractFiles(paths)
    for (const a of out) {
      if (a.kind !== 'image' || a.error) continue
      try {
        const img = nativeImage.createFromPath(a.path)
        if (!img.isEmpty()) {
          const { width, height } = img.getSize()
          const thumb = height > 240 ? img.resize({ height: 240, quality: 'good' }) : img
          a.thumb = 'data:image/jpeg;base64,' + thumb.toJPEG(80).toString('base64') // small JPEG keeps chat files light
          a.width = width
          a.height = height
        }
      } catch {
        /* no thumbnail */
      }
    }
    return out
  }
  // Pasted screenshots have no file on disk: save them into the vault (so the Obsidian note can show them).
  // Fallback when the paste event carries no file: read an image straight from the system clipboard.
  handle('files:pasteClipboardImage', async () => {
    const { clipboard } = require('electron')
    try {
      const items = typeof clipboard.read === 'function' ? await clipboard.read() : []
      for (const item of Array.isArray(items) ? items : []) {
        const type = (item.types || []).find((t) => t.startsWith('image/'))
        if (!type) continue
        const blob = await item.getType(type)
        return saveImageBytes(new Uint8Array(await blob.arrayBuffer()), type)
      }
    } catch (e) {
      log('files', 'clipboard image read failed', { message: String(e.message || e) })
    }
    return null
  })
  handle('files:savePasted', (bytes, mime) => saveImageBytes(bytes, mime))
  async function saveImageBytes(bytes, mime) {
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' }[mime] || '.png'
    const vaultPath = config.get('vaultPath')
    const dir = vaultPath ? path.join(vaultPath, 'Wicked Code', 'Attachments') : path.join(app.getPath('userData'), 'pastes')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '')
    let file = path.join(dir, `Screenshot ${stamp}${ext}`)
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `Screenshot ${stamp} (${n})${ext}`)
    fs.writeFileSync(file, Buffer.from(bytes))
    log('files', 'pasted image saved', { file, bytes: bytes.length })
    return (await extractWithThumbs([file]))[0]
  }
  handle('files:extract', async (paths) => {
    const started = Date.now()
    const out = await extractWithThumbs((paths || []).filter(Boolean))
    log('files', 'extracted', { files: out.map((f) => ({ ext: f.ext, size: f.size, chars: f.chars, error: f.error })), ms: Date.now() - started })
    return out
  })
  handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents, text & images', extensions: ['docx', 'pdf', 'xlsx', 'xlsm', 'pptx', 'txt', 'md', 'csv', 'json', 'html', 'xml', 'log', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'js', 'ts', 'tsx', 'py', 'java', 'cs', 'cpp', 'c', 'go', 'rs', 'rb', 'php', 'sql', 'yaml', 'yml', 'toml', 'ini', 'sh', 'ps1'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    return r.canceled ? [] : extractWithThumbs(r.filePaths)
  })

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
  // Rename from the latest saved copy, so a rename never overwrites newer messages.
  handle('sessions:rename', async (id, title, source = 'user') => {
    const s = await vault.load(id)
    if (source === 'auto' && s.titleSource === 'user') return s // never override a name the user chose
    const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!clean) throw new Error('Title cannot be empty.')
    return vault.save({ ...s, title: clean, titleSource: source })
  })
  handle('sessions:generateTitle', async ({ modelId, messages }) => {
    const { provider, model } = parseModelId(modelId)
    models.beginBusy() // don't let the idle timer unload the model mid-title
    const started = Date.now()
    const ac = new AbortController()
    titleRuns.add(ac)
    try {
      const title = await generateTitle({
        provider,
        model,
        apiKey: provider === 'ollama' ? null : config.getApiKey(provider),
        ollama,
        ollamaOptions: ollamaRunOptions(),
        keepAlive: models.keepAlive(),
        messages,
        signal: ac.signal,
      })
      log('title', 'generated', { ms: Date.now() - started, title })
      return title
    } finally {
      titleRuns.delete(ac)
      models.endBusy()
    }
  })

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
  handle('model:forceUnload', () => forceUnload())
  handle('model:touch', () => {
    // Typing counts as activity (resets the idle timer); it only loads the model if that setting is on.
    if (config.get('autoLoadOnType') === false) models.lastActivity = Date.now()
    else models.touch()
  })

  // GPU stats: one probe at a time (never pile up nvidia-smi calls), and while a model is
  // generating, query the GPU driver at most every 6 s — driver queries during heavy CUDA work
  // can stall the whole system on some Windows setups.
  let gpuProbe = null
  let lastGpu = null
  let lastGpuAt = 0
  handle('gpu:stats', async () => {
    const minGap = models.busy > 0 ? 6000 : 1500
    if (gpuProbe) return lastGpu ?? gpuProbe
    if (lastGpu && Date.now() - lastGpuAt < minGap) return lastGpu
    gpuProbe = (async () => {
      const started = Date.now()
      let loaded = []
      try {
        loaded = await ollama.ps()
        models.reconcile(loaded)
      } catch {
        /* ollama offline */
      }
      const stats = await getGpuStats(async () => loaded)
      const took = Date.now() - started
      if (took > 1500) log('gpu', 'slow GPU probe', { ms: took, busy: models.busy > 0 })
      lastGpu = stats
      lastGpuAt = Date.now()
      return stats
    })()
    try {
      return await gpuProbe
    } finally {
      gpuProbe = null
    }
  })
  handle('app:openLogs', () => shell.showItemInFolder(logFile()))

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
  handle('agent:run', async ({ runId, mode, modelId, history, folders, sessionId, autoApprove, permissionMode }) => {
    const { provider, model } = parseModelId(modelId)
    const ac = new AbortController()
    runs.set(runId, ac)
    if (modelId !== models.current) await models.setModel(modelId)
    models.beginBusy()
    // Coalesce streamed tokens: one UI update per ~60 ms instead of one per token.
    const pending = { text: '', thinking: '' }
    let flushTimer = null
    const flush = () => {
      clearTimeout(flushTimer)
      flushTimer = null
      if (pending.thinking) send('agent:event', { runId, type: 'thinking', text: pending.thinking })
      if (pending.text) send('agent:event', { runId, type: 'text', text: pending.text })
      pending.text = ''
      pending.thinking = ''
    }
    const started = Date.now()
    let firstTokenAt = 0
    let streamedChars = 0
    const emit = (type, payload = {}) => {
      if (type === 'text' || type === 'thinking') {
        if (!firstTokenAt) firstTokenAt = Date.now()
        streamedChars += payload.text.length
        pending[type] += payload.text
        if (!flushTimer) flushTimer = setTimeout(flush, 60)
        return
      }
      flush()
      send('agent:event', { runId, type, ...payload })
    }
    log('run', 'start', { mode, model: modelId, ctx: config.get('contextLength'), status: models.status, history: history.length })
    try {
      const memory = config.get('useVaultMemory') ? await vault.readMemory() : null
      // Per-chat permission (falls back to the default in Settings for older sessions).
      runPermissions.set(runId, autoApprove ? 'auto-all' : permissionMode || config.get('permissionMode') || 'ask')
      const ghToken = config.getApiKey('github')
      const info = mode === 'code' && folders?.[0] ? await repoInfo(folders[0]) : null
      const ghTools = info && ghToken ? { info, createPullRequest: (args) => github.createPullRequest(folders[0], args) } : null
      const produced = await runAgent({
        owner: sessionId,
        processes: mode === 'code' ? processes : null,
        browserCheck: mode === 'code' ? browserCheck : null,
        openForUser:
          mode === 'code'
            ? async ({ path: file, url }) => {
                log('agent', 'open for user', { file, url })
                if (file) {
                  const err = await shell.openPath(file)
                  if (err) throw new Error(err)
                } else await shell.openExternal(url)
              }
            : null,
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
        ollamaOptions: ollamaRunOptions(),
        permissionMode: () => runPermissions.get(runId) || 'ask',
        signal: ac.signal,
        emit,
        requestApproval: (call) =>
          new Promise((resolve) => {
            const requestId = `${runId}:${call.id}`
            approvals.set(requestId, resolve)
            approvalCalls.set(requestId, { runId, name: call.name })
            ac.signal.addEventListener('abort', () => resolve(false), { once: true })
            emit('approval', { requestId, call })
          }),
      })
      flush()
      log('run', 'done', {
        ms: Date.now() - started,
        firstTokenMs: firstTokenAt ? firstTokenAt - started : null,
        chars: streamedChars,
        charsPerSec: firstTokenAt ? Math.round(streamedChars / Math.max(0.001, (Date.now() - firstTokenAt) / 1000)) : 0,
        aborted: ac.signal.aborted,
      })
      return { messages: produced, aborted: ac.signal.aborted }
    } catch (e) {
      flush()
      log('run', 'error', { message: String(e.message || e), ms: Date.now() - started })
      if (ac.signal.aborted) return { messages: [], aborted: true }
      throw e
    } finally {
      runs.delete(runId)
      runPermissions.delete(runId)
      models.endBusy()
    }
  })
  handle('agent:stop', (runId) => runs.get(runId)?.abort())
  /** Change a running chat's permission level; approvals it no longer needs are released. */
  const setRunPermission = (runId, mode) => {
    if (!runs.has(runId)) return
    runPermissions.set(runId, mode)
    for (const [id, info] of approvalCalls) {
      if (info.runId === runId && !needsApproval(info.name, mode)) {
        approvals.get(id)?.(true)
        approvals.delete(id)
        approvalCalls.delete(id)
      }
    }
  }
  handle('agent:setPermission', (runId, mode) => setRunPermission(runId, mode))
  handle('agent:approve', (requestId, allowed) => {
    // allowed: true | false | 'all' (approve this and switch the chat to auto-approve everything)
    const runId = requestId.slice(0, requestId.indexOf(':'))
    approvals.get(requestId)?.(!!allowed)
    approvals.delete(requestId)
    approvalCalls.delete(requestId)
    if (allowed === 'all') setRunPermission(runId, 'auto-all')
  })
}

app.whenReady().then(() => {
  config = new Config(app.getPath('userData'), safeStorage)
  initLog(path.join(app.getPath('userData'), 'logs'))
  applyTheme()
  ollama = new Ollama(() => config.get('ollamaUrl'))
  vault = new Vault(() => config.get('vaultPath'))
  models = new ModelManager({
    ollama,
    runOptions: ollamaRunOptions,
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
