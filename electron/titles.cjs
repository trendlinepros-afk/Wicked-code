// Names a chat/code session from its first exchange, using the session's own model.
const { streamChat } = require('./providers.cjs')

const SYSTEM =
  'You write titles for conversations. Reply with ONLY a short, specific title of 3 to 6 words that says what the conversation is about. ' +
  'No quotes, no emojis, no ending punctuation, no explanations.'

/** Turn a model reply into a clean one-line title. */
function cleanTitle(raw) {
  let t = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
  t = t.split('\n').map((l) => l.trim()).find((l) => l && !/^(okay|sure|here)/i.test(l)) || ''
  t = t
    .replace(/^\**\s*(title|chat title|conversation title)\s*[:\-–]\s*/i, '')
    .replace(/[*_`#]/g, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.!?:;,]+$/, '')
    .trim()
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '')
  return t
}

/** Fallback when the model can't be used: first few words of the first message. */
function fallbackTitle(text) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ')
  return words.length > 50 ? words.slice(0, 50) + '…' : words || 'New chat'
}

/**
 * @param {object} p
 * @param {string} p.provider
 * @param {string} p.model
 * @param {string|null} p.apiKey
 * @param {object} p.ollama
 * @param {object} [p.ollamaOptions]
 * @param {string|number} [p.keepAlive]
 * @param {Array<{role: string, content: string}>} p.messages  the conversation so far
 * @param {AbortSignal} [p.signal]
 */
async function generateTitle(p) {
  const convo = p.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && !m.isError)
    .slice(0, 4)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1500)}`)
    .join('\n\n')
  const firstUser = p.messages.find((m) => m.role === 'user')?.content || ''
  try {
    const { content } = await streamChat({
      provider: p.provider,
      model: p.model,
      apiKey: p.apiKey,
      ollama: p.ollama,
      ollamaOptions: p.ollamaOptions,
      keepAlive: p.keepAlive,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Conversation:\n\n${convo}\n\nTitle (3-6 words):` },
      ],
      tools: [],
      signal: p.signal ? AbortSignal.any([p.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      onText: () => {},
      onThinking: () => {},
    })
    const title = cleanTitle(content)
    return title.length >= 3 ? title : fallbackTitle(firstUser)
  } catch {
    return fallbackTitle(firstUser)
  }
}

module.exports = { generateTitle, cleanTitle, fallbackTitle }
