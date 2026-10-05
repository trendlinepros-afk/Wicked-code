import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type LocalModel, type PullProgress } from '../lib/api'
import { CATALOG, catalogInfo, estimateVramGB, type CatalogModel } from '../lib/catalog'
import { rateModel } from '../lib/rating'
import { useApp } from '../lib/store'
import { ConfirmDialog, Icon, Spinner, Stars, formatGB } from '../components/ui'

type Confirm = { kind: 'delete'; name: string } | { kind: 'download'; name: string; sizeGB?: number } | null

const isInstalled = (models: LocalModel[], name: string) => models.some((m) => m.name === name || m.name === `${name}:latest`)

export function LocalModels() {
  const { localModels, ollamaRunning, gpu, pulls, startPull, refreshModels, settings, setSettings, selectModel, modelState } = useApp()
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('all')
  const [sort, setSort] = useState<'fit' | 'size' | 'name'>('fit')
  const [custom, setCustom] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    refreshModels()
  }, [refreshModels])

  const favorites = settings.favoriteModels ?? []
  const isFav = (name: string) => favorites.some((f) => f === name || f === `${name}:latest` || `${f}:latest` === name)

  const store = useMemo(() => {
    const q = query.toLowerCase()
    const list = CATALOG.filter((m) => !isInstalled(localModels, m.name) && !isFav(m.name))
      .filter((m) => tag === 'all' || m.tags.includes(tag))
      .filter((m) => !q || `${m.name} ${m.display} ${m.strengths} ${m.tags.join(' ')}`.toLowerCase().includes(q))
    const stars = (m: CatalogModel) => rateModel(m.vramGB, gpu).stars
    return list.sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1
      if (sort === 'name') return a.display.localeCompare(b.display)
      if (sort === 'size') return a.vramGB - b.vramGB
      return stars(b) - stars(a) || b.vramGB - a.vramGB
    })
  }, [localModels, query, tag, sort, gpu, favorites])

  const toggleFavorite = async (name: string) => {
    const next = isFav(name) ? favorites.filter((f) => f !== name && f !== `${name}:latest` && `${f}:latest` !== name) : [...favorites, name]
    setSettings((s) => ({ ...s, favoriteModels: next })) // instant feedback
    setSettings(await api().settings.set('favoriteModels', next))
  }

  // Favorites hold installed models and/or store models, in the order they were starred.
  const favInstalled = localModels.filter((m) => isFav(m.name))
  const favStore = CATALOG.filter((m) => isFav(m.name) && !isInstalled(localModels, m.name))
  const downloaded = localModels.filter((m) => !isFav(m.name))
  const favOrder = (name: string) => favorites.findIndex((f) => f === name || f === `${name}:latest` || `${f}:latest` === name)
  const favCards = [
    ...favInstalled.map((m) => ({ key: m.name, order: favOrder(m.name), node: installedCard(m) })),
    ...favStore.map((m) => ({ key: m.name, order: favOrder(m.name), node: storeCard(m) })),
  ].sort((a, b) => a.order - b.order)

  const allTags = useMemo(() => ['all', ...Array.from(new Set(CATALOG.flatMap((m) => m.tags)))], [])

  const doConfirm = async () => {
    const c = confirm
    setConfirm(null)
    if (!c) return
    setError(null)
    if (c.kind === 'delete') {
      try {
        await api().models.delete(c.name)
        await api().models.setNotes(c.name, '')
        if (isFav(c.name) && !catalogInfo(c.name)) await toggleFavorite(c.name)
        await refreshModels()
      } catch (e) {
        setError(String((e as Error).message || e))
      }
    } else {
      startPull(c.name)
    }
  }

  function installedCard(m: LocalModel) {
      const info = catalogInfo(m.name)
      const need = info?.vramGB ?? estimateVramGB(m.size)
      const r = rateModel(need, gpu)
      const id = `ollama:${m.name}`
      const selected = settings.selectedModel === id
      return (
        <article key={m.name} className={`model-card ${selected ? 'selected' : ''}`}>
          <FavoriteButton on={isFav(m.name)} onToggle={() => toggleFavorite(m.name)} />
          <header>
            <div>
              <div className="model-card-title">{info?.display ?? m.name}</div>
              <code className="model-card-tag">{m.name}</code>
            </div>
            <div className="model-card-rating" title={r.detail}>
              <Stars stars={r.stars} title={r.detail} />
              <span className="muted small">{r.label}</span>
            </div>
          </header>
          <div className="model-facts">
            <span>
              <b>{formatGB(need, false)}</b> VRAM needed
            </span>
            <span>{formatGB(m.size)} on disk</span>
            {m.parameterSize && <span>{m.parameterSize}</span>}
            {m.quantization && <span>{m.quantization}</span>}
          </div>
          <ModelBlurb info={info} fallback={`${m.family || 'Custom'} model${m.parameterSize ? ` with ${m.parameterSize} parameters` : ''}. Not in the Wicked Code catalog, so strengths are unknown.`} />
          <div className="muted small fit-detail">{r.detail}</div>
          <Notes name={m.name} initial={settings.modelNotes[m.name] || ''} />
          <footer>
            <button
              className={`btn btn-sm ${selected ? '' : 'btn-primary'}`}
              disabled={selected || r.stars === 0 || modelState?.busy}
              onClick={() => selectModel(id)}
            >
              {selected ? 'Active model' : 'Use this model'}
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => setConfirm({ kind: 'delete', name: m.name })}>
              <Icon name="trash" size={14} /> Delete
            </button>
          </footer>
        </article>
      )
  }

  function storeCard(m: CatalogModel) {
      const r = rateModel(m.vramGB, gpu)
      return (
        <article key={m.name} className={`model-card store ${m.featured ? 'featured' : ''}`}>
          <FavoriteButton on={isFav(m.name)} onToggle={() => toggleFavorite(m.name)} />
          <header>
            <div>
              <div className="model-card-title">
                {m.display} {m.featured && <span className="pill accent">Featured</span>}
              </div>
              <code className="model-card-tag">{m.name}</code>
            </div>
            <div className="model-card-rating" title={r.detail}>
              <Stars stars={r.stars} title={r.detail} />
              <span className="muted small">{r.label}</span>
            </div>
          </header>
          <div className="model-facts">
            <span>
              <b>{formatGB(m.vramGB, false)}</b> VRAM needed
            </span>
            <span>{formatGB(m.sizeGB, false)} download</span>
            {m.tags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </div>
          <ModelBlurb info={m} />
          <div className="muted small fit-detail">{r.detail}</div>
          <footer>
            <PullButton
              name={m.name}
              progress={pulls[m.name]}
              disabled={!ollamaRunning}
              onClick={() => setConfirm({ kind: 'download', name: m.name, sizeGB: m.sizeGB })}
            />
          </footer>
        </article>
      )
  }

  const gpuSummary = gpu
    ? gpu.totalMB > 0
      ? `${gpu.gpus.map((g) => g.name).join(' + ')} · ${(gpu.totalMB / 1024).toFixed(0)} GB VRAM · ${(gpu.systemRamMB / 1024).toFixed(0)} GB RAM`
      : `No GPU detected · ${(gpu.systemRamMB / 1024).toFixed(0)} GB RAM`
    : 'Detecting hardware…'

  return (
    <div className="settings-page wide">
      <h2>Local Model Management</h2>
      <div className="hw-summary">
        <Icon name="cpu" size={16} /> {gpuSummary}
        <span className="muted small"> · Ratings estimate how well each model will run on this machine.</span>
      </div>
      {!ollamaRunning && (
        <div className="callout warn">
          Ollama isn’t running at {settings.ollamaUrl}. Install it from{' '}
          <a href="https://ollama.com/download" target="_blank" rel="noreferrer">
            ollama.com/download
          </a>{' '}
          and start it to manage local models.
        </div>
      )}
      {error && <div className="callout error">{error}</div>}

      <h3 className="section-title">
        <span className="fav-title-star">★</span> Favorites <span className="count">{favCards.length}</span>
      </h3>
      {favCards.length ? (
        <div className="model-grid">{favCards.map((c) => c.node)}</div>
      ) : (
        <div className="fav-empty muted small">
          Click the <span className="fav-inline">☆</span> in the top-right corner of any model to pin it here.
        </div>
      )}

      <h3 className="section-title">
        Downloaded models <span className="count">{downloaded.length}</span>
      </h3>
      {ollamaRunning && !localModels.length && <div className="muted pad">No models downloaded yet. Pick one from the store below.</div>}
      {ollamaRunning && !!localModels.length && !downloaded.length && <div className="muted pad">All your downloaded models are in Favorites.</div>}
      <div className="model-grid">
        {downloaded.map((m) => installedCard(m))}
      </div>

      <h3 className="section-title store-title">
        Model store <span className="count">{store.length}</span>
      </h3>
      <div className="store-controls">
        <input className="input" placeholder="Search models…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="input narrow" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="fit">Best for my system</option>
          <option value="size">Smallest first</option>
          <option value="name">Name</option>
        </select>
      </div>
      <div className="tag-filter">
        {allTags.map((t) => (
          <button key={t} className={tag === t ? 'active' : ''} onClick={() => setTag(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="model-grid">
        {store.map((m) => storeCard(m))}
      </div>
      {!store.length && <div className="muted pad">No store models match.</div>}

      <section className="card custom-pull">
        <h3>Download another model</h3>
        <p className="muted small">
          Enter any tag from{' '}
          <a href="https://ollama.com/library" target="_blank" rel="noreferrer">
            ollama.com/library
          </a>{' '}
          (for example <code>qwen3.8:27b-q8_0</code>).
        </p>
        <div className="row">
          <input className="input" placeholder="model:tag" value={custom} onChange={(e) => setCustom(e.target.value)} />
          {pulls[custom.trim()] ? (
            <PullButton name={custom.trim()} progress={pulls[custom.trim()]} onClick={() => {}} />
          ) : (
            <button className="btn btn-primary" disabled={!custom.trim() || !ollamaRunning} onClick={() => setConfirm({ kind: 'download', name: custom.trim() })}>
              <Icon name="download" size={14} /> Download
            </button>
          )}
        </div>
        {Object.values(pulls)
          .filter((p) => !CATALOG.some((c) => c.name === p.name) && p.name !== custom.trim())
          .map((p) => (
            <div key={p.name} className="row">
              <code>{p.name}</code>
              <PullButton name={p.name} progress={p} onClick={() => {}} />
            </div>
          ))}
      </section>

      {confirm?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete model?"
          message={
            <>
              Are you sure you want to delete <b>{confirm.name}</b>? It will be removed from your machine and your notes for it will be erased.
            </>
          }
          danger
          onYes={doConfirm}
          onNo={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'download' && (
        <ConfirmDialog
          title="Download model?"
          message={
            <>
              Are you sure you want to download <b>{confirm.name}</b>
              {confirm.sizeGB ? <> ({formatGB(confirm.sizeGB, false)})</> : null}?
            </>
          }
          onYes={doConfirm}
          onNo={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

function FavoriteButton({ on, onToggle }: { on: boolean; onToggle(): void }) {
  return (
    <button
      className={`fav-btn ${on ? 'on' : ''}`}
      onClick={onToggle}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
      aria-label={on ? 'Remove from favorites' : 'Add to favorites'}
      aria-pressed={on}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
        <path
          d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.6l6-.9z"
          fill={on ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

function ModelBlurb({ info, fallback }: { info?: CatalogModel; fallback?: string }) {
  if (!info) return <p className="model-blurb muted">{fallback}</p>
  return (
    <div className="model-blurb">
      <p>
        <span className="plus">Strengths</span> {info.strengths}
      </p>
      <p>
        <span className="minus">Weaknesses</span> {info.weaknesses}
      </p>
    </div>
  )
}

function PullButton({ name, progress, onClick, disabled }: { name: string; progress?: PullProgress; onClick(): void; disabled?: boolean }) {
  if (!progress) {
    return (
      <button className="btn btn-sm btn-primary" disabled={disabled} onClick={onClick}>
        <Icon name="download" size={14} /> Download
      </button>
    )
  }
  if (progress.done) {
    return (
      <span className={`small ${progress.status === 'success' ? 'ok' : 'bad'}`}>
        {progress.status === 'success' ? 'Downloaded ✓' : progress.status === 'cancelled' ? 'Cancelled' : `Failed: ${progress.error}`}
      </span>
    )
  }
  const pct = progress.total ? Math.round(((progress.completed || 0) / progress.total) * 100) : 0
  return (
    <div className="pull-progress">
      <div className="pull-bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <span className="small muted">
        {progress.total ? `${pct}% · ${formatGB(progress.completed || 0)} / ${formatGB(progress.total)}` : progress.status}
      </span>
      <button className="btn btn-sm btn-ghost" onClick={() => api().models.cancelPull(name)} title="Cancel download">
        {progress.total ? <Icon name="x" size={14} /> : <Spinner />}
      </button>
    </div>
  )
}

function Notes({ name, initial }: { name: string; initial: string }) {
  const { setSettings } = useApp()
  const [text, setText] = useState(initial)
  const [saved, setSaved] = useState(true)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const save = async (v: string) => {
    clearTimeout(timer.current)
    await api().models.setNotes(name, v)
    setSettings((s) => ({ ...s, modelNotes: { ...s.modelNotes, [name]: v } }))
    setSaved(true)
  }

  return (
    <div className="notes">
      <label className="small muted">
        My notes {!saved && <span>· saving…</span>}
      </label>
      <textarea
        className="input"
        placeholder="Add your own notes about this model…"
        value={text}
        rows={2}
        onChange={(e) => {
          const v = e.target.value
          setText(v)
          setSaved(false)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => save(v), 700)
        }}
        onBlur={() => !saved && save(text)}
      />
    </div>
  )
}
