// "Lessons Learned": asks the model what it learned in a conversation (things that failed and what
// finally worked), posts that in the chat and saves one note per lesson in the vault:
//   <vault>/Lessons Learned/<model>/<model>-<lesson title, max 5 words>.md
const fs = require('fs')
const path = require('path')
const { streamChat } = require('./providers.cjs')

const SYSTEM = [
  'You review a finished AI-assistant conversation and write down the LESSONS LEARNED, so the same mistakes are not repeated next time.',
  'A lesson is something that went wrong first and was then made to work: a failed command, an error, a wrong approach, a bug, a tool used the wrong way, or something the user had to correct.',
  'For each lesson say exactly what failed and exactly what was done to get the expected result (the real commands, code, settings or steps from the conversation).',
  'Only use what actually happened in the conversation. Do not invent anything. Skip trivial things. At most 6 lessons.',
  '',
  'Reply in EXACTLY this format, one block per lesson, nothing before or after:',
  '',
  'LESSON: <title, at most 5 words>',
  'PROBLEM: <what was being attempted and what went wrong, one or two sentences>',
  'WHAT FAILED: <the attempts that did not work and why>',
  'WHAT WORKED: <exactly what was done to get it right>',
  'EXAMPLE:',
  '<the exact command, code or steps that worked — or "none">',
  '===',
  '',
  'If nothing went wrong and nothing was learned, reply with exactly: NONE',
].join('\n')

const clip = (s, n) => {
  s = String(s ?? '')
  return s.length <= n ? s : s.slice(0, Math.floor(n * 0.6)) + `\n… [${s.length - n} chars cut] …\n` + s.slice(-Math.floor(n * 0.4))
}

/** The conversation as plain text, with tool calls, results and errors (that's where lessons hide). */
function buildTranscript(messages, maxChars = 40_000) {
  const parts = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.lessons) continue
      const files = (m.attachments || []).map((a) => a.name).join(', ')
      parts.push(`${m.synthetic ? 'APP REMINDER' : 'USER'}: ${clip(m.content, 2000)}${files ? ` [attached: ${files}]` : ''}`)
    } else if (m.role === 'assistant') {
      if (m.lessons) continue
      if (m.isError) parts.push(`ERROR SHOWN TO USER: ${clip(m.content, 800)}`)
      else if (m.content?.trim()) parts.push(`ASSISTANT: ${clip(m.content, 2000)}`)
      for (const c of m.toolCalls || []) parts.push(`TOOL CALL ${c.name}: ${clip(JSON.stringify(c.args || {}), 900)}`)
    } else if (m.role === 'tool') {
      parts.push(`TOOL RESULT ${m.toolName || ''}${m.isError ? ' (FAILED)' : ''}: ${clip(m.content, m.isError ? 1200 : 700)}`)
    }
  }
  let text = parts.join('\n\n')
  if (text.length > maxChars) {
    // Keep the start (the goal) and the most recent work.
    text = text.slice(0, Math.floor(maxChars * 0.25)) + '\n\n… [middle of the conversation cut] …\n\n' + text.slice(-Math.floor(maxChars * 0.75))
  }
  return text
}

/** Max five words, no characters that are invalid in file names. */
function cleanTitle(raw) {
  const words = String(raw || '')
    .replace(/[*_`#"“”'‘’]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[.!?,;]+$/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
  // Don't end a cut-off title on a filler word ("Test key input with a").
  while (words.length > 1 && /^(a|an|the|with|to|for|of|and|or|but|so|as|in|on|at|by|from|into|is|it|that|when|before|after|than)$/i.test(words[words.length - 1])) words.pop()
  return words.join(' ')
}

const FIELDS = { problem: /^problem$/i, failed: /^what\s+failed$/i, worked: /^what\s+worked$/i, example: /^example$/i }

/** Parse the model's reply into lessons. */
function parseLessons(raw) {
  const text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\r/g, '')
  const blocks = text.split(/^\s*[#*\s]*LESSON\s*\**\s*[:\-–]\s*/im).slice(1)
  const lessons = []
  for (const block of blocks) {
    const body = block.split(/^\s*===+\s*$/m)[0]
    const lines = body.split('\n')
    const lesson = { title: cleanTitle(lines.shift()), problem: '', failed: '', worked: '', example: '' }
    let field = null
    for (const line of lines) {
      const m = line.match(/^\s*[#*\s]*([A-Za-z ]{4,14}?)\s*\**\s*:\s*\**\s*(.*)$/)
      const key = m && Object.keys(FIELDS).find((k) => FIELDS[k].test(m[1].trim()))
      if (key) {
        field = key
        lesson[key] = m[2]
      } else if (field) lesson[field] += (lesson[field] ? '\n' : '') + line
    }
    for (const k of Object.keys(FIELDS)) lesson[k] = lesson[k].trim()
    if (/^none\.?$/i.test(lesson.example)) lesson.example = ''
    if (lesson.title && (lesson.worked || lesson.problem)) lessons.push(lesson)
  }
  return lessons.slice(0, 8)
}

/** "qwen3.8:27b" → "qwen3.8-27b" (safe as a folder / file name on every OS). */
function modelSlug(model) {
  return (
    String(model || 'model')
      .replace(/^.*\//, '')
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'model'
  )
}

function lessonMarkdown(lesson, { model, sessionTitle, date }) {
  const fence = lesson.example.includes('```') ? '' : '```'
  return [
    '---',
    `model: "${model}"`,
    `date: ${date}`,
    `session: "${String(sessionTitle || '').replace(/"/g, "'")}"`,
    'tags: [lesson-learned, wicked-code]',
    '---',
    '',
    `# ${lesson.title}`,
    '',
    '## Problem',
    lesson.problem || '—',
    '',
    '## What failed',
    lesson.failed || '—',
    '',
    '## What worked',
    lesson.worked || '—',
    ...(lesson.example ? ['', '## Example', fence ? `${fence}\n${lesson.example}\n${fence}` : lesson.example] : []),
    '',
  ].join('\n')
}

/** Save one Markdown file per lesson. Never overwrites an existing lesson. */
function saveLessons({ vaultPath, model, lessons, sessionTitle, now = new Date() }) {
  if (!vaultPath) throw new Error('Choose an Obsidian vault first (Settings → General).')
  const slug = modelSlug(model)
  const dir = path.join(vaultPath, 'Lessons Learned', slug)
  fs.mkdirSync(dir, { recursive: true })
  const date = now.toISOString().slice(0, 10)
  return lessons.map((lesson) => {
    const base = `${slug}-${lesson.title}`
    let file = path.join(dir, `${base}.md`)
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n}).md`)
    fs.writeFileSync(file, lessonMarkdown(lesson, { model, sessionTitle, date }), 'utf8')
    return { ...lesson, file, relPath: path.relative(vaultPath, file).split(path.sep).join('/') }
  })
}

/** The message posted in the chat. */
function chatMessage(saved, model) {
  if (!saved.length) {
    return `### 🎓 Lessons learned\n\nNothing went wrong in this conversation that needed a different approach, so there are no new lessons for **${model}**.`
  }
  const out = [`### 🎓 Lessons learned (${saved.length})`, '']
  saved.forEach((l, i) => {
    out.push(`**${i + 1}. ${l.title}**`, '')
    if (l.problem) out.push(`- **Problem:** ${l.problem}`)
    if (l.failed) out.push(`- **What failed:** ${l.failed}`)
    if (l.worked) out.push(`- **What worked:** ${l.worked}`)
    if (l.example) out.push('', l.example.includes('```') ? l.example : '```\n' + l.example + '\n```')
    out.push('', `*Saved to* \`${l.relPath}\``, '')
  })
  return out.join('\n').trim()
}

/**
 * Ask the model for the lessons, save them and return the chat message.
 * @param {object} p  provider/model/apiKey/ollama/ollamaOptions/keepAlive/signal as for streamChat,
 *   plus messages, vaultPath, learner (the model that did the work), sessionTitle, maxChars
 */
async function learnLessons(p) {
  const transcript = buildTranscript(p.messages, p.maxChars)
  const { content } = await streamChat({
    provider: p.provider,
    model: p.model,
    apiKey: p.apiKey,
    ollama: p.ollama,
    ollamaOptions: p.ollamaOptions,
    keepAlive: p.keepAlive,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Conversation to review:\n\n${transcript}\n\nWrite the lessons learned now, in the exact format.` },
    ],
    tools: [],
    signal: p.signal,
    onText: p.onText || (() => {}),
    onThinking: () => {},
  })
  const lessons = parseLessons(content)
  if (!lessons.length && !/^\s*NONE\b/i.test(String(content).replace(/<think>[\s\S]*?<\/think>/gi, '').trim()) && String(content).trim()) {
    throw new Error("The model's answer couldn't be read as lessons. Try again, or pick a stronger model.")
  }
  const learner = p.learner || p.model
  const saved = saveLessons({ vaultPath: p.vaultPath, model: learner, lessons, sessionTitle: p.sessionTitle })
  return { lessons: saved, message: chatMessage(saved, learner) }
}

module.exports = { learnLessons, buildTranscript, parseLessons, saveLessons, modelSlug, cleanTitle, chatMessage }
