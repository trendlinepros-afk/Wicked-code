import { useState } from 'react'
import { api, PROVIDER_LABELS, type CloudProvider } from '../lib/api'
import { useApp } from '../lib/store'
import { ConfirmDialog, Spinner } from '../components/ui'

const PROVIDERS: { id: CloudProvider; url: string; placeholder: string }[] = [
  { id: 'anthropic', url: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
  { id: 'gemini', url: 'https://aistudio.google.com/app/apikey', placeholder: 'AIza…' },
  { id: 'deepseek', url: 'https://platform.deepseek.com/api_keys', placeholder: 'sk-…' },
  { id: 'grok', url: 'https://console.x.ai', placeholder: 'xai-…' },
]

export function ApiKeys() {
  return (
    <div className="settings-page">
      <h2>API Keys</h2>
      <p className="muted">
        Keys are encrypted with your operating system’s keychain and never leave this machine except to call the provider. Models from
        providers with a key appear in the model picker.
      </p>
      {PROVIDERS.map((p) => (
        <KeyRow key={p.id} {...p} />
      ))}
    </div>
  )
}

function KeyRow({ id, url, placeholder }: { id: CloudProvider; url: string; placeholder: string }) {
  const { settings, setSettings, refreshModels } = useApp()
  const info = settings.apiKeys[id]
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const save = async () => {
    setSettings(await api().apiKeys.set(id, value))
    setValue('')
    setStatus({ ok: true, text: 'Saved.' })
    refreshModels()
  }
  const test = async () => {
    setTesting(true)
    const r = await api().apiKeys.test(id, value || undefined)
    setTesting(false)
    setStatus({ ok: r.ok, text: r.ok ? 'Key works!' : `Failed: ${r.error}` })
  }
  const remove = async () => {
    setConfirmRemove(false)
    setSettings(await api().apiKeys.set(id, ''))
    setStatus(null)
    refreshModels()
  }

  return (
    <section className="card">
      <div className="row space">
        <h3>{PROVIDER_LABELS[id]}</h3>
        <span className={`pill ${info.set ? 'ok' : ''}`}>{info.set ? `Saved ${info.hint}` : 'Not set'}</span>
      </div>
      <div className="row">
        <input
          className="input"
          type={show ? 'text' : 'password'}
          placeholder={info.set ? 'Enter a new key to replace the saved one' : placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn btn-ghost" onClick={() => setShow((s) => !s)}>
          {show ? 'Hide' : 'Show'}
        </button>
        <button className="btn btn-primary" disabled={!value.trim()} onClick={save}>
          Save
        </button>
        <button className="btn" disabled={testing || (!value.trim() && !info.set)} onClick={test}>
          {testing ? <Spinner /> : null} Test
        </button>
        {info.set && (
          <button className="btn btn-danger" onClick={() => setConfirmRemove(true)}>
            Remove
          </button>
        )}
      </div>
      <div className="row space small">
        <span className={status ? (status.ok ? 'ok' : 'bad') : 'muted'}>{status?.text ?? ''}</span>
        <a href={url} target="_blank" rel="noreferrer">
          Get a key →
        </a>
      </div>
      {confirmRemove && (
        <ConfirmDialog
          title="Remove API key?"
          message={`Are you sure you want to remove your ${PROVIDER_LABELS[id]} key?`}
          danger
          onYes={remove}
          onNo={() => setConfirmRemove(false)}
        />
      )}
    </section>
  )
}
