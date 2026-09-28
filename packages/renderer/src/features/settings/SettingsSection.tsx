import type { ReactNode } from 'react'

/**
 * One block of settings: a display heading, a sentence of context, and the controls below it
 * on one or more cards (SettingsCard).
 */
export function SettingsSection({
  title,
  description,
  children,
  action
}: {
  title: string
  description?: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2.5 pt-8 first:pt-0 wide:pt-10">
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2.5">
          <h2 className="font-display text-[22px] leading-tight font-bold tracking-[-0.3px] text-text">
            {title}
          </h2>
          {action && <div className="shrink-0">{action}</div>}
        </div>
        {description && (
          <p className="max-w-2xl text-[14px] leading-[1.4] font-medium text-text-dim">{description}</p>
        )}
      </header>
      {children}
    </section>
  )
}

/** The surface a group of rows sits on: borderless, radius 20, rows divided by a hairline. */
export function SettingsCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`overflow-hidden rounded-card bg-card ${className}`}>{children}</div>
}

/**
 * A labelled row for a single control, meant to sit inside a SettingsCard. A control too wide
 * to share the line with its label (a phone, a text field) wraps under it.
 */
export function SettingRow({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-4 py-3 first:border-t-0 wide:px-5">
      <div className="min-w-0 flex-1 basis-[200px]">
        <div className="text-[15px] font-semibold text-text">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-[1.45] font-medium text-text-faint">{hint}</div>}
      </div>
      <div className="max-w-full shrink-0">{children}</div>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40
        ${checked ? 'bg-accent' : 'bg-track'}`}
    >
      {/* The knob slides with a bounce; transform only, so nothing re-lays out. */}
      <span
        className={`absolute top-[3px] left-[3px] h-5 w-5 rounded-full bg-white ${checked ? 'translate-x-[18px]' : 'translate-x-0'}`}
        style={{ transition: 'transform 450ms var(--spring-bouncy)' }}
      />
    </button>
  )
}

export const numberField =
  'h-10 w-24 rounded-input border border-transparent bg-input px-3 text-right text-[15px] font-bold text-text tabular-nums outline-none focus:border-accent'

export const textField =
  'h-10 w-72 max-w-full rounded-input border border-transparent bg-input px-3 text-[14px] font-medium text-text outline-none placeholder:text-text-faint focus:border-accent'

/** A full-size select, for a row's main control. */
export const selectField =
  'h-10 max-w-full rounded-input border border-transparent bg-input px-2.5 text-[14px] font-semibold text-text outline-none focus:border-accent'

/** A smaller, quieter select inside a list row (a project's organization, a calendar's area). */
export const rowSelect =
  'h-[38px] max-w-full rounded-input border border-transparent bg-input px-2 text-[13px] font-semibold text-text-dim outline-none focus:border-accent'

/** The "Add" button beside an add-field. */
export const addButton =
  'h-10 shrink-0 rounded-input bg-secondary px-3.5 text-[14px] font-bold text-text transition-colors hover:bg-secondary-hover disabled:cursor-not-allowed disabled:opacity-40'

/** The ✕ that archives a row. */
export const archiveButton =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-input text-[14px] font-bold text-text-faint transition-colors hover:bg-card-hover hover:text-danger-text'

/** Something went wrong. Amber, not red: it is a problem to fix, not a loss. */
export const problemNote = 'rounded-button bg-warn-soft px-4 py-3 text-[13px] font-semibold text-warn'

/** Something worked. */
export const successNote = 'rounded-button bg-rail-active px-4 py-3 text-[14px] font-semibold text-accent-soft'

/** Tiny status chip beside a label ("configured", "online"). */
export const statusChip = 'rounded-pill px-2.5 py-1 text-[12px] font-bold'
