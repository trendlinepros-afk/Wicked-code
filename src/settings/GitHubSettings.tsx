import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useApp } from '../lib/store'
import { ConfirmDialog, Icon, Spinner } from '../components/ui'

const TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=Wicked%20Code&description=Wicked%20Code%20desktop%20app&contents=write&pull_requests=write&metadata=read'

export function GitHubSettings() {
  const { settings, setSettings } = useApp()
  const info = settings.apiKeys.github
  const [token, setToken] = useState('')
  const [user, setUser] = useState<string | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    if (!info?.set) return setUser(null)
    api()
      .github.user()
      .then((u) => setUser(u.login))
      .catch((e) => setStatus({ ok: false, text: String(e.message || e) }))
  }, [info?.set, info?.hint])

  const save = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const u = await api().github.test(token)
      setSettings(await api().apiKeys.set('github', token))
      setToken('')
      setUser(u.login)
      setStatus({ ok: true, text: `Connected as ${u.login}.` })
    } catch (e) {
      setStatus({ ok: false, text: 'That token did not work: ' + String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    } finally {
      setBusy(false)
    }
  }

  const changeRoot = async () => {
    const p = await api().dialog.pickFolder('Where should GitHub repositories be cloned?')
    if (p) setSettings(await api().settings.set('cloneRoot', p))
  }

  return (
    <div className="settings-page">
      <h2>GitHub</h2>
      <p className="muted">
        Connect GitHub to start code sessions from your repositories. Wicked Code clones the repo, works on a new branch, and the agent can commit, push and
        open pull requests for you — like Claude Code.
      </p>

      <section className="card">
        <div className="row space">
          <h3>Account</h3>
          <span className={`pill ${info?.set ? 'ok' : ''}`}>{info?.set ? (user ? `Connected as ${user}` : `Token ${info.hint}`) : 'Not connected'}</span>
        </div>
        <ol className="steps small">
          <li>
            <a href={TOKEN_URL} target="_blank" rel="noreferrer">
              Create a fine-grained personal access token →
            </a>
          </li>
          <li>
            Choose which repositories it can access, and give it <b>Contents: Read and write</b> and <b>Pull requests: Read and write</b> (the link pre-fills these).
          </li>
          <li>Paste it below. It’s stored encrypted on this computer.</li>
        </ol>
        <div className="row">
          <input
            className="input"
            type="password"
            placeholder={info?.set ? 'Paste a new token to replace the current one' : 'github_pat_…'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn btn-primary" disabled={!token.trim() || busy} onClick={save}>
            {busy ? <Spinner /> : null} Connect
          </button>
          {info?.set && (
            <button className="btn btn-danger" onClick={() => setConfirmRemove(true)}>
              Disconnect
            </button>
          )}
        </div>
        {status && <div className={`small ${status.ok ? 'ok' : 'bad'}`}>{status.text}</div>}
      </section>

      <section className="card">
        <h3>Clone location</h3>
        <p className="muted small">Repositories you open from GitHub are cloned here (one folder per owner/repo; existing clones are reused).</p>
        <div className="row">
          <code className="path">{settings.cloneRootResolved}</code>
          <button className="btn" onClick={changeRoot}>
            <Icon name="folder" size={14} /> Change…
          </button>
        </div>
      </section>

      <section className="card">
        <h3>How it works</h3>
        <ul className="steps small">
          <li>
            <b>Code → New code session → GitHub repository</b>: pick a repo and a branch name; it’s cloned and checked out.
          </li>
          <li>The agent edits, runs and tests code in that folder. Git commands it runs are authenticated automatically.</li>
          <li>
            Click <b>Commit, push &amp; open PR</b> under the message box (or just ask) and the agent commits, pushes the branch and opens a pull request.
          </li>
          <li>Local folders that are already GitHub clones get the same abilities.</li>
          <li>Git must be installed (git-scm.com).</li>
        </ul>
      </section>

      {confirmRemove && (
        <ConfirmDialog
          title="Disconnect GitHub?"
          message="Are you sure you want to remove your GitHub token from Wicked Code?"
          danger
          onNo={() => setConfirmRemove(false)}
          onYes={async () => {
            setConfirmRemove(false)
            setSettings(await api().apiKeys.set('github', ''))
            setUser(null)
            setStatus(null)
          }}
        />
      )}
    </div>
  )
}
