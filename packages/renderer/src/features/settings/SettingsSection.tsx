import type { ReactNode } from 'react'

/** One block of settings: a heading, a sentence of context, and the controls. */
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
    <section className="border-b border-border py-8 first:pt-0 last:border-b-0">
      <header className="mb-5 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold text-text">{title}</h2>
          {description && (
            <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-text-dim">{description}</p>
          )}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

/** A labelled row for a single control. */
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
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <div className="text-[14px] text-text">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-text-faint">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
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
      className={`relative h-6 w-11 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40
        ${checked ? 'bg-accent' : 'bg-border-strong'}`}
    >
      <span
        className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-6' : 'left-1'}`}
      />
    </button>
  )
}

export const numberField =
  'w-24 rounded-[8px] border border-border bg-bg px-3 py-2 text-right text-[14px] text-text outline-none focus:border-accent'

export const textField =
  'w-72 rounded-[8px] border border-border bg-bg px-3 py-2 text-[14px] text-text outline-none placeholder:text-text-faint focus:border-accent'
