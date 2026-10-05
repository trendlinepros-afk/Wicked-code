import { useEffect, useRef, useState } from 'react'
import { api, type NotesContext, type Theme } from '../lib/api'
import { useTheme } from '../lib/theme'
import { Icon } from '../components/ui'

type Tab = 'app' | 'session'
type Pending = { scope: Tab; id?: string; text: string }

const SAVE_DELAY = 400

/**
 * The separate Notes window: an app-wide note (same everywhere) and a note for the chat / code
 * session currently open in the main window. Everything saves automatically as you type.
 */
export function NotesApp() {
  const [theme, setTheme] = useState<Theme>('system')
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return localStorage.getItem('wicked.notesTab') === 'session' ? 'session' : 'app'
    } catch {
      return 'app'
    }
  })
  const [ctx, setCtx] = useState<NotesContext | null>(null)
  const [appText, setAppText] = useState<string | null>(null)
  const [sessionText, setSessionText] = useState<string | null>(null)
  const [status, setStatus] = useState<'saved' | 'saving' | 'error'>('saved')
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<Pending | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionId = useRef<string | undefined>(undefined)

  useTheme(theme)

  const flush = async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const p = pending.current
    if (!p) return
    pending.current = null
    try {
      await api().notes.write(p.scope, p.id, p.text)
      if (!pending.current) setStatus('saved')
      setError(null)
    } catch (e) {
      setStatus('error')
      setError(String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const queueSave = (p: Pending) => {
    // A pending save for a different note goes out right away.
    if (pending.current && (pending.current.scope !== p.scope || pending.current.id !== p.id)) flush()
    pending.current = p
    setStatus('saving')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY)
  }

  // Theme follows the app's setting (re-checked whenever this window gets focus).
  useEffect(() => {
    const read = () =>
      api()
        .settings.get()
        .then((s) => setTheme(s.theme ?? 'system'))
        .catch(() => {})
    read()
    window.addEventListener('focus', read)
    return () => window.removeEventListener('focus', read)
  }, [])

  // App-wide note + which session is open in the main window.
  useEffect(() => {
    api().notes.read('app').then(setAppText, () => setAppText(''))
    api().notes.getContext().then(setCtx)
    const off = api().notes.onContext(setCtx)
    // Never lose the last keystrokes when the window closes.
    const beforeUnload = () => {
      const p = pending.current
      if (p) api().notes.writeNow(p.scope, p.id, p.text)
      pending.current = null
    }
    window.addEventListener('beforeunload', beforeUnload)
    const offFlush = api().notes.onFlush(beforeUnload)
    return () => {
      off()
      offFlush()
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [])

  // Switching sessions in the main window swaps the session note (saving the old one first).
  useEffect(() => {
    sessionId.current = ctx?.id
    setSessionText(null)
    if (!ctx) return
    let live = true
    flush().then(() =>
      api()
        .notes.read('session', ctx.id)
        .then((t) => live && setSessionText(t), () => live && setSessionText('')),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.id])

  useEffect(() => {
    document.title = 'Wicked Code — Notes'
  }, [])

  const pickTab = (t: Tab) => {
    setTab(t)
    try {
      localStorage.setItem('wicked.notesTab', t)
    } catch {
      /* not remembered */
    }
  }

  const kind = ctx?.mode === 'code' ? 'code session' : 'chat'

  return (
    <div className="notes-app">
      <div className="notes-tabs" role="tablist">
        <button role="tab" className={`notes-tab ${tab === 'app' ? 'active' : ''}`} onClick={() => pickTab('app')} title="The same note in every chat and code session">
          <Icon name="book" size={14} /> App-wide
        </button>
        <button
          role="tab"
          className={`notes-tab ${tab === 'session' ? 'active' : ''}`}
          onClick={() => pickTab('session')}
          title={ctx ? `Notes for “${ctx.title}”` : 'Notes for the chat or code session open in Wicked Code'}
        >
          <Icon name={ctx?.mode === 'code' ? 'code' : 'chat'} size={14} />
          <span className="notes-tab-text">{ctx ? ctx.title || `This ${kind}` : 'This session'}</span>
        </button>
      </div>

      <div className="notes-body">
        <textarea
          className="notes-input"
          style={{ display: tab === 'app' ? undefined : 'none' }}
          placeholder={appText === null ? 'Loading…' : 'Things to improve in Wicked Code… (shared across every chat and code session)'}
          disabled={appText === null}
          value={appText ?? ''}
          spellCheck
          onChange={(e) => {
            setAppText(e.target.value)
            queueSave({ scope: 'app', text: e.target.value })
          }}
          onBlur={flush}
        />
        {tab === 'session' && !ctx && (
          <div className="notes-empty muted">
            <Icon name="chat" size={22} />
            <p>Open a chat or code session in Wicked Code to take notes about it.</p>
          </div>
        )}
        <textarea
          key={ctx?.id ?? 'none'}
          className="notes-input"
          style={{ display: tab === 'session' && ctx ? undefined : 'none' }}
          placeholder={sessionText === null ? 'Loading…' : `Notes for this ${kind} only…`}
          disabled={sessionText === null}
          value={sessionText ?? ''}
          spellCheck
          onChange={(e) => {
            setSessionText(e.target.value)
            queueSave({ scope: 'session', id: sessionId.current, text: e.target.value })
          }}
          onBlur={flush}
        />
      </div>

      <div className={`notes-foot ${status}`}>
        {status === 'error' ? (
          <span title={error ?? ''}>Couldn’t save: {error}</span>
        ) : status === 'saving' ? (
          <span>Saving…</span>
        ) : (
          <span>
            <Icon name="check" size={12} /> Saved automatically
          </span>
        )}
        <span className="muted">Vault › Wicked Code › Notes</span>
      </div>
    </div>
  )
}
