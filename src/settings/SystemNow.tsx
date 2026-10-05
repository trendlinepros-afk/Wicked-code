import { useApp } from '../lib/store'
import { VRAM_HEADROOM_GB, capacity } from '../lib/rating'
import { Icon } from '../components/ui'

const gb = (mb: number) => (mb / 1024).toFixed(1)

/** Live hardware snapshot (like Task Manager): what's in use right now and what a model can still use. */
export function SystemNow() {
  const { gpu } = useApp()
  if (!gpu) return <div className="sysnow muted small">Detecting hardware…</div>
  const c = capacity(gpu)
  const main = gpu.gpus[0]
  const otherMB = gpu.otherUsedMB ?? Math.max(0, gpu.usedMB - gpu.ollamaVramMB)
  const pct = (mb: number) => `${Math.min(100, (mb / Math.max(gpu.totalMB, 1)) * 100)}%`
  const ramUsed = gpu.ramUsedMB ?? 0

  return (
    <section className="sysnow">
      <div className="sysnow-head">
        <Icon name="cpu" size={16} />
        <b>{gpu.totalMB > 0 ? gpu.gpus.map((g) => g.name).join(' + ') : 'No GPU detected (CPU only)'}</b>
        <span className="muted small">· live, updates every 2 s · ratings use what’s free right now</span>
      </div>
      {gpu.totalMB > 0 && (
        <div className="sysnow-vram">
          <div className="sysnow-bar" title={`Other apps ${gb(otherMB)} GB · Ollama models ${gb(gpu.ollamaVramMB)} GB · free ${gb(gpu.totalMB - gpu.usedMB)} GB`}>
            <div className="seg other" style={{ width: pct(otherMB) }} />
            <div className="seg ollama" style={{ width: pct(gpu.ollamaVramMB) }} />
          </div>
          <div className="sysnow-legend small">
            <span>
              <i className="dot other" /> Other apps <b>{gb(otherMB)} GB</b>
            </span>
            <span>
              <i className="dot ollama" /> Loaded models <b>{gb(gpu.ollamaVramMB)} GB</b>
            </span>
            <span>
              <i className="dot free" /> Total <b>{gb(gpu.totalMB)} GB</b>
            </span>
          </div>
        </div>
      )}
      <div className="sysnow-stats">
        <div className="stat highlight" title={`Total VRAM minus what other apps use, minus ${VRAM_HEADROOM_GB} GB safety margin`}>
          <span>Free for a model now</span>
          <b>{gpu.totalMB > 0 ? `${c.freeGB.toFixed(1)} GB` : '—'}</b>
        </div>
        <div className="stat">
          <span>System RAM</span>
          <b>
            {gb(ramUsed)} / {gb(gpu.systemRamMB)} GB
          </b>
        </div>
        <div className="stat">
          <span>CPU</span>
          <b>{gpu.cpuPercent != null ? `${gpu.cpuPercent}%` : '…'}</b>
        </div>
        {main?.utilization != null && (
          <div className="stat">
            <span>GPU load</span>
            <b>
              {main.utilization}%{main.temperatureC != null ? ` · ${main.temperatureC} °C` : ''}
            </b>
          </div>
        )}
      </div>
    </section>
  )
}
