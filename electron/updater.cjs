// "Check for updates": checks GitHub Releases, downloads an available update,
// then lets the user install + restart now or later (installed on next quit).
const { EventEmitter } = require('events')

class Updater extends EventEmitter {
  /**
   * @param {object} opts
   * @param {boolean} opts.supported  false when running unpackaged (dev) — updates need an installed build
   * @param {() => any} opts.getAutoUpdater  lazily returns electron-updater's autoUpdater
   * @param {string} opts.currentVersion
   */
  constructor({ supported, getAutoUpdater, currentVersion }) {
    super()
    this.supported = supported
    this.getAutoUpdater = getAutoUpdater
    this.currentVersion = currentVersion
    this.state = { status: 'idle', currentVersion, version: null, percent: 0, error: null }
    this.wired = false
  }

  set(patch) {
    this.state = { ...this.state, ...patch }
    this.emit('status', this.state)
  }

  wire() {
    if (this.wired) return this.au
    const au = this.getAutoUpdater()
    au.autoDownload = false // we download explicitly after "check"
    au.autoInstallOnAppQuit = true // "later" still installs the next time the app quits
    au.on('checking-for-update', () => this.set({ status: 'checking', error: null }))
    au.on('update-available', (info) => {
      this.set({ status: 'downloading', version: info.version, percent: 0 })
      au.downloadUpdate().catch((e) => this.set({ status: 'error', error: String(e.message || e) }))
    })
    au.on('update-not-available', () => this.set({ status: 'none' }))
    au.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent || 0) }))
    au.on('update-downloaded', (info) => this.set({ status: 'downloaded', version: info.version, percent: 100 }))
    au.on('error', (e) => this.set({ status: 'error', error: String(e?.message || e) }))
    this.au = au
    this.wired = true
    return au
  }

  async check() {
    if (!this.supported) {
      this.set({ status: 'unsupported', error: 'Updates can only be installed from the packaged app (not in dev mode).' })
      return this.state
    }
    if (['checking', 'downloading'].includes(this.state.status)) return this.state
    if (this.state.status === 'downloaded') {
      this.emit('status', this.state) // re-show the install prompt
      return this.state
    }
    try {
      this.set({ status: 'checking', error: null })
      let timer
      const result = await Promise.race([
        this.wire().checkForUpdates(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out contacting GitHub. Check your internet connection.')), 60_000)
        }),
      ]).finally(() => clearTimeout(timer))
      // electron-updater resolves with null (and emits nothing) when this build can't self-update.
      if (result == null && this.state.status === 'checking') {
        this.set({ status: 'unsupported', error: 'This copy of Wicked Code can’t update itself. Reinstall it from the latest installer.' })
      }
    } catch (e) {
      if (['checking', 'idle'].includes(this.state.status)) this.set({ status: 'error', error: String(e.message || e) })
    }
    return this.state
  }

  install() {
    if (this.state.status !== 'downloaded') return false
    // isSilent=false shows the installer UI on Windows; isForceRunAfter=true relaunches the app.
    setImmediate(() => this.au.quitAndInstall(false, true))
    return true
  }
}

module.exports = { Updater }
