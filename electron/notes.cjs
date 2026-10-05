// Notes window storage: one app-wide note plus one note per chat / code session.
// Saved as Markdown in the vault (Wicked Code/Notes) so they're visible in Obsidian too.
const fs = require('fs')
const path = require('path')

class NotesStore {
  /**
   * @param {() => string|null} getVaultPath
   * @param {string} fallbackDir  used when no vault is set
   */
  constructor(getVaultPath, fallbackDir) {
    this.getVaultPath = getVaultPath
    this.fallbackDir = fallbackDir
  }

  dir() {
    const v = this.getVaultPath()
    return v ? path.join(v, 'Wicked Code', 'Notes') : this.fallbackDir
  }

  file(scope, id) {
    if (scope === 'app') return path.join(this.dir(), 'App notes.md')
    const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '')
    if (scope !== 'session' || !safe) throw new Error('Unknown note.')
    return path.join(this.dir(), 'Sessions', `${safe}.md`)
  }

  read(scope, id) {
    try {
      return fs.readFileSync(this.file(scope, id), 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return ''
      throw e
    }
  }

  /** Atomic write (temp file + rename) so a crash never leaves a half-written note. */
  write(scope, id, text) {
    const file = this.file(scope, id)
    const body = String(text ?? '')
    if (!body && !fs.existsSync(file)) return { file, bytes: 0 }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file)
    return { file, bytes: Buffer.byteLength(body) }
  }
}

module.exports = { NotesStore }
