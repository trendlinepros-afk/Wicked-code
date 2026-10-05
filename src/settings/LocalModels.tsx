import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, type LocalModel, type PullProgress } from '../lib/api'
import { CATALOG, catalogInfo, estimateVramGB, formatReleased, type CatalogModel } from '../lib/catalog'
import { rateModel } from '../lib/rating'
import { useApp } from '../lib/store'
import { ModelFilterBar } from './ModelFilterBar'
import { comparator, inferTags, loadFilter, matches, saveFilter, type ModelFacts, type ModelFilter } from '../lib/modelFilter'
import { ConfirmDialog, Icon, Spinner, Stars, formatGB } from '../components/ui'

type Confirm = { kind: 'delete'; name: string } | { kind: 'download'; name: string; sizeGB?: number } | null

const isInstalled = (models: LocalModel[], name: string) => models.some((m) => m.name === name || m.name === `${name}:latest`)

export function LocalModels() {
  const { localModels, ollamaRunning, gpu, pulls, startPull, refreshModels, settings, setSettings, selectModel, modelState } = useApp()
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [filter, setFilterState] = useState<ModelFilter>(loadFilter)
  const setFilter = (f: ModelFilter) => {
    setFilterState(f)
    saveFilter(f)
  }
  const [custom, setCustom] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    refreshModels()
  }, [refreshModels])

  const favorites = settings.favoriteModels ?? []
  const isFav = (name: string) => favorites.some((f) => f === name || f === `${name}:latest` || `${f}:latest` === name)

  const toggleFavorite = async (name: string) => {
    const next = isFav(name) ? favorites.filter((f) => f !== name && f !== `${name}:latest` && `${f}:latest` !== name) : [...favorites, name]
    setSettings((s) => ({ ...s, favoriteModels: next })) // instant feedback
    setSettings(await api().settings.set('favoriteModels', next))
  }

  // ----- facts used for filtering/sorting -----
  const gpuVramGB = gpu && gpu.totalMB > 0 ? gpu.totalMB / 1024 : 0
  const installedFacts = (m: LocalModel): ModelFacts => {
    const info = catalogInfo(m.name)
    const vramGB = info?.vramGB ?? estimateVramGB(m.size)
    return {
      name: m.name,
      display: info?.display ?? m.name,
      vramGB,
      sizeGB: m.size / 1024 ** 3,
      stars: rateModel(vramGB, gpu).stars,
      tags: info?.tags ?? inferTags(m.name, m.family, vramGB),
      text: `${m.family} ${m.parameterSize} ${info?.strengths ?? ''} ${settings.modelNotes[m.name] ?? ''}`,
      released: info?.released,
    }
  }
  const storeFacts = (m: CatalogModel): ModelFacts => ({
    name: m.name,
    display: m.display,
    vramGB: m.vramGB,
    sizeGB: m.sizeGB,
    stars: rateModel(m.vramGB, gpu).stars,
    tags: m.tags,
    text: `${m.strengths} ${m.weaknesses}`,
    released: m.released,
  })
  const cmp = comparator(filter.sort)
  type Entry = { facts: ModelFacts; installed: boolean; node: () => ReactNode; order: number }
  const finish = (list: Entry[]) => {
    const out = list.filter((e) => matches(filter, e.facts, gpuVramGB))
    return cmp ? out.sort((a, b) => cmp(a.facts, b.facts)) : out.sort((a, b) => a.order - b.order)
  }
  const showDownloaded = filter.source !== 'store'
  const showStore = filter.source !== 'downloaded'

  // Favorites hold installed models and/or store models, in the order they were starred.
  const favOrder = (name: string) => favorites.findIndex((f) => f === name || f === `${name}:latest` || `${f}:latest` === name)
  const favAll: Entry[] = [
    ...localModels.filter((m) => isFav(m.name)).map((m) => ({ facts: installedFacts(m), installed: true, node: () => installedCard(m), order: favOrder(m.name) })),
    ...CATALOG.filter((m) => isFav(m.name) && !isInstalled(localModels, m.name)).map((m) => ({
      facts: storeFacts(m),
      installed: false,
      node: () => storeCard(m),
      order: favOrder(m.name),
    })),
  ]
  const favShown = finish(favAll.filter((e) => (e.installed ? showDownloaded : showStore)))

  // Favorites are copies: starred models also stay in their normal section.
  const downloadedAll: Entry[] = localModels.map((m, i) => ({ facts: installedFacts(m), installed: true, node: () => installedCard(m), order: i }))
  const downloadedShown = showDownloaded ? finish(downloadedAll) : []

  // Store default order: featured first, then best fit for this machine.
  const storeAll: Entry[] = CATALOG.filter((m) => !isInstalled(localModels, m.name))
    .map((m) => ({ facts: storeFacts(m), installed: false, node: () => storeCard(m), order: 0, featured: !!m.featured }))
    .sort((a, b) => Number(b.featured) - Number(a.featured) || b.facts.stars - a.facts.stars || b.facts.vramGB - a.facts.vramGB)
    .map((e, i) => ({ ...e, order: i }))
  const storeShown = showStore ? finish(storeAll) : []

  // Count distinct models (favorites are duplicates of cards below).
  const totalModels = downloadedAll.length + storeAll.length
  const shownModels = downloadedShown.length + storeShown.length
  const filtering = shownModels < totalModels
  const allTags = useMemo(
    () => Array.from(new Set([...CATALOG.flatMap((m) => m.tags), ...localModels.flatMap((m) => installedFacts(m).tags)])).sort(),
    [localModels],
  )
  const maxVramScale = Math.max(32, Math.ceil(Math.max(...CATALOG.map((m) => m.vramGB), ...downloadedAll.map((e) => e.facts.vramGB), 0) / 8) * 8)

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
            {info?.released && <ReleasedChip released={info.released} />}
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
            <ReleasedChip released={m.released} />
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

      <ModelFilterBar
        filter={filter}
        onChange={setFilter}
        tags={allTags}
        gpuVramGB={gpuVramGB}
        maxVramScale={maxVramScale}
        shown={shownModels}
        total={totalModels}
      />

      <h3 className="section-title">
        <span className="fav-title-star">★</span> Favorites <span className="count">{favShown.length}</span>
      </h3>
      {favShown.length ? (
        <div className="model-grid">{favShown.map((e) => e.node())}</div>
      ) : favAll.length ? (
        <div className="fav-empty muted small">No favorites match your filters.</div>
      ) : (
        <div className="fav-empty muted small">
          Click the <span className="fav-inline">☆</span> in the top-right corner of any model to pin it here.
        </div>
      )}

      {showDownloaded && (
        <>
          <h3 className="section-title">
            Downloaded models <span className="count">{downloadedShown.length}</span>
          </h3>
          {ollamaRunning && !localModels.length && <div className="muted pad">No models downloaded yet. Pick one from the store below.</div>}
          {!!downloadedAll.length && !downloadedShown.length && <div className="muted pad">No downloaded models match your filters.</div>}
        </>
      )}
      <div className="model-grid">
        {downloadedShown.map((e) => e.node())}
      </div>

      {showStore && (
        <>
          <h3 className="section-title store-title">
            Model store <span className="count">{storeShown.length}</span>
          </h3>
          <div className="model-grid">{storeShown.map((e) => e.node())}</div>
          {!storeShown.length && <div className="muted pad">{filtering ? 'No store models match your filters.' : 'You have every catalog model.'}</div>}
        </>
      )}

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

function ReleasedChip({ released }: { released: string }) {
  return (
    <span className="released" title={`Released ${formatReleased(released)}`}>
      <Icon name="calendar" size={12} /> {formatReleased(released)}
    </span>
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
  const editing = useRef(false)

  // The same model can be shown twice (Favorites + its section): pick up edits made in the other copy.
  useEffect(() => {
    if (!editing.current) setText(initial)
  }, [initial])

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
        onFocus={() => (editing.current = true)}
        onBlur={() => {
          editing.current = false
          if (!saved) save(text)
        }}
      />
    </div>
  )
}
