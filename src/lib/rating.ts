import type { GpuStats } from './api'

export interface Rating {
  stars: number // 0 = won't run, 1 (poor) .. 5 (excellent)
  label: string
  detail: string
}

/** VRAM kept free as a safety margin (Settings → Model memory → VRAM safety buffer). */
export let VRAM_HEADROOM_GB = 1
export function setVramReserve(gb: number) {
  VRAM_HEADROOM_GB = Number.isFinite(gb) && gb >= 0 ? gb : 1
}

export interface Capacity {
  totalGB: number // GPU VRAM (0 = no GPU detected)
  otherUsedGB: number // VRAM used right now by everything except Ollama models
  freeGB: number // what a newly loaded model can use right now
  ramFreeGB: number // system RAM available for CPU offload
  unified: boolean // Apple Silicon (no separate VRAM, no offload)
}

/** What this machine can give a model *right now*, based on live GPU/RAM usage. */
export function capacity(gpu: GpuStats): Capacity {
  const totalGB = gpu.totalMB / 1024
  const otherUsedGB = (gpu.otherUsedMB ?? Math.max(0, gpu.usedMB - gpu.ollamaVramMB)) / 1024
  const freeGB = Math.max(0, totalGB - otherUsedGB - VRAM_HEADROOM_GB)
  const ramTotalGB = gpu.systemRamMB / 1024
  const ramUsedGB = (gpu.ramUsedMB ?? gpu.systemRamMB * 0.4) / 1024
  // Leave ~15% of RAM for the OS and other apps.
  const ramFreeGB = Math.max(0, ramTotalGB * 0.85 - ramUsedGB)
  return { totalGB, otherUsedGB, freeGB, ramFreeGB, unified: gpu.source === 'apple' }
}

const gb = (n: number) => `${n.toFixed(n < 100 ? 1 : 0)} GB`

/**
 * Estimate how well a model needing `needGB` will run on this machine right now.
 * Fully fitting in the currently *free* VRAM with headroom is best; spilling into system RAM
 * (CPU offload) works but is slow; not fitting in free VRAM + free RAM means it won't run.
 */
export function rateModel(needGB: number, gpu: GpuStats | null): Rating {
  if (!gpu) return { stars: 0, label: 'Unknown', detail: 'Detecting hardware…' }
  const c = capacity(gpu)
  const offload = c.unified ? 0 : c.ramFreeGB

  if (c.totalGB > 0) {
    const free = c.freeGB
    const busy = c.otherUsedGB >= 0.5 ? ` (${gb(c.otherUsedGB)} already in use by other apps)` : ''
    if (needGB <= free) {
      const ratio = needGB / Math.max(free, 0.1)
      if (ratio <= 0.6) return { stars: 5, label: 'Excellent', detail: `Fits easily in the ${gb(free)} of VRAM free right now` }
      if (ratio <= 0.85) return { stars: 4, label: 'Great', detail: `Fits in free VRAM (${gb(free)}) with room for longer context` }
      return { stars: 3, label: 'Good', detail: `Fits in free VRAM (${gb(free)}) but tight; keep context moderate` }
    }
    if (needGB <= free + offload) {
      const spill = needGB - free
      if (needGB <= free * 1.35 || spill <= 2)
        return { stars: 2, label: 'Slow', detail: `Needs ${gb(needGB)}, only ${gb(free)} VRAM free${busy} — ${gb(spill)} spills into RAM, expect slower replies` }
      return { stars: 1, label: 'Very slow', detail: `Needs ${gb(needGB)}, only ${gb(free)} VRAM free${busy} — mostly runs on CPU/RAM` }
    }
    return { stars: 0, label: "Won't run", detail: `Needs ~${gb(needGB)}; ${gb(free)} VRAM + ${gb(offload)} RAM free right now` }
  }

  // No GPU detected: CPU only.
  if (needGB <= offload) {
    if (needGB <= 6) return { stars: 2, label: 'CPU only', detail: 'No GPU detected — small models run OK on CPU' }
    return { stars: 1, label: 'CPU only', detail: 'No GPU detected — this will be very slow on CPU' }
  }
  return { stars: 0, label: "Won't run", detail: `Needs ~${gb(needGB)} but only ${gb(offload)} RAM free` }
}

/** "Best for you": guaranteed to run fully on the GPU with what's free right now. */
export function fitsNow(needGB: number, gpu: GpuStats | null): boolean {
  if (!gpu) return false
  const c = capacity(gpu)
  if (c.totalGB > 0) return needGB <= c.freeGB
  return needGB <= Math.min(6, c.ramFreeGB) // CPU-only machines: small models only
}
