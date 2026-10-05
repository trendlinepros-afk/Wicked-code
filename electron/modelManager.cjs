// Tracks which model is active, loads/unloads local models, and unloads after idle time.
const { EventEmitter } = require('events')

/** Split "provider:model" ids. Local Ollama models use the "ollama" provider. */
function parseModelId(id) {
  const i = id.indexOf(':')
  if (i < 0) return { provider: 'ollama', model: id }
  return { provider: id.slice(0, i), model: id.slice(i + 1) }
}

/**
 * Ollama-side keep_alive: a safety net in case the app closes without unloading.
 * Longer than our own idle timer so ours always wins; -1 (forever) when auto-unload is off.
 */
function keepAliveFor(idleSeconds) {
  if (!(idleSeconds > 0)) return -1
  return `${Math.max(600, idleSeconds + 300)}s`
}

class ModelManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./ollama.cjs').Ollama} opts.ollama
   * @param {() => number} opts.idleSeconds
   * @param {string|null} opts.initialModel
   * @param {() => number} [opts.now]
   */
  constructor({ ollama, idleSeconds, initialModel, now, runOptions }) {
    super()
    // Options (context size, threads) must match what chats use, or Ollama reloads the model on send.
    this.runOptions = runOptions || (() => undefined)
    this.keepAlive = () => keepAliveFor(idleSeconds())
    this.ollama = ollama
    this.idleSeconds = idleSeconds
    this.now = now || Date.now
    this.current = initialModel || null
    this.status = 'unloaded' // unloaded | loading | loaded | unloading | cloud | error
    this.error = null
    this.busy = 0
    this.lastActivity = this.now()
    this.queue = Promise.resolve()
    if (this.current && parseModelId(this.current).provider !== 'ollama') this.status = 'cloud'
  }

  isLocal(id = this.current) {
    return !!id && parseModelId(id).provider === 'ollama'
  }

  state() {
    return {
      model: this.current,
      status: this.status,
      error: this.error,
      local: this.isLocal(),
      busy: this.busy > 0,
      idleSeconds: this.idleSeconds(),
      idleRemaining: this.status === 'loaded' && this.busy === 0 && this.idleSeconds() > 0
        ? Math.max(0, Math.ceil(this.idleSeconds() - (this.now() - this.lastActivity) / 1000))
        : null,
    }
  }

  setStatus(status, error = null) {
    this.status = status
    this.error = error
    this.emit('state', this.state())
  }

  /** Serialize load/unload operations so they never overlap. */
  enqueue(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  async load() {
    return this.enqueue(async () => {
      if (!this.isLocal()) return this.setStatus(this.current ? 'cloud' : 'unloaded')
      if (this.status === 'loaded') return
      const model = parseModelId(this.current).model
      this.lastActivity = this.now()
      this.setStatus('loading')
      try {
        await this.ollama.load(model, this.keepAlive(), this.runOptions())
        // The model may have been switched while we were loading.
        if (parseModelId(this.current).model !== model) {
          await this.ollama.unload(model).catch(() => {})
          return
        }
        this.lastActivity = this.now()
        this.setStatus('loaded')
      } catch (e) {
        this.setStatus('error', String(e.message || e))
      }
    })
  }

  async unload(id = this.current) {
    return this.enqueue(async () => {
      if (!this.isLocal(id)) return
      const model = parseModelId(id).model
      const isCurrent = id === this.current
      if (isCurrent) this.setStatus('unloading')
      try {
        await this.ollama.unload(model)
        // Ollama answers before the model has fully left memory; wait until /api/ps stops listing it so
        // the status (and VRAM meter) don't bounce back to "loaded".
        await this.waitUntilGone(model)
        this.unloadedAt = this.now()
        if (isCurrent) this.setStatus('unloaded')
      } catch (e) {
        if (isCurrent) this.setStatus('error', String(e.message || e))
      }
    })
  }

  /**
   * Switch models: unload the previous local model, then (by default) load the new one.
   * With { load: false } the new model is only selected; the user loads it with the Load button
   * (or it auto-loads when they start typing).
   */
  async setModel(id, { load = true } = {}) {
    if (id === this.current) return
    const prev = this.current
    const prevWasLoaded = this.status === 'loaded' || this.status === 'loading'
    this.current = id
    if (prev && this.isLocal(prev) && prevWasLoaded) await this.unload(prev)
    if (this.isLocal(id)) {
      this.setStatus('unloaded')
      if (load) await this.load()
    } else {
      this.setStatus(id ? 'cloud' : 'unloaded')
    }
  }

  /** User is typing / interacting. Auto-loads the local model if needed. */
  touch() {
    this.lastActivity = this.now()
    if (this.isLocal() && (this.status === 'unloaded' || this.status === 'error')) this.load()
  }

  beginBusy() {
    this.busy++
    this.touch()
    this.emit('state', this.state())
  }

  endBusy() {
    this.busy = Math.max(0, this.busy - 1)
    this.lastActivity = this.now()
    // Ollama loads the model itself when it serves a chat request — unless the user just
    // force-unloaded it (the aborted run ends after the unload).
    const justForced = this.forcedAt && this.now() - this.forcedAt < 5000
    if (this.isLocal() && this.status !== 'loaded' && !justForced) this.setStatus('loaded')
    else this.emit('state', this.state())
  }

  /**
   * Ctrl+U: unload now, regardless of what's running. The caller aborts in-flight requests first;
   * `loadedNames` are all models Ollama currently has in memory (so nothing is left behind).
   */
  async forceUnload(loadedNames = []) {
    this.forcedAt = this.now()
    return this.enqueue(async () => {
      const names = new Set(loadedNames)
      if (this.isLocal()) names.add(parseModelId(this.current).model)
      if (this.isLocal()) this.setStatus('unloading')
      for (const n of names) await this.ollama.unload(n).catch(() => {})
      for (const n of names) await this.waitUntilGone(n, 5000)
      this.forcedAt = this.now()
      this.unloadedAt = this.now()
      this.setStatus(this.isLocal() ? 'unloaded' : this.current ? 'cloud' : 'unloaded')
    })
  }

  /** Called periodically: unload after the idle window with no activity. */
  tick() {
    if (this.status !== 'loaded' || this.busy > 0) return
    if (this.idleSeconds() <= 0) return // "Never" auto-unload
    const idleMs = this.now() - this.lastActivity
    if (idleMs >= this.idleSeconds() * 1000) this.unload()
    else this.emit('state', this.state())
  }

  /** Reconcile with what Ollama actually has loaded. */
  async waitUntilGone(model, timeoutMs = 10_000) {
    if (typeof this.ollama.ps !== 'function') return
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      try {
        const ps = await this.ollama.ps()
        if (!ps.some((m) => m.name === model || m.name === model + ':latest')) return
      } catch {
        return
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  reconcile(psModels) {
    if (!this.isLocal() || this.busy > 0) return
    if (this.status !== 'loaded' && this.status !== 'unloaded') return
    // Right after an unload Ollama may still list the model for a moment — don't flip back to "loaded".
    if (this.status === 'unloaded' && this.unloadedAt && this.now() - this.unloadedAt < 15_000) return
    const name = parseModelId(this.current).model
    const loaded = psModels.some((m) => m.name === name || m.name === name + ':latest')
    if (loaded && this.status === 'unloaded') {
      this.lastActivity = this.now()
      this.setStatus('loaded')
    } else if (!loaded && this.status === 'loaded') {
      this.setStatus('unloaded')
    }
  }
}

module.exports = { ModelManager, parseModelId, keepAliveFor }
