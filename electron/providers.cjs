// Streaming chat (with tool calling) for Ollama, OpenAI-compatible APIs (Gemini, DeepSeek, Grok)
// and Anthropic. All providers share one internal message format:
//   { role: 'system'|'user'|'assistant'|'tool', content: string,
//     toolCalls?: [{ id, name, args }], toolCallId?: string, toolName?: string }
const { readNdjson } = require('./ollama.cjs')

const OPENAI_COMPAT = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  deepseek: 'https://api.deepseek.com/v1',
  grok: 'https://api.x.ai/v1',
}

const FALLBACK_MODELS = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  grok: ['grok-4', 'grok-3-mini'],
}

const PROVIDER_LABELS = {
  ollama: 'Local (Ollama)',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  grok: 'xAI Grok',
}

let callCounter = 0
const newCallId = () => `call_${Date.now().toString(36)}_${(callCounter++).toString(36)}`

async function errorText(res) {
  const t = await res.text().catch(() => '')
  try {
    const j = JSON.parse(t)
    return j.error?.message || j.error || j.message || t
  } catch {
    return t || res.statusText
  }
}

/** Parse a Server-Sent-Events body; onEvent(eventName, dataString). */
async function readSse(res, onEvent) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let event = 'message'
  let data = []
  const flush = () => {
    if (data.length) onEvent(event, data.join('\n'))
    event = 'message'
    data = []
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (line === '') flush()
      else if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
  }
  flush()
}

// ---------- Ollama ----------

function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })),
      }
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.toolName }
    return { role: m.role, content: m.content }
  })
}

async function streamOllama({ ollama, model, messages, tools, signal, onText, onThinking, numCtx, keepAlive, ollamaOptions }) {
  const body = {
    model,
    messages: toOllamaMessages(messages),
    stream: true,
    keep_alive: keepAlive ?? '10m',
    options: ollamaOptions ?? (numCtx ? { num_ctx: numCtx } : undefined),
  }
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  const res = await ollama.chat(body, signal)
  let content = ''
  const toolCalls = []
  await readNdjson(res, (o) => {
    if (o.error) throw new Error(o.error)
    const msg = o.message || {}
    if (msg.thinking) onThinking?.(msg.thinking)
    if (msg.content) {
      content += msg.content
      onText(msg.content)
    }
    for (const c of msg.tool_calls || []) {
      let args = c.function?.arguments ?? {}
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          args = {}
        }
      }
      toolCalls.push({ id: newCallId(), name: c.function?.name, args })
    }
  })
  return { content, toolCalls }
}

// ---------- OpenAI-compatible (Gemini, DeepSeek, Grok) ----------

function toOpenAiMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      }
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    return { role: m.role, content: m.content }
  })
}

async function streamOpenAiCompat({ provider, apiKey, model, messages, tools, signal, onText, onThinking }) {
  const body = { model, messages: toOpenAiMessages(messages), stream: true }
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  const res = await fetch(`${OPENAI_COMPAT[provider]}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw new Error(`${PROVIDER_LABELS[provider]}: ${await errorText(res)}`)
  let content = ''
  const partial = [] // index -> { id, name, args(string) }
  await readSse(res, (_event, data) => {
    if (data === '[DONE]') return
    const j = JSON.parse(data)
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error))
    const delta = j.choices?.[0]?.delta || {}
    if (delta.reasoning_content) onThinking?.(delta.reasoning_content)
    if (delta.content) {
      content += delta.content
      onText(delta.content)
    }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? partial.length
      partial[i] ||= { id: tc.id || newCallId(), name: '', args: '' }
      if (tc.id) partial[i].id = tc.id
      if (tc.function?.name) partial[i].name += tc.function.name
      if (tc.function?.arguments) partial[i].args += tc.function.arguments
    }
  })
  const toolCalls = partial.filter(Boolean).map((p) => {
    let args = {}
    try {
      args = p.args ? JSON.parse(p.args) : {}
    } catch {
      /* leave empty */
    }
    return { id: p.id, name: p.name, args }
  })
  return { content, toolCalls }
}

// ---------- Anthropic ----------

function toAnthropic(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const out = []
  const push = (role, blocks) => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: [...blocks] })
  }
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }])
    } else if (m.role === 'assistant') {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} })
      if (blocks.length) push('assistant', blocks)
    } else {
      push('user', [{ type: 'text', text: m.content || ' ' }])
    }
  }
  return { system, messages: out }
}

async function streamAnthropic({ apiKey, model, messages, tools, signal, onText, onThinking }) {
  const { system, messages: msgs } = toAnthropic(messages)
  const body = { model, max_tokens: 16000, messages: msgs, stream: true }
  if (system) body.system = system
  if (tools?.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw new Error(`Anthropic: ${await errorText(res)}`)
  let content = ''
  const blocks = {} // index -> { type, id, name, json }
  await readSse(res, (event, data) => {
    const j = JSON.parse(data)
    if (event === 'error' || j.type === 'error') throw new Error(j.error?.message || 'Anthropic stream error')
    if (j.type === 'content_block_start') {
      const b = j.content_block
      blocks[j.index] = { type: b.type, id: b.id, name: b.name, json: '' }
    } else if (j.type === 'content_block_delta') {
      const d = j.delta
      if (d.type === 'text_delta') {
        content += d.text
        onText(d.text)
      } else if (d.type === 'thinking_delta') {
        onThinking?.(d.thinking)
      } else if (d.type === 'input_json_delta' && blocks[j.index]) {
        blocks[j.index].json += d.partial_json
      }
    }
  })
  const toolCalls = Object.values(blocks)
    .filter((b) => b.type === 'tool_use')
    .map((b) => {
      let args = {}
      try {
        args = b.json ? JSON.parse(b.json) : {}
      } catch {
        /* leave empty */
      }
      return { id: b.id, name: b.name, args }
    })
  return { content, toolCalls }
}

// ---------- Public API ----------

/**
 * Stream one model turn. Returns { content, toolCalls }.
 */
async function streamChat(opts) {
  const { provider } = opts
  if (provider === 'ollama') return streamOllama(opts)
  if (!opts.apiKey) throw new Error(`No API key set for ${PROVIDER_LABELS[provider] || provider}. Add one in Settings → API Keys.`)
  if (provider === 'anthropic') return streamAnthropic(opts)
  if (OPENAI_COMPAT[provider]) return streamOpenAiCompat(opts)
  throw new Error('Unknown provider: ' + provider)
}

/** List chat models available for a cloud provider (falls back to a built-in list). */
async function listCloudModels(provider, apiKey) {
  if (!apiKey) return []
  try {
    let ids = []
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(await errorText(res))
      ids = (await res.json()).data.map((m) => m.id)
    } else {
      const res = await fetch(`${OPENAI_COMPAT[provider]}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(await errorText(res))
      ids = (await res.json()).data.map((m) => String(m.id).replace(/^models\//, ''))
      if (provider === 'gemini') {
        ids = ids.filter((id) => /^gemini/.test(id) && !/(embedding|tts|image|audio|live|aqa)/.test(id))
      }
      if (provider === 'grok') ids = ids.filter((id) => !/(image|imagine|vision-beta)/.test(id))
    }
    return ids.length ? ids : FALLBACK_MODELS[provider]
  } catch {
    return FALLBACK_MODELS[provider]
  }
}

/** Validate an API key by listing models. Returns { ok, error? }. */
async function testApiKey(provider, apiKey) {
  try {
    const url = provider === 'anthropic' ? 'https://api.anthropic.com/v1/models?limit=1' : `${OPENAI_COMPAT[provider]}/models`
    const headers = provider === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${apiKey}` }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
    if (!res.ok) return { ok: false, error: await errorText(res) }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

module.exports = {
  streamChat,
  listCloudModels,
  testApiKey,
  toAnthropic,
  toOpenAiMessages,
  toOllamaMessages,
  readSse,
  PROVIDER_LABELS,
}
