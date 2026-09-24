import { useEffect, type ReactNode } from 'react'

interface Props {
  open: boolean
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}

/** Centred dialog on a dimmed backdrop. Escape always closes it. */
export function Modal({ open, title, subtitle, onClose, children, footer, width = 860 }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="flex max-h-full w-full flex-col overflow-hidden rounded-[16px] border border-border bg-card"
        style={{ maxWidth: width }}
      >
        <header className="flex items-start justify-between border-b border-border px-7 py-6">
          <div>
            <h2 className="text-[22px] font-semibold text-text">{title}</h2>
            {subtitle && <p className="mt-1 text-[13px] text-text-dim">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-text-dim transition-colors hover:bg-card-hover hover:text-text"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">{children}</div>

        {footer && (
          <footer className="flex items-center justify-between gap-3 border-t border-border px-7 py-5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
