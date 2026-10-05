// Saves chat and code sessions into the user's Obsidian vault.
//   <vault>/Wicked Code/Chats/*.md          readable chat notes
//   <vault>/Wicked Code/Code Sessions/*.md  readable code-session notes
//   <vault>/Wicked Code/.sessions/*.json    full session data (hidden from Obsidian)
//   <vault>/Wicked Code/Memory.md           long-term memory included in prompts
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

const ROOT = 'Wicked Code'
const MEMORY_TEMPLATE = `# Wicked Code Memory

Anything written in this note is given to the AI at the start of every chat and code session.
Use it for preferences, facts about you, coding conventions, and project notes you want remembered.

## About me
-

## Coding preferences
-
`

function dirs(vault) {
  const root = path.join(vault, ROOT)
  return {
    root,
    chats: path.join(root, 'Chats'),
    code: path.join(root, 'Code Sessions'),
    data: path.join(root, '.sessions'),
    memory: path.join(root, 'Memory.md'),
  }
}

/** Check a folder looks like an Obsidian vault. */
function inspectVault(vault) {
  if (!vault || !fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) return { exists: false, isObsidian: false }
  return { exists: true, isObsidian: fs.existsSync(path.join(vault, '.obsidian')) }
}

async function setupVault(vault) {
  const d = dirs(vault)
  for (const p of [d.chats, d.code, d.data]) await fsp.mkdir(p, { recursive: true })
  if (!fs.existsSync(d.memory)) await fsp.writeFile(d.memory, MEMORY_TEMPLATE, 'utf8')
  return d
}

function safeName(s) {
  return (
    String(s || 'Untitled')
      .replace(/[\\/:*?"<>|#^[\]\n\r\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Untitled'
  )
}

function yamlStr(s) {
  return JSON.stringify(String(s ?? ''))
}

function toMarkdown(session) {
  const fm = [
    '---',
    `type: ${session.mode === 'code' ? 'wicked-code-session' : 'wicked-chat'}`,
    `title: ${yamlStr(session.title)}`,
    `model: ${yamlStr(session.model)}`,
    `created: ${session.createdAt}`,
    `updated: ${session.updatedAt}`,
  ]
  if (session.folders?.length) {
    fm.push('folders:')
    for (const f of session.folders) fm.push(`  - ${yamlStr(f)}`)
  }
  fm.push('tags:', '  - wicked-code', `  - ${session.mode === 'code' ? 'code-session' : 'chat'}`, '---', '')

  const body = [`# ${session.title}`, '']
  if (session.mode === 'code' && session.folders?.[0]) body.push(`**Working folder:** \`${session.folders[0]}\``, '')
  for (const m of session.messages || []) {
    if (m.role === 'user') {
      body.push('## You', '', m.content, '')
    } else if (m.role === 'assistant') {
      if (m.content?.trim()) body.push(`## Assistant${m.model ? ` (${m.model})` : ''}`, '', m.content, '')
      for (const c of m.toolCalls || []) {
        const summary = c.args?.path || c.args?.command || c.args?.pattern || ''
        body.push(`> [!example]- Tool: ${c.name}${summary ? ` — ${String(summary).slice(0, 100)}` : ''}`, '')
      }
    } else if (m.role === 'tool' && m.isError) {
      body.push(`> [!warning]- ${m.toolName} failed`, ...m.content.split('\n').slice(0, 10).map((l) => '> ' + l), '')
    }
  }
  return fm.join('\n') + body.join('\n')
}

class Vault {
  constructor(getPath) {
    this.getPath = getPath
  }

  d() {
    const v = this.getPath()
    if (!v) throw new Error('No Obsidian vault selected.')
    return dirs(v)
  }

  async list() {
    const d = this.d()
    await fsp.mkdir(d.data, { recursive: true })
    const files = (await fsp.readdir(d.data)).filter((f) => f.endsWith('.json'))
    const out = []
    for (const f of files) {
      try {
        const s = JSON.parse(await fsp.readFile(path.join(d.data, f), 'utf8'))
        out.push({
          id: s.id,
          title: s.title,
          mode: s.mode,
          model: s.model,
          folders: s.folders || [],
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })
      } catch {
        /* skip corrupt file */
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  async load(id) {
    const d = this.d()
    return JSON.parse(await fsp.readFile(path.join(d.data, safeName(id) + '.json'), 'utf8'))
  }

  async save(session) {
    const d = await setupVault(this.getPath())
    const folder = session.mode === 'code' ? d.code : d.chats
    const date = String(session.createdAt).slice(0, 10)
    const shortId = String(session.id).slice(-6)
    const noteName = `${date} ${safeName(session.title)} (${shortId}).md`
    const notePath = path.join(folder, noteName)
    if (session.notePath && session.notePath !== notePath && fs.existsSync(session.notePath)) {
      await fsp.rename(session.notePath, notePath).catch(() => {})
    }
    const saved = { ...session, notePath }
    await fsp.writeFile(notePath, toMarkdown(saved), 'utf8')
    const jsonPath = path.join(d.data, safeName(session.id) + '.json')
    await fsp.writeFile(jsonPath + '.tmp', JSON.stringify(saved, null, 1), 'utf8')
    await fsp.rename(jsonPath + '.tmp', jsonPath)
    return saved
  }

  async remove(id) {
    const d = this.d()
    const jsonPath = path.join(d.data, safeName(id) + '.json')
    try {
      const s = JSON.parse(await fsp.readFile(jsonPath, 'utf8'))
      if (s.notePath) await fsp.rm(s.notePath, { force: true })
    } catch {
      /* already gone */
    }
    await fsp.rm(jsonPath, { force: true })
  }

  async readMemory() {
    try {
      const text = await fsp.readFile(this.d().memory, 'utf8')
      return text.length > 12000 ? text.slice(0, 12000) + '\n…' : text
    } catch {
      return null
    }
  }

  memoryPath() {
    return this.d().memory
  }
}

module.exports = { Vault, setupVault, inspectVault, toMarkdown, safeName }
