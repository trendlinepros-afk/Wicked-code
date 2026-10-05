// Types for the bridge exposed by electron/preload.cjs.

export type Provider = 'ollama' | 'anthropic' | 'gemini' | 'deepseek' | 'grok'
export type CloudProvider = Exclude<Provider, 'ollama'>
export type Mode = 'chat' | 'code'
export type PermissionMode = 'ask' | 'auto-edits' | 'auto-all'

export interface Settings {
  vaultPath: string | null
  ollamaUrl: string
  idleUnloadSeconds: number
  contextLength: number
  selectedModel: string | null
  permissionMode: PermissionMode
  useVaultMemory: boolean
  modelNotes: Record<string, string>
  apiKeys: Record<CloudProvider, { set: boolean; hint: string }>
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface Message {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  model?: string
  thinking?: string
}

export interface SessionMeta {
  id: string
  title: string
  mode: Mode
  model: string
  folders: string[]
  createdAt: string
  updatedAt: string
}

export interface Session extends SessionMeta {
  messages: Message[]
  notePath?: string
}

export interface LocalModel {
  name: string
  size: number
  modifiedAt: string
  parameterSize: string
  quantization: string
  family: string
}

export interface CloudModel {
  id: string
  provider: CloudProvider
  model: string
}

export type ModelStatus = 'unloaded' | 'loading' | 'loaded' | 'unloading' | 'cloud' | 'error'

export interface ModelState {
  model: string | null
  status: ModelStatus
  error: string | null
  local: boolean
  busy: boolean
  idleSeconds: number
  idleRemaining: number | null
}

export interface GpuStats {
  source: 'nvidia' | 'amd' | 'apple' | 'none'
  gpus: { name: string; totalMB: number; usedMB: number }[]
  totalMB: number
  usedMB: number
  ollamaVramMB: number
  systemRamMB: number
}

export interface PullProgress {
  name: string
  status: string
  completed?: number
  total?: number
  done?: boolean
  error?: string | null
}

export type AgentEvent =
  | { runId: string; type: 'turn-start' }
  | { runId: string; type: 'text'; text: string }
  | { runId: string; type: 'thinking'; text: string }
  | { runId: string; type: 'notice'; text: string }
  | { runId: string; type: 'assistant'; message: Message }
  | { runId: string; type: 'tool-result'; message: Message }
  | { runId: string; type: 'approval'; requestId: string; call: ToolCall }

type Unsub = () => void

export interface WickedApi {
  platform: string
  settings: {
    get(): Promise<Settings>
    set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<Settings>
  }
  apiKeys: {
    set(provider: CloudProvider, key: string): Promise<Settings>
    test(provider: CloudProvider, key?: string): Promise<{ ok: boolean; error?: string }>
  }
  dialog: { pickFolder(title?: string): Promise<string | null> }
  shell: { openPath(p: string): Promise<string> }
  vault: {
    inspect(p: string): Promise<{ exists: boolean; isObsidian: boolean }>
    set(p: string): Promise<Settings>
    openMemory(): Promise<string>
  }
  sessions: {
    list(): Promise<SessionMeta[]>
    load(id: string): Promise<Session>
    save(s: Session): Promise<Session>
    delete(id: string): Promise<void>
  }
  ollama: { status(): Promise<{ running: boolean; url: string }> }
  models: {
    listLocal(): Promise<{ running: boolean; models: LocalModel[] }>
    listCloud(): Promise<CloudModel[]>
    pull(name: string): Promise<void>
    cancelPull(name: string): Promise<void>
    delete(name: string): Promise<void>
    setNotes(name: string, text: string): Promise<void>
    onPullProgress(cb: (p: PullProgress) => void): Unsub
  }
  model: {
    state(): Promise<ModelState>
    set(id: string): Promise<ModelState>
    load(): Promise<ModelState>
    unload(): Promise<ModelState>
    touch(): Promise<void>
    onState(cb: (s: ModelState) => void): Unsub
  }
  gpu: { stats(): Promise<GpuStats> }
  agent: {
    run(p: { runId: string; mode: Mode; modelId: string; history: Message[]; folders: string[] }): Promise<{
      messages: Message[]
      aborted: boolean
    }>
    stop(runId: string): Promise<void>
    approve(requestId: string, allowed: boolean): Promise<void>
    onEvent(cb: (e: AgentEvent) => void): Unsub
  }
}

declare global {
  interface Window {
    wicked: WickedApi
  }
}

export const api = (): WickedApi => window.wicked

export const PROVIDER_LABELS: Record<Provider, string> = {
  ollama: 'Local (Ollama)',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  grok: 'xAI Grok',
}

export function parseModelId(id: string | null): { provider: Provider; model: string } {
  if (!id) return { provider: 'ollama', model: '' }
  const i = id.indexOf(':')
  if (i < 0) return { provider: 'ollama', model: id }
  return { provider: id.slice(0, i) as Provider, model: id.slice(i + 1) }
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
