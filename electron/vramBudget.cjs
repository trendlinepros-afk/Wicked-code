// Keeps a VRAM safety buffer: if a model (plus what other apps already use) would push the GPU past
// "total VRAM − buffer", only part of the model's layers go on the GPU (Ollama `num_gpu`) and the rest
// run from system RAM. Maxed-out VRAM can freeze Windows; a little headroom prevents that.

const GB = 1024 ** 3

/** Read the numbers we need from Ollama's /api/show model_info. */
function modelShape(show) {
  const info = show?.model_info || {}
  const arch = info['general.architecture'] || ''
  const get = (k) => info[`${arch}.${k}`]
  const blocks = Number(get('block_count')) || 0
  const heads = Number(get('attention.head_count')) || 0
  const kvHeads = Number(get('attention.head_count_kv')) || heads
  const embed = Number(get('embedding_length')) || 0
  const keyLen = Number(get('attention.key_length')) || (heads ? embed / heads : 0)
  const valLen = Number(get('attention.value_length')) || keyLen
  return { arch, blocks, kvHeads, keyLen, valLen }
}

/**
 * Work out how many layers can go on the GPU.
 * @param {object} p
 * @param {number} p.fileBytes   model weights size (from /api/tags)
 * @param {object} p.show        /api/show response
 * @param {number} p.ctx         context length (tokens)
 * @param {number} p.totalMB     GPU VRAM
 * @param {number} p.otherUsedMB VRAM used by everything except Ollama models
 * @param {number} p.reserveGB   safety buffer to keep free
 * @returns {{ numGpu: number|null, blocks: number, needGB: number, budgetGB: number, gpuGB: number }}
 *   numGpu null = everything fits, no cap needed
 */
function planGpuLayers({ fileBytes, show, ctx, totalMB, otherUsedMB, reserveGB }) {
  const shape = modelShape(show)
  const weightsGB = fileBytes / GB
  // fp16 KV cache: keys + values for every layer and token.
  const kvGB = shape.blocks && shape.kvHeads ? (shape.blocks * shape.kvHeads * (shape.keyLen + shape.valLen) * 2 * ctx) / GB : 0.15 * (ctx / 8192)
  const overheadGB = 0.6 + 0.4 * (ctx / 32768) // compute graph / scratch buffers
  const needGB = weightsGB + kvGB + overheadGB
  const budgetGB = totalMB / 1024 - reserveGB - otherUsedMB / 1024
  if (!totalMB || !shape.blocks || needGB <= budgetGB) {
    return { numGpu: null, blocks: shape.blocks, needGB, budgetGB, gpuGB: Math.min(needGB, Math.max(budgetGB, 0)) }
  }
  // Output layer / embeddings (~5% of weights) and the graph stay on the GPU when any layer does.
  const perLayerGB = (weightsGB * 0.95 + kvGB) / shape.blocks
  const fixedGB = weightsGB * 0.05 + overheadGB
  const layers = Math.max(0, Math.min(shape.blocks - 1, Math.floor((budgetGB - fixedGB) / perLayerGB)))
  return { numGpu: layers, blocks: shape.blocks, needGB, budgetGB, gpuGB: layers ? fixedGB + layers * perLayerGB : 0 }
}

module.exports = { planGpuLayers, modelShape }
