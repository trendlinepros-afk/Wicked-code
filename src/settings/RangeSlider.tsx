// Two-handle range slider for picking a VRAM range (e.g. 5–10 GB).
// Uses a curved scale so small sizes get most of the track: the left half covers ~0–18 GB.

const STEPS = 1000

export function toGB(pos: number, max: number): number {
  const gb = max * Math.pow(pos / STEPS, 2)
  return gb < 10 ? Math.round(gb * 2) / 2 : Math.round(gb)
}

export function toPos(gb: number, max: number): number {
  return Math.round(Math.sqrt(Math.min(Math.max(gb, 0), max) / max) * STEPS)
}

const fmt = (gb: number) => `${gb % 1 ? gb.toFixed(1) : gb} GB`

export function RangeSlider({
  min,
  max,
  low,
  high,
  marker,
  onChange,
}: {
  min: number
  max: number
  /** Current range; null ends mean "no limit". */
  low: number | null
  high: number | null
  marker?: { gb: number; label: string }
  onChange(low: number | null, high: number | null): void
}) {
  const lo = toPos(low ?? min, max)
  const hi = toPos(high ?? max, max)
  const minGap = 10 // keep the handles from crossing

  const setLow = (pos: number) => {
    const p = Math.min(pos, hi - minGap)
    const gb = toGB(p, max)
    onChange(gb <= min ? null : gb, high)
  }
  const setHigh = (pos: number) => {
    const p = Math.max(pos, lo + minGap)
    const gb = toGB(p, max)
    onChange(low, gb >= max ? null : gb)
  }

  return (
    <div className="rs">
      <div className="rs-track">
        <div className="rs-fill" style={{ left: `${(lo / STEPS) * 100}%`, right: `${100 - (hi / STEPS) * 100}%` }} />
        {marker && marker.gb > 0 && marker.gb < max && (
          <div className="rs-marker" style={{ left: `${(toPos(marker.gb, max) / STEPS) * 100}%` }} title={marker.label}>
            <span>{marker.label}</span>
          </div>
        )}
        <input
          type="range"
          min={0}
          max={STEPS}
          value={lo}
          aria-label="Minimum VRAM"
          aria-valuetext={fmt(low ?? min)}
          onChange={(e) => setLow(Number(e.target.value))}
          style={{ zIndex: lo > STEPS - 50 ? 4 : 3 }}
        />
        <input
          type="range"
          min={0}
          max={STEPS}
          value={hi}
          aria-label="Maximum VRAM"
          aria-valuetext={high == null ? 'No limit' : fmt(high)}
          onChange={(e) => setHigh(Number(e.target.value))}
          style={{ zIndex: 3 }}
        />
      </div>
      <div className="rs-scale">
        {[0, 4, 8, 16, 32, max].map((gb) => (
          <span key={gb} style={{ left: `${(toPos(gb, max) / STEPS) * 100}%` }}>
            {gb}
          </span>
        ))}
      </div>
    </div>
  )
}

export { fmt as formatGBRange }
