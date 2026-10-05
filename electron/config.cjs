// Persistent app settings + encrypted API key storage.
const fs = require('fs')
const path = require('path')

const PROVIDERS = ['anthropic', 'gemini', 'deepseek', 'grok']
const SECRETS = [...PROVIDERS, 'github']

const DEFAULTS = {
  vaultPath: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  idleUnloadSeconds: 30,
  contextLength: 16384,
  maxAgentSteps: 100,
  autoStartOllama: true,
  stopOllamaOnExit: true,
  cloneRoot: null, // default: ~/Wicked Code Repos
  selectedModel: 'ollama:qwen3.8:27b',
  permissionMode: 'ask', // 'ask' | 'auto-edits' | 'auto-all'
  useVaultMemory: true,
  theme: 'system', // 'system' | 'light' | 'dark'
  modelNotes: {},
  favoriteModels: [], // Ollama model names pinned in Local Model Management
  apiKeys: {}, // provider -> { enc: base64, plain?: string }
}

class Config {
  /**
   * @param {string} dir  directory to store config.json in (app userData)
   * @param {{isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string} | null} safeStorage
   */
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'config.json')
    this.safeStorage = safeStorage
    this.data = { ...DEFAULTS }
    // Settings survive app updates: they live in the user-data folder (never touched by installers),
    // unknown/new keys get defaults, and a backup copy is used if the main file is ever unreadable.
    for (const f of [this.file, this.file + '.bak']) {
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
        this.data = { ...DEFAULTS, ...raw }
        this.loadedFrom = f
        break
      } catch (e) {
        if (f === this.file && fs.existsSync(f) && e instanceof SyntaxError) {
          try {
            fs.copyFileSync(f, `${f}.corrupt-${Date.now()}`)
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    if (fs.existsSync(this.file)) {
      try {
        fs.copyFileSync(this.file, this.file + '.bak')
      } catch {
        /* ignore */
      }
    }
    fs.renameSync(tmp, this.file)
  }

  get(key) {
    return this.data[key]
  }

  set(key, value) {
    if (key === 'apiKeys') throw new Error('Use setApiKey')
    this.data[key] = value
    this.save()
  }

  /** Settings safe to send to the renderer (no secrets). */
  publicSettings() {
    const { apiKeys, ...rest } = this.data
    const keys = {}
    for (const p of SECRETS) {
      const k = this.getApiKey(p)
      keys[p] = k ? { set: true, hint: '…' + k.slice(-4) } : { set: false, hint: '' }
    }
    return { ...rest, apiKeys: keys }
  }

  setApiKey(provider, key) {
    if (!SECRETS.includes(provider)) throw new Error('Unknown provider ' + provider)
    const keys = { ...this.data.apiKeys }
    if (!key) {
      delete keys[provider]
    } else if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      keys[provider] = { enc: this.safeStorage.encryptString(key).toString('base64') }
    } else {
      keys[provider] = { plain: key }
    }
    this.data.apiKeys = keys
    this.save()
  }

  getApiKey(provider) {
    const entry = this.data.apiKeys?.[provider]
    if (!entry) return null
    if (entry.plain) return entry.plain
    if (entry.enc && this.safeStorage) {
      try {
        return this.safeStorage.decryptString(Buffer.from(entry.enc, 'base64'))
      } catch {
        return null
      }
    }
    return null
  }
}

module.exports = { Config, PROVIDERS, SECRETS, DEFAULTS }
