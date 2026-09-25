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
      // On a phone the dialog is the whole screen, above the tab bar, clear of the notch.
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] wide:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="flex h-full max-h-full w-full flex-col overflow-hidden border-border bg-card wide:h-auto wide:rounded-[16px] wide:border"
        style={{ maxWidth: width }}
      >
        <header className="flex items-start justify-between border-b border-border px-4 py-4 wide:px-7 wide:py-6">
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

        <div className="flex-1 overflow-y-auto px-4 py-4 wide:px-7 wide:py-6">{children}</div>

        {footer && (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 wide:flex-nowrap wide:px-7 wide:py-5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
