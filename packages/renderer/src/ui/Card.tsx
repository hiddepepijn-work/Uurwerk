import type { ReactNode } from 'react'

interface Props {
  title?: string
  /** Small right-aligned action, e.g. "See all". */
  action?: ReactNode
  children: ReactNode
  className?: string
  padded?: boolean
}

/** The surface every panel sits on: a flat, borderless card one step above the page. */
export function Card({ title, action, children, className = '', padded = true }: Props) {
  return (
    <section
      className={`rounded-card bg-card ${padded ? 'p-5' : ''} ${className}`}
    >
      {(title || action) && (
        <header className={`flex items-center justify-between ${padded ? 'mb-4' : 'p-5 pb-0'}`}>
          {title && <h2 className="text-[16px] font-bold text-text">{title}</h2>}
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
      className="text-[14px] font-bold text-accent-soft transition-opacity hover:opacity-80"
    >
      {children}
    </button>
  )
}
