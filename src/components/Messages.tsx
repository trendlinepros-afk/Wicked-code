import { useState } from 'react'
import type { Message, ToolCall } from '../lib/api'
import { Markdown } from './Markdown'
import { Icon, Spinner } from './ui'

export function toolSummary(call: ToolCall): string {
  const a = call.args || {}
  return String(a.path ?? a.command ?? a.pattern ?? a.url ?? a.title ?? a.id ?? '')
}

const TOOL_LABELS: Record<string, string> = {
  list_files: 'List',
  read_file: 'Read',
  search_files: 'Search',
  write_file: 'Write',
  edit_file: 'Edit',
  run_command: 'Run',
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
  return (
    <div className={`tool-row ${result?.isError ? 'error' : ''}`}>
      <button className="tool-row-head" onClick={() => setOpen((o) => !o)}>
        <span className={`tool-chevron ${open ? 'open' : ''}`}>▸</span>
        <span className="tool-name">{TOOL_LABELS[call.name] || call.name}</span>
        <span className="tool-summary">{toolSummary(call)}</span>
        {!result && pending && <Spinner />}
        {result?.isError && <span className="tool-badge">failed</span>}
      </button>
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
        if (m.role === 'user') {
          return (
            <div key={i} className="msg user">
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
