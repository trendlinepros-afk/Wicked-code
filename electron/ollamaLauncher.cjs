// Starts the Ollama server with the app if it isn't already running, and stops it on exit
// (only if we were the ones who started it).
const { spawn, execFile } = require('child_process')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')

function candidatePaths() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return [
      path.join(local, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe'),
    ]
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Ollama.app/Contents/Resources/ollama', '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama', path.join(home, 'Applications/Ollama.app/Contents/Resources/ollama')]
  }
  return ['/usr/local/bin/ollama', '/usr/bin/ollama', '/bin/ollama', path.join(home, '.local/bin/ollama')]
}

/** Locate the ollama executable (known install locations, then PATH). */
function findOllama() {
  for (const p of candidatePaths()) if (fs.existsSync(p)) return Promise.resolve(p)
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { windowsHide: true, timeout: 3000 }, (err, out) => {
      resolve(err ? null : String(out).split(/\r?\n/)[0].trim() || null)
    })
  })
}

function isLocalUrl(url) {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

class OllamaLauncher extends EventEmitter {
  /**
   * @param {object} o
   * @param {{ isRunning(): Promise<boolean> }} o.ollama
   * @param {() => string} o.getUrl
   * @param {string} o.logFile
   * @param {() => Promise<string|null>} [o.find]  override for tests
   * @param {typeof spawn} [o.spawnFn]  override for tests
   */
  constructor({ ollama, getUrl, logFile, find = findOllama, spawnFn = spawn, extraEnv = () => ({}) }) {
    super()
    this.extraEnv = extraEnv
    this.ollama = ollama
    this.getUrl = getUrl
    this.logFile = logFile
    this.find = find
    this.spawnFn = spawnFn
    this.child = null
    this.state = { status: 'unknown', startedByApp: false, error: null, binary: null }
  }

  set(patch) {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }

  /** Make sure Ollama is reachable; start `ollama serve` if it isn't. */
  async ensure() {
    if (await this.ollama.isRunning()) {
      this.set({ status: 'running', error: null })
      return this.state
    }
    const url = this.getUrl()
    if (!isLocalUrl(url)) {
      this.set({ status: 'stopped', error: `Ollama at ${url} is not reachable (remote servers aren't started automatically).` })
      return this.state
    }
    const bin = await this.find()
    if (!bin) {
      this.set({ status: 'not-installed', binary: null, error: 'Ollama is not installed.' })
      return this.state
    }
    this.set({ status: 'starting', binary: bin, error: null })
    try {
      const u = new URL(url)
      const host = `${u.hostname === 'localhost' ? '127.0.0.1' : u.hostname}:${u.port || 11434}`
      let log = 'ignore'
      try {
        log = fs.openSync(this.logFile, 'a')
      } catch {
        /* no log file */
      }
      const child = this.spawnFn(bin, ['serve'], {
        env: { ...process.env, ...this.extraEnv(), OLLAMA_HOST: host },
        stdio: ['ignore', log, log],
        windowsHide: true,
        detached: false,
      })
      this.child = child
      child.on('exit', (code) => {
        if (this.child === child) {
          this.child = null
          this.set({ status: 'stopped', startedByApp: false, error: code ? `Ollama exited with code ${code}. See ${this.logFile}` : null })
        }
      })
      child.on('error', (e) => this.set({ status: 'error', error: e.message }))
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (await this.ollama.isRunning()) {
          this.set({ status: 'running', startedByApp: true, error: null })
          return this.state
        }
        if (!this.child) break
      }
      if (this.state.status === 'starting') this.set({ status: 'error', error: `Ollama did not start. See ${this.logFile}` })
    } catch (e) {
      this.set({ status: 'error', error: String(e.message || e) })
    }
    return this.state
  }

  /** Stop the server if this app started it. */
  stop() {
    if (!this.child) return false
    try {
      this.child.kill()
    } catch {
      /* already gone */
    }
    this.child = null
    this.set({ status: 'stopped', startedByApp: false })
    return true
  }
}

module.exports = { OllamaLauncher, findOllama, isLocalUrl }
