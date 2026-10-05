// Persistent app settings + encrypted API key storage.
const fs = require('fs')
const path = require('path')

const PROVIDERS = ['anthropic', 'gemini', 'deepseek', 'grok']

const DEFAULTS = {
  vaultPath: null,
  ollamaUrl: 'http://127.0.0.1:11434',
  idleUnloadSeconds: 30,
  contextLength: 8192,
  selectedModel: 'ollama:qwen3.8:27b',
  permissionMode: 'ask', // 'ask' | 'auto-edits' | 'auto-all'
  useVaultMemory: true,
  theme: 'system', // 'system' | 'light' | 'dark'
  modelNotes: {},
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
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.data = { ...DEFAULTS, ...raw }
    } catch {
      /* first run */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
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
    for (const p of PROVIDERS) {
      const k = this.getApiKey(p)
      keys[p] = k ? { set: true, hint: '…' + k.slice(-4) } : { set: false, hint: '' }
    }
    return { ...rest, apiKeys: keys }
  }

  setApiKey(provider, key) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unknown provider ' + provider)
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

module.exports = { Config, PROVIDERS, DEFAULTS }
