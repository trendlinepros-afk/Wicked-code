import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type UpdateState } from '../lib/api'
import { useApp } from '../lib/store'
import { Icon, Modal, Spinner } from './ui'

/** Popup shown once an update has finished downloading. */
export function UpdateReadyDialog() {
  const { update } = useApp()
  const [open, setOpen] = useState(false)
  const [installing, setInstalling] = useState(false)
  const last = useRef<UpdateState | null>(null)

  useEffect(() => {
    // Open whenever a "downloaded" status arrives (including when the user clicks Check again).
    if (update?.status === 'downloaded' && update !== last.current) setOpen(true)
    last.current = update
  }, [update])

  // Let the status bar reopen it.
  useEffect(() => {
    const reopen = () => setOpen(true)
    window.addEventListener('wicked:show-update', reopen)
    return () => window.removeEventListener('wicked:show-update', reopen)
  }, [])

  if (!open || update?.status !== 'downloaded') return null
  return (
    <Modal onClose={() => setOpen(false)} width={460}>
      <div className="update-hero">
        <Icon name="download" size={22} />
      </div>
      <h3 className="modal-title">Update ready to install</h3>
      <div className="modal-body">
        Wicked Code <b>v{update.version}</b> has been downloaded (you’re on v{update.currentVersion}). Install it now and restart the app?
        <div className="muted small update-later-note">If you choose later, it installs automatically the next time you close Wicked Code.</div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={() => setOpen(false)} disabled={installing}>
          I’ll do this later
        </button>
        <button
          className="btn btn-primary"
          disabled={installing}
          onClick={async () => {
            setInstalling(true)
            await api().updater.install()
          }}
        >
          {installing ? <Spinner /> : <Icon name="refresh" size={14} />} Install &amp; restart
        </button>
      </div>
    </Modal>
  )
}

/** "About & updates" card for Settings → General. */
export function UpdatesCard() {
  const { appInfo, update } = useApp()
  const status = update?.status ?? 'idle'
  const busy = status === 'checking' || status === 'downloading'

  let message: ReactNode = null
  if (status === 'checking') message = 'Checking for updates…'
  else if (status === 'none') message = <span className="ok">You’re on the latest version.</span>
  else if (status === 'downloading') message = `Downloading v${update?.version}… ${update?.percent ?? 0}%`
  else if (status === 'downloaded') message = <span className="ok">v{update?.version} is downloaded and ready to install.</span>
  else if (status === 'error') message = <span className="bad">Update failed: {update?.error}</span>
  else if (status === 'unsupported') message = <span className="muted">{update?.error}</span>

  return (
    <section className="card">
      <div className="row space">
        <div>
          <h3>About &amp; updates</h3>
          <div className="muted small">
            Wicked Code <b className="version-strong">v{appInfo?.version ?? '…'}</b>
          </div>
        </div>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => (status === 'downloaded' ? window.dispatchEvent(new Event('wicked:show-update')) : api().updater.check())}
        >
          {busy ? <Spinner /> : <Icon name="refresh" size={14} />}
          {status === 'downloaded' ? 'Install update…' : 'Check for updates'}
        </button>
      </div>
      {message && <div className="small update-msg">{message}</div>}
      {status === 'downloading' && (
        <div className="pull-bar update-bar">
          <div style={{ width: `${update?.percent ?? 0}%` }} />
        </div>
      )}
    </section>
  )
}

/** Thin bar along the bottom of the window: version on the far left, status on the right. */
export function StatusBar() {
  const { appInfo, update, settings, ollamaRunning } = useApp()
  const vaultName = settings.vaultPath?.split(/[\\/]/).filter(Boolean).pop()
  return (
    <footer className="statusbar">
      <span className="statusbar-version" title="Wicked Code version">
        v{appInfo?.version ?? '…'}
      </span>
      <span className="statusbar-item" title={settings.vaultPath || ''}>
        <Icon name="book" size={12} /> {vaultName}
      </span>
      <span className="topbar-spacer" />
      {update?.status === 'downloading' && (
        <span className="statusbar-item">
          <Spinner /> Downloading update {update.percent}%
        </span>
      )}
      {update?.status === 'downloaded' && (
        <button className="statusbar-item statusbar-update" onClick={() => window.dispatchEvent(new Event('wicked:show-update'))}>
          <Icon name="download" size={12} /> Update v{update.version} ready — restart to install
        </button>
      )}
      <span className={`statusbar-item ${ollamaRunning ? '' : 'bad'}`}>● Ollama {ollamaRunning ? 'connected' : 'offline'}</span>
    </footer>
  )
}

/** Version label for screens without the status bar (onboarding). */
export function VersionTag() {
  const [v, setV] = useState<string | null>(null)
  useEffect(() => {
    api().app.info().then((i) => setV(i.version))
  }, [])
  return <div className="version-tag">{v ? `v${v}` : ''}</div>
}
