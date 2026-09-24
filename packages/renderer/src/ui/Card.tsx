import type { ReactNode } from 'react'

interface Props {
  title?: string
  /** Small right-aligned action, e.g. "See all". */
  action?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
}

/** The surface every panel in the mockups sits on: flat, 1px border, no shadow. */
export function Card({ title, action, children, className = '', padded = true }: Props) {
  return (
    <section
      className={`rounded-[12px] border border-border bg-card ${padded ? 'p-5' : ''} ${className}`}
    >
      {(title || action) && (
        <header className={`flex items-center justify-between ${padded ? 'mb-4' : 'p-5 pb-0'}`}>
          {title && <h2 className="text-[15px] font-semibold text-text">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function CardAction({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-[13px] text-accent transition-opacity hover:opacity-80"
    >
      {children}
    </button>
  )
}
