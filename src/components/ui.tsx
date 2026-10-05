import { useEffect, type ReactNode } from 'react'

export function Modal({ children, onClose, width = 440 }: { children: ReactNode; onClose?: () => void; width?: number }) {
  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  )
}

/** Yes/No confirmation dialog. */
export function ConfirmDialog({
  title,
  message,
  yesLabel = 'Yes',
  noLabel = 'No',
  danger,
  onYes,
  onNo,
}: {
  title: string
  message: ReactNode
  yesLabel?: string
  noLabel?: string
  danger?: boolean
  onYes(): void
  onNo(): void
}) {
  return (
    <Modal onClose={onNo}>
      <h3 className="modal-title">{title}</h3>
      <div className="modal-body">{message}</div>
      <div className="modal-actions">
        <button className="btn" onClick={onNo} autoFocus>
          {noLabel}
        </button>
        <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onYes}>
          {yesLabel}
        </button>
      </div>
    </Modal>
  )
}

export function Stars({ stars, title }: { stars: number; title?: string }) {
  if (stars <= 0) {
    return (
      <span className="stars none" title={title}>
        Won’t run
      </span>
    )
  }
  return (
    <span className="stars" title={title} aria-label={`${stars} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= stars ? 'star on' : 'star'}>
          ★
        </span>
      ))}
    </span>
  )
}

export function Spinner() {
  return <span className="spinner" aria-hidden />
}

const paths: Record<string, string> = {
  chat: 'M4 5h16v11H8l-4 4V5z',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6z',
  folder: 'M3 6h6l2 2h10v11H3z',
  plus: 'M12 5v14M5 12h14',
  send: 'M5 12h14M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  x: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  chevron: 'M8 10l4 4 4-4',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
  key: 'M14 10a4 4 0 1 0-3.9 4H11v2h2v2h2v2h3v-3l-4.1-4.1A4 4 0 0 0 14 10z',
  cpu: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zM5 17a3 3 0 0 1 3-3h11',
  check: 'M5 12l5 5 9-10',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  refresh: 'M20 11a8 8 0 0 0-14.7-4.4L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.4L20 16M20 20v-4h-4',
  github: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  play: 'M7 4l13 8-13 8z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
}

export function Icon({ name, size = 16 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[name] || ''} />
    </svg>
  )
}

export function formatGB(bytesOrGB: number, isBytes = true) {
  const gb = isBytes ? bytesOrGB / 1024 ** 3 : bytesOrGB
  return gb >= 10 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`
}

export function basename(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}
