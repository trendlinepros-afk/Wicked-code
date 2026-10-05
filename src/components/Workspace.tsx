import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { api, parseModelId, uid, type Attachment, type Message, type PermissionControl, type PermissionMode, type Mode, type ProcessInfo, type Session, type SessionMeta, type ToolCall } from '../lib/api'
import { useApp } from '../lib/store'
import { MessageList, ToolArgs, EmptyIcon, AttachmentChip } from './Messages'
import { ModelPicker } from './ModelPicker'
import { ConfirmDialog, Icon, Spinner, basename } from './ui'
import { NewCodeSessionDialog } from './NewCodeSession'
import { SidebarUpdateButton } from './Updates'
import { ToolSkillBanner } from './ToolSkillBanner'
import { canSeeImages } from '../lib/catalog'

interface RunState {
  runId: string
  sessionId: string
  produced: Message[]
  liveText: string
  liveThinking: string
  approvals: { requestId: string; call: ToolCall }[]
  notices: string[]
}

const newSession = (mode: Mode, model: string, folders: string[]): Session => {
  const now = new Date().toISOString()
  return { id: uid(), mode, title: mode === 'code' ? 'New code session' : 'New chat', model, folders, messages: [], createdAt: now, updatedAt: now }
}

/** Strip UI-only messages before sending history to the model. */
const forModel = (msgs: Message[]) =>
  msgs
    .filter((m) => !(m.role === 'assistant' && m.isError))
    .map(({ thinking: _t, model: _m, ...rest }) => rest)

const SHIP_PROMPT =
  'Review the changes, run the tests to make sure everything passes, then commit with a clear message, push the branch, and open a pull request describing what changed and how it was tested.'

export function Workspace({
  mode,
  visible,
  onManageModels,
  onOpenGithubSettings,
  onOpenSettings,
  onPermissionControl,
}: {
  mode: Mode
  visible: boolean
  onManageModels(): void
  onOpenGithubSettings(): void
  onOpenSettings(): void
  /** Registers this workspace's per-chat permission control with the top bar while visible. */
  onPermissionControl(c: PermissionControl | null): void
}) {
  const { settings, modelState } = useApp()
  const [metas, setMetas] = useState<SessionMeta[]>([])
  const [active, setActive] = useState<Session | null>(null)
  const [run, setRun] = useState<RunState | null>(null)
  const [input, setInput] = useState('')
  // Files waiting to be sent with the next message (drag & drop or 📎).
  const [pendingFiles, setPendingFiles] = useState<(Attachment & { reading?: boolean })[]>([])
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [confirmDelete, setConfirmDelete] = useState<SessionMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showNewCode, setShowNewCode] = useState(false)
  const [naming, setNaming] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  // Permission for a chat that hasn't been created yet (before its first message).
  const [draftPermission, setDraftPermission] = useState<PermissionMode | null>(null)
  const activeRef = useRef<Session | null>(null)
  const [procs, setProcs] = useState<ProcessInfo[]>([])
  const runRef = useRef<RunState | null>(null)
  const lastTouch = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const updateRun = (fn: (r: RunState) => RunState) => {
    if (!runRef.current) return
    runRef.current = fn(runRef.current)
    setRun(runRef.current)
  }

  const refreshList = useCallback(async () => {
    try {
      setMetas((await api().sessions.list()).filter((s) => s.mode === mode))
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }, [mode])

  useEffect(() => {
    refreshList()
  }, [refreshList])

  // Background processes (dev servers etc.) started by the agent.
  useEffect(() => {
    if (mode !== 'code') return
    api().processes.list().then(setProcs)
    return api().processes.onChanged(setProcs)
  }, [mode])

  /** Refresh the GitHub branch shown for a code session (the agent may switch branches). */
  const refreshRepo = useCallback(async (s: Session) => {
    if (s.mode !== 'code' || !s.folders[0]) return s
    const info = await api().github.repoInfo(s.folders[0]).catch(() => null)
    const github = info ? { fullName: info.fullName, branch: info.branch, url: info.url } : null
    if (JSON.stringify(github) === JSON.stringify(s.github ?? null)) return s
    const next = { ...s, github }
    setActive((cur) => (cur?.id === s.id ? { ...cur, github } : cur))
    return next
  }, [])

  // Stream agent events for our run.
  useEffect(
    () =>
      api().agent.onEvent((e) => {
        if (!runRef.current || e.runId !== runRef.current.runId) return
        switch (e.type) {
          case 'turn-start':
            updateRun((r) => ({ ...r, liveText: '', liveThinking: '' }))
            break
          case 'text':
            updateRun((r) => ({ ...r, liveText: r.liveText + e.text }))
            break
          case 'thinking':
            updateRun((r) => ({ ...r, liveThinking: r.liveThinking + e.text }))
            break
          case 'notice':
            updateRun((r) => ({ ...r, notices: [...r.notices, e.text] }))
            break
          case 'assistant':
            updateRun((r) => ({
              ...r,
              produced: [...r.produced, { ...e.message, model: parseModelId(settings.selectedModel).model, thinking: r.liveThinking || undefined }],
              liveText: '',
              liveThinking: '',
            }))
            break
          case 'tool-result':
          case 'nudge':
            updateRun((r) => ({ ...r, produced: [...r.produced, e.message] }))
            break
          case 'approval':
            updateRun((r) => ({ ...r, approvals: [...r.approvals, { requestId: e.requestId, call: e.call }] }))
            break
        }
      }),
    [settings.selectedModel],
  )

  // Auto-scroll while streaming unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  })

  useEffect(() => {
    if (visible) inputRef.current?.focus()
  }, [visible, active?.id])

  const openSession = async (id: string) => {
    if (active?.id === id) return
    try {
      const s = await api().sessions.load(id)
      setDraftPermission(null)
      setActive(s)
      setError(null)
      refreshRepo(s)
      stickToBottom.current = true
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  const startNew = async () => {
    if (!settings.selectedModel) return setError('Select a model first.')
    if (mode === 'code') {
      setShowNewCode(true)
      return
    } else {
      setActive(null)
    }
    setError(null)
    setInput('')
    setDraftPermission(null)
    inputRef.current?.focus()
  }

  const persist = async (s: Session) => {
    try {
      const saved = await api().sessions.save(s)
      refreshList()
      return saved
    } catch (e) {
      setError('Could not save to vault: ' + String((e as Error).message || e))
      return s
    }
  }

  const addFolder = async () => {
    const folder = await api().dialog.pickFolder(mode === 'code' ? 'Add a context folder' : 'Add a folder to the chat context')
    if (!folder) return
    const base = active ?? newSession(mode, settings.selectedModel || '', [])
    if (base.folders.includes(folder)) return
    const next = { ...base, folders: [...base.folders, folder] }
    setActive(next)
    if (next.messages.length) setActive(await persist(next))
  }

  const removeFolder = async (folder: string) => {
    if (!active) return
    const next = { ...active, folders: active.folders.filter((f) => f !== folder) }
    setActive(next)
    if (next.messages.length) setActive(await persist(next))
  }

  const onType = (v: string) => {
    setInput(v)
    // Typing wakes the model (auto-load) and resets the idle timer.
    const now = Date.now()
    if (v && now - lastTouch.current > 2000) {
      lastTouch.current = now
      api().model.touch()
    }
  }

  const attachPaths = async (paths: string[]) => {
    const fresh = paths.filter((p) => p && !pendingFiles.some((f) => f.path === p))
    if (!fresh.length) return
    const placeholders = fresh.map((p) => ({ name: basename(p), path: p, ext: '', size: 0, kind: 'document' as const, reading: true }))
    setPendingFiles((cur) => [...cur, ...placeholders])
    const extracted = await api().files.extract(fresh)
    setPendingFiles((cur) => cur.map((f) => extracted.find((x) => x.path === f.path) ?? f))
    api().model.touch() // attaching counts as activity (and starts loading the model)
    inputRef.current?.focus()
  }

  const pickFiles = async () => {
    const picked = await api().files.pick()
    if (picked.length) setPendingFiles((cur) => [...cur, ...picked.filter((p) => !cur.some((c) => c.path === p.path))])
    inputRef.current?.focus()
  }

  /** Ctrl+V: screenshots (saved into the vault) and files copied in Explorer/Finder become attachments. */
  const onPaste = async (e: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(e.clipboardData.files)
    if (needsFolder) return
    if (!files.length) {
      // Some screenshot tools put only raw image data on the clipboard (no file, no text).
      if (e.clipboardData.types.some((t) => t.startsWith('text/'))) return // plain text paste
      const key = `paste-${Date.now()}`
      setPendingFiles((cur) => [...cur, { name: 'Pasted image', path: key, ext: '', size: 0, kind: 'image', reading: true }])
      const att = await api().files.pasteClipboardImage()
      setPendingFiles((cur) => (att ? cur.map((x) => (x.path === key ? att : x)) : cur.filter((x) => x.path !== key)))
      return
    }
    e.preventDefault()
    const withPath = files.map((f) => ({ f, p: api().files.pathFor(f) }))
    const onDisk = withPath.filter((x) => x.p).map((x) => x.p)
    if (onDisk.length) attachPaths(onDisk)
    for (const { f } of withPath.filter((x) => !x.p && x.f.type.startsWith('image/'))) {
      const key = `paste-${Date.now()}-${Math.random()}`
      setPendingFiles((cur) => [...cur, { name: 'Pasted image', path: key, ext: '', size: f.size, kind: 'image', reading: true }])
      try {
        const att = await api().files.savePasted(new Uint8Array(await f.arrayBuffer()), f.type)
        setPendingFiles((cur) => cur.map((x) => (x.path === key ? att : x)))
      } catch (err) {
        setPendingFiles((cur) => cur.map((x) => (x.path === key ? { ...x, reading: false, error: String((err as Error).message || err) } : x)))
      }
    }
    api().model.touch()
  }

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (needsFolder) return
    const files = Array.from(e.dataTransfer.files)
    attachPaths(files.map((f) => api().files.pathFor(f)))
  }

  const send = async () => {
    const files = pendingFiles.filter((f) => !f.reading)
    const text = input.trim() || (files.length ? 'Please look at the attached file' + (files.length > 1 ? 's.' : '.') : '')
    if (!text || run || pendingFiles.some((f) => f.reading)) return
    const modelId = settings.selectedModel
    if (!modelId) return setError('Select a model first (bottom right).')
    if (mode === 'code' && !active?.folders.length) return setError('Choose a working folder before starting a code session.')

    let session = active ?? newSession(mode, modelId, [])
    if (!session.permissionMode) session = { ...session, permissionMode: permissionOf(session) }
    const userMsg: Message = { role: 'user', content: text }
    if (files.length) userMsg.attachments = files.map(({ reading: _r, ...f }) => f)
    const isFirst = session.messages.length === 0
    session = {
      ...session,
      model: modelId,
      // Named properly by the model after the first reply (see nameSession).
      title: isFirst && session.titleSource !== 'user' ? (mode === 'code' ? 'New code session' : 'New chat') : session.title,
      titleSource: isFirst && session.titleSource !== 'user' ? 'pending' : session.titleSource,
      messages: [...session.messages, userMsg],
      updatedAt: new Date().toISOString(),
    }
    setActive(session)
    setInput('')
    setPendingFiles([])
    setError(null)
    stickToBottom.current = true
    session = await persist(session)
    setActive(session)

    const runId = uid()
    runRef.current = { runId, sessionId: session.id, produced: [], liveText: '', liveThinking: '', approvals: [], notices: [] }
    setRun(runRef.current)

    let failure: string | null = null
    let result: { messages: Message[]; aborted: boolean } | null = null
    try {
      result = await api().agent.run({
        runId,
        mode,
        modelId,
        history: forModel(session.messages),
        folders: session.folders,
        sessionId: session.id,
        permissionMode: permissionOf(session),
      })
    } catch (e) {
      failure = String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    }
    const r = runRef.current!
    const modelName = parseModelId(modelId).model
    let produced: Message[]
    if (result && !result.aborted) {
      // The main process's list is authoritative: streamed events can arrive after the run's reply.
      let ai = 0
      const streamedAssistants = r.produced.filter((m) => m.role === 'assistant')
      produced = result.messages.map((m) => (m.role === 'assistant' ? { ...m, model: modelName, thinking: streamedAssistants[ai++]?.thinking } : m))
    } else {
      produced = [...r.produced]
      // Keep partial text if the run was stopped mid-stream.
      if (r.liveText) produced.push({ role: 'assistant', content: r.liveText + '\n\n*(stopped)*', model: modelName })
    }
    if (failure) produced.push({ role: 'assistant', content: failure, isError: true })
    for (const n of r.notices) produced.unshift({ role: 'assistant', content: n, isError: true })
    runRef.current = null
    setRun(null)

    // The chat's permission may have been changed while the reply was running.
    const latest = activeRef.current?.id === session.id ? activeRef.current : null
    let finished: Session = {
      ...session,
      permissionMode: latest?.permissionMode ?? session.permissionMode,
      autoApprove: false,
      messages: [...session.messages, ...produced],
      updatedAt: new Date().toISOString(),
    }
    finished = await refreshRepo(finished)
    setActive((cur) => (cur?.id === finished.id ? finished : cur))
    const saved = await persist(finished)
    setActive((cur) => (cur?.id === saved.id ? saved : cur))
    // Only name it after a reply that completed normally — never reload a model the user just
    // stopped or force-unloaded (Ctrl+U). A pending title is named after the next good reply.
    if (saved.titleSource === 'pending' && result && !result.aborted && !failure) nameSession(saved.id, modelId, saved.messages)
  }

  /** Ask the model for a short title describing the conversation (can take a while on local models). */
  const nameSession = async (id: string, modelId: string, msgs: Message[]) => {
    setNaming((n) => new Set(n).add(id))
    try {
      const title = await api().sessions.generateTitle({ modelId, messages: forModel(msgs) })
      const renamed = await api().sessions.rename(id, title, 'auto')
      setActive((cur) => (cur?.id === id ? { ...cur, title: renamed.title, titleSource: renamed.titleSource, notePath: renamed.notePath } : cur))
    } catch {
      /* keep the placeholder; the user can rename it */
    } finally {
      setNaming((n) => {
        const next = new Set(n)
        next.delete(id)
        return next
      })
      refreshList()
    }
  }

  const commitRename = async () => {
    if (!editing) return
    const { id, text } = editing
    setEditing(null)
    const title = text.replace(/\s+/g, ' ').trim()
    if (!title) return
    try {
      if (active?.id === id && !active.notePath) {
        // Not saved yet (no messages): just rename locally.
        setActive({ ...active, title, titleSource: 'user' })
        return
      }
      const renamed = await api().sessions.rename(id, title, 'user')
      setActive((cur) => (cur?.id === id ? { ...cur, title: renamed.title, titleSource: 'user', notePath: renamed.notePath } : cur))
      refreshList()
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  const stop = () => run && api().agent.stop(run.runId)

  const answerApproval = (requestId: string, allowed: boolean | 'all') => {
    api().agent.approve(requestId, allowed)
    if (allowed === 'all') {
      updateRun((r) => ({ ...r, approvals: [] }))
      setActive((cur) => (cur ? { ...cur, permissionMode: 'auto-all', autoApprove: false } : cur))
    } else {
      updateRun((r) => ({ ...r, approvals: r.approvals.filter((a) => a.requestId !== requestId) }))
    }
  }

  const doDelete = async (m: SessionMeta) => {
    setConfirmDelete(null)
    await api().sessions.delete(m.id)
    if (active?.id === m.id) setActive(null)
    refreshList()
  }

  activeRef.current = active
  /** This chat's permission level (older sessions: "auto-approve" = everything). */
  const permissionOf = (s: Session | null): PermissionMode =>
    s?.permissionMode ?? (s?.autoApprove ? 'auto-all' : draftPermission ?? settings.permissionMode ?? 'ask')
  const permission = permissionOf(active)

  const changePermission = async (mode: PermissionMode) => {
    const cur = activeRef.current
    if (!cur) return setDraftPermission(mode)
    const next = { ...cur, permissionMode: mode, autoApprove: false }
    setActive(next)
    // Takes effect immediately for a reply that's running in this chat.
    if (runRef.current?.sessionId === cur.id) {
      api().agent.setPermission(runRef.current.runId, mode)
      if (mode !== 'ask') updateRun((r) => ({ ...r, approvals: r.approvals.filter((a) => (mode === 'auto-edits' ? !['write_file', 'edit_file'].includes(a.call.name) : false)) }))
    }
    if (next.messages.length) {
      try {
        await api().sessions.save(next)
      } catch {
        /* ignore */
      }
    }
  }
  const changePermissionRef = useRef(changePermission)
  changePermissionRef.current = changePermission

  // Hand the top bar a control for the visible chat's permissions.
  useEffect(() => {
    if (!visible) return
    onPermissionControl({ value: permission, mode, set: (m) => changePermissionRef.current(m) })
  }, [visible, permission, mode, onPermissionControl])
  useEffect(() => () => onPermissionControl(null), [onPermissionControl])

  const runningHere = !!run && run.sessionId === active?.id
  const sessionProcs = procs.filter((p) => p.status === 'running' && p.owner === active?.id)
  const messages = active ? [...active.messages, ...(runningHere ? run!.produced : [])] : []
  const folders = active?.folders ?? []
  const needsFolder = mode === 'code' && !folders.length
  const modelBusy = modelState?.status === 'loading' || modelState?.status === 'unloading'

  return (
    <div className="workspace" style={{ display: visible ? 'flex' : 'none' }}>
      <aside className="sidebar">
        <button className="btn btn-primary new-btn" onClick={startNew}>
          <Icon name="plus" size={16} /> {mode === 'code' ? 'New code session' : 'New chat'}
        </button>
        <div className="session-list">
          {!metas.length && <div className="muted small pad">No {mode === 'code' ? 'code sessions' : 'chats'} yet.</div>}
          {metas.map((m) => (
            <div
              key={m.id}
              className={`session-item ${active?.id === m.id ? 'active' : ''} ${editing?.id === m.id ? 'editing' : ''}`}
              onClick={() => editing?.id !== m.id && openSession(m.id)}
            >
              {editing?.id === m.id ? (
                <input
                  className="session-rename"
                  autoFocus
                  value={editing.text}
                  onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  onBlur={commitRename}
                  onFocus={(e) => e.target.select()}
                  maxLength={80}
                />
              ) : (
                <div className="session-title">
                  {naming.has(m.id) ? (
                    <span className="session-naming">
                      <Spinner /> Naming…
                    </span>
                  ) : (
                    m.title
                  )}
                </div>
              )}
              <div className="session-meta">
                {mode === 'code' && m.folders[0] ? basename(m.folders[0]) + ' · ' : ''}
                {new Date(m.updatedAt).toLocaleDateString()}
                {run?.sessionId === m.id && <span className="session-running"> · running</span>}
              </div>
              {editing?.id !== m.id && (
                <div className="session-actions">
                  <button
                    title="Rename"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditing({ id: m.id, text: m.title })
                    }}
                  >
                    <Icon name="pencil" size={14} />
                  </button>
                  <button
                    className="danger"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmDelete(m)
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <button className="sidebar-settings" onClick={onOpenSettings} title="Settings">
            <Icon name="gear" size={15} /> Settings
          </button>
          <SidebarUpdateButton />
        </div>
      </aside>

      <section
        className="main-pane"
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          dragDepth.current++
          setDragging(true)
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (!dragDepth.current) setDragging(false)
        }}
        onDrop={onDrop}
      >
        {dragging && (
          <div className="drop-overlay">
            <div className="drop-card">
              <Icon name="paperclip" size={28} />
              <b>{needsFolder ? 'Choose a working folder first' : 'Drop files to attach'}</b>
              <span className="muted small">Word, PDF, Excel, PowerPoint, text & code files, and images</span>
            </div>
          </div>
        )}
        {active && (active.notePath || active.mode === 'code') && (
          <div className="pane-head">
            <div className="pane-title">{active.title}</div>
            {active.github && (
              <a className="repo-badge" href={active.github.url} target="_blank" rel="noreferrer" title="Open on GitHub">
                <Icon name="github" size={13} /> {active.github.fullName}
                {active.github.branch && <span className="repo-branch">{active.github.branch}</span>}
              </a>
            )}
            <span className="topbar-spacer" />
            {sessionProcs.map((p) => (
              <span key={p.id} className="proc-chip" title={`${p.command}\n${p.cwd}`}>
                <span className="proc-dot" /> {p.command.length > 28 ? p.command.slice(0, 28) + '…' : p.command}
                <button title="Stop process" onClick={() => api().processes.stop(p.id)}>
                  <Icon name="stop" size={11} />
                </button>
              </span>
            ))}
            {active.notePath && (
              <button className="btn btn-ghost btn-sm" onClick={() => api().shell.openPath(active.notePath!)} title="Open the Markdown note in your vault">
                <Icon name="book" size={14} /> Open note
              </button>
            )}
          </div>
        )}
        <div
          className="messages"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          <div className="messages-inner">
            {!messages.length && !runningHere && (
              <div className="empty">
                <EmptyIcon mode={mode} />
                {mode === 'code' ? (
                  needsFolder ? (
                    <>
                      <h2>Start a code session</h2>
                      <p className="muted">Choose the project folder where code will be read and written. The AI can only touch files inside it.</p>
                      <button className="btn btn-primary btn-lg" onClick={startNew}>
                        <Icon name="folder" size={16} /> Choose working folder
                      </button>
                    </>
                  ) : (
                    <>
                      <h2>{basename(folders[0])}</h2>
                      <p className="muted">Describe what you want to build or fix. The agent will explore, edit and run commands in this folder.</p>
                    </>
                  )
                ) : (
                  <>
                    <h2>What’s on your mind?</h2>
                    <p className="muted">Ask anything. Add a folder to give the model read access to your files.</p>
                  </>
                )}
              </div>
            )}
            <MessageList messages={messages} running={runningHere} live={runningHere ? { text: run!.liveText, thinking: run!.liveThinking } : null} />
            {runningHere &&
              run!.notices.map((n, i) => (
                <div key={i} className="callout warn">
                  {n}
                </div>
              ))}
            {runningHere &&
              run!.approvals.map((a) => (
                <div key={a.requestId} className="approval">
                  <div className="approval-title">
                    {a.call.name === 'run_command'
                      ? 'Run this command?'
                      : a.call.name === 'start_process'
                        ? 'Start this background process?'
                        : a.call.name === 'github_create_pull_request'
                          ? 'Open this pull request on GitHub?'
                          : a.call.name === 'save_document'
                            ? `Save “${String(a.call.args.filename)}” next to your file?`
                          : a.call.name === 'edit_file'
                            ? `Edit ${String(a.call.args.path)}?`
                            : `Write ${String(a.call.args.path)}?`}
                  </div>
                  <ToolArgs call={a.call} />
                  <div className="approval-actions">
                    <button className="btn" onClick={() => answerApproval(a.requestId, false)}>
                      Deny
                    </button>
                    <button className="btn" onClick={() => answerApproval(a.requestId, 'all')} title="Stop asking for the rest of this session">
                      Allow all for this session
                    </button>
                    <button className="btn btn-primary" onClick={() => answerApproval(a.requestId, true)}>
                      Allow
                    </button>
                  </div>
                </div>
              ))}
            {error && <div className="callout error">{error}</div>}
          </div>
        </div>

        <div className="composer-wrap">
          {mode === 'code' && !needsFolder && <ToolSkillBanner onManageModels={onManageModels} />}
          <div className={`composer ${needsFolder ? 'disabled' : ''}`} onPaste={onPaste}>
            {pendingFiles.length > 0 && (
              <div className="composer-files">
                {pendingFiles.map((f) => (
                  <AttachmentChip key={f.path} att={f} reading={f.reading} onRemove={() => setPendingFiles((cur) => cur.filter((x) => x.path !== f.path))} />
                ))}
              </div>
            )}
            {pendingFiles.some((f) => f.kind === 'image' && !f.error) && settings.selectedModel && !canSeeImages(settings.selectedModel) && (
              <div className="vision-warn">
                <Icon name="image" size={13} /> {parseModelId(settings.selectedModel).model} can’t look at images — pick a vision model (e.g. qwen2.5vl, Qwen 3.8, Gemma 3) in the
                model picker.
              </div>
            )}
            <div className="composer-folders">
              <button className="folder-add" onClick={pickFiles} disabled={needsFolder} title="Attach files (or drag & drop them anywhere here)">
                <Icon name="paperclip" size={13} /> Attach
              </button>
              {folders.map((f, i) => (
                <span key={f} className={`folder-chip ${mode === 'code' && i === 0 ? 'primary' : ''}`} title={f}>
                  <Icon name="folder" size={13} />
                  {mode === 'code' && i === 0 ? 'Working folder: ' : ''}
                  {basename(f)}
                  {!(mode === 'code' && i === 0) && (
                    <button onClick={() => removeFolder(f)} title="Remove from context">
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </span>
              ))}
              <button className="folder-add" onClick={addFolder} disabled={needsFolder} title="Add a folder to the context">
                <Icon name="plus" size={13} /> Add folder
              </button>
            </div>
            <textarea
              ref={inputRef}
              className="composer-input"
              placeholder={needsFolder ? 'Choose a working folder to begin…' : mode === 'code' ? 'Ask Wicked Code to build, fix or explain something…' : 'Message Wicked Code…'}
              value={input}
              disabled={needsFolder}
              rows={1}
              onChange={(e) => onType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <div className="composer-bar">
              {mode === 'code' && active?.github && !run ? (
                <button className="ship-chip" onClick={() => setInput(SHIP_PROMPT)} title="Fill in a prompt that commits, pushes and opens a pull request">
                  <Icon name="github" size={12} /> Commit, push &amp; open PR
                </button>
              ) : (
                <span className="muted small">{runningHere ? 'Generating…' : 'Enter to send · Shift+Enter for new line'}</span>
              )}
              <div className="composer-right">
                <ModelPicker disabled={!!run || modelBusy} onManage={onManageModels} />
                {run ? (
                  <button className="send-btn stop" onClick={stop} title="Stop">
                    <Icon name="stop" size={16} />
                  </button>
                ) : (
                  <button
                    className="send-btn"
                    onClick={send}
                    disabled={(!input.trim() && !pendingFiles.length) || pendingFiles.some((f) => f.reading) || needsFolder}
                    title="Send"
                  >
                    <Icon name="send" size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {showNewCode && (
        <NewCodeSessionDialog
          onCancel={() => setShowNewCode(false)}
          onOpenSettings={() => {
            setShowNewCode(false)
            onOpenGithubSettings()
          }}
          onDone={({ folder, github }) => {
            setShowNewCode(false)
            const s = newSession('code', settings.selectedModel || '', [folder])
            s.github = github ? { fullName: github.fullName, branch: github.branch, url: github.url } : null
            if (github) s.title = `${github.repo} · ${github.branch ?? ''}`.trim()
            setActive(s)
            setError(null)
            setInput('')
            inputRef.current?.focus()
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete session?"
          message={
            <>
              Are you sure you want to delete <b>{confirmDelete.title}</b>? Its note will also be removed from your vault.
            </>
          }
          danger
          onYes={() => doDelete(confirmDelete)}
          onNo={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}
