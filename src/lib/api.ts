// Types for the bridge exposed by electron/preload.cjs.

export type Provider = 'ollama' | 'anthropic' | 'gemini' | 'deepseek' | 'grok'
export type CloudProvider = Exclude<Provider, 'ollama'>
export type Mode = 'chat' | 'code'
export type PermissionMode = 'ask' | 'auto-edits' | 'auto-all'
export type Theme = 'system' | 'light' | 'dark'

export interface Settings {
  vaultPath: string | null
  ollamaUrl: string
  idleUnloadSeconds: number // 0 = never
  autoLoadOnType: boolean
  /** keep this much VRAM free; bigger models spill into system RAM */
  vramReserveGB: number
  contextLength: number
  selectedModel: string | null
  permissionMode: PermissionMode
  useVaultMemory: boolean
  theme: Theme
  maxAgentSteps: number
  autoStartOllama: boolean
  stopOllamaOnExit: boolean
  cloneRoot: string | null
  cloneRootResolved: string
  modelNotes: Record<string, string>
  favoriteModels: string[]
  apiKeys: Record<CloudProvider | 'github', { set: boolean; hint: string }>
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface Attachment {
  name: string
  path: string
  ext: string
  size: number
  kind: 'document' | 'text' | 'image'
  mime?: string
  text?: string // extracted contents (documents/text)
  truncated?: boolean
  pages?: number
  chars?: number
  error?: string
  /** small data-URL preview for images */
  thumb?: string
  width?: number
  height?: number
}

export interface Message {
  role: 'user' | 'assistant' | 'tool'
  content: string
  attachments?: Attachment[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  model?: string
  thinking?: string
  /** Reminder the app sent to the model (shown as a small note, not as the user's message) */
  synthetic?: boolean
}

export interface RepoInfo {
  owner: string
  repo: string
  fullName: string
  branch: string | null
  dirty: number
  url: string
}

export interface GithubRepo {
  fullName: string
  description: string | null
  private: boolean
  defaultBranch: string
  pushedAt: string
  language: string | null
  url: string
}

export interface ProcessInfo {
  id: string
  command: string
  cwd: string
  owner: string | null
  pid: number
  status: 'running' | 'exited'
  exitCode: number | string | null
  startedAt: number
}

export interface LauncherState {
  status: 'unknown' | 'running' | 'starting' | 'stopped' | 'not-installed' | 'error'
  startedByApp: boolean
  error: string | null
  binary: string | null
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
  github?: { fullName: string; branch: string | null; url: string } | null
  /** @deprecated older sessions; same as permissionMode 'auto-all' */
  autoApprove?: boolean
  /** This chat's own permission level (code sessions and document saves) */
  permissionMode?: PermissionMode
  /** 'user' once renamed by hand (never auto-renamed after that) */
  titleSource?: 'user' | 'auto' | 'pending'
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
  gpus: { name: string; totalMB: number; usedMB: number; utilization?: number; temperatureC?: number }[]
  totalMB: number
  usedMB: number
  ollamaVramMB: number
  /** VRAM used by everything except Ollama's models. */
  otherUsedMB?: number
  systemRamMB: number
  ramUsedMB?: number
  cpuPercent?: number | null
  /** Models Ollama currently has in memory. */
  models?: { name: string; vramMB: number; totalMB: number }[]
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
  | { runId: string; type: 'nudge'; message: Message }
  | { runId: string; type: 'approval'; requestId: string; call: ToolCall }

type Unsub = () => void

export type UpdateStatus = 'idle' | 'checking' | 'none' | 'downloading' | 'downloaded' | 'error' | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  version: string | null
  percent: number
  error: string | null
}

export interface AppInfo {
  version: string
  packaged: boolean
  platform: string
}

export interface WickedApi {
  platform: string
  settings: {
    get(): Promise<Settings>
    set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<Settings>
  }
  apiKeys: {
    set(provider: CloudProvider | 'github', key: string): Promise<Settings>
    test(provider: CloudProvider, key?: string): Promise<{ ok: boolean; error?: string }>
  }
  dialog: { pickFolder(title?: string): Promise<string | null> }
  shell: { openPath(p: string): Promise<string> }
  files: {
    pathFor(file: File): string
    extract(paths: string[]): Promise<Attachment[]>
    pick(): Promise<Attachment[]>
    savePasted(bytes: Uint8Array, mime: string): Promise<Attachment>
    pasteClipboardImage(): Promise<Attachment | null>
  }
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
    rename(id: string, title: string, source?: 'user' | 'auto'): Promise<Session>
    generateTitle(p: { modelId: string; messages: Message[] }): Promise<string>
  }
  ollama: {
    status(): Promise<{ running: boolean; url: string; launcher: LauncherState }>
    start(): Promise<LauncherState>
    onLauncher(cb: (s: LauncherState) => void): Unsub
  }
  github: {
    user(): Promise<{ login: string; name: string | null; url: string }>
    test(token?: string): Promise<{ login: string; name: string | null; url: string }>
    repos(): Promise<GithubRepo[]>
    branches(fullName: string): Promise<string[]>
    clone(p: { fullName: string; baseBranch?: string; newBranch?: string }): Promise<{ path: string; info: RepoInfo | null }>
    repoInfo(dir: string): Promise<RepoInfo | null>
    suggestBranch(title: string): Promise<string>
  }
  processes: {
    list(): Promise<ProcessInfo[]>
    stop(id: string): Promise<boolean>
    onChanged(cb: (list: ProcessInfo[]) => void): Unsub
  }
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
    set(id: string, opts?: { load?: boolean }): Promise<ModelState>
    load(): Promise<ModelState>
    unload(): Promise<ModelState>
    touch(): Promise<void>
    forceUnload(): Promise<void>
    onForced(cb: (p: { unloaded: string[] }) => void): Unsub
    onState(cb: (s: ModelState) => void): Unsub
  }
  gpu: { stats(): Promise<GpuStats> }
  app: { info(): Promise<AppInfo>; openLogs(): Promise<void> }
  updater: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    install(): Promise<boolean>
    onStatus(cb: (s: UpdateState) => void): Unsub
  }
  agent: {
    run(p: {
      runId: string
      mode: Mode
      modelId: string
      history: Message[]
      folders: string[]
      sessionId: string
      autoApprove?: boolean
      permissionMode?: PermissionMode
    }): Promise<{
      messages: Message[]
      aborted: boolean
    }>
    stop(runId: string): Promise<void>
    approve(requestId: string, allowed: boolean | 'all'): Promise<void>
    setPermission(runId: string, mode: PermissionMode): Promise<void>
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

/** Lets the top bar show and change the visible chat's permission level. */
export interface PermissionControl {
  value: PermissionMode
  set(mode: PermissionMode): void
  mode: Mode
}

export const PERMISSION_OPTIONS: { value: PermissionMode; label: string; short: string; detail: string }[] = [
  { value: 'ask', label: 'Ask before every change', short: 'Ask first', detail: 'Approve every file change, command and saved document.' },
  { value: 'auto-edits', label: 'Auto-approve file edits', short: 'Auto edits', detail: 'File edits go through; still asks before running commands.' },
  { value: 'auto-all', label: 'Auto-approve everything', short: 'Full auto', detail: 'Edits and commands run without asking. Use with care.' },
]
