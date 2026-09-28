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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] wide:bg-scrim wide:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="flex h-full max-h-full w-full flex-col overflow-hidden bg-bg wide:h-auto wide:rounded-modal wide:bg-card wide:shadow-[0_30px_90px_rgba(0,0,0,0.55)]"
        style={{ maxWidth: width }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 pt-4 pb-4 wide:px-7 wide:pt-7 wide:pb-5">
          <div className="min-w-0">
            <h2 className="display-title text-[28px] leading-[1.05] tracking-[-0.4px] text-text">{title}</h2>
            {subtitle && <p className="mt-1 text-[14px] font-medium text-text-dim">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-input text-text-dim transition-colors hover:bg-secondary-hover hover:text-text wide:h-9 wide:w-9"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 wide:px-7 wide:py-6">{children}</div>

        {footer && (
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3.5 wide:flex-nowrap wide:px-7 wide:py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
