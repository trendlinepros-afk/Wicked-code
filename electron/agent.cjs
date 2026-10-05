// Agent loop: streams model output, executes tool calls inside the session's folders,
// and feeds results back until the model produces a final answer.
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const { streamChat } = require('./providers.cjs')

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.cache', '__pycache__',
  '.venv', 'venv', 'target', '.idea', '.vscode', '.obsidian', 'coverage', '.turbo',
])
const MAX_READ_BYTES = 200_000
const MAX_TOOL_OUTPUT = 30_000
const MAX_STEPS = 40

const truncate = (s, n = MAX_TOOL_OUTPUT) =>
  s.length > n ? s.slice(0, n) + `\n… [truncated ${s.length - n} characters]` : s

// ---------- Tool definitions ----------

const READ_TOOLS = [
  {
    name: 'list_files',
    description: 'List files and folders under a directory (recursively, skipping build/vendor folders).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path, relative to the working folder. Defaults to ".".' },
        depth: { type: 'number', description: 'Max depth to recurse (default 3).' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file. Returns the content with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the working folder.' },
        start_line: { type: 'number', description: 'First line to read (1-based, optional).' },
        end_line: { type: 'number', description: 'Last line to read (inclusive, optional).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search file contents with a regular expression. Returns matching lines as path:line: text.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression to search for.' },
        path: { type: 'string', description: 'Directory to search in (default ".").' },
        file_glob: { type: 'string', description: 'Optional filename filter like "*.ts".' },
      },
      required: ['pattern'],
    },
  },
]

const WRITE_TOOLS = [
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Parent folders are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the working folder.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match exactly once (include surrounding lines to make it unique).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the working folder.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the working folder (e.g. tests, builds, git). Returns exit code, stdout and stderr. Times out after 120s.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run.' } },
      required: ['command'],
    },
  },
]

function toolsFor(mode, folders) {
  if (!folders.length) return []
  return mode === 'code' ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS
}

// ---------- Path safety ----------

function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function resolvePath(folders, p) {
  if (!folders.length) throw new Error('No folder is attached to this session.')
  const target = path.resolve(folders[0], p || '.')
  if (!folders.some((f) => isInside(target, f))) {
    throw new Error(`Path "${p}" is outside the session folders. Allowed: ${folders.join(', ')}`)
  }
  return target
}

// ---------- Tool implementations ----------

async function walk(dir, depth, out, root, limit = 800) {
  if (out.length >= limit) return
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  for (const e of entries) {
    if (out.length >= limit) {
      out.push('… (listing truncated)')
      return
    }
    const full = path.join(dir, e.name)
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue
      out.push(rel + '/')
      if (depth > 1) await walk(full, depth - 1, out, root, limit)
    } else {
      out.push(rel)
    }
  }
}

async function listFiles(folders, args) {
  const dir = resolvePath(folders, args.path)
  const out = []
  await walk(dir, Math.min(Math.max(Number(args.depth) || 3, 1), 8), out, dir)
  return out.length ? out.join('\n') : '(empty directory)'
}

async function readFile(folders, args) {
  const file = resolvePath(folders, args.path)
  const stat = await fsp.stat(file)
  if (stat.isDirectory()) throw new Error(`${args.path} is a directory; use list_files.`)
  const fd = await fsp.open(file, 'r')
  const buf = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES))
  await fd.read(buf, 0, buf.length, 0)
  await fd.close()
  if (buf.includes(0)) return `(binary file, ${stat.size} bytes)`
  const lines = buf.toString('utf8').split('\n')
  const start = Math.max(1, Number(args.start_line) || 1)
  const end = Math.min(lines.length, Number(args.end_line) || lines.length)
  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(5)}  ${l}`)
    .join('\n')
  const note = stat.size > MAX_READ_BYTES ? `\n… [file is ${stat.size} bytes; only the first ${MAX_READ_BYTES} were read]` : ''
  return body + note
}

function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + esc + '$', 'i')
}

async function searchFiles(folders, args) {
  const dir = resolvePath(folders, args.path)
  const re = new RegExp(args.pattern, 'i')
  const nameRe = args.file_glob ? globToRegex(args.file_glob) : null
  const files = []
  await walk(dir, 12, files, dir, 5000)
  const hits = []
  for (const rel of files) {
    if (rel.endsWith('/') || rel.startsWith('…')) continue
    if (nameRe && !nameRe.test(path.basename(rel))) continue
    const full = path.join(dir, rel)
    let text
    try {
      const st = await fsp.stat(full)
      if (st.size > 1_000_000) continue
      text = await fsp.readFile(full, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`)
        if (hits.length >= 200) return hits.join('\n') + '\n… (more matches truncated)'
      }
    }
  }
  return hits.length ? hits.join('\n') : 'No matches.'
}

async function writeFile(folders, args) {
  const file = resolvePath(folders, args.path)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const existed = fs.existsSync(file)
  await fsp.writeFile(file, String(args.content ?? ''), 'utf8')
  return `${existed ? 'Updated' : 'Created'} ${args.path} (${Buffer.byteLength(String(args.content ?? ''))} bytes).`
}

async function editFile(folders, args) {
  const file = resolvePath(folders, args.path)
  const text = await fsp.readFile(file, 'utf8')
  const oldS = String(args.old_string ?? '')
  if (!oldS) throw new Error('old_string must not be empty.')
  const count = text.split(oldS).length - 1
  if (count === 0) throw new Error('old_string was not found in the file. Re-read the file and copy the text exactly.')
  if (count > 1) throw new Error(`old_string matches ${count} times; include more surrounding context to make it unique.`)
  await fsp.writeFile(file, text.replace(oldS, () => String(args.new_string ?? '')), 'utf8')
  return `Edited ${args.path}.`
}

function runCommand(folders, args, signal) {
  return new Promise((resolve) => {
    const child = spawn(String(args.command), {
      cwd: folders[0],
      shell: true,
      windowsHide: true,
      env: process.env,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), 120_000)
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort)
    child.stdout.on('data', (d) => (out = truncate(out + d, MAX_TOOL_OUTPUT * 2)))
    child.stderr.on('data', (d) => (err = truncate(err + d, MAX_TOOL_OUTPUT * 2)))
    child.on('error', (e) => (err += String(e.message)))
    child.on('close', (code, sig) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(
        truncate(
          `exit code: ${code ?? sig}\n` + (out ? `stdout:\n${out}\n` : '') + (err ? `stderr:\n${err}` : ''),
        ),
      )
    })
  })
}

const IMPLEMENTATIONS = {
  list_files: listFiles,
  read_file: readFile,
  search_files: searchFiles,
  write_file: writeFile,
  edit_file: editFile,
  run_command: runCommand,
}

function needsApproval(name, permissionMode) {
  if (name === 'run_command') return permissionMode !== 'auto-all'
  if (name === 'write_file' || name === 'edit_file') return permissionMode === 'ask'
  return false
}

// ---------- System prompt ----------

async function buildSystemPrompt({ mode, folders, memory, toolsAvailable }) {
  const lines = []
  if (mode === 'code') {
    lines.push(
      'You are Wicked Code, an expert software engineering agent running on the user\'s machine.',
      'You work inside the user\'s project folder using tools: explore with list_files/search_files/read_file, change code with edit_file/write_file, and verify with run_command.',
      'Always read a file before editing it. Prefer small, targeted edit_file changes over rewriting whole files. Keep the user informed with brief explanations, and finish with a short summary of what you changed.',
    )
  } else {
    lines.push(
      'You are Wicked Code, a helpful, knowledgeable assistant. Answer clearly and concisely, using Markdown when it helps.',
    )
    if (folders.length) lines.push('The user has attached folders for context; use the read-only file tools to look things up before answering questions about them.')
  }
  lines.push(`Current date: ${new Date().toDateString()}. OS: ${os.type()} ${os.release()} (${process.platform}).`)
  if (folders.length) {
    lines.push('', mode === 'code' ? `Working folder: ${folders[0]}` : 'Attached folders:')
    if (mode === 'code' && folders.length > 1) lines.push('Additional context folders:')
    for (const f of mode === 'code' ? folders.slice(1) : folders) lines.push(`- ${f}`)
    lines.push('Relative tool paths resolve against ' + folders[0] + '; use absolute paths for other attached folders.')
    const tree = []
    await walk(folders[0], toolsAvailable ? 2 : 4, tree, folders[0], toolsAvailable ? 150 : 400)
    lines.push('', `Top of ${path.basename(folders[0])}:`, '```', tree.join('\n') || '(empty)', '```')
    if (!toolsAvailable) {
      lines.push(
        'NOTE: The current model does not support tool calling, so you cannot read or write files directly. Answer from the listing above and ask the user to paste file contents when needed. When proposing code changes, give complete code blocks labeled with the file path.',
      )
    }
  }
  if (memory) lines.push('', 'Long-term memory from the user\'s Obsidian vault (Memory.md):', memory)
  return lines.join('\n')
}

// ---------- Agent loop ----------

/**
 * @param {object} p
 * @param {'chat'|'code'} p.mode
 * @param {string} p.provider
 * @param {string} p.model
 * @param {Array} p.history         internal-format messages (no system message)
 * @param {string[]} p.folders
 * @param {string|null} p.memory
 * @param {string|null} p.apiKey
 * @param {object} p.ollama
 * @param {number} p.numCtx
 * @param {string} p.permissionMode
 * @param {AbortSignal} p.signal
 * @param {(type: string, payload?: object) => void} p.emit
 * @param {(call: object) => Promise<boolean>} p.requestApproval
 * @returns {Promise<Array>} new messages produced during this run
 */
async function runAgent(p) {
  const produced = []
  let tools = toolsFor(p.mode, p.folders)
  let system = await buildSystemPrompt({ mode: p.mode, folders: p.folders, memory: p.memory, toolsAvailable: tools.length > 0 })

  for (let step = 0; step < MAX_STEPS; step++) {
    if (p.signal.aborted) break
    p.emit('turn-start')
    const messages = [{ role: 'system', content: system }, ...p.history, ...produced]
    let result
    try {
      result = await streamChat({
        provider: p.provider,
        model: p.model,
        apiKey: p.apiKey,
        ollama: p.ollama,
        numCtx: p.numCtx,
        messages,
        tools,
        signal: p.signal,
        onText: (t) => p.emit('text', { text: t }),
        onThinking: (t) => p.emit('thinking', { text: t }),
      })
    } catch (e) {
      const msg = String(e.message || e)
      if (tools.length && /does not support tools/i.test(msg)) {
        tools = []
        system = await buildSystemPrompt({ mode: p.mode, folders: p.folders, memory: p.memory, toolsAvailable: false })
        p.emit('notice', { text: `${p.model} does not support tool calling, so it can't read or edit files directly. Continuing without tools.` })
        step--
        continue
      }
      throw e
    }

    const assistant = { role: 'assistant', content: result.content }
    if (result.toolCalls.length) assistant.toolCalls = result.toolCalls
    produced.push(assistant)
    p.emit('assistant', { message: assistant })
    if (!result.toolCalls.length) break

    for (const call of result.toolCalls) {
      if (p.signal.aborted) break
      let output
      let isError = false
      const impl = IMPLEMENTATIONS[call.name]
      const allowed = tools.some((t) => t.name === call.name)
      try {
        if (!impl || !allowed) throw new Error(`Unknown or unavailable tool: ${call.name}`)
        if (needsApproval(call.name, p.permissionMode)) {
          const ok = await p.requestApproval(call)
          if (!ok) throw new Error('The user denied this action. Ask them how they would like to proceed.')
        }
        output = await impl(p.folders, call.args || {}, p.signal)
      } catch (e) {
        isError = true
        output = 'Error: ' + String(e.message || e)
      }
      const toolMsg = { role: 'tool', toolCallId: call.id, toolName: call.name, content: truncate(String(output)), isError }
      produced.push(toolMsg)
      p.emit('tool-result', { message: toolMsg })
    }
  }
  return produced
}

module.exports = { runAgent, resolvePath, buildSystemPrompt, toolsFor, IMPLEMENTATIONS, needsApproval }
