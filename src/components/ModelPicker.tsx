import { useEffect, useRef, useState } from 'react'
import { parseModelId, PROVIDER_LABELS, type CloudProvider } from '../lib/api'
import { catalogInfo, estimateVramGB } from '../lib/catalog'
import { rateModel } from '../lib/rating'
import { useApp } from '../lib/store'
import { Icon, Stars, formatGB } from './ui'

/** Button in the composer's bottom-right corner showing the active model; click to switch. */
export function ModelPicker({ disabled, onManage }: { disabled?: boolean; onManage(): void }) {
  const { settings, localModels, cloudModels, selectModel, gpu, modelState, ollamaRunning } = useApp()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const current = settings.selectedModel
  const { provider, model } = parseModelId(current)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (id: string) => {
    setOpen(false)
    if (id !== current) selectModel(id)
  }

  const f = filter.toLowerCase()
  const favs = settings.favoriteModels ?? []
  const favRank = (name: string) => {
    const i = favs.findIndex((x) => x === name || `${x}:latest` === name || x === `${name}:latest`)
    return i < 0 ? Infinity : i
  }
  const locals = localModels.filter((m) => m.name.toLowerCase().includes(f)).sort((a, b) => favRank(a.name) - favRank(b.name))
  const groups = (['anthropic', 'gemini', 'deepseek', 'grok'] as CloudProvider[])
    .map((p) => ({ p, models: cloudModels.filter((m) => m.provider === p && m.model.toLowerCase().includes(f)) }))
    .filter((g) => g.models.length)
  const installed = provider !== 'ollama' || localModels.some((m) => m.name === model || m.name === model + ':latest')
  const switching = modelState?.status === 'loading' || modelState?.status === 'unloading'

  return (
    <div className="model-picker" ref={ref}>
      <button
        className={`model-picker-btn ${!installed ? 'warn' : ''}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={!installed ? 'This model is not downloaded yet' : 'Change model'}
      >
        <span className={`dot ${provider === 'ollama' ? 'local' : 'cloud'}`} />
        <span className="model-picker-name">{model || 'Select model'}</span>
        {switching && <span className="muted small">{modelState?.status}…</span>}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="model-menu">
          <input className="input model-menu-search" placeholder="Search models…" autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="model-menu-list">
            <div className="model-menu-group">{PROVIDER_LABELS.ollama}</div>
            {!ollamaRunning && <div className="model-menu-empty">Ollama is not running. Start it to use local models.</div>}
            {ollamaRunning && !locals.length && <div className="model-menu-empty">No local models found.</div>}
            {locals.map((m) => {
              const id = `ollama:${m.name}`
              const need = catalogInfo(m.name)?.vramGB ?? estimateVramGB(m.size)
              return (
                <button key={id} className={`model-menu-item ${id === current ? 'selected' : ''}`} onClick={() => choose(id)}>
                  <span className="model-menu-item-name">
                    {favRank(m.name) !== Infinity && <span className="fav-mini">★</span>}
                    {m.name}
                  </span>
                  <span className="model-menu-item-meta">
                    {formatGB(need, false)} <Stars stars={rateModel(need, gpu).stars} />
                  </span>
                  {id === current && <Icon name="check" size={14} />}
                </button>
              )
            })}
            {groups.map((g) => (
              <div key={g.p}>
                <div className="model-menu-group">{PROVIDER_LABELS[g.p]}</div>
                {g.models.map((m) => (
                  <button key={m.id} className={`model-menu-item ${m.id === current ? 'selected' : ''}`} onClick={() => choose(m.id)}>
                    <span className="model-menu-item-name">{m.model}</span>
                    <span className="model-menu-item-meta">cloud</span>
                    {m.id === current && <Icon name="check" size={14} />}
                  </button>
                ))}
              </div>
            ))}
            {!cloudModels.length && <div className="model-menu-empty">Add API keys in Settings to use Anthropic, Gemini, DeepSeek or Grok.</div>}
          </div>
          <button
            className="model-menu-footer"
            onClick={() => {
              setOpen(false)
              onManage()
            }}
          >
            <Icon name="download" size={14} /> Manage &amp; download models…
          </button>
        </div>
      )}
    </div>
  )
}
