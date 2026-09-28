import type { PublishFlags } from '@core/contract/types.js'
import { InfoIcon, ShieldIcon } from '../../ui/icons.js'

interface Props {
  flags: PublishFlags
  onChange: (flags: PublishFlags) => void
  counts: { screenshots: number; timelapse: number }
}

const ROWS: Array<{ key: keyof PublishFlags; label: string }> = [
  { key: 'sessions', label: 'Time tracking & sessions' },
  { key: 'tasks', label: 'Tasks (completed & in progress)' },
  { key: 'summary', label: 'Daily summary (text)' },
  { key: 'screenshots', label: 'Screenshots (selected)' },
  { key: 'timelapse', label: 'Timelapse' }
]

/**
 * What leaves this machine.
 *
 * Every box starts unticked, every day. Yesterday's choice is restored for convenience but
 * a fresh day never inherits consent — publishing has to be an act, not a habit the app
 * performs on your behalf.
 */
export function PublishSelection({ flags, onChange, counts }: Props) {
  const toggle = (key: keyof PublishFlags): void => onChange({ ...flags, [key]: !flags[key] })

  const rightLabel = (key: keyof PublishFlags): string | null => {
    if (key === 'screenshots') return `${counts.screenshots} selected`
    if (key === 'timelapse') return counts.timelapse === 1 ? '1 file' : `${counts.timelapse} files`
    return null
  }

  const disabled = (key: keyof PublishFlags): boolean =>
    (key === 'screenshots' && counts.screenshots === 0) ||
    (key === 'timelapse' && counts.timelapse === 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-card border border-border p-[18px]">
        <div className="mb-1.5 flex items-center gap-2">
          <h3 className="text-[15px] font-bold">What will be published</h3>
          <span className="text-text-faint">
            <InfoIcon size={15} />
          </span>
        </div>

        <ul className="flex flex-col">
          {ROWS.map((row) => {
            const isDisabled = disabled(row.key)
            const checked = flags[row.key] && !isDisabled
            return (
              <li key={row.key}>
                <label
                  className={`flex h-[38px] items-center gap-3 ${isDisabled ? 'opacity-40' : 'cursor-pointer'}`}
                >
                  <span
                    onClick={() => !isDisabled && toggle(row.key)}
                    className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] border-[1.5px] transition-colors
                      ${checked ? 'border-accent bg-accent text-accent-ink' : 'border-border-strong bg-transparent'}`}
                  >
                    {checked && (
                      <svg className="animate-pop" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </span>
                  <span className="flex-1 text-[14px] font-semibold text-text">{row.label}</span>
                  {rightLabel(row.key) && (
                    <span className="text-[13px] font-bold text-text-faint">{rightLabel(row.key)}</span>
                  )}
                </label>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="flex gap-3 rounded-card bg-rail-active px-[18px] py-4">
        <span className="mt-px shrink-0 text-accent-soft">
          <ShieldIcon size={20} />
        </span>
        <div className="flex flex-col gap-1">
          <h3 className="text-[15px] font-bold text-accent-soft">Privacy check</h3>
          <p className="text-[13px] leading-normal text-text-dim">
          Only the items ticked above become visible to your supervisor, and only after you press
          Publish. Screenshots additionally need to be approved one by one in the next step.
          Everything else stays on this machine, and Publish can be undone.
          </p>
        </div>
      </div>
    </div>
  )
}
