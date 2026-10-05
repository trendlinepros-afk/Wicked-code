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
  await IMPLEMENTATIONS.write_file([dir], { path: 'src/a.txt', content: 'hello\nworld\n' })
  assert.match(await IMPLEMENTATIONS.read_file([dir], { path: 'src/a.txt' }), /1 {2}hello/)
  await IMPLEMENTATIONS.edit_file([dir], { path: 'src/a.txt', old_string: 'world', new_string: 'there' })
  assert.strictEqual(fs.readFileSync(path.join(dir, 'src/a.txt'), 'utf8'), 'hello\nthere\n')
  await assert.rejects(IMPLEMENTATIONS.edit_file([dir], { path: 'src/a.txt', old_string: 'nope', new_string: 'x' }), /not found/)
  assert.match(await IMPLEMENTATIONS.search_files([dir], { pattern: 'there' }), /src\/a.txt:2/)
  assert.match(await IMPLEMENTATIONS.list_files([dir], {}), /src\/a.txt/)
  assert.match(await IMPLEMENTATIONS.run_command([dir], { command: 'echo hi' }), /exit code: 0[\s\S]*hi/)
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
