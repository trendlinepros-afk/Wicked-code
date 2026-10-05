import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import {
  api,
  type AppInfo,
  type CloudModel,
  type LauncherState,
  type GpuStats,
  type LocalModel,
  type ModelState,
  type PullProgress,
  type Settings,
  type UpdateState,
} from './api'
import { setVramReserve } from './rating'

interface AppStore {
  settings: Settings
  setSettings: Dispatch<SetStateAction<Settings>>
  modelState: ModelState | null
  gpu: GpuStats | null
  ollamaRunning: boolean
  localModels: LocalModel[]
  cloudModels: CloudModel[]
  refreshModels(): Promise<void>
  pulls: Record<string, PullProgress>
  startPull(name: string): Promise<void>
  /** Select a model. By default it is loaded right away; pass { load: false } to only select it. */
  selectModel(id: string, opts?: { load?: boolean }): Promise<void>
  appInfo: AppInfo | null
  update: UpdateState | null
  launcher: LauncherState | null
}

const Ctx = createContext<AppStore | null>(null)

export function useApp(): AppStore {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside provider')
  return v
}

export function AppProvider({ initial, children }: { initial: Settings; children: ReactNode }) {
  const [settings, setSettings] = useState(initial)
  // Ratings/"Best for you" respect the VRAM safety buffer (set before children render).
  setVramReserve(settings.vramReserveGB ?? 1)
  const [modelState, setModelState] = useState<ModelState | null>(null)
  const [gpu, setGpu] = useState<GpuStats | null>(null)
  const [ollamaRunning, setOllamaRunning] = useState(true)
  const [localModels, setLocalModels] = useState<LocalModel[]>([])
  const [cloudModels, setCloudModels] = useState<CloudModel[]>([])
  const [pulls, setPulls] = useState<Record<string, PullProgress>>({})
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [launcher, setLauncher] = useState<LauncherState | null>(null)
  const refreshing = useRef(false)
  const wasRunning = useRef(true)

  const refreshModels = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    try {
      const [local, cloud] = await Promise.all([api().models.listLocal(), api().models.listCloud()])
      setOllamaRunning(local.running)
      setLocalModels(local.models)
      setCloudModels(cloud)
    } finally {
      refreshing.current = false
    }
  }, [])

  // Model state + initial lists.
  useEffect(() => {
    api().model.state().then(setModelState)
    refreshModels()
    return api().model.onState(setModelState)
  }, [refreshModels])

  // App version + update status.
  useEffect(() => {
    api().app.info().then(setAppInfo)
    api().updater.state().then(setUpdate)
    const offUpdate = api().updater.onStatus(setUpdate)
    const offLauncher = api().ollama.onLauncher((s) => {
      setLauncher(s)
      if (s.status === 'running') refreshModels()
    })
    return () => {
      offUpdate()
      offLauncher()
    }
  }, [refreshModels])

  // Re-list cloud models when API keys change.
  const keySig = Object.values(settings.apiKeys).map((k) => k.hint).join('|')
  useEffect(() => {
    api().models.listCloud().then(setCloudModels)
  }, [keySig])

  // Poll GPU memory and Ollama status.
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const g = await api().gpu.stats()
        if (alive) setGpu(g)
        const st = await api().ollama.status()
        if (alive) setLauncher(st.launcher)
        if (alive) {
          if (!wasRunning.current && st.running) refreshModels()
          wasRunning.current = st.running
          setOllamaRunning(st.running)
        }
      } catch {
        /* ignore */
      }
    }
    // Chain polls (never overlapping): the next one starts 2 s after the previous finished.
    let t: ReturnType<typeof setTimeout>
    const loop = async () => {
      await poll()
      if (alive) t = setTimeout(loop, 2000)
    }
    loop()
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [refreshModels])

  // Download progress.
  useEffect(
    () =>
      api().models.onPullProgress((p) => {
        setPulls((prev) => ({ ...prev, [p.name]: p }))
        if (p.done) {
          if (p.status === 'success') refreshModels()
          setTimeout(
            () =>
              setPulls((prev) => {
                if (!prev[p.name]?.done) return prev
                const { [p.name]: _gone, ...rest } = prev
                return rest
              }),
            p.status === 'error' ? 15000 : 1500,
          )
        }
      }),
    [refreshModels],
  )

  const startPull = useCallback(async (name: string) => {
    setPulls((prev) => ({ ...prev, [name]: { name, status: 'starting', completed: 0, total: 0 } }))
    try {
      await api().models.pull(name)
    } catch {
      /* error shown via progress event */
    }
  }, [])

  const selectModel = useCallback(async (id: string, opts?: { load?: boolean }) => {
    setSettings((s) => ({ ...s, selectedModel: id }))
    setModelState(await api().model.set(id, opts))
  }, [])

  const value = useMemo<AppStore>(
    () => ({
      settings,
      setSettings,
      modelState,
      gpu,
      ollamaRunning,
      localModels,
      cloudModels,
      refreshModels,
      pulls,
      startPull,
      selectModel,
      appInfo,
      update,
      launcher,
    }),
    [settings, modelState, gpu, ollamaRunning, localModels, cloudModels, refreshModels, pulls, startPull, selectModel, appInfo, update, launcher],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
