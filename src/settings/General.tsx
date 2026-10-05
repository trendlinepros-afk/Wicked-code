import { useState } from 'react'
import { api, type PermissionMode, type Settings, type Theme } from '../lib/api'
import { useApp } from '../lib/store'
import { Icon } from '../components/ui'
import { UpdatesCard } from '../components/Updates'

function formatIdle(sec: number) {
  if (sec < 60) return `${sec} seconds`
  if (sec % 3600 === 0) return `${sec / 3600} hour${sec === 3600 ? '' : 's'}`
  if (sec % 60 === 0) return `${sec / 60} minute${sec === 60 ? '' : 's'}`
  return `${Math.floor(sec / 60)} min ${sec % 60} s`
}

export function General() {
  const { settings, setSettings, ollamaRunning, refreshModels, launcher } = useApp()
  const [url, setUrl] = useState(settings.ollamaUrl)
  const [vaultMsg, setVaultMsg] = useState<string | null>(null)

  const set = async <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(await api().settings.set(key, value))

  const changeVault = async () => {
    const p = await api().dialog.pickFolder('Select your Obsidian vault')
    if (!p) return
    const info = await api().vault.inspect(p)
    setSettings(await api().vault.set(p))
    setVaultMsg(info.isObsidian ? 'Vault updated.' : 'Vault updated (note: no .obsidian folder found there).')
  }

  return (
    <div className="settings-page">
      <h2>General</h2>

      <UpdatesCard />

      <section className="card">
        <h3>Appearance</h3>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {(
            [
              ['system', 'Use system'],
              ['light', 'Light'],
              ['dark', 'Dark'],
            ] as [Theme, string][]
          ).map(([v, label]) => (
            <button key={v} role="radio" aria-checked={settings.theme === v} className={settings.theme === v ? 'active' : ''} onClick={() => set('theme', v)}>
              <Icon name={v === 'system' ? 'monitor' : v === 'light' ? 'sun' : 'moon'} size={15} /> {label}
            </button>
          ))}
        </div>
        <p className="muted small">“Use system” follows your operating system’s light/dark setting automatically.</p>
      </section>

      <section className="card">
        <h3>Obsidian vault</h3>
        <p className="muted small">All chats and code sessions are saved here under “Wicked Code”.</p>
        <div className="row">
          <code className="path">{settings.vaultPath}</code>
          <button className="btn" onClick={changeVault}>
            <Icon name="folder" size={14} /> Change…
          </button>
        </div>
        {vaultMsg && <div className="muted small">{vaultMsg}</div>}
        <label className="check">
          <input type="checkbox" checked={settings.useVaultMemory} onChange={(e) => set('useVaultMemory', e.target.checked)} />
          Give the AI my vault memory note (Wicked Code/Memory.md) in every session
        </label>
        <button className="btn btn-ghost btn-sm" onClick={() => api().vault.openMemory()}>
          <Icon name="book" size={14} /> Open Memory.md
        </button>
      </section>

      <section className="card">
        <h3>Ollama</h3>
        <div className="row">
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:11434" />
          <button
            className="btn"
            disabled={url === settings.ollamaUrl}
            onClick={async () => {
              await set('ollamaUrl', url.trim())
              refreshModels()
            }}
          >
            Save
          </button>
        </div>
        <div className={`small ${ollamaRunning ? 'ok' : 'bad'}`}>
          {ollamaRunning
            ? `● Connected${launcher?.startedByApp ? ' (started by Wicked Code)' : ''}`
            : launcher?.status === 'not-installed'
              ? '● Ollama is not installed — get it from ollama.com/download'
              : launcher?.status === 'starting'
                ? '● Starting Ollama…'
                : `● Not reachable${launcher?.error ? ` — ${launcher.error}` : ''}`}
        </div>
        {!ollamaRunning && launcher?.status !== 'starting' && launcher?.status !== 'not-installed' && (
          <button className="btn btn-sm" onClick={() => api().ollama.start()}>
            <Icon name="play" size={12} /> Start Ollama
          </button>
        )}
        <label className="check">
          <input type="checkbox" checked={settings.autoStartOllama} onChange={(e) => set('autoStartOllama', e.target.checked)} />
          Start Ollama automatically when Wicked Code opens
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.stopOllamaOnExit} onChange={(e) => set('stopOllamaOnExit', e.target.checked)} />
          Stop Ollama when Wicked Code closes (only if Wicked Code started it)
        </label>
        <div className="field">
          <label>Context window (tokens)</label>
          <select className="input narrow" value={settings.contextLength} onChange={(e) => set('contextLength', Number(e.target.value))}>
            {[4096, 8192, 16384, 32768, 65536].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
          <span className="muted small">Larger windows let the model see more code but use more VRAM.</span>
        </div>
      </section>

      <section className="card">
        <h3>Model memory</h3>
        <p className="muted small">
          Controls when local models are loaded into and removed from your GPU’s VRAM. Press <kbd>Ctrl</kbd>+<kbd>U</kbd> anytime to force-unload
          the model immediately — it stops any reply in progress.
        </p>
        <label className="check">
          <input type="checkbox" checked={settings.autoLoadOnType !== false} onChange={(e) => set('autoLoadOnType', e.target.checked)} />
          Start loading the selected model as soon as I start typing in a chat or code session
        </label>
        <div className="field">
          <label>Unload the model after it sits idle for</label>
          <div className="mf-presets">
            {(
              [
                [30, '30 sec'],
                [60, '1 min'],
                [300, '5 min'],
                [900, '15 min'],
                [3600, '1 hour'],
                [0, 'Never'],
              ] as [number, string][]
            ).map(([v, label]) => (
              <button key={v} className={settings.idleUnloadSeconds === v ? 'active' : ''} onClick={() => set('idleUnloadSeconds', v)}>
                {label}
              </button>
            ))}
          </div>
          <div className="row">
            <input
              className="input narrow"
              type="number"
              min={0}
              max={86400}
              value={settings.idleUnloadSeconds}
              onChange={(e) => {
                const v = Number(e.target.value)
                set('idleUnloadSeconds', Number.isFinite(v) && v >= 0 ? Math.min(86400, Math.round(v)) : 30)
              }}
            />
            <span className="muted small">seconds (0 = never)</span>
          </div>
          <span className="muted small">
            {settings.idleUnloadSeconds > 0
              ? `With no chatting or coding for ${formatIdle(settings.idleUnloadSeconds)}, the model is unloaded to free your VRAM. A countdown shows next to the model name at the top.`
              : 'Models stay loaded until you press “Unload model” or close Wicked Code.'}
          </span>
        </div>
      </section>

      <section className="card">
        <h3>Agent loop</h3>
        <div className="field">
          <label>Max steps per request</label>
          <input
            className="input narrow"
            type="number"
            min={10}
            max={500}
            value={settings.maxAgentSteps}
            onChange={(e) => set('maxAgentSteps', Math.min(500, Math.max(10, Number(e.target.value) || 100)))}
          />
          <span className="muted small">
            How many tool calls the agent may make for one message while it writes, runs, tests and fixes code. You can always say “continue”.
          </span>
        </div>
      </section>

      <section className="card">
        <h3>Default permissions for new chats</h3>
        <p className="muted small">Each chat and code session has its own setting — change it anytime from the <b>Permissions</b> menu at the top of the app.</p>
        {(
          [
            ['ask', 'Ask before every file change and command'],
            ['auto-edits', 'Auto-approve file edits, ask before running commands'],
            ['auto-all', 'Auto-approve everything (use with care)'],
          ] as [PermissionMode, string][]
        ).map(([v, label]) => (
          <label key={v} className="check">
            <input type="radio" name="perm" checked={settings.permissionMode === v} onChange={() => set('permissionMode', v)} />
            {label}
          </label>
        ))}
      </section>
    </div>
  )
}
