import { useEffect, useMemo, useState } from 'react'
import { api, type GithubRepo, type RepoInfo } from '../lib/api'
import { useApp } from '../lib/store'
import { Icon, Modal, Spinner } from './ui'

export interface NewSessionResult {
  folder: string
  github: RepoInfo | null
}

/** Start a code session from a local folder or a GitHub repository (cloned locally). */
export function NewCodeSessionDialog({ onDone, onCancel, onOpenSettings }: { onDone(r: NewSessionResult): void; onCancel(): void; onOpenSettings(): void }) {
  const { settings } = useApp()
  const hasToken = settings.apiKeys.github?.set
  const [tab, setTab] = useState<'local' | 'github'>(hasToken ? 'github' : 'local')
  const [repos, setRepos] = useState<GithubRepo[] | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<GithubRepo | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [base, setBase] = useState('')
  const [makeBranch, setMakeBranch] = useState(true)
  const [branchName, setBranchName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (tab !== 'github' || !hasToken || repos) return
    api()
      .github.repos()
      .then(setRepos)
      .catch((e) => setError(String(e.message || e)))
  }, [tab, hasToken, repos])

  useEffect(() => {
    if (!picked) return
    setBase(picked.defaultBranch)
    setBranches([picked.defaultBranch])
    api().github.branches(picked.fullName).then(setBranches).catch(() => {})
    api().github.suggestBranch(picked.fullName.split('/')[1]).then(setBranchName)
  }, [picked])

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return (repos || []).filter((r) => !q || r.fullName.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q)).slice(0, 100)
  }, [repos, query])

  const pickLocal = async () => {
    const folder = await api().dialog.pickFolder('Choose the project working folder for this code session')
    if (!folder) return
    onDone({ folder, github: await api().github.repoInfo(folder).catch(() => null) })
  }

  const clone = async () => {
    if (!picked) return
    setBusy(true)
    setError(null)
    try {
      const r = await api().github.clone({ fullName: picked.fullName, baseBranch: base, newBranch: makeBranch ? branchName.trim() || undefined : undefined })
      onDone({ folder: r.path, github: r.info })
    } catch (e) {
      setError(String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setBusy(false)
    }
  }

  return (
    <Modal onClose={busy ? undefined : onCancel} width={620}>
      <h3 className="modal-title">New code session</h3>
      <div className="segmented wide">
        <button className={tab === 'local' ? 'active' : ''} onClick={() => setTab('local')}>
          <Icon name="folder" size={15} /> Local folder
        </button>
        <button className={tab === 'github' ? 'active' : ''} onClick={() => setTab('github')}>
          <Icon name="github" size={15} /> GitHub repository
        </button>
      </div>

      {tab === 'local' && (
        <div className="newsession-body">
          <p className="muted">Pick the project folder where code will be read, written, run and tested. The agent can only touch files inside it.</p>
          <button className="btn btn-primary btn-lg" onClick={pickLocal}>
            <Icon name="folder" size={16} /> Choose working folder…
          </button>
        </div>
      )}

      {tab === 'github' && !hasToken && (
        <div className="newsession-body">
          <p className="muted">Connect your GitHub account to clone repositories, push branches and open pull requests.</p>
          <button className="btn btn-primary" onClick={onOpenSettings}>
            <Icon name="key" size={14} /> Connect GitHub in Settings
          </button>
        </div>
      )}

      {tab === 'github' && hasToken && (
        <div className="newsession-body">
          {!picked ? (
            <>
              <input className="input" placeholder="Search your repositories…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
              <div className="repo-list">
                {!repos && !error && (
                  <div className="muted pad">
                    <Spinner /> Loading repositories…
                  </div>
                )}
                {repos && !filtered.length && <div className="muted pad">No repositories match.</div>}
                {filtered.map((r) => (
                  <button key={r.fullName} className="repo-item" onClick={() => setPicked(r)}>
                    <div className="repo-item-name">
                      {r.fullName} {r.private && <span className="pill">private</span>}
                    </div>
                    <div className="muted small repo-item-desc">
                      {[r.language, r.description].filter(Boolean).join(' · ') || 'No description'}
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="repo-picked">
                <Icon name="github" size={18} />
                <b>{picked.fullName}</b>
                <button className="btn btn-ghost btn-sm" onClick={() => setPicked(null)} disabled={busy}>
                  Change
                </button>
              </div>
              <div className="field">
                <label>Start from branch</label>
                <select className="input" value={base} onChange={(e) => setBase(e.target.value)} disabled={busy}>
                  {branches.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </div>
              <label className="check">
                <input type="checkbox" checked={makeBranch} onChange={(e) => setMakeBranch(e.target.checked)} disabled={busy} />
                Work on a new branch (recommended — keeps {base || 'main'} clean for a pull request)
              </label>
              {makeBranch && <input className="input" value={branchName} onChange={(e) => setBranchName(e.target.value)} disabled={busy} />}
              <p className="muted small">
                Clones to <code>{settings.cloneRootResolved}</code> (reuses an existing clone).
              </p>
            </>
          )}
        </div>
      )}

      {error && <div className="callout error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {tab === 'github' && picked && (
          <button className="btn btn-primary" onClick={clone} disabled={busy || (makeBranch && !branchName.trim())}>
            {busy ? <Spinner /> : <Icon name="download" size={14} />} {busy ? 'Cloning…' : 'Clone & start session'}
          </button>
        )}
      </div>
    </Modal>
  )
}
