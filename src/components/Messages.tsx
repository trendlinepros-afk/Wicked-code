import { useState } from 'react'
import { api, type Attachment, type Message, type ToolCall } from '../lib/api'
import { Markdown } from './Markdown'
import { Icon, Spinner } from './ui'

const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`)

/** A file attached to a message (or waiting in the composer). */
export function AttachmentChip({ att, reading, onRemove }: { att: Attachment; reading?: boolean; onRemove?: () => void }) {
  const detail = reading
    ? 'Reading…'
    : att.error
      ? att.error
      : [att.pages ? `${att.pages} page${att.pages === 1 ? '' : 's'}` : null, att.size ? fmtSize(att.size) : null, att.truncated ? 'truncated' : null]
          .filter(Boolean)
          .join(' · ')
  return (
    <span className={`att-chip ${att.error ? 'error' : ''} ${att.kind}`} title={`${att.path}${att.error ? `\n${att.error}` : ''}`}>
      {att.thumb ? (
        <img className="att-thumb" src={att.thumb} alt="" />
      ) : (
        <span className="att-icon">{reading ? <Spinner /> : <Icon name={att.kind === 'image' ? 'image' : 'file'} size={15} />}</span>
      )}
      <span className="att-text">
        <span className="att-name">{att.name}</span>
        <span className="att-detail">{detail}</span>
      </span>
      {onRemove && (
        <button onClick={onRemove} title="Remove">
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  )
}

export function toolSummary(call: ToolCall): string {
  const a = call.args || {}
  return String(a.path ?? a.filename ?? a.target ?? a.command ?? a.pattern ?? a.url ?? a.title ?? a.id ?? '')
}

const TOOL_LABELS: Record<string, string> = {
  list_files: 'List',
  read_file: 'Read',
  search_files: 'Search',
  write_file: 'Write',
  edit_file: 'Edit',
  run_command: 'Run',
  save_document: 'Save document',
  open_in_browser: 'Preview',
  show_preview: 'Preview',
  start_process: 'Start',
  read_process_output: 'Logs',
  stop_process: 'Stop',
  list_processes: 'Processes',
  http_request: 'HTTP',
  browser_check: 'Browser',
  github_create_pull_request: 'Pull request',
}

export function ToolArgs({ call }: { call: ToolCall }) {
  const a = call.args || {}
  if (call.name === 'edit_file') {
    return (
      <div className="diff">
        {String(a.old_string ?? '')
          .split('\n')
          .map((l, i) => (
            <div key={'o' + i} className="diff-del">
              - {l}
            </div>
          ))}
        {String(a.new_string ?? '')
          .split('\n')
          .map((l, i) => (
            <div key={'n' + i} className="diff-add">
              + {l}
            </div>
          ))}
      </div>
    )
  }
  if (call.name === 'save_document') return <pre className="tool-pre">{String(a.content ?? '')}</pre>
  if (call.name === 'write_file') return <pre className="tool-pre">{String(a.content ?? '')}</pre>
  if (call.name === 'run_command' || call.name === 'start_process') return <pre className="tool-pre">$ {String(a.command ?? '')}</pre>
  if (call.name === 'github_create_pull_request') {
    return (
      <pre className="tool-pre">
        {String(a.title ?? '')}
        {a.base ? ` → ${String(a.base)}` : ''}
        {'\n\n'}
        {String(a.body ?? '')}
      </pre>
    )
  }
  return <pre className="tool-pre">{JSON.stringify(a, null, 2)}</pre>
}

function ToolRow({ call, result, pending }: { call: ToolCall; result?: Message; pending: boolean }) {
  const [open, setOpen] = useState(false)
  const [big, setBig] = useState(false)
  return (
    <div className={`tool-row ${result?.isError ? 'error' : ''}`}>
      <button className="tool-row-head" onClick={() => setOpen((o) => !o)}>
        <span className={`tool-chevron ${open ? 'open' : ''}`}>▸</span>
        <span className="tool-name">{TOOL_LABELS[call.name] || call.name}</span>
        <span className="tool-summary">{toolSummary(call)}</span>
        {!result && pending && <Spinner />}
        {result?.isError && <span className="tool-badge">failed</span>}
      </button>
      {result?.thumb && (
        <button className={`tool-shot ${big ? 'big' : ''}`} onClick={() => setBig((b) => !b)} title={big ? 'Click to shrink' : 'Screenshot the agent took while testing — click to enlarge'}>
          <img src={result.thumb} alt="Screenshot of the page under test" />
        </button>
      )}
      {open && (
        <div className="tool-row-body">
          <ToolArgs call={call} />
          {result && <pre className="tool-pre result">{result.content}</pre>}
        </div>
      )}
    </div>
  )
}

export function MessageList({
  messages,
  live,
  running,
}: {
  messages: Message[]
  live?: { text: string; thinking: string } | null
  running: boolean
}) {
  const results = new Map<string, Message>()
  for (const m of messages) if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m)

  return (
    <>
      {messages.map((m, i) => {
        if (m.role === 'tool') return null
        if (m.role === 'user' && m.synthetic && m.review) {
          return (
            <div key={i} className="msg nudge review" title={m.content}>
              <Icon name="image" size={13} /> The model is looking at the screenshot: “Does this look like what you asked for? Any errors?”
            </div>
          )
        }
        if (m.role === 'user' && m.synthetic) {
          return (
            <div key={i} className="msg nudge" title={m.content}>
              <Icon name="refresh" size={13} /> Wicked Code reminded the model to actually do the work with tools
            </div>
          )
        }
        if (m.role === 'user') {
          return (
            <div key={i} className="msg user">
              {m.attachments?.some((a) => a.thumb) && (
                <div className="msg-images">
                  {m.attachments
                    .filter((a) => a.thumb)
                    .map((a) => (
                      <button key={a.path} className="msg-image" onClick={() => api().shell.openPath(a.path)} title={`${a.name} — click to open`}>
                        <img src={a.thumb} alt={a.name} />
                      </button>
                    ))}
                </div>
              )}
              {m.attachments?.some((a) => !a.thumb) && (
                <div className="msg-files">
                  {m.attachments
                    .filter((a) => !a.thumb)
                    .map((a) => (
                      <AttachmentChip key={a.path} att={a} />
                    ))}
                </div>
              )}
              <div className="bubble">{m.content}</div>
            </div>
          )
        }
        return (
          <div key={i} className={`msg assistant ${m.isError ? 'error' : ''}`}>
            {m.thinking && <Thinking text={m.thinking} />}
            {m.content && (m.isError ? <div className="callout error">{m.content}</div> : <Markdown text={m.content} />)}
            {m.toolCalls?.map((c) => (
              <ToolRow key={c.id} call={c} result={results.get(c.id)} pending={running} />
            ))}
          </div>
        )
      })}
      {live && (live.text || live.thinking || running) && (
        <div className="msg assistant">
          {live.thinking && <Thinking text={live.thinking} live />}
          {live.text ? <Markdown text={live.text} /> : running && !live.thinking && <div className="typing"><span /><span /><span /></div>}
        </div>
      )}
    </>
  )
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking">
      <button onClick={() => setOpen((o) => !o)}>
        {live ? <Spinner /> : <span className={`tool-chevron ${open ? 'open' : ''}`}>▸</span>} {live ? 'Thinking…' : 'Thought process'}
      </button>
      {(open || live) && <div className="thinking-body">{live ? text.slice(-1200) : text}</div>}
    </div>
  )
}

export function EmptyIcon({ mode }: { mode: 'chat' | 'code' }) {
  return (
    <div className="empty-icon">
      <Icon name={mode} size={28} />
    </div>
  )
}
