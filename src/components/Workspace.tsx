import { useCallback, useEffect, useRef, useState } from 'react'
import { api, parseModelId, uid, type Message, type Mode, type Session, type SessionMeta, type ToolCall } from '../lib/api'
import { useApp } from '../lib/store'
import { MessageList, ToolArgs, EmptyIcon } from './Messages'
import { ModelPicker } from './ModelPicker'
import { ConfirmDialog, Icon, basename } from './ui'

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

export function Workspace({ mode, visible, onManageModels }: { mode: Mode; visible: boolean; onManageModels(): void }) {
  const { settings, modelState } = useApp()
  const [metas, setMetas] = useState<SessionMeta[]>([])
  const [active, setActive] = useState<Session | null>(null)
  const [run, setRun] = useState<RunState | null>(null)
  const [input, setInput] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<SessionMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
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
      setActive(await api().sessions.load(id))
      setError(null)
      stickToBottom.current = true
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }

  const startNew = async () => {
    if (!settings.selectedModel) return setError('Select a model first.')
    if (mode === 'code') {
      const folder = await api().dialog.pickFolder('Choose the project working folder for this code session')
      if (!folder) return
      setActive(newSession('code', settings.selectedModel, [folder]))
    } else {
      setActive(null)
    }
    setError(null)
    setInput('')
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

  const send = async () => {
    const text = input.trim()
    if (!text || run) return
    const modelId = settings.selectedModel
    if (!modelId) return setError('Select a model first (bottom right).')
    if (mode === 'code' && !active?.folders.length) return setError('Choose a working folder before starting a code session.')

    let session = active ?? newSession(mode, modelId, [])
    const userMsg: Message = { role: 'user', content: text }
    const isFirst = session.messages.length === 0
    session = {
      ...session,
      model: modelId,
      title: isFirst ? text.replace(/\s+/g, ' ').slice(0, 60) : session.title,
      messages: [...session.messages, userMsg],
      updatedAt: new Date().toISOString(),
    }
    setActive(session)
    setInput('')
    setError(null)
    stickToBottom.current = true
    session = await persist(session)
    setActive(session)

    const runId = uid()
    runRef.current = { runId, sessionId: session.id, produced: [], liveText: '', liveThinking: '', approvals: [], notices: [] }
    setRun(runRef.current)

    let failure: string | null = null
    try {
      await api().agent.run({ runId, mode, modelId, history: forModel(session.messages), folders: session.folders })
    } catch (e) {
      failure = String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    }
    const r = runRef.current!
    const produced = [...r.produced]
    // Keep partial text if the run was stopped mid-stream.
    if (r.liveText) produced.push({ role: 'assistant', content: r.liveText + '\n\n*(stopped)*', model: parseModelId(modelId).model })
    if (failure) produced.push({ role: 'assistant', content: failure, isError: true })
    for (const n of r.notices) produced.unshift({ role: 'assistant', content: n, isError: true })
    runRef.current = null
    setRun(null)

    const finished = { ...session, messages: [...session.messages, ...produced], updatedAt: new Date().toISOString() }
    setActive((cur) => (cur?.id === finished.id ? finished : cur))
    const saved = await persist(finished)
    setActive((cur) => (cur?.id === saved.id ? saved : cur))
  }

  const stop = () => run && api().agent.stop(run.runId)

  const answerApproval = (requestId: string, allowed: boolean) => {
    api().agent.approve(requestId, allowed)
    updateRun((r) => ({ ...r, approvals: r.approvals.filter((a) => a.requestId !== requestId) }))
  }

  const doDelete = async (m: SessionMeta) => {
    setConfirmDelete(null)
    await api().sessions.delete(m.id)
    if (active?.id === m.id) setActive(null)
    refreshList()
  }

  const runningHere = !!run && run.sessionId === active?.id
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
            <div key={m.id} className={`session-item ${active?.id === m.id ? 'active' : ''}`} onClick={() => openSession(m.id)}>
              <div className="session-title">{m.title}</div>
              <div className="session-meta">
                {mode === 'code' && m.folders[0] ? basename(m.folders[0]) + ' · ' : ''}
                {new Date(m.updatedAt).toLocaleDateString()}
                {run?.sessionId === m.id && <span className="session-running"> · running</span>}
              </div>
              <button
                className="session-delete"
                title="Delete session"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmDelete(m)
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="sidebar-foot muted small" title={settings.vaultPath || ''}>
          <Icon name="book" size={13} /> Saving to {basename(settings.vaultPath || '')}
        </div>
      </aside>

      <section className="main-pane">
        {active?.notePath && (
          <div className="pane-head">
            <div className="pane-title">{active.title}</div>
            <button className="btn btn-ghost btn-sm" onClick={() => api().shell.openPath(active.notePath!)} title="Open the Markdown note in your vault">
              <Icon name="book" size={14} /> Open note
            </button>
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
                    {a.call.name === 'run_command' ? 'Run this command?' : a.call.name === 'edit_file' ? `Edit ${String(a.call.args.path)}?` : `Write ${String(a.call.args.path)}?`}
                  </div>
                  <ToolArgs call={a.call} />
                  <div className="approval-actions">
                    <button className="btn" onClick={() => answerApproval(a.requestId, false)}>
                      Deny
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
          <div className={`composer ${needsFolder ? 'disabled' : ''}`}>
            <div className="composer-folders">
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
              <span className="muted small">{runningHere ? 'Generating…' : 'Enter to send · Shift+Enter for new line'}</span>
              <div className="composer-right">
                <ModelPicker disabled={!!run || modelBusy} onManage={onManageModels} />
                {run ? (
                  <button className="send-btn stop" onClick={stop} title="Stop">
                    <Icon name="stop" size={16} />
                  </button>
                ) : (
                  <button className="send-btn" onClick={send} disabled={!input.trim() || needsFolder} title="Send">
                    <Icon name="send" size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

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
