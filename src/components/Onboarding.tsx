import { useState } from 'react'
import { api, type Settings } from '../lib/api'
import { Icon, Spinner } from './ui'

/** First-run screen: the user must pick an Obsidian vault before using the app. */
export function Onboarding({ onDone, current }: { onDone(s: Settings): void; current?: string | null }) {
  const [path, setPath] = useState<string | null>(current ?? null)
  const [warn, setWarn] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const pick = async () => {
    const p = await api().dialog.pickFolder('Select your Obsidian vault')
    if (!p) return
    setPath(p)
    setError(null)
    const info = await api().vault.inspect(p)
    setWarn(info.isObsidian ? null : 'This folder has no .obsidian settings folder, so it may not be a vault. You can still use it.')
  }

  const save = async () => {
    if (!path) return
    setSaving(true)
    try {
      onDone(await api().vault.set(path))
    } catch (e) {
      setError(String((e as Error).message || e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="brand big">
          <span className="brand-mark">W</span>
          <span className="brand-name">
            wicked <b>code</b>
          </span>
        </div>
        <h1>Connect your Obsidian vault</h1>
        <p className="muted">
          Wicked Code saves every chat and code session to your vault as Markdown notes, and reads{' '}
          <code>Wicked Code/Memory.md</code> as long-term memory for the AI. Pick your vault to get started.
        </p>
        <button className="vault-picker" onClick={pick}>
          <Icon name="book" size={22} />
          <div>
            <div className="vault-picker-title">{path ? path : 'Choose vault folder…'}</div>
            <div className="muted small">{path ? 'Click to change' : 'This is the folder that contains your .obsidian folder'}</div>
          </div>
        </button>
        {warn && <div className="callout warn">{warn}</div>}
        {error && <div className="callout error">{error}</div>}
        <div className="onboarding-tree muted small">
          Sessions will be saved to:
          <pre>{`${path ? path : '<vault>'}/Wicked Code/
├── Chats/
├── Code Sessions/
└── Memory.md`}</pre>
        </div>
        <button className="btn btn-primary btn-lg" disabled={!path || saving} onClick={save}>
          {saving ? <Spinner /> : null} Start using Wicked Code
        </button>
      </div>
    </div>
  )
}
