import { useRef, useState } from 'react'
import { api, type Attachment } from '../lib/api'
import { Icon, Spinner } from './ui'

/** Short label for the address bar: the file path for working-folder pages, the URL otherwise. */
function label(url: string) {
  if (!url.startsWith('wicked-preview:')) return url
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1)) || 'index.html'
  } catch {
    return url
  }
}

/**
 * Built-in preview panel for code sessions: shows the HTML page / local web app the agent built,
 * right next to the chat. The agent's browser_check and show_preview update it automatically.
 */
export function PreviewPane({
  url,
  reloadKey,
  width,
  resizing,
  onReload,
  onClose,
  onScreenshot,
}: {
  url: string
  reloadKey: number
  width: number
  /** true while the divider is dragged (the page must not swallow mouse events) */
  resizing: boolean
  onReload(): void
  onClose(): void
  onScreenshot(att: Attachment): void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [capturing, setCapturing] = useState(false)
  const [flash, setFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const screenshot = async () => {
    const el = frame.current
    if (!el) return
    setCapturing(true)
    setError(null)
    try {
      const r = el.getBoundingClientRect()
      const att = await api().preview.capture({ x: r.left, y: r.top, width: r.width, height: r.height })
      onScreenshot(att)
      setFlash(true)
      setTimeout(() => setFlash(false), 450)
    } catch (e) {
      setError(String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setCapturing(false)
    }
  }

  return (
    <aside className="preview-pane" style={{ width }}>
      <div className="preview-head">
        <Icon name="monitor" size={14} />
        <span className="preview-url" title={url}>
          {label(url)}
        </span>
        <button className="icon-btn" onClick={onReload} title="Reload">
          <Icon name="refresh" size={14} />
        </button>
        <button className="btn btn-sm" onClick={screenshot} disabled={capturing} title="Take a screenshot of the preview and attach it to your next message">
          {capturing ? <Spinner /> : <Icon name="image" size={13} />} Screenshot
        </button>
        <button className="icon-btn" onClick={() => api().preview.openExternal(url)} title="Open in your web browser">
          <Icon name="external" size={14} />
        </button>
        <button className="icon-btn" onClick={onClose} title="Close preview">
          <Icon name="x" size={14} />
        </button>
      </div>
      {error && <div className="callout error preview-error">{error}</div>}
      <div className={`preview-body ${flash ? 'flash' : ''}`}>
        <iframe
          key={`${url}#${reloadKey}`}
          ref={frame}
          className="preview-frame"
          src={url}
          title="Preview"
          style={{ pointerEvents: resizing ? 'none' : undefined }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups"
          allow="fullscreen; gamepad; autoplay"
        />
      </div>
    </aside>
  )
}
