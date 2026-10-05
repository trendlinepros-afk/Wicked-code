import { api, parseModelId, PROVIDER_LABELS, type Mode } from '../lib/api'
import { useApp } from '../lib/store'
import { catalogInfo, vramNeededGB } from '../lib/catalog'
import { capacity } from '../lib/rating'
import { Icon, Spinner } from './ui'

export function TopBar({
  mode,
  onMode,
}: {
  mode: Mode
  onMode(m: Mode): void
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">W</span>
        <span className="brand-name">
          wicked <b>code</b>
        </span>
      </div>
      <nav className="mode-tabs" role="tablist">
        <button role="tab" aria-selected={mode === 'chat'} className={mode === 'chat' ? 'active' : ''} onClick={() => onMode('chat')}>
          <Icon name="chat" /> Chat
        </button>
        <button role="tab" aria-selected={mode === 'code'} className={mode === 'code' ? 'active' : ''} onClick={() => onMode('code')}>
          <Icon name="code" /> Code
        </button>
      </nav>
      <div className="topbar-spacer" />
      <ModelControl />
      <VramMeter />
    </header>
  )
}

function ModelControl() {
  const { modelState, ollamaRunning, gpu, localModels, settings } = useApp()
  if (!modelState) return null
  const { provider, model } = parseModelId(modelState.model)
  const status = modelState.status
  const busy = status === 'loading' || status === 'unloading'

  let label = 'Load model'
  if (status === 'loaded') label = 'Unload model'
  if (status === 'loading') label = 'Loading…'
  if (status === 'unloading') label = 'Unloading…'

  const statusText =
    status === 'cloud'
      ? PROVIDER_LABELS[provider]
      : status === 'loaded'
        ? modelState.busy
          ? 'In use'
          : 'Loaded'
        : status === 'error'
          ? 'Error'
          : status === 'unloaded'
            ? 'Not loaded'
            : label

  // VRAM this model uses: measured from Ollama while loaded, otherwise the estimate for loading it.
  let vramText: string | null = null
  let tooBig: string | null = null
  if (modelState.local && model) {
    const live = gpu?.models?.find((m) => m.name === model || m.name === `${model}:latest`)
    if (live && live.vramMB > 0) {
      vramText = `${(live.vramMB / 1024).toFixed(1)} GB VRAM`
      if (live.totalMB - live.vramMB > 512) vramText += ` + ${((live.totalMB - live.vramMB) / 1024).toFixed(1)} GB RAM`
    } else {
      const installed = localModels.find((m) => m.name === model || m.name === `${model}:latest`)
      const need = catalogInfo(model) || installed ? vramNeededGB(model, settings.contextLength, installed) : null
      if (need) vramText = `~${need} GB VRAM`
      if (need && gpu && gpu.totalMB > 0) {
        const free = capacity(gpu).freeGB
        if (need > free) tooBig = `Only ${free.toFixed(1)} GB VRAM is free right now (other apps are using ${((gpu.otherUsedMB ?? 0) / 1024).toFixed(1)} GB). This model needs ~${need} GB, so part of it will run from system RAM and be slower.`
      }
    }
  }

  return (
    <div className={`model-control status-${status}`} title={modelState.error || ''}>
      <span className="status-dot" />
      <div className="model-control-text">
        <span className="model-control-name">{model || 'No model selected'}</span>
        <span className="model-control-status">
          {!modelState.local || ollamaRunning ? statusText : 'Ollama not running'}
          {vramText && (
            <span
              className={`model-control-vram ${tooBig ? 'too-big' : ''}`}
              title={tooBig ?? (status === 'loaded' ? 'Memory this model is using right now' : 'Estimated memory needed to load this model')}
            >
              {' · '}
              {vramText}
              {tooBig && ` · ${capacity(gpu!).freeGB.toFixed(1)} GB free ⚠`}
            </span>
          )}
          {status === 'loaded' && !modelState.busy && modelState.idleRemaining != null && ` · unloads in ${modelState.idleRemaining}s`}
        </span>
      </div>
      {modelState.local ? (
        <button
          className={status === 'loaded' ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
          disabled={busy || !modelState.model || !ollamaRunning || modelState.busy}
          title={status === 'loaded' ? 'Unload model (Ctrl+U force-unloads anytime, even mid-reply)' : 'Load model'}
          onClick={() => (status === 'loaded' ? api().model.unload() : api().model.load())}
        >
          {busy ? <Spinner /> : <Icon name="power" size={14} />}
          {label}
        </button>
      ) : (
        <button className="btn btn-sm" disabled title="Cloud models don't use local memory">
          <Icon name="power" size={14} /> Cloud model
        </button>
      )}
    </div>
  )
}

function VramMeter() {
  const { gpu } = useApp()
  if (!gpu) return null
  if (gpu.totalMB <= 0) {
    return (
      <div className="vram" title="No supported GPU detected (NVIDIA via nvidia-smi, AMD via rocm-smi, or Apple Silicon)">
        <div className="vram-label">
          <span>VRAM</span>
          <span>n/a</span>
        </div>
        <div className="vram-bar" />
      </div>
    )
  }
  const used = gpu.usedMB / 1024
  const total = gpu.totalMB / 1024
  const pct = Math.min(100, (gpu.usedMB / gpu.totalMB) * 100)
  const level = pct > 90 ? 'high' : pct > 70 ? 'mid' : 'low'
  const tip = [
    ...gpu.gpus.map((g) => `${g.name}: ${(g.usedMB / 1024).toFixed(1)} / ${(g.totalMB / 1024).toFixed(1)} GB`),
    `Ollama models: ${(gpu.ollamaVramMB / 1024).toFixed(1)} GB`,
    `Available: ${(total - used).toFixed(1)} GB`,
  ].join('\n')
  return (
    <div className="vram" title={tip}>
      <div className="vram-label">
        <span>VRAM</span>
        <span>
          <b>{used.toFixed(1)}</b> / {total.toFixed(1)} GB · {(total - used).toFixed(1)} free
        </span>
      </div>
      <div className="vram-bar">
        <div className={`vram-fill ${level}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
