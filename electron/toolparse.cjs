// Some local models (e.g. qwen2.5-coder:7b) don't use Ollama's tool-calling channel and instead type
// tool calls into their reply as JSON, sometimes wrapped in <tool_call> tags or ```json fences.
// This finds those calls so they can be executed, and removes them from the visible text.

/** Extract a balanced {...} starting at `start`, fixing raw newlines/tabs inside strings. */
function balancedObject(text, start) {
  let depth = 0
  let inStr = false
  let esc = false
  let out = ''
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') continue
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
      continue
    }
    out += ch
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { json: out, end: i + 1 }
    }
  }
  return null
}

function asCall(obj, toolNames) {
  if (!obj || typeof obj !== 'object') return null
  const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj
  const name = fn.name ?? obj.tool ?? obj.tool_name
  if (typeof name !== 'string' || !toolNames.has(name)) return null
  let args = fn.arguments ?? fn.parameters ?? fn.args ?? obj.tool_input ?? obj.input ?? {}
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  return { name, args }
}

/**
 * @param {string} text  the model's reply
 * @param {string[]} toolNames  tools available this turn
 * @returns {{ calls: {name: string, args: object}[], text: string }}  calls found + reply with them removed
 */
function parseTextToolCalls(text, toolNames) {
  const names = new Set(toolNames)
  const calls = []
  const cut = [] // [start, end) ranges to remove from the visible text
  if (!text || !names.size || !text.includes('{')) return { calls, text }
  for (let i = text.indexOf('{'); i !== -1 && i < text.length; ) {
    const obj = balancedObject(text, i)
    if (!obj) break
    let parsed = null
    try {
      parsed = JSON.parse(obj.json)
    } catch {
      /* not JSON */
    }
    const list = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : [parsed]
    const found = list.map((o) => asCall(o, names)).filter(Boolean)
    if (found.length) {
      calls.push(...found)
      cut.push([i, obj.end])
      i = text.indexOf('{', obj.end)
    } else {
      i = text.indexOf('{', i + 1)
    }
  }
  if (!calls.length) return { calls, text }
  let rest = ''
  let last = 0
  for (const [s, e] of cut) {
    rest += text.slice(last, s)
    last = e
  }
  rest += text.slice(last)
  rest = rest
    .replace(/<\/?tool_call>/g, '')
    .replace(/```(?:json|tool_call)?\s*```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { calls, text: rest }
}

module.exports = { parseTextToolCalls }
