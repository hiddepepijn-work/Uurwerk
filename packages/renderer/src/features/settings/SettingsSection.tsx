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
          <h2 className="text-[16px] font-bold text-text">{title}</h2>
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
        <div className="text-[14px] font-semibold text-text">{label}</div>
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
      className={`relative h-[26px] w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40
        ${checked ? 'bg-accent' : 'bg-track'}`}
    >
      <span
        className={`absolute top-[3px] h-5 w-5 rounded-full bg-white transition-all ${checked ? 'left-[21px]' : 'left-[3px]'}`}
      />
    </button>
  )
}

export const numberField =
  'h-10 w-24 rounded-input border border-transparent bg-input px-3 text-right text-[14px] font-medium text-text outline-none focus:border-accent'

export const textField =
  'h-10 w-72 rounded-input border border-transparent bg-input px-3 text-[14px] font-medium text-text outline-none placeholder:text-text-faint focus:border-accent'
