import { api, parseModelId, PERMISSION_OPTIONS, PROVIDER_LABELS, type Mode, type PermissionControl } from '../lib/api'
import { useEffect, useRef, useState } from 'react'
import { useApp } from '../lib/store'
import { catalogInfo, vramNeededGB } from '../lib/catalog'
import { capacity } from '../lib/rating'
import { Icon, Spinner } from './ui'

export function TopBar({
  mode,
  onMode,
  permission,
}: {
  mode: Mode
  onMode(m: Mode): void
  /** The visible chat's permission control (null while Settings is open). */
  permission: PermissionControl | null
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
      <LessonsButton ctl={permission?.lessons ?? null} mode={permission?.mode ?? mode} />
      <PermissionMenu ctl={permission} />
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
          disabled={busy || !modelState.model || !ollamaRunning}
          title={status === 'loaded' ? 'Unload model (Ctrl+U force-unloads anytime, even mid-reply)' : 'Load model'}
          onClick={() =>
            status === 'loaded'
              ? // While a reply or chat-naming is running, unloading stops it first (same as Ctrl+U).
                modelState.busy
                ? api().model.forceUnload()
                : api().model.unload()
              : api().model.load()
          }
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

/** Per-chat permissions: how much the agent may do without asking, for the chat you're looking at. */
/** "Lessons Learned": the model reviews the visible chat and saves what it learned to the vault. */
function LessonsButton({ ctl, mode }: { ctl: PermissionControl['lessons'] | null; mode: Mode }) {
  const what = mode === 'code' ? 'code session' : 'chat'
  return (
    <button
      className="lessons-btn"
      disabled={!ctl || !ctl.canRun}
      onClick={() => ctl?.run()}
      title={
        ctl?.busy
          ? 'Reviewing this conversation…'
          : ctl?.canRun
            ? `Post what the model learned in this ${what} (what failed and what finally worked) and save each lesson to your vault under Lessons Learned`
            : `Available once this ${what} has messages and no reply is running`
      }
    >
      {ctl?.busy ? <Spinner /> : <Icon name="sparkle" size={15} />}
      Lessons Learned
    </button>
  )
}

function PermissionMenu({ ctl }: { ctl: PermissionControl | null }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
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
  const current = PERMISSION_OPTIONS.find((o) => o.value === ctl?.value) ?? PERMISSION_OPTIONS[0]
  return (
    <div className="perm" ref={ref}>
      <button
        className={`perm-btn level-${current.value}`}
        disabled={!ctl}
        onClick={() => setOpen((o) => !o)}
        title={ctl ? `Permissions for this ${ctl.mode === 'code' ? 'code session' : 'chat'}: ${current.label}` : 'Open a chat or code session to set its permissions'}
      >
        <Icon name="shield" size={15} />
        <span className="perm-text">
          <span className="perm-label">Permissions</span>
          <span className="perm-value">{current.short}</span>
        </span>
        <Icon name="chevron" size={14} />
      </button>
      {open && ctl && (
        <div className="perm-menu" role="menu">
          <div className="perm-head">This {ctl.mode === 'code' ? 'code session' : 'chat'} only</div>
          {PERMISSION_OPTIONS.map((o) => (
            <button
              key={o.value}
              role="menuitemradio"
              aria-checked={o.value === ctl.value}
              className={`perm-item level-${o.value} ${o.value === ctl.value ? 'selected' : ''}`}
              onClick={() => {
                ctl.set(o.value)
                setOpen(false)
              }}
            >
              <span className="perm-dot" />
              <span className="perm-item-text">
                <b>{o.label}</b>
                <span>{o.detail}</span>
              </span>
              {o.value === ctl.value && <Icon name="check" size={14} />}
            </button>
          ))}
          <div className="perm-foot">New chats start with the default from Settings → General.</div>
        </div>
      )}
    </div>
  )
}
