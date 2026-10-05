// Built-in preview: serves files from a code session's working folder on a private
// `wicked-preview://<token>/…` URL so the app can show HTML results in its own preview panel.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const SCHEME = 'wicked-preview'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

class PreviewRoots {
  constructor() {
    this.roots = new Map() // token -> folder
  }

  /** Stable token for a folder (same folder → same URL across restarts). */
  register(folder) {
    const root = path.resolve(folder)
    const token = crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16)
    this.roots.set(token, root)
    return token
  }

  /**
   * URL to show `target` (relative/absolute file path inside `folder`, or a local http URL).
   * Throws for anything outside the folder or non-local URLs.
   */
  urlFor(folder, target) {
    const t = String(target || '').trim() || 'index.html'
    if (/^https?:/i.test(t)) {
      if (!LOCAL_HOSTS.has(new URL(t).hostname)) throw new Error('Only local pages (localhost) can be previewed.')
      return t
    }
    if (t.startsWith(`${SCHEME}:`)) return t
    const root = path.resolve(folder)
    const file = path.resolve(root, t.replace(/^file:\/\//, ''))
    if (!isInside(file, root)) throw new Error(`${t} is outside the working folder.`)
    const rel = path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/')
    return `${SCHEME}://${this.register(root)}/${rel}`
  }

  /** Map a wicked-preview:// request to a file on disk, or null if it isn't allowed. */
  fileFor(url) {
    let u
    try {
      u = new URL(url)
    } catch {
      return null
    }
    const root = this.roots.get(u.hostname)
    if (!root) return null
    let rel
    try {
      rel = decodeURIComponent(u.pathname)
    } catch {
      return null
    }
    let file = path.resolve(root, '.' + rel)
    if (!isInside(file, root)) return null
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    } catch {
      /* missing → 404 by the caller */
    }
    return file
  }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

module.exports = { PreviewRoots, SCHEME }
