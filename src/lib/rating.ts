import type { GpuStats } from './api'

export interface Rating {
  stars: number // 0 = won't run, 1 (poor) .. 5 (excellent)
  label: string
  detail: string
}

/**
 * Estimate how well a model needing `needGB` of memory will run on this machine.
 * Fully fitting in VRAM with headroom is best; spilling into system RAM (CPU offload)
 * works but is slow; not fitting in VRAM + RAM means it won't run.
 */
export function rateModel(needGB: number, gpu: GpuStats | null): Rating {
  if (!gpu) return { stars: 0, label: 'Unknown', detail: 'Detecting hardware…' }
  const vram = gpu.totalMB / 1024
  const ram = gpu.systemRamMB / 1024
  const unified = gpu.source === 'apple'
  // Memory available for CPU offload (leave room for the OS and other apps).
  const offloadRam = unified ? 0 : Math.max(0, ram * 0.6)

  if (vram > 0) {
    const ratio = needGB / vram
    if (ratio <= 0.6) return { stars: 5, label: 'Excellent', detail: `Fits easily in ${vram.toFixed(0)} GB of VRAM` }
    if (ratio <= 0.8) return { stars: 4, label: 'Great', detail: `Fits in VRAM with room for longer context` }
    if (ratio <= 0.97) return { stars: 3, label: 'Good', detail: `Fits in VRAM but tight; keep context moderate` }
    if (needGB <= vram + offloadRam) {
      if (needGB <= vram * 1.35) return { stars: 2, label: 'Slow', detail: 'Partly offloaded to system RAM — expect slower replies' }
      return { stars: 1, label: 'Very slow', detail: 'Mostly runs on CPU/RAM — usable but very slow' }
    }
    return { stars: 0, label: "Won't run", detail: `Needs ~${needGB} GB; you have ${vram.toFixed(0)} GB VRAM + ${ram.toFixed(0)} GB RAM` }
  }

  // No GPU detected: CPU only.
  if (needGB <= offloadRam) {
    if (needGB <= 6) return { stars: 2, label: 'CPU only', detail: 'No GPU detected — small models run OK on CPU' }
    return { stars: 1, label: 'CPU only', detail: 'No GPU detected — this will be very slow on CPU' }
  }
  return { stars: 0, label: "Won't run", detail: `Needs ~${needGB} GB but only ${ram.toFixed(0)} GB RAM` }
}
