// Thin client for the Ollama REST API (https://github.com/ollama/ollama/blob/main/docs/api.md).

/** Read a fetch Response body as newline-delimited JSON, calling onObj for each object. */
async function readNdjson(res, onObj) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onObj(JSON.parse(line))
    }
  }
  if (buf.trim()) onObj(JSON.parse(buf))
}

async function errorText(res) {
  const t = await res.text().catch(() => '')
  try {
    return JSON.parse(t).error || t
  } catch {
    return t || res.statusText
  }
}

class Ollama {
  constructor(getBaseUrl) {
    this.getBaseUrl = getBaseUrl
  }

  url(p) {
    return this.getBaseUrl().replace(/\/+$/, '') + p
  }

  async request(p, opts = {}) {
    const res = await fetch(this.url(p), {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    })
    if (!res.ok) throw new Error(`Ollama ${p}: ${await errorText(res)}`)
    return res
  }

  async isRunning() {
    try {
      const res = await fetch(this.url('/api/version'), { signal: AbortSignal.timeout(1500) })
      return res.ok
    } catch {
      return false
    }
  }

  /** Installed models. */
  async list() {
    const res = await this.request('/api/tags')
    const j = await res.json()
    return (j.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at,
      parameterSize: m.details?.parameter_size || '',
      quantization: m.details?.quantization_level || '',
      family: m.details?.family || '',
    }))
  }

  /** Models currently loaded in memory. */
  async ps() {
    const res = await this.request('/api/ps', { signal: AbortSignal.timeout(2000) })
    const j = await res.json()
    return (j.models || []).map((m) => ({ name: m.name, size: m.size, sizeVram: m.size_vram || 0 }))
  }

  /** Load a model into memory (empty generate request). */
  async load(model, keepAlive = '10m', options) {
    await this.request('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model, keep_alive: keepAlive, options }),
    })
  }

  /** Unload a model from memory. */
  async unload(model) {
    await this.request('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model, keep_alive: 0 }),
    })
  }

  async delete(model) {
    await this.request('/api/delete', { method: 'DELETE', body: JSON.stringify({ model }) })
  }

  /** Pull a model, reporting {status, completed, total} progress. */
  async pull(model, onProgress, signal) {
    const res = await this.request('/api/pull', {
      method: 'POST',
      body: JSON.stringify({ model, stream: true }),
      signal,
    })
    await readNdjson(res, (o) => {
      if (o.error) throw new Error(o.error)
      onProgress(o)
    })
  }

  /** Streaming chat. Returns the raw response for the caller to parse. */
  async chat(body, signal) {
    return this.request('/api/chat', { method: 'POST', body: JSON.stringify(body), signal })
  }
}

module.exports = { Ollama, readNdjson }
