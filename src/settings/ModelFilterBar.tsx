import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/ui'
import { RangeSlider, formatGBRange } from './RangeSlider'
import { DEFAULT_FILTER, SORT_LABELS, activeCount, type ModelFilter, type SortKey, type Source } from '../lib/modelFilter'

const RELEASE_OPTIONS = [
  { v: null, label: 'Any time' },
  { v: 3, label: 'Last 3 months' },
  { v: 6, label: 'Last 6 months' },
  { v: 12, label: 'Last year' },
  { v: 24, label: 'Last 2 years' },
]

const VRAM_PRESETS: { label: string; min: number | null; max: number | null }[] = [
  { label: 'Tiny ≤4 GB', min: null, max: 4 },
  { label: 'Small 4–8 GB', min: 4, max: 8 },
  { label: 'Medium 8–16 GB', min: 8, max: 16 },
  { label: 'Large 16–32 GB', min: 16, max: 32 },
  { label: 'Huge 32 GB+', min: 32, max: null },
]

/** "5–10 GB", "≤ 8 GB", "≥ 16 GB" or "Any". */
function vramRangeLabel(lo: number | null, hi: number | null): string {
  if (lo == null && hi == null) return 'Any'
  if (lo == null) return `≤ ${formatGBRange(hi!)}`
  if (hi == null) return `≥ ${formatGBRange(lo)}`
  return `${formatGBRange(lo).replace(' GB', '')}–${formatGBRange(hi)}`
}

const STAR_OPTIONS = [
  { v: 0, label: 'Any' },
  { v: 2, label: '2★+' },
  { v: 3, label: '3★+' },
  { v: 4, label: '4★+' },
  { v: 5, label: '5★' },
]

/** Search box + "Filter" dropdown + removable chips for active filters. */
export function ModelFilterBar({
  filter,
  onChange,
  tags,
  gpuVramGB,
  maxVramScale,
  shown,
  total,
}: {
  filter: ModelFilter
  onChange(f: ModelFilter): void
  tags: string[]
  gpuVramGB: number
  maxVramScale: number
  shown: number
  total: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const set = (patch: Partial<ModelFilter>) => onChange({ ...filter, ...patch })
  const count = activeCount(filter)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggleTag = (t: string) => set({ tags: filter.tags.includes(t) ? filter.tags.filter((x) => x !== t) : [...filter.tags, t] })

  // Chips for every active filter, each removable on its own.
  const chips: { key: string; label: string; clear(): void }[] = []
  if (filter.sort !== 'recommended') chips.push({ key: 'sort', label: `Sort: ${SORT_LABELS[filter.sort]}`, clear: () => set({ sort: 'recommended' }) })
  if (filter.source !== 'all') chips.push({ key: 'src', label: filter.source === 'downloaded' ? 'Downloaded only' : 'Store only', clear: () => set({ source: 'all' }) })
  if (filter.minVramGB != null || filter.maxVramGB != null) {
    chips.push({ key: 'vram', label: `${vramRangeLabel(filter.minVramGB, filter.maxVramGB)} VRAM`, clear: () => set({ minVramGB: null, maxVramGB: null }) })
  }
  if (filter.fitsOnly) chips.push({ key: 'fits', label: `Fits my GPU (${gpuVramGB.toFixed(0)} GB)`, clear: () => set({ fitsOnly: false }) })
  if (filter.minStars > 0) chips.push({ key: 'stars', label: `${filter.minStars}★${filter.minStars < 5 ? '+' : ''} rating`, clear: () => set({ minStars: 0 }) })
  if (filter.hideWontRun) chips.push({ key: 'wont', label: 'Hide won’t run', clear: () => set({ hideWontRun: false }) })
  if (filter.releasedWithinMonths != null) {
    const o = RELEASE_OPTIONS.find((x) => x.v === filter.releasedWithinMonths)
    chips.push({ key: 'rel', label: `Released: ${o?.label.toLowerCase() ?? `last ${filter.releasedWithinMonths} months`}`, clear: () => set({ releasedWithinMonths: null }) })
  }
  for (const t of filter.tags) chips.push({ key: 't-' + t, label: t, clear: () => toggleTag(t) })


  return (
    <div className="mf">
      <div className="mf-row">
        <div className="mf-search">
          <Icon name="search" size={15} />
          <input placeholder="Search all models…" value={filter.query} onChange={(e) => set({ query: e.target.value })} />
          {filter.query && (
            <button onClick={() => set({ query: '' })} title="Clear search">
              <Icon name="x" size={13} />
            </button>
          )}
        </div>
        <div className="mf-dropdown" ref={ref}>
          <button className={`btn mf-btn ${count ? 'active' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Icon name="filter" size={15} /> Filter
            {count > 0 && <span className="mf-badge">{count}</span>}
            <Icon name="chevron" size={14} />
          </button>
          {open && (
            <div className="mf-panel" role="dialog" aria-label="Filter models">
              <div className="mf-group">
                <label>Sort by</label>
                <div className="mf-sort">
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                    <button key={k} className={filter.sort === k ? 'active' : ''} onClick={() => set({ sort: k })}>
                      {SORT_LABELS[k]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mf-group">
                <label>
                  VRAM range <span className="mf-value">{vramRangeLabel(filter.minVramGB, filter.maxVramGB)}</span>
                </label>
                <RangeSlider
                  min={0}
                  max={maxVramScale}
                  low={filter.minVramGB}
                  high={filter.maxVramGB}
                  marker={gpuVramGB > 0 ? { gb: gpuVramGB, label: `Your GPU ${gpuVramGB.toFixed(0)} GB` } : undefined}
                  onChange={(lo, hi) => set({ minVramGB: lo, maxVramGB: hi })}
                />
                <div className="mf-presets">
                  {VRAM_PRESETS.map((p) => {
                    const active = filter.minVramGB === p.min && filter.maxVramGB === p.max
                    return (
                      <button
                        key={p.label}
                        className={active ? 'active' : ''}
                        onClick={() => set(active ? { minVramGB: null, maxVramGB: null } : { minVramGB: p.min, maxVramGB: p.max })}
                      >
                        {p.label}
                      </button>
                    )
                  })}
                </div>
                {gpuVramGB > 0 && (
                  <label className="check">
                    <input type="checkbox" checked={filter.fitsOnly} onChange={(e) => set({ fitsOnly: e.target.checked })} />
                    Only models that fit fully in my GPU ({gpuVramGB.toFixed(0)} GB)
                  </label>
                )}
              </div>

              <div className="mf-group">
                <label>Minimum rating for my system</label>
                <div className="mf-presets">
                  {STAR_OPTIONS.map((o) => (
                    <button key={o.v} className={filter.minStars === o.v ? 'active' : ''} onClick={() => set({ minStars: o.v })}>
                      {o.label}
                    </button>
                  ))}
                </div>
                <label className="check">
                  <input type="checkbox" checked={filter.hideWontRun} onChange={(e) => set({ hideWontRun: e.target.checked })} />
                  Hide models that won’t run on this machine
                </label>
              </div>

              <div className="mf-group">
                <label>Released</label>
                <div className="mf-presets">
                  {RELEASE_OPTIONS.map((o) => (
                    <button key={o.label} className={filter.releasedWithinMonths === o.v ? 'active' : ''} onClick={() => set({ releasedWithinMonths: o.v })}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mf-group">
                <label>Good at</label>
                <div className="mf-presets">
                  {tags.map((t) => (
                    <button key={t} className={filter.tags.includes(t) ? 'active' : ''} onClick={() => toggleTag(t)}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mf-group">
                <label>Show</label>
                <div className="mf-presets">
                  {(
                    [
                      ['all', 'Everything'],
                      ['downloaded', 'Downloaded only'],
                      ['store', 'Store only'],
                    ] as [Source, string][]
                  ).map(([v, label]) => (
                    <button key={v} className={filter.source === v ? 'active' : ''} onClick={() => set({ source: v })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mf-foot">
                <button className="btn btn-ghost btn-sm" disabled={!count} onClick={() => onChange({ ...DEFAULT_FILTER, query: filter.query })}>
                  Reset filters
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setOpen(false)}>
                  Show {shown} model{shown === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {(chips.length > 0 || filter.query) && (
        <div className="mf-chips">
          <span className="muted small">
            Showing {shown} of {total}
          </span>
          {chips.map((c) => (
            <button key={c.key} className="mf-chip" onClick={c.clear} title="Remove filter">
              {c.label} <Icon name="x" size={11} />
            </button>
          ))}
          {chips.length > 1 && (
            <button className="link-btn small" onClick={() => onChange({ ...DEFAULT_FILTER, query: filter.query })}>
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  )
}
