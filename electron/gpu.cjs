// Reports GPU memory (VRAM) total/used. Tries NVIDIA, then AMD, then Apple unified memory.
const { execFile } = require('child_process')
const os = require('os')

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2500, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout))
    })
  })
}

/** Parse `nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits`. */
function parseNvidia(out) {
  const gpus = []
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split(',').map((s) => s.trim())
    if (parts.length < 3) continue
    const total = Number(parts[1])
    const used = Number(parts[2])
    if (!Number.isFinite(total) || !Number.isFinite(used)) continue
    gpus.push({ name: parts[0], totalMB: total, usedMB: used })
  }
  return gpus
}

/** Parse `rocm-smi --showmeminfo vram --showproductname --json`. */
function parseRocm(out) {
  let j
  try {
    j = JSON.parse(out)
  } catch {
    return []
  }
  const gpus = []
  for (const [card, info] of Object.entries(j)) {
    const total = Number(info['VRAM Total Memory (B)'])
    const used = Number(info['VRAM Total Used Memory (B)'])
    if (!Number.isFinite(total)) continue
    gpus.push({
      name: info['Card series'] || info['Card Series'] || card,
      totalMB: Math.round(total / 1048576),
      usedMB: Math.round((used || 0) / 1048576),
    })
  }
  return gpus
}

let cachedSource = null // remember which probe worked so we don't spawn failing tools every poll

/**
 * @param {() => Promise<Array<{sizeVram:number}>>} getLoaded  Ollama /api/ps
 */
async function getGpuStats(getLoaded) {
  const systemRamMB = Math.round(os.totalmem() / 1048576)
  let gpus = []
  let source = 'none'

  if (cachedSource === null || cachedSource === 'nvidia') {
    const out = await run('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.used',
      '--format=csv,noheader,nounits',
    ])
    if (out) gpus = parseNvidia(out)
    if (gpus.length) source = 'nvidia'
  }
  if (!gpus.length && (cachedSource === null || cachedSource === 'amd')) {
    const out = await run('rocm-smi', ['--showmeminfo', 'vram', '--showproductname', '--json'])
    if (out) gpus = parseRocm(out)
    if (gpus.length) source = 'amd'
  }

  let loaded = []
  try {
    loaded = await getLoaded()
  } catch {
    /* ollama not running */
  }
  const ollamaVramMB = Math.round(loaded.reduce((a, m) => a + (m.sizeVram || 0), 0) / 1048576)

  if (!gpus.length && process.platform === 'darwin' && process.arch === 'arm64') {
    // Apple Silicon: unified memory; macOS lets the GPU use roughly 75% of RAM by default.
    source = 'apple'
    gpus = [{ name: 'Apple Silicon (unified)', totalMB: Math.round(systemRamMB * 0.75), usedMB: ollamaVramMB }]
  }
  if (cachedSource === null && source !== 'none') cachedSource = source

  const totalMB = gpus.reduce((a, g) => a + g.totalMB, 0)
  const usedMB = gpus.reduce((a, g) => a + g.usedMB, 0)
  // Per-model memory of what Ollama currently has loaded (VRAM part and total incl. any CPU offload).
  const models = loaded.map((m) => ({ name: m.name, vramMB: Math.round((m.sizeVram || 0) / 1048576), totalMB: Math.round((m.size || 0) / 1048576) }))
  return { source, gpus, totalMB, usedMB, ollamaVramMB, systemRamMB, models }
}

module.exports = { getGpuStats, parseNvidia, parseRocm }
