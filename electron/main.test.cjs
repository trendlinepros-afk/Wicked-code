// Unit tests for main-process logic. Run with `npm test`.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const { ModelManager, parseModelId } = require('./modelManager.cjs')
const { toAnthropic, toOpenAiMessages } = require('./providers.cjs')
const { runAgent, resolvePath, IMPLEMENTATIONS, needsApproval } = require('./agent.cjs')
const { Vault, toMarkdown } = require('./vault.cjs')
const { parseNvidia, parseRocm } = require('./gpu.cjs')
const { Ollama } = require('./ollama.cjs')
const { Config } = require('./config.cjs')

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wicked-'))

function fakeOllama() {
  const calls = []
  return {
    calls,
    load: async (m) => calls.push(['load', m]),
    unload: async (m) => calls.push(['unload', m]),
  }
}

test('parseModelId', () => {
  assert.deepStrictEqual(parseModelId('ollama:qwen3.8:27b'), { provider: 'ollama', model: 'qwen3.8:27b' })
  assert.deepStrictEqual(parseModelId('anthropic:claude-opus-5-5'), { provider: 'anthropic', model: 'claude-opus-5-5' })
})

test('model manager auto-loads on touch and unloads after idle window', async () => {
  let now = 0
  const ollama = fakeOllama()
  const mm = new ModelManager({ ollama, idleSeconds: () => 30, initialModel: 'ollama:qwen3.8:27b', now: () => now })
  mm.touch()
  await mm.queue
  assert.strictEqual(mm.status, 'loaded')
  assert.deepStrictEqual(ollama.calls, [['load', 'qwen3.8:27b']])

  now = 29_000
  mm.tick()
  await mm.queue
  assert.strictEqual(mm.status, 'loaded')

  // Busy (generating) blocks idle unload.
  mm.beginBusy()
  now = 100_000
  mm.tick()
  assert.strictEqual(mm.status, 'loaded')
  mm.endBusy()
  now = 129_999
  mm.tick()
  await mm.queue
  assert.strictEqual(mm.status, 'loaded')
  now = 130_000
  mm.tick()
  await mm.queue
  assert.strictEqual(mm.status, 'unloaded')
  assert.deepStrictEqual(ollama.calls.at(-1), ['unload', 'qwen3.8:27b'])
})

test('switching models unloads the old one and loads the new one', async () => {
  const ollama = fakeOllama()
  const mm = new ModelManager({ ollama, idleSeconds: () => 30, initialModel: 'ollama:a:1b' })
  await mm.load()
  await mm.setModel('ollama:b:2b')
  assert.deepStrictEqual(ollama.calls, [['load', 'a:1b'], ['unload', 'a:1b'], ['load', 'b:2b']])
  assert.strictEqual(mm.status, 'loaded')

  await mm.setModel('anthropic:claude-sonnet-5-5')
  assert.deepStrictEqual(ollama.calls.at(-1), ['unload', 'b:2b'])
  assert.strictEqual(mm.status, 'cloud')
  mm.touch() // cloud models never load locally
  await mm.queue
  assert.strictEqual(ollama.calls.length, 4)
})

test('anthropic conversion merges tool results into one user turn', () => {
  const { system, messages } = toAnthropic([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'checking', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a' } }, { id: 't2', name: 'read_file', args: { path: 'b' } }] },
    { role: 'tool', toolCallId: 't1', toolName: 'read_file', content: 'A' },
    { role: 'tool', toolCallId: 't2', toolName: 'read_file', content: 'B' },
  ])
  assert.strictEqual(system, 'sys')
  assert.strictEqual(messages.length, 3)
  assert.deepStrictEqual(messages[1].content.map((b) => b.type), ['text', 'tool_use', 'tool_use'])
  assert.deepStrictEqual(messages[2].content.map((b) => b.tool_use_id), ['t1', 't2'])
})

test('openai conversion stringifies tool arguments', () => {
  const out = toOpenAiMessages([{ role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'list_files', args: { path: '.' } }] }])
  assert.strictEqual(out[0].tool_calls[0].function.arguments, '{"path":"."}')
})

test('agent tools stay inside the session folders', async () => {
  const dir = tmpDir()
  assert.throws(() => resolvePath([dir], '../escape.txt'), /outside/)
  assert.throws(() => resolvePath([dir], path.resolve('/etc/passwd')), /outside/)
  await IMPLEMENTATIONS.write_file({ folders: [dir] }, { path: 'src/a.txt', content: 'hello\nworld\n' })
  assert.match(await IMPLEMENTATIONS.read_file({ folders: [dir] }, { path: 'src/a.txt' }), /1 {2}hello/)
  await IMPLEMENTATIONS.edit_file({ folders: [dir] }, { path: 'src/a.txt', old_string: 'world', new_string: 'there' })
  assert.strictEqual(fs.readFileSync(path.join(dir, 'src/a.txt'), 'utf8'), 'hello\nthere\n')
  await assert.rejects(IMPLEMENTATIONS.edit_file({ folders: [dir] }, { path: 'src/a.txt', old_string: 'nope', new_string: 'x' }), /not found/)
  assert.match(await IMPLEMENTATIONS.search_files({ folders: [dir] }, { pattern: 'there' }), /src\/a.txt:2/)
  assert.match(await IMPLEMENTATIONS.list_files({ folders: [dir] }, {}), /src\/a.txt/)
  assert.match(await IMPLEMENTATIONS.run_command({ folders: [dir] }, { command: 'echo hi' }), /exit code: 0[\s\S]*hi/)
})

test('approval rules follow permission mode', () => {
  assert.strictEqual(needsApproval('read_file', 'ask'), false)
  assert.strictEqual(needsApproval('edit_file', 'ask'), true)
  assert.strictEqual(needsApproval('edit_file', 'auto-edits'), false)
  assert.strictEqual(needsApproval('run_command', 'auto-edits'), true)
  assert.strictEqual(needsApproval('run_command', 'auto-all'), false)
})

test('agent loop runs tool calls against a fake Ollama server', async () => {
  const dir = tmpDir()
  let turn = 0
  const bodies = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      res.setHeader('Content-Type', 'application/x-ndjson')
      if (turn++ === 0) {
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'Writing it. ' } }) + '\n')
        res.write(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'hello.py', content: 'print("hi")\n' } } }] } }) + '\n')
      } else {
        res.write(JSON.stringify({ message: { role: 'assistant', content: 'Done!' } }) + '\n')
      }
      res.end(JSON.stringify({ done: true }) + '\n')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const ollama = new Ollama(() => `http://127.0.0.1:${server.address().port}`)
  const events = []
  try {
    const produced = await runAgent({
      mode: 'code',
      provider: 'ollama',
      model: 'qwen3.8:27b',
      history: [{ role: 'user', content: 'make hello.py' }],
      folders: [dir],
      memory: 'User likes Python.',
      apiKey: null,
      ollama,
      numCtx: 8192,
      permissionMode: 'ask',
      signal: new AbortController().signal,
      emit: (type, p) => events.push(type),
      requestApproval: async () => true,
    })
    assert.strictEqual(fs.readFileSync(path.join(dir, 'hello.py'), 'utf8'), 'print("hi")\n')
    assert.deepStrictEqual(produced.map((m) => m.role), ['assistant', 'tool', 'assistant'])
    assert.strictEqual(produced[2].content, 'Done!')
    assert.ok(bodies[0].tools.some((t) => t.function.name === 'edit_file'))
    assert.match(bodies[0].messages[0].content, /User likes Python/)
    assert.strictEqual(bodies[1].messages.at(-1).role, 'tool')
    assert.ok(events.includes('tool-result'))
  } finally {
    server.close()
  }
})

test('denied approval does not write the file', async () => {
  const dir = tmpDir()
  let turn = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (turn++ === 0) res.write(JSON.stringify({ message: { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'x.txt', content: 'x' } } }] } }) + '\n')
      else res.write(JSON.stringify({ message: { content: 'ok' } }) + '\n')
      res.end(JSON.stringify({ done: true }) + '\n')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const produced = await runAgent({
      mode: 'code', provider: 'ollama', model: 'm', history: [{ role: 'user', content: 'go' }], folders: [dir], memory: null,
      ollama: new Ollama(() => `http://127.0.0.1:${server.address().port}`), numCtx: 0, permissionMode: 'ask',
      signal: new AbortController().signal, emit: () => {}, requestApproval: async () => false,
    })
    assert.strictEqual(fs.existsSync(path.join(dir, 'x.txt')), false)
    assert.ok(produced[1].isError)
  } finally {
    server.close()
  }
})

test('vault saves session json + markdown note and renames on title change', async () => {
  const vaultDir = tmpDir()
  const v = new Vault(() => vaultDir)
  const s = { id: 'abc123', mode: 'chat', title: 'First: title?', model: 'ollama:qwen3.8:27b', folders: [], createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-05T10:00:00.000Z', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi there', model: 'qwen3.8:27b' }] }
  const saved = await v.save(s)
  assert.ok(fs.existsSync(saved.notePath))
  assert.match(saved.notePath, /Wicked Code[\\/]Chats[\\/]2026-10-05 First title \(abc123\)\.md$/)
  assert.match(fs.readFileSync(saved.notePath, 'utf8'), /## Assistant \(qwen3.8:27b\)\n\nhi there/)
  assert.ok(fs.existsSync(path.join(vaultDir, 'Wicked Code', 'Memory.md')))
  const renamed = await v.save({ ...saved, title: 'Renamed' })
  assert.ok(!fs.existsSync(saved.notePath))
  assert.ok(fs.existsSync(renamed.notePath))
  assert.strictEqual((await v.list()).length, 1)
  await v.remove('abc123')
  assert.strictEqual((await v.list()).length, 0)
  assert.ok(!fs.existsSync(renamed.notePath))
})

test('markdown includes code folder and tool callouts', () => {
  const md = toMarkdown({ id: '1', mode: 'code', title: 'T', model: 'm', folders: ['/p'], createdAt: 'c', updatedAt: 'u', messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'run_command', args: { command: 'npm test' } }] }] })
  assert.match(md, /type: wicked-code-session/)
  assert.match(md, /\*\*Working folder:\*\* `\/p`/)
  assert.match(md, /> \[!example\]- Tool: run_command — npm test/)
})

test('gpu parsers', () => {
  assert.deepStrictEqual(parseNvidia('NVIDIA GeForce RTX 4090, 24564, 1200\n'), [{ name: 'NVIDIA GeForce RTX 4090', totalMB: 24564, usedMB: 1200 }])
  const rocm = parseRocm(JSON.stringify({ card0: { 'VRAM Total Memory (B)': '17163091968', 'VRAM Total Used Memory (B)': '1073741824', 'Card series': 'RX 7800 XT' } }))
  assert.deepStrictEqual(rocm, [{ name: 'RX 7800 XT', totalMB: 16368, usedMB: 1024 }])
})

test('config stores api keys encrypted and hides them from the renderer', () => {
  const dir = tmpDir()
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s),
    decryptString: (b) => b.toString().slice(4),
  }
  const c = new Config(dir, fakeSafe)
  c.setApiKey('anthropic', 'sk-ant-secret1234')
  const raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf8')
  assert.ok(!raw.includes('sk-ant-secret1234'))
  assert.strictEqual(new Config(dir, fakeSafe).getApiKey('anthropic'), 'sk-ant-secret1234')
  const pub = c.publicSettings()
  assert.deepStrictEqual(pub.apiKeys.anthropic, { set: true, hint: '…1234' })
  assert.ok(!JSON.stringify(pub).includes('secret'))
})

test('updater: check → auto-download → downloaded → install', async () => {
  const { Updater } = require('./updater.cjs')
  const { EventEmitter } = require('events')
  const au = new EventEmitter()
  let installed = null
  au.checkForUpdates = async () => {
    au.emit('checking-for-update')
    au.emit('update-available', { version: '0.2.0' })
  }
  au.downloadUpdate = async () => {
    au.emit('download-progress', { percent: 42.4 })
    au.emit('update-downloaded', { version: '0.2.0' })
  }
  au.quitAndInstall = (silent, runAfter) => (installed = { silent, runAfter })
  const u = new Updater({ supported: true, currentVersion: '0.1.0', getAutoUpdater: () => au })
  const seen = []
  u.on('status', (s) => seen.push(s.status))
  assert.strictEqual(u.install(), false) // nothing downloaded yet
  await u.check()
  await new Promise((r) => setImmediate(r))
  assert.strictEqual(au.autoDownload, false)
  assert.strictEqual(au.autoInstallOnAppQuit, true) // "later" installs on next quit
  assert.deepStrictEqual(seen, ['checking', 'checking', 'downloading', 'downloading', 'downloaded'])
  assert.strictEqual(u.state.version, '0.2.0')
  // Checking again after download re-emits so the install popup reappears.
  await u.check()
  assert.strictEqual(seen.at(-1), 'downloaded')
  assert.strictEqual(u.install(), true)
  await new Promise((r) => setImmediate(r))
  assert.deepStrictEqual(installed, { silent: false, runAfter: true })
})

test('updater: no update, errors, and dev mode', async () => {
  const { Updater } = require('./updater.cjs')
  const { EventEmitter } = require('events')
  const dev = new Updater({ supported: false, currentVersion: '0.1.0', getAutoUpdater: () => assert.fail('must not load in dev') })
  assert.strictEqual((await dev.check()).status, 'unsupported')

  const au = new EventEmitter()
  au.checkForUpdates = async () => au.emit('update-not-available', {})
  const u = new Updater({ supported: true, currentVersion: '0.1.0', getAutoUpdater: () => au })
  assert.strictEqual((await u.check()).status, 'none')
  au.checkForUpdates = async () => {
    throw new Error('net down')
  }
  const s = await u.check()
  assert.strictEqual(s.status, 'error')
  assert.strictEqual(s.error, 'net down')
})

// ---------- agent loop: build → run → test → fix ----------

/** Fake Ollama that replays a scripted conversation and records each request. */
async function scriptedOllama(script) {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw)
      requests.push(body)
      const step = script[requests.length - 1] || { content: 'done' }
      res.setHeader('Content-Type', 'application/x-ndjson')
      const msg = { role: 'assistant', content: step.content || '' }
      if (step.tool) msg.tool_calls = [{ function: { name: step.tool, arguments: step.args } }]
      res.write(JSON.stringify({ message: msg }) + '\n')
      res.end(JSON.stringify({ done: true }) + '\n')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, requests, ollama: new Ollama(() => `http://127.0.0.1:${server.address().port}`) }
}

test('agent loop: writes code, runs the test, sees the failure, fixes it, re-runs until it passes', async () => {
  const dir = tmpDir()
  const testCmd = 'node test.js'
  const { server, requests, ollama } = await scriptedOllama([
    { content: 'Writing add().', tool: 'write_file', args: { path: 'add.js', content: 'module.exports = (a, b) => a - b\n' } },
    { tool: 'write_file', args: { path: 'test.js', content: "const add = require('./add'); if (add(2, 3) !== 5) { console.error('FAIL: add(2,3) = ' + add(2, 3)); process.exit(1) } console.log('PASS')\n" } },
    { content: 'Running tests.', tool: 'run_command', args: { command: testCmd } },
    { content: 'Test failed, fixing the operator.', tool: 'edit_file', args: { path: 'add.js', old_string: 'a - b', new_string: 'a + b' } },
    { tool: 'run_command', args: { command: testCmd } },
    { content: 'All tests pass.' },
  ])
  try {
    const produced = await runAgent({
      mode: 'code', provider: 'ollama', model: 'qwen3.8:27b', history: [{ role: 'user', content: 'write add() with a test' }],
      folders: [dir], memory: null, ollama, numCtx: 16384, permissionMode: 'auto-all',
      signal: new AbortController().signal, emit: () => {}, requestApproval: async () => true,
    })
    const toolResults = produced.filter((m) => m.role === 'tool')
    assert.match(toolResults[2].content, /exit code: 1[\s\S]*FAIL: add\(2,3\) = -1/)
    assert.match(toolResults[4].content, /exit code: 0[\s\S]*PASS/)
    // The failing output was fed back to the model before it made the fix.
    assert.match(requests[3].messages.at(-1).content, /FAIL/)
    assert.strictEqual(produced.at(-1).content, 'All tests pass.')
    assert.strictEqual(fs.readFileSync(path.join(dir, 'add.js'), 'utf8'), 'module.exports = (a, b) => a + b\n')
    // The system prompt tells the model to work in a test-and-fix loop.
    assert.match(requests[0].messages[0].content, /build → run → test → fix/)
  } finally {
    server.close()
  }
})

test('agent loop: starts a server in the background, tests it over HTTP, then stops it', async () => {
  const { ProcessManager } = require('./processes.cjs')
  const dir = tmpDir()
  const port = 40000 + Math.floor(Math.random() * 20000)
  fs.writeFileSync(
    path.join(dir, 'server.js'),
    `require('http').createServer((q, s) => s.end(JSON.stringify({ ok: true, path: q.url }))).listen(${port}, () => console.log('listening on ${port}'))\n`,
  )
  const processes = new ProcessManager()
  const { server, ollama } = await scriptedOllama([
    { tool: 'start_process', args: { command: 'node server.js', ready_pattern: 'listening' } },
    { tool: 'http_request', args: { url: `http://localhost:${port}/health` } },
    { tool: 'http_request', args: { url: 'https://example.com/' } },
    { tool: 'list_processes', args: {} },
    { tool: 'stop_process', args: { id: 'p1' } },
    { content: 'Server works.' },
  ])
  try {
    const produced = await runAgent({
      mode: 'code', provider: 'ollama', model: 'm', history: [{ role: 'user', content: 'run the server and check it' }],
      folders: [dir], memory: null, ollama, numCtx: 16384, permissionMode: 'auto-all', processes, owner: 's1',
      signal: new AbortController().signal, emit: () => {}, requestApproval: async () => true,
    })
    const results = produced.filter((m) => m.role === 'tool').map((m) => m.content)
    assert.match(results[0], /Started background process p1[\s\S]*ready pattern matched[\s\S]*listening on/)
    assert.match(results[1], /HTTP 200[\s\S]*"ok":true,"path":"\/health"/)
    assert.match(results[2], /only works with local servers/) // no outbound requests
    assert.match(results[3], /p1 {2}running {2}node server.js/)
    assert.match(results[4], /Stopped p1/)
    await new Promise((r) => setTimeout(r, 500))
    assert.strictEqual(processes.list()[0].status, 'exited')
  } finally {
    processes.stopAll()
    server.close()
  }
})

test('run_command honours timeout_seconds and points at start_process', async () => {
  const out = await IMPLEMENTATIONS.run_command({ folders: [tmpDir()] }, { command: 'node -e "setTimeout(()=>{}, 10000)"', timeout_seconds: 1 })
  assert.match(out, /timed out after 1s — for servers use start_process/)
})

test('approval is required for commands, processes and PRs unless auto-all', () => {
  for (const t of ['run_command', 'start_process', 'github_create_pull_request']) {
    assert.strictEqual(needsApproval(t, 'auto-edits'), true)
    assert.strictEqual(needsApproval(t, 'auto-all'), false)
  }
  assert.strictEqual(needsApproval('http_request', 'ask'), false)
})

test('compactMessages trims old tool output first and keeps recent messages intact', () => {
  const { compactMessages } = require('./agent.cjs')
  const big = 'x'.repeat(5000)
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'goal' }]
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: 'c' + i, name: 'read_file', args: { path: 'f' } }] })
    msgs.push({ role: 'tool', toolCallId: 'c' + i, toolName: 'read_file', content: big })
  }
  const out = compactMessages(msgs, 20_000)
  const total = out.reduce((a, m) => a + m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), 0)
  assert.ok(total <= 20_000, `total ${total}`)
  assert.strictEqual(out[0].content, 'sys')
  assert.strictEqual(out[1].content, 'goal')
  assert.strictEqual(out.at(-1).content, big) // latest output untouched
  assert.match(out[3].content, /older output trimmed/)
  assert.strictEqual(msgs[3].content, big) // input not mutated
  assert.strictEqual(compactMessages(msgs, 1e9), msgs)
})

test('truncate keeps the head and the tail (where errors are)', () => {
  const { truncate } = require('./agent.cjs')
  const s = 'START' + 'x'.repeat(50_000) + 'ERROR AT END'
  const t = truncate(s, 1000)
  assert.ok(t.startsWith('START'))
  assert.ok(t.endsWith('ERROR AT END'))
  assert.ok(t.length < 1100)
})

test('code-mode tool set depends on capabilities', () => {
  const { toolsFor } = require('./agent.cjs')
  const names = (caps) => toolsFor('code', ['/x'], caps).map((t) => t.name)
  assert.ok(!names({}).includes('start_process'))
  assert.ok(names({ processes: true, browser: true }).includes('browser_check'))
  assert.ok(names({ github: true }).includes('github_create_pull_request'))
  assert.ok(!toolsFor('chat', ['/x'], { processes: true }).some((t) => t.name === 'write_file'))
})

// ---------- GitHub ----------

test('github remote parsing and git auth env (token never in URLs)', () => {
  const { parseGithubRemote, gitAuthEnv } = require('./github.cjs')
  assert.deepStrictEqual(parseGithubRemote('https://github.com/trendlinepros-afk/Wicked-code.git'), { owner: 'trendlinepros-afk', repo: 'Wicked-code', fullName: 'trendlinepros-afk/Wicked-code' })
  assert.strictEqual(parseGithubRemote('git@github.com:a/b.git').fullName, 'a/b')
  assert.strictEqual(parseGithubRemote('https://gitlab.com/a/b.git'), null)
  const env = gitAuthEnv('tok123')
  assert.strictEqual(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader')
  assert.strictEqual(Buffer.from(env.GIT_CONFIG_VALUE_0.split(' ').pop(), 'base64').toString(), 'x-access-token:tok123')
})

test('github repoInfo reads branch and origin from a local clone', async () => {
  const { repoInfo, git } = require('./github.cjs')
  const dir = tmpDir()
  await git(['init', '-b', 'feature/x'], { cwd: dir })
  await git(['remote', 'add', 'origin', 'https://github.com/me/proj.git'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
  const info = await repoInfo(dir)
  assert.strictEqual(info.fullName, 'me/proj')
  assert.strictEqual(info.branch, 'feature/x')
  assert.strictEqual(info.dirty, 1)
  assert.strictEqual(await repoInfo(tmpDir()), null)
})

test('github createPullRequest posts head/base to the API', async () => {
  const { GitHub, git } = require('./github.cjs')
  const dir = tmpDir()
  await git(['init', '-b', 'wicked/feat'], { cwd: dir })
  await git(['remote', 'add', 'origin', 'https://github.com/me/proj.git'], { cwd: dir })
  const calls = []
  const realFetch = global.fetch
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body), auth: opts.headers.Authorization })
    const json = url.endsWith('/pulls') ? { number: 7, html_url: 'https://github.com/me/proj/pull/7' } : { default_branch: 'main' }
    return new Response(JSON.stringify(json), { status: url.endsWith('/pulls') ? 201 : 200 })
  }
  try {
    const out = await new GitHub(() => 'tok').createPullRequest(dir, { title: 'Add thing', body: 'Tested.' })
    assert.strictEqual(out, 'Opened pull request #7: https://github.com/me/proj/pull/7')
    assert.deepStrictEqual(calls[1].body, { title: 'Add thing', body: 'Tested.', head: 'wicked/feat', base: 'main', draft: false })
    assert.strictEqual(calls[1].auth, 'Bearer tok')
  } finally {
    global.fetch = realFetch
  }
})

// ---------- Ollama launcher ----------

test('ollama launcher starts `ollama serve` when not running, and stops only what it started', async () => {
  const { OllamaLauncher } = require('./ollamaLauncher.cjs')
  const { EventEmitter } = require('events')
  let running = false
  let spawned = null
  const child = Object.assign(new EventEmitter(), { kill: () => (child.killed = true) })
  const launcher = new OllamaLauncher({
    ollama: { isRunning: async () => running },
    getUrl: () => 'http://127.0.0.1:11434',
    logFile: path.join(tmpDir(), 'ollama.log'),
    find: async () => '/usr/bin/ollama',
    spawnFn: (bin, args, opts) => {
      spawned = { bin, args, host: opts.env.OLLAMA_HOST }
      setTimeout(() => (running = true), 600)
      return child
    },
  })
  const st = await launcher.ensure()
  assert.deepStrictEqual(spawned, { bin: '/usr/bin/ollama', args: ['serve'], host: '127.0.0.1:11434' })
  assert.strictEqual(st.status, 'running')
  assert.strictEqual(st.startedByApp, true)
  assert.strictEqual(launcher.stop(), true)
  assert.ok(child.killed)

  // Already running → nothing spawned, nothing stopped.
  spawned = null
  const l2 = new OllamaLauncher({ ollama: { isRunning: async () => true }, getUrl: () => 'http://127.0.0.1:11434', logFile: '/dev/null', find: async () => assert.fail(), spawnFn: () => assert.fail() })
  assert.strictEqual((await l2.ensure()).startedByApp, false)
  assert.strictEqual(l2.stop(), false)

  const l3 = new OllamaLauncher({ ollama: { isRunning: async () => false }, getUrl: () => 'http://127.0.0.1:11434', logFile: '/dev/null', find: async () => null })
  assert.strictEqual((await l3.ensure()).status, 'not-installed')
})

// ---------- settings survive updates ----------

test('settings from an older version load with new defaults and nothing lost', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ vaultPath: '/v', selectedModel: 'ollama:qwen3.8:27b', modelNotes: { a: 'n' }, contextLength: 8192, apiKeys: { grok: { plain: 'k' } } }))
  const c = new Config(dir, null)
  assert.strictEqual(c.get('vaultPath'), '/v')
  assert.strictEqual(c.get('contextLength'), 8192) // user's choice kept, not reset to the new default
  assert.deepStrictEqual(c.get('modelNotes'), { a: 'n' })
  assert.strictEqual(c.getApiKey('grok'), 'k')
  assert.strictEqual(c.get('autoStartOllama'), true) // new setting gets its default
  assert.strictEqual(c.get('theme'), 'system')
  assert.deepStrictEqual(c.get('favoriteModels'), []) // added in 0.2.2
  c.set('favoriteModels', ['qwen3.8:27b'])
  assert.deepStrictEqual(new Config(dir, null).get('favoriteModels'), ['qwen3.8:27b'])
})

test('a corrupted settings file falls back to the backup copy', () => {
  const dir = tmpDir()
  const c = new Config(dir, null)
  c.set('vaultPath', '/first')
  c.set('theme', 'light') // creates config.json.bak with the previous state
  fs.writeFileSync(path.join(dir, 'config.json'), '{"vaultPath": "/fir') // simulate a crash mid-write
  const c2 = new Config(dir, null)
  assert.strictEqual(c2.get('vaultPath'), '/first')
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('config.json.corrupt-')))
})

test('updater: a build that cannot self-update never gets stuck on "checking"', async () => {
  const { Updater } = require('./updater.cjs')
  const { EventEmitter } = require('events')
  const au = new EventEmitter()
  au.checkForUpdates = async () => null // what electron-updater does when it isn't active
  const u = new Updater({ supported: true, currentVersion: '0.2.0', getAutoUpdater: () => au })
  assert.strictEqual((await u.check()).status, 'unsupported')
})

test('gpu: reads utilization + temperature and works out VRAM used by other apps', async () => {
  const { parseNvidia, getGpuStats } = require('./gpu.cjs')
  assert.deepStrictEqual(parseNvidia('NVIDIA GeForce RTX 5070 Ti, 16303, 4096, 1, 41\n'), [
    { name: 'NVIDIA GeForce RTX 5070 Ti', totalMB: 16303, usedMB: 4096, utilization: 1, temperatureC: 41 },
  ])
  // Without a real GPU here, check the shape and that RAM/CPU readings are filled in.
  const s1 = await getGpuStats(async () => [])
  const s2 = await getGpuStats(async () => [{ name: 'm', size: 2 * 1048576 * 1024, sizeVram: 1048576 * 1024 }])
  assert.ok(s2.ramUsedMB > 0 && s2.ramUsedMB <= s2.systemRamMB)
  assert.ok(s2.cpuPercent === null || (s2.cpuPercent >= 0 && s2.cpuPercent <= 100))
  assert.strictEqual(s2.ollamaVramMB, 1024)
  assert.strictEqual(s2.otherUsedMB, Math.max(0, s2.usedMB - 1024))
  assert.deepStrictEqual(s2.models, [{ name: 'm', vramMB: 1024, totalMB: 2048 }])
  assert.ok('otherUsedMB' in s1)
})

test('selecting a model without loading it ("Use this model")', async () => {
  const ollama = fakeOllama()
  const mm = new ModelManager({ ollama, idleSeconds: () => 30, initialModel: 'ollama:a:1b' })
  await mm.load()
  await mm.setModel('ollama:b:2b', { load: false })
  // The old model is freed from VRAM, the new one is only selected.
  assert.deepStrictEqual(ollama.calls, [['load', 'a:1b'], ['unload', 'a:1b']])
  assert.strictEqual(mm.current, 'ollama:b:2b')
  assert.strictEqual(mm.status, 'unloaded')
  await mm.load() // user presses "Load model"
  assert.deepStrictEqual(ollama.calls.at(-1), ['load', 'b:2b'])
  assert.strictEqual(mm.status, 'loaded')
})

test('idle unload can be turned off ("Never") and keep_alive follows the setting', async () => {
  const { keepAliveFor } = require('./modelManager.cjs')
  assert.strictEqual(keepAliveFor(0), -1)
  assert.strictEqual(keepAliveFor(30), '600s')
  assert.strictEqual(keepAliveFor(3600), '3900s')
  let now = 0
  let idle = 0
  const ollama = { calls: [], load: async (m, ka) => ollama.calls.push(['load', m, ka]), unload: async (m) => ollama.calls.push(['unload', m]) }
  const mm = new ModelManager({ ollama, idleSeconds: () => idle, initialModel: 'ollama:a:1b', now: () => now })
  mm.touch()
  await mm.queue
  assert.deepStrictEqual(ollama.calls[0], ['load', 'a:1b', -1])
  now = 10 * 3600 * 1000
  mm.tick()
  await mm.queue
  assert.strictEqual(mm.status, 'loaded') // never unloads
  assert.strictEqual(mm.state().idleRemaining, null)
  idle = 60 // user switches back to 1 minute
  mm.tick()
  await mm.queue
  assert.strictEqual(mm.status, 'unloaded')
})

// ---------- chat naming ----------

test('cleanTitle strips thinking, labels, quotes and punctuation', () => {
  const { cleanTitle, fallbackTitle } = require('./titles.cjs')
  assert.strictEqual(cleanTitle('<think>The user asks about Rust…</think>\n"Understanding Rust Lifetimes."'), 'Understanding Rust Lifetimes')
  assert.strictEqual(cleanTitle('Title: **Fixing Login Bug**'), 'Fixing Login Bug')
  assert.strictEqual(cleanTitle('Sure!\nHome Lab Network Plan'), 'Home Lab Network Plan')
  assert.ok(cleanTitle('word '.repeat(40)).length <= 60)
  assert.strictEqual(fallbackTitle('  can you help me   set up a postgres database for my side project please '), 'can you help me set up a')
})

test('generateTitle asks the session model and falls back on failure', async () => {
  const { generateTitle } = require('./titles.cjs')
  let body
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      body = JSON.parse(raw)
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'Postgres Setup For Side Project' } }) + '\n')
      res.end(JSON.stringify({ done: true }) + '\n')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const ollama = new Ollama(() => `http://127.0.0.1:${server.address().port}`)
    const messages = [{ role: 'user', content: 'help me set up postgres' }, { role: 'assistant', content: 'Sure, first install…' }]
    const t = await generateTitle({ provider: 'ollama', model: 'qwen3:8b', ollama, ollamaOptions: { num_ctx: 16384 }, messages })
    assert.strictEqual(t, 'Postgres Setup For Side Project')
    assert.deepStrictEqual(body.options, { num_ctx: 16384 }) // same options as chats: no model reload
    assert.ok(!body.tools)
    assert.match(body.messages[1].content, /User: help me set up postgres/)
    const dead = new Ollama(() => 'http://127.0.0.1:9')
    assert.strictEqual(await generateTitle({ provider: 'ollama', model: 'x', ollama: dead, messages }), 'help me set up postgres')
  } finally {
    server.close()
  }
})

test('force unload (Ctrl+U) mid-reply unloads everything and stays unloaded', async () => {
  const ollama = fakeOllama()
  const mm = new ModelManager({ ollama, idleSeconds: () => 30, initialModel: 'ollama:qwen3:8b' })
  await mm.load()
  mm.beginBusy() // a reply is streaming
  await mm.forceUnload(['qwen3:8b', 'other:7b'])
  assert.strictEqual(mm.status, 'unloaded')
  assert.deepStrictEqual(ollama.calls.filter((c) => c[0] === 'unload').map((c) => c[1]).sort(), ['other:7b', 'qwen3:8b'])
  mm.endBusy() // the aborted run finishes afterwards
  assert.strictEqual(mm.status, 'unloaded') // not flipped back to "loaded"
})

// ---------- attachments (drag & drop) ----------

function makePdf(text) {
  // Minimal one-page PDF with real (selectable) text and a correct xref table.
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

test('attachments: text is extracted from Word, PDF, Excel, PowerPoint and text files', async () => {
  const { extractFiles } = require('./attachments.cjs')
  const { markdownToDocx } = require('./docwriter.cjs')
  const ExcelJS = require('exceljs')
  const JSZip = require('jszip')
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'proposal.docx'), await markdownToDocx('# Q3 Proposal\n\nWe will **grow** revenue.\n\n- Hire two engineers\n- Ship v2'))
  fs.writeFileSync(path.join(dir, 'invoice.pdf'), makePdf('Invoice total 4200 USD'))
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Budget')
  ws.addRow(['Item', 'Cost'])
  ws.addRow(['GPU', 899])
  await wb.xlsx.writeFile(path.join(dir, 'budget.xlsx'))
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>Roadmap &amp; Goals</a:t></a:r></a:p></p:sld>')
  zip.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>Launch in May</a:t></a:r></a:p></p:sld>')
  fs.writeFileSync(path.join(dir, 'deck.pptx'), await zip.generateAsync({ type: 'nodebuffer' }))
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\nremember the milk')
  fs.writeFileSync(path.join(dir, 'photo.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  fs.writeFileSync(path.join(dir, 'old.doc'), 'x')
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 5]))

  const r = Object.fromEntries((await extractFiles(fs.readdirSync(dir).map((f) => path.join(dir, f)))).map((a) => [a.name, a]))
  assert.match(r['proposal.docx'].text, /Q3 Proposal[\s\S]*grow[\s\S]*Hire two engineers/)
  assert.match(r['invoice.pdf'].text, /Page 1[\s\S]*Invoice total 4200 USD/)
  assert.strictEqual(r['invoice.pdf'].pages, 1)
  assert.match(r['budget.xlsx'].text, /## Sheet: Budget\nItem,Cost\nGPU,899/)
  assert.match(r['deck.pptx'].text, /Slide 1 ---\nRoadmap & Goals[\s\S]*Slide 2 ---\nLaunch in May/)
  assert.strictEqual(r['notes.md'].kind, 'text')
  assert.strictEqual(r['photo.png'].kind, 'image')
  assert.strictEqual(r['photo.png'].text, undefined)
  assert.match(r['old.doc'].error, /save it as \.docx/)
  assert.match(r['blob.bin'].error, /Unsupported/)
})

test('attachments: expanded into the user message; images go to vision payloads per provider', async () => {
  const { expandAttachments } = require('./attachments.cjs')
  const dir = tmpDir()
  const png = path.join(dir, 'chart.png')
  fs.writeFileSync(png, Buffer.from('89504e47', 'hex'))
  const msgs = expandAttachments([
    { role: 'user', content: 'summarise this', attachments: [{ name: 'a.docx', path: '/x/a.docx', kind: 'document', text: 'DOC BODY' }, { name: 'chart.png', path: png, kind: 'image' }] },
  ])
  assert.match(msgs[0].content, /<attached_file name="a.docx" path="\/x\/a.docx">\nDOC BODY\n<\/attached_file>/)
  assert.match(msgs[0].content, /\[Attached image: chart.png\][\s\S]*summarise this$/)
  assert.deepStrictEqual(msgs[0].images, [{ mime: 'image/png', data: Buffer.from('89504e47', 'hex').toString('base64') }])
  assert.ok(!('attachments' in msgs[0]))
  const { toOllamaMessages, toOpenAiMessages, toAnthropic } = require('./providers.cjs')
  assert.deepStrictEqual(toOllamaMessages(msgs)[0].images, [msgs[0].images[0].data])
  assert.strictEqual(toOpenAiMessages(msgs)[0].content[0].image_url.url, `data:image/png;base64,${msgs[0].images[0].data}`)
  assert.strictEqual(toAnthropic(msgs).messages[0].content[0].source.media_type, 'image/png')
})

test('save_document writes a real .docx next to the original and never overwrites', async () => {
  const { saveDocument } = require('./docwriter.cjs')
  const { extractFile } = require('./attachments.cjs')
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'Report.docx'), 'ORIGINAL')
  const msg = await saveDocument([dir], { filename: 'Report.docx', content: '# Report\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n1. First\n2. Second' })
  assert.match(msg, /Report \(2\)\.docx[\s\S]*not overwritten/)
  assert.strictEqual(fs.readFileSync(path.join(dir, 'Report.docx'), 'utf8'), 'ORIGINAL')
  const back = await extractFile(path.join(dir, 'Report (2).docx'))
  assert.match(back.text, /Report[\s\S]*First[\s\S]*Second/)
  await assert.rejects(saveDocument([], { filename: 'x.docx', content: 'x' }), /No attached files/)
  await saveDocument([dir], { filename: '../../escape.md', content: 'hi' }) // path parts are stripped
  assert.ok(fs.existsSync(path.join(dir, 'escape.md')))
})

test('chat agent reads an attached Word doc and saves an edited copy (with approval)', async () => {
  const { markdownToDocx } = require('./docwriter.cjs')
  const { extractFile } = require('./attachments.cjs')
  const dir = tmpDir()
  const original = path.join(dir, 'Letter.docx')
  fs.writeFileSync(original, await markdownToDocx('Dear Sam,\n\nThanks for teh help.'))
  const att = await extractFile(original)
  const { server, requests, ollama } = await scriptedOllama([
    { content: 'Fixed the typo.', tool: 'save_document', args: { filename: 'Letter (edited).docx', content: 'Dear Sam,\n\nThanks for the help.' } },
    { content: 'Saved **Letter (edited).docx** next to your original.' },
  ])
  const approvals = []
  try {
    const produced = await runAgent({
      mode: 'chat', provider: 'ollama', model: 'm', history: [{ role: 'user', content: 'fix the typos', attachments: [att] }],
      folders: [], memory: null, ollama, numCtx: 8192, permissionMode: 'ask',
      signal: new AbortController().signal, emit: () => {}, requestApproval: async (c) => (approvals.push(c.name), true),
    })
    assert.deepStrictEqual(approvals, ['save_document'])
    assert.ok(requests[0].tools.some((t) => t.function.name === 'save_document'))
    assert.match(requests[0].messages[1].content, /<attached_file name="Letter.docx"[\s\S]*Thanks for teh help/)
    assert.match(requests[0].messages[0].content, /attached files/)
    const edited = await extractFile(path.join(dir, 'Letter (edited).docx'))
    assert.match(edited.text, /Thanks for the help/)
    assert.match(produced[1].content, /Saved .*Letter \(edited\)\.docx/)
  } finally {
    server.close()
  }
})

// ---------- small models that type tool calls as text (qwen2.5-coder:7b) ----------

test('tool calls typed as JSON text are recognised and removed from the reply', () => {
  const { parseTextToolCalls } = require('./toolparse.cjs')
  const names = ['list_files', 'write_file', 'run_command']
  // Exactly the shape qwen2.5-coder:7b produced in the user's session.
  const reply =
    '{"name":"list_files","arguments":{"path":"."}}\n\n// Assuming list_files returns an empty array, let\'s create a new file for our snake game\n\n' +
    '{"name":"write_file","arguments":{"path":"snake_game.js","content":"const canvas = document.createElement(\'canvas\');\\ncanvas.width = 800;\\nif (a) { b(); }"}}'
  const r = parseTextToolCalls(reply, names)
  assert.deepStrictEqual(r.calls.map((c) => c.name), ['list_files', 'write_file'])
  assert.strictEqual(r.calls[1].args.path, 'snake_game.js')
  assert.match(r.calls[1].args.content, /canvas.width = 800;\nif \(a\) \{ b\(\); \}/)
  assert.strictEqual(r.text, "// Assuming list_files returns an empty array, let's create a new file for our snake game")
  // other wrappers: <tool_call> tags, ```json fences, {"function": …}, raw newlines inside strings, string arguments
  assert.strictEqual(parseTextToolCalls('<tool_call>\n{"name": "run_command", "arguments": {"command": "npm test"}}\n</tool_call>', names).calls[0].args.command, 'npm test')
  assert.strictEqual(parseTextToolCalls('```json\n{"function": {"name": "list_files", "arguments": "{\\"path\\": \\"src\\"}"}}\n```', names).calls[0].args.path, 'src')
  assert.strictEqual(parseTextToolCalls('{"name":"write_file","arguments":{"path":"a.txt","content":"line1\nline2"}}', names).calls[0].args.content, 'line1\nline2')
  // not tool calls: unknown names, plain JS objects, prose
  assert.strictEqual(parseTextToolCalls('{"name":"delete_everything","arguments":{}}', names).calls.length, 0)
  assert.strictEqual(parseTextToolCalls('let apple = {x: 1, y: 2}', names).calls.length, 0)
  assert.strictEqual(parseTextToolCalls('Here you go.', names).text, 'Here you go.')
})

test('needsNudge catches pasted code and claimed-but-not-done work', () => {
  const { needsNudge } = require('./agent.cjs')
  const code = 'Here it is:\n```html\n<html>\n<body>\n<canvas></canvas>\n<script>\nlet x = 1\n</script>\n</body>\n</html>\n```'
  assert.match(needsNudge(code, []), /did not create or change any files/)
  assert.match(needsNudge('I have created index.html and tested it.', []), /no tool did that/)
  const wrote = [{ role: 'tool', toolName: 'write_file', content: 'Created index.html' }]
  assert.strictEqual(needsNudge(code, wrote), null)
  assert.strictEqual(needsNudge('I created index.html.', wrote), null)
  assert.strictEqual(needsNudge('What should the snake look like?', []), null)
})

test('code agent: replay of the snake-game session — text tool calls run, pasted code is nudged into real files, game is opened', async () => {
  const dir = tmpDir()
  const html = '<!doctype html><html><body style="background:#fff"><canvas id="c"></canvas><script>/* snake */</script></body></html>'
  const { server, requests, ollama } = await scriptedOllama([
    // 1) qwen2.5-coder style: tool call as text, plus a hallucinated assumption
    { content: '{"name":"list_files","arguments":{"path":"."}}\n\n// Assuming list_files returns an empty array, let\'s create the game' },
    // 2) pastes code instead of writing it, and claims success
    { content: 'I have created the snake game:\n```html\n<!doctype html>\n<html>\n<body>\n<canvas></canvas>\n<script></script>\n</body>\n</html>\n```' },
    // 3) after the reminder it actually writes the file (still as text)
    { content: '{"name":"write_file","arguments":{"path":"index.html","content":' + JSON.stringify(html) + '}}' },
    { content: 'Opening it for you.', tool: 'open_in_browser', args: { target: 'index.html' } },
    { content: 'Created **index.html** and opened it in your browser.' },
  ])
  const opened = []
  try {
    const produced = await runAgent({
      mode: 'code', provider: 'ollama', model: 'qwen2.5-coder:7b', history: [{ role: 'user', content: 'create the snake game' }],
      folders: [dir], memory: null, ollama, numCtx: 8192, permissionMode: 'auto-all',
      openForUser: async (t) => opened.push(t),
      signal: new AbortController().signal, emit: () => {}, requestApproval: async () => true,
    })
    assert.strictEqual(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), html)
    assert.deepStrictEqual(opened, [{ path: path.join(dir, 'index.html') }])
    const roles = produced.map((m) => (m.synthetic ? 'nudge' : m.role === 'tool' ? `tool:${m.toolName}` : m.role))
    assert.deepStrictEqual(roles, ['assistant', 'tool:list_files', 'assistant', 'nudge', 'assistant', 'tool:write_file', 'assistant', 'tool:open_in_browser', 'assistant'])
    assert.ok(!produced[0].content.includes('"name"')) // raw JSON hidden from the chat
    assert.match(requests[0].messages[0].content, /Never claim you created/)
    assert.ok(requests[0].tools.some((t) => t.function.name === 'open_in_browser'))
  } finally {
    server.close()
  }
})

// ---------- unload button + per-chat permissions ----------

test('unload waits until Ollama really released the model, and the status does not bounce back to loaded', async () => {
  let listed = true
  const calls = []
  const ollama = {
    load: async (m) => calls.push(['load', m]),
    unload: async (m) => {
      calls.push(['unload', m])
      setTimeout(() => (listed = false), 600) // Ollama keeps listing it briefly after answering
    },
    ps: async () => (listed ? [{ name: 'qwen3:8b' }] : []),
  }
  const mm = new ModelManager({ ollama, idleSeconds: () => 30, initialModel: 'ollama:qwen3:8b' })
  await mm.load()
  const started = Date.now()
  await mm.unload()
  assert.ok(Date.now() - started >= 500, 'waited for /api/ps to drop the model')
  assert.strictEqual(mm.status, 'unloaded')
  mm.reconcile([{ name: 'qwen3:8b' }]) // a stale poll result arriving late
  assert.strictEqual(mm.status, 'unloaded')
})

test('per-chat permission can be raised mid-run and releases the waiting approval', async () => {
  const dir = tmpDir()
  const { server, ollama } = await scriptedOllama([
    { tool: 'write_file', args: { path: 'a.txt', content: 'A' } },
    { tool: 'run_command', args: { command: 'echo hi' } },
    { content: 'done' },
  ])
  let permission = 'ask'
  const asked = []
  try {
    await runAgent({
      mode: 'code', provider: 'ollama', model: 'm', history: [{ role: 'user', content: 'go' }], folders: [dir], memory: null, ollama, numCtx: 8192,
      permissionMode: () => permission,
      signal: new AbortController().signal, emit: () => {},
      requestApproval: async (call) => {
        asked.push(call.name)
        permission = 'auto-all' // user picks "Auto-approve everything" from the Permissions menu while asked
        return true
      },
    })
    assert.deepStrictEqual(asked, ['write_file']) // run_command no longer needed approval
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'A')
  } finally {
    server.close()
  }
})
