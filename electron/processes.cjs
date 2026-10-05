// Long-running background processes started by the agent (dev servers, watchers, apps under test).
// Output is kept in a rolling buffer so the agent can read it while the process keeps running.
const { spawn } = require('child_process')
const { EventEmitter } = require('events')

const MAX_BUFFER = 200_000

class ProcessManager extends EventEmitter {
  constructor() {
    super()
    this.procs = new Map()
    this.nextId = 1
  }

  /** Start a shell command. Returns the process record. */
  start({ command, cwd, env, owner }) {
    const id = `p${this.nextId++}`
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...env },
      detached: process.platform !== 'win32', // own process group so we can kill the whole tree
    })
    const rec = {
      id,
      command,
      cwd,
      owner: owner || null,
      pid: child.pid,
      status: 'running',
      exitCode: null,
      output: '',
      readOffset: 0, // characters of `output` already returned to the agent
      dropped: 0, // characters discarded from the front of the buffer
      startedAt: Date.now(),
      child,
    }
    const onData = (d) => {
      rec.output += d.toString()
      if (rec.output.length > MAX_BUFFER) {
        const cut = rec.output.length - MAX_BUFFER
        rec.output = rec.output.slice(cut)
        rec.dropped += cut
        rec.readOffset = Math.max(0, rec.readOffset - cut)
      }
      this.emit('output', rec)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (e) => onData(`\n[failed to start: ${e.message}]\n`))
    child.on('close', (code, signal) => {
      rec.status = 'exited'
      rec.exitCode = code ?? signal
      this.emit('change', this.list())
    })
    this.procs.set(id, rec)
    this.emit('change', this.list())
    return rec
  }

  get(id) {
    const rec = this.procs.get(id)
    if (!rec) throw new Error(`No background process with id ${id}. Use list_processes to see running processes.`)
    return rec
  }

  /** Output produced since the last read (or the whole buffer). */
  read(id, { all = false } = {}) {
    const rec = this.get(id)
    const text = all ? rec.output : rec.output.slice(rec.readOffset)
    rec.readOffset = rec.output.length
    return { text, status: rec.status, exitCode: rec.exitCode }
  }

  /** Resolve when the process exits, output matches `pattern`, or `ms` elapse. */
  waitFor(id, { ms = 5000, pattern = null } = {}) {
    const rec = this.get(id)
    const re = pattern ? new RegExp(pattern, 'i') : null
    return new Promise((resolve) => {
      const done = (why) => {
        clearTimeout(timer)
        this.off('output', onOut)
        this.off('change', onChange)
        resolve(why)
      }
      const onOut = (r) => r === rec && re && re.test(rec.output.slice(rec.readOffset)) && done('matched')
      const onChange = () => rec.status !== 'running' && done('exited')
      const timer = setTimeout(() => done('timeout'), ms)
      this.on('output', onOut)
      this.on('change', onChange)
      if (rec.status !== 'running') done('exited')
      else if (re && re.test(rec.output.slice(rec.readOffset))) done('matched')
    })
  }

  stop(id) {
    const rec = this.get(id)
    if (rec.status !== 'running') return false
    killTree(rec.child)
    return true
  }

  stopAll(owner) {
    for (const rec of this.procs.values()) {
      if (rec.status === 'running' && (owner === undefined || rec.owner === owner)) killTree(rec.child)
    }
  }

  list() {
    return [...this.procs.values()].map((r) => ({
      id: r.id,
      command: r.command,
      cwd: r.cwd,
      owner: r.owner,
      pid: r.pid,
      status: r.status,
      exitCode: r.exitCode,
      startedAt: r.startedAt,
    }))
  }
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(-child.pid, 'SIGTERM')
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }, 3000).unref()
    }
  } catch {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
}

module.exports = { ProcessManager }
