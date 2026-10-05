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
