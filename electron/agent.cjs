// Agent loop: streams model output, executes tool calls inside the session's folders,
// and feeds results back until the model produces a final answer.
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const { streamChat } = require('./providers.cjs')
const { expandAttachments } = require('./attachments.cjs')
const { saveDocument } = require('./docwriter.cjs')

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.cache', '__pycache__',
  '.venv', 'venv', 'target', '.idea', '.vscode', '.obsidian', 'coverage', '.turbo',
])
const MAX_READ_BYTES = 200_000
const MAX_TOOL_OUTPUT = 16_000
const DEFAULT_MAX_STEPS = 100

/** Shorten long text, keeping the start and (mostly) the end, where errors and test summaries usually are. */
function truncate(s, n = MAX_TOOL_OUTPUT) {
  if (s.length <= n) return s
  const head = Math.floor(n * 0.25)
  const tail = n - head
  return s.slice(0, head) + `\n… [${s.length - n} characters omitted] …\n` + s.slice(s.length - tail)
}

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
      'Run a shell command in the working folder and wait for it to finish (tests, builds, installs, git, scripts). Returns exit code, stdout and stderr. Do NOT use this for servers or apps that keep running — use start_process for those.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 120, max 900).' },
      },
      required: ['command'],
    },
  },
]

const PROCESS_TOOLS = [
  {
    name: 'start_process',
    description:
      'Start a long-running command in the background (dev server, web app, API, watcher, GUI app) in the working folder. Waits until ready_pattern appears in the output (or wait_seconds pass) and returns the output so far plus a process id. Use read_process_output to check logs later and stop_process when done.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to start, e.g. "npm run dev" or "python app.py".' },
        ready_pattern: { type: 'string', description: 'Optional regex that signals the process is ready, e.g. "listening|ready|localhost:\\d+".' },
        wait_seconds: { type: 'number', description: 'How long to wait for startup output (default 8, max 60).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_process_output',
    description: 'Read new output (logs, errors) from a background process since the last read, and whether it is still running.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id from start_process.' },
        wait_seconds: { type: 'number', description: 'Optionally wait this many seconds for more output first (max 60).' },
        all: { type: 'boolean', description: 'Return the whole buffered log instead of only new output.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'stop_process',
    description: 'Stop a background process (and its child processes).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_processes',
    description: 'List background processes started in this session with their status.',
    parameters: { type: 'object', properties: {} },
  },
]

const TEST_TOOLS = [
  {
    name: 'http_request',
    description:
      'Send an HTTP request to a locally running server (localhost / 127.0.0.1 only) to test an API or web app you started. Returns status, headers and body.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'e.g. http://localhost:3000/api/health' },
        method: { type: 'string', description: 'GET (default), POST, PUT, PATCH, DELETE…' },
        headers: { type: 'object', description: 'Optional request headers.' },
        body: { type: 'string', description: 'Optional request body (send JSON as a string and set Content-Type).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_check',
    description:
      'Open a local web page (http://localhost… or an .html file in the working folder) in a real headless browser, run its JavaScript, and report the page title, visible text, console errors/warnings and failed network requests. Use it to verify a web UI actually renders and works.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http://localhost:PORT/path or a path to an .html file.' },
        wait_ms: { type: 'number', description: 'Extra time to wait after load for scripts to run (default 1500).' },
        script: { type: 'string', description: 'Optional JavaScript expression evaluated in the page after load; its result is returned (e.g. to click a button and read the result).' },
      },
      required: ['url'],
    },
  },
]

const GITHUB_TOOLS = [
  {
    name: 'github_create_pull_request',
    description:
      'Open a pull request on GitHub for the current branch. Commit and `git push -u origin <branch>` with run_command first.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown description of the change and how it was tested.' },
        base: { type: 'string', description: 'Branch to merge into (defaults to the repository default branch).' },
        draft: { type: 'boolean' },
      },
      required: ['title'],
    },
  },
]

const DOC_TOOLS = [
  {
    name: 'save_document',
    description:
      'Save a new document next to the user\'s attached file(s) — e.g. an edited version of their Word document. Write the full content in Markdown (headings, lists, **bold**, tables); a .docx filename produces a real Word document. Existing files are never overwritten.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name only, e.g. "Proposal (edited).docx" or "summary.md".' },
        content: { type: 'string', description: 'The complete document content in Markdown.' },
      },
      required: ['filename', 'content'],
    },
  },
]

/** @param {{processes?: boolean, browser?: boolean, github?: boolean, documents?: boolean}} caps */
function toolsFor(mode, folders, caps = {}) {
  const docTools = caps.documents ? DOC_TOOLS : []
  if (!folders.length) return [...docTools]
  if (mode !== 'code') return [...READ_TOOLS, ...docTools]
  const tools = [...READ_TOOLS, ...WRITE_TOOLS]
  if (caps.processes) tools.push(...PROCESS_TOOLS)
  tools.push(...TEST_TOOLS.filter((t) => t.name !== 'browser_check' || caps.browser))
  if (caps.github) tools.push(...GITHUB_TOOLS)
  tools.push(...docTools)
  return tools
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

async function listFiles({ folders }, args) {
  const dir = resolvePath(folders, args.path)
  const out = []
  await walk(dir, Math.min(Math.max(Number(args.depth) || 3, 1), 8), out, dir)
  return out.length ? out.join('\n') : '(empty directory)'
}

async function readFile({ folders }, args) {
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

async function searchFiles({ folders }, args) {
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

async function writeFile({ folders }, args) {
  const file = resolvePath(folders, args.path)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const existed = fs.existsSync(file)
  await fsp.writeFile(file, String(args.content ?? ''), 'utf8')
  return `${existed ? 'Updated' : 'Created'} ${args.path} (${Buffer.byteLength(String(args.content ?? ''))} bytes).`
}

async function editFile({ folders }, args) {
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

function runCommand({ folders, signal, env }, args) {
  return new Promise((resolve) => {
    const child = spawn(String(args.command), {
      cwd: folders[0],
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...env },
    })
    const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds) || 120, 1), 900) * 1000
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      err += `\n[timed out after ${timeoutMs / 1000}s — for servers use start_process]`
      child.kill()
    }, timeoutMs)
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

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

async function startProcess(ctx, args) {
  if (!ctx.processes) throw new Error('Background processes are not available.')
  const rec = ctx.processes.start({ command: String(args.command), cwd: ctx.folders[0], env: ctx.env, owner: ctx.owner })
  const ms = Math.min(Math.max(Number(args.wait_seconds) || 8, 1), 60) * 1000
  const why = await ctx.processes.waitFor(rec.id, { ms, pattern: args.ready_pattern || null })
  const { text, status, exitCode } = ctx.processes.read(rec.id)
  const head =
    status === 'running'
      ? `Started background process ${rec.id} (pid ${rec.pid}); still running${why === 'matched' ? ' — ready pattern matched' : ''}.`
      : `Process ${rec.id} exited with code ${exitCode}.`
  return truncate(`${head}\n--- output ---\n${text || '(no output yet)'}`)
}

async function readProcessOutput(ctx, args) {
  if (!ctx.processes) throw new Error('Background processes are not available.')
  const wait = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), 60)
  if (wait) await ctx.processes.waitFor(args.id, { ms: wait * 1000 })
  const { text, status, exitCode } = ctx.processes.read(args.id, { all: !!args.all })
  return truncate(`status: ${status}${status === 'exited' ? ` (code ${exitCode})` : ''}\n--- output ---\n${text || '(no new output)'}`)
}

async function stopProcess(ctx, args) {
  if (!ctx.processes) throw new Error('Background processes are not available.')
  return ctx.processes.stop(args.id) ? `Stopped ${args.id}.` : `${args.id} was not running.`
}

async function listProcesses(ctx) {
  if (!ctx.processes) return 'No background processes.'
  const list = ctx.processes.list().filter((p) => !ctx.owner || p.owner === ctx.owner)
  if (!list.length) return 'No background processes.'
  return list.map((p) => `${p.id}  ${p.status}${p.status === 'exited' ? `(${p.exitCode})` : ''}  ${p.command}`).join('\n')
}

async function httpRequest(ctx, args) {
  const url = new URL(String(args.url))
  if (!/^https?:$/.test(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('http_request only works with local servers (localhost / 127.0.0.1).')
  }
  const started = Date.now()
  const res = await fetch(url, {
    method: String(args.method || 'GET').toUpperCase(),
    headers: args.headers || undefined,
    body: args.body ?? undefined,
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)].filter(Boolean)),
    redirect: 'manual',
  })
  const body = await res.text()
  const headers = [...res.headers.entries()]
    .filter(([k]) => ['content-type', 'location', 'set-cookie', 'content-length'].includes(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return truncate(`HTTP ${res.status} ${res.statusText} (${Date.now() - started} ms)\n${headers}\n\n${body}`, 10_000)
}

async function browserCheck(ctx, args) {
  if (!ctx.browserCheck) throw new Error('browser_check is not available.')
  let target = String(args.url)
  if (/^https?:/i.test(target)) {
    const u = new URL(target)
    if (!LOCAL_HOSTS.has(u.hostname)) throw new Error('browser_check only opens local pages (localhost or files in the working folder).')
  } else {
    target = 'file://' + resolvePath(ctx.folders, target.replace(/^file:\/\//, '')).split(path.sep).join('/')
  }
  return truncate(await ctx.browserCheck({ url: target, waitMs: Number(args.wait_ms) || 1500, script: args.script }), 12_000)
}

async function githubCreatePr(ctx, args) {
  if (!ctx.github) throw new Error('This folder is not a GitHub repository, or no GitHub token is set.')
  return ctx.github.createPullRequest(args)
}

const IMPLEMENTATIONS = {
  list_files: listFiles,
  read_file: readFile,
  search_files: searchFiles,
  write_file: writeFile,
  edit_file: editFile,
  run_command: runCommand,
  start_process: startProcess,
  read_process_output: readProcessOutput,
  stop_process: stopProcess,
  list_processes: listProcesses,
  http_request: httpRequest,
  browser_check: browserCheck,
  github_create_pull_request: githubCreatePr,
  save_document: (ctx, args) => saveDocument(ctx.attachDirs || [], args),
}

function needsApproval(name, permissionMode) {
  if (name === 'run_command' || name === 'start_process' || name === 'github_create_pull_request' || name === 'save_document') return permissionMode !== 'auto-all'
  if (name === 'write_file' || name === 'edit_file') return permissionMode === 'ask'
  return false
}

// ---------- System prompt ----------

async function buildSystemPrompt({ mode, folders, memory, toolsAvailable, github, attachments }) {
  const lines = []
  if (mode === 'code') {
    lines.push(
      'You are Wicked Code, an autonomous software engineering agent running on the user\'s machine.',
      'You work inside the user\'s project folder using tools: explore with list_files/search_files/read_file, change code with edit_file/write_file, and run things with run_command/start_process.',
      '',
      'Work in a build → run → test → fix loop until the task is really done:',
      '1. Understand the code first (read the relevant files). Always read a file before editing it; prefer small edit_file changes.',
      '2. After writing code, VERIFY it: run the tests, build, linter or the program itself with run_command. If there are no tests for new behaviour, write a quick test or script that exercises it.',
      '3. For servers and apps that keep running, use start_process (with a ready_pattern), then exercise them with http_request or browser_check, and read logs with read_process_output.',
      '4. When anything fails, read the error carefully, fix the cause, and run the check again. Repeat until everything passes. Do not stop at the first error and do not claim success without having run it.',
      '5. Stop background processes you started once you are done with them.',
      'Install missing dependencies when needed. Keep the user informed with brief updates, and finish with a short summary of what you changed and how you verified it (including the final test result).',
    )
    if (github) {
      lines.push(
        '',
        `This folder is the GitHub repository ${github.fullName} (current branch: ${github.branch || 'unknown'}). Git is authenticated for you.`,
        'When the user asks you to ship or open a PR: make sure you are on a feature branch (not the default branch), `git add` + `git commit` with a clear message, `git push -u origin <branch>`, then call github_create_pull_request.',
      )
    }
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
  if (attachments) {
    lines.push(
      '',
      'The user attached files. Their contents are included in their messages inside <attached_file> tags (images are attached directly when the model supports vision). Read them carefully and quote specifics.',
      toolsAvailable
        ? 'When the user wants a document edited or created, write the full result and call save_document (Markdown content; use a .docx name like "Original name (edited).docx" for Word files). It is saved next to their original and never overwrites it. Briefly summarise what you changed.'
        : 'When the user wants a document edited, give the complete revised text in your reply.',
    )
  }
  if (memory) lines.push('', 'Long-term memory from the user\'s Obsidian vault (Memory.md):', memory)
  return lines.join('\n')
}

// ---------- Context management ----------

const contentLength = (m) => (m.content?.length || 0) + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0)

/**
 * Keep long agent loops inside the model's context window: once the conversation is over budget,
 * shrink the oldest tool outputs and file contents first (the model can always re-read or re-run).
 * The system prompt and the most recent messages are never touched.
 */
function compactMessages(messages, budget) {
  let total = messages.reduce((a, m) => a + contentLength(m), 0)
  if (total <= budget) return messages
  const out = messages.map((m) => ({ ...m }))
  const keepFrom = Math.max(1, out.length - 6)
  for (let i = 1; i < keepFrom && total > budget; i++) {
    const m = out[i]
    if (m.role === 'tool' && m.content.length > 400) {
      total -= m.content.length
      m.content = m.content.slice(0, 300) + '\n… [older output trimmed to save context — re-run the tool if you need it again]'
      total += m.content.length
    } else if (m.role === 'assistant' && m.toolCalls?.some((c) => String(c.args?.content || '').length > 400)) {
      m.toolCalls = m.toolCalls.map((c) => {
        const content = String(c.args?.content || '')
        if (content.length <= 400) return c
        total -= content.length - 60
        return { ...c, args: { ...c.args, content: `[${content.length} characters written earlier — trimmed]` } }
      })
    }
  }
  // Still too long: drop the oldest turns, but always keep the first user message for the original goal.
  while (total > budget && out.length > 8) {
    const [removed] = out.splice(2, 1)
    total -= contentLength(removed)
    // Never leave tool results without the assistant call that produced them.
    while (out[2]?.role === 'tool') total -= contentLength(out.splice(2, 1)[0])
  }
  return out
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
  const attachDirs = [
    ...new Set(
      p.history.flatMap((m) => (m.role === 'user' ? (m.attachments || []).filter((a) => !a.error && a.path).map((a) => path.dirname(a.path)) : [])),
    ),
  ]
  const hasAttachments = p.history.some((m) => m.attachments?.length)
  const caps = { processes: !!p.processes, browser: !!p.browserCheck, github: !!p.github, documents: attachDirs.length > 0 }
  let tools = toolsFor(p.mode, p.folders, caps)
  const prompt = (toolsAvailable) =>
    buildSystemPrompt({ mode: p.mode, folders: p.folders, memory: p.memory, toolsAvailable, github: p.github?.info, attachments: hasAttachments })
  let system = await prompt(tools.length > 0)
  const ctx = {
    folders: p.folders,
    signal: p.signal,
    env: p.env || {},
    owner: p.owner,
    processes: p.processes,
    browserCheck: p.browserCheck,
    github: p.github,
    attachDirs,
  }
  let history = expandAttachments(p.history)
  // Rough character budget for the conversation (≈3 chars per token, leaving room for the reply).
  const budget = p.provider === 'ollama' ? Math.max(8000, (p.numCtx || 8192) * 3 - 6000) : 600_000
  const maxSteps = p.maxSteps || DEFAULT_MAX_STEPS

  for (let step = 0; step < maxSteps; step++) {
    if (p.signal.aborted) break
    p.emit('turn-start')
    const messages = compactMessages([{ role: 'system', content: system }, ...history, ...produced], budget)
    let result
    try {
      result = await streamChat({
        provider: p.provider,
        model: p.model,
        apiKey: p.apiKey,
        ollama: p.ollama,
        numCtx: p.numCtx,
        keepAlive: p.keepAlive,
        ollamaOptions: p.ollamaOptions,
        messages,
        tools,
        signal: p.signal,
        onText: (t) => p.emit('text', { text: t }),
        onThinking: (t) => p.emit('thinking', { text: t }),
      })
    } catch (e) {
      const msg = String(e.message || e)
      if (history.some((m) => m.images) && /image|vision|multimodal|projector/i.test(msg)) {
        history = history.map(({ images, ...m }) => m)
        p.emit('notice', { text: `${p.model} can't look at images, so the attached image(s) were skipped. Pick a vision model (e.g. qwen2.5vl or Qwen 3.8) to analyse images.` })
        step--
        continue
      }
      if (tools.length && /does not support tools/i.test(msg)) {
        tools = []
        system = await prompt(false)
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

    if (step === maxSteps - 1) {
      p.emit('notice', { text: `Stopped after ${maxSteps} steps. Send “continue” to keep going.` })
    }
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
        output = await impl(ctx, call.args || {})
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

module.exports = { runAgent, resolvePath, buildSystemPrompt, toolsFor, IMPLEMENTATIONS, needsApproval, compactMessages, truncate }
