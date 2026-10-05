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
