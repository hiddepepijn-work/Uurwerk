import { useMemo, useRef, useState } from 'react'
import { CalendarIcon } from './icons.js'
import { Popover } from './Popover.js'

/**
 * A month you can click, instead of a three-box date input.
 *
 * The browser's own date field makes you type or step through day, month and year
 * separately, which is the wrong shape for the question actually being asked here — "which
 * day this week" or "the Friday after next". A month grid answers that at a glance.
 *
 * Weeks start on Monday, matching the ISO weeks the whole app plans in.
 */

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

const pad = (n: number): string => String(n).padStart(2, '0')
const toIso = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** Parses 'YYYY-MM-DD' as a local date; `new Date(iso)` would read it as UTC and shift it. */
function fromIso(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year!, (month ?? 1) - 1, day ?? 1)
}

export function DateField({
  value,
  onChange,
  placeholder = 'No date',
  className = ''
}: {
  /** ISO 'YYYY-MM-DD', or '' for no date. */
  value: string
  onChange: (next: string) => void
  placeholder?: string
  className?: string
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const selected = useMemo(() => fromIso(value), [value])
  const [month, setMonth] = useState(() => startOfMonth(selected ?? new Date()))

  const today = new Date()
  const todayIso = toIso(today)

  const days = useMemo(() => {
    const first = startOfMonth(month)
    // Back up to the Monday on or before the 1st, so the grid always starts on a Monday.
    const start = new Date(first)
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7))

    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start)
      date.setDate(start.getDate() + index)
      return date
    })
  }, [month])

  const label = selected
    ? `${selected.getDate()} ${MONTHS[selected.getMonth()]!.slice(0, 3)} ${selected.getFullYear()}`
    : placeholder

  const pick = (date: Date): void => {
    onChange(toIso(date))
    setOpen(false)
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => {
          setMonth(startOfMonth(selected ?? new Date()))
          setOpen((value) => !value)
        }}
        className={`flex items-center gap-2 rounded-[10px] border px-3.5 py-2.5 text-left text-[14px] transition-colors ${
          open ? 'border-accent' : 'border-border hover:border-border-strong'
        } bg-bg ${selected ? 'text-text' : 'text-text-faint'} ${className}`}
      >
        <span className="text-text-dim">
          <CalendarIcon size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>

      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={272}>
        <header className="mb-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setMonth(shiftMonth(month, -1))}
            aria-label="Previous month"
            className="rounded-md px-2 py-1 text-text-dim transition-colors hover:bg-card-hover hover:text-text"
          >
            ←
          </button>
          <span className="text-[13px] font-medium text-text">
            {MONTHS[month.getMonth()]} {month.getFullYear()}
          </span>
          <button
            type="button"
            onClick={() => setMonth(shiftMonth(month, 1))}
            aria-label="Next month"
            className="rounded-md px-2 py-1 text-text-dim transition-colors hover:bg-card-hover hover:text-text"
          >
            →
          </button>
        </header>

        <div className="mb-1 grid grid-cols-7 gap-1">
          {WEEKDAYS.map((day) => (
            <span key={day} className="py-1 text-center text-[11px] text-text-faint">
              {day}
            </span>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {days.map((date) => {
            const iso = toIso(date)
            const outside = date.getMonth() !== month.getMonth()
            const isSelected = iso === value
            const isToday = iso === todayIso

            return (
              <button
                key={iso}
                type="button"
                onClick={() => pick(date)}
                aria-current={isToday ? 'date' : undefined}
                className={`h-8 rounded-[8px] text-[13px] tabular-nums transition-colors ${
                  isSelected
                    ? 'bg-accent font-medium text-[#06210F]'
                    : outside
                      ? 'text-text-faint hover:bg-card-hover'
                      : 'text-text hover:bg-card-hover'
                } ${isToday && !isSelected ? 'ring-1 ring-accent/50 ring-inset' : ''}`}
              >
                {date.getDate()}
              </button>
            )
          })}
        </div>

        <footer className="mt-2 flex items-center justify-between border-t border-border pt-2">
          <button
            type="button"
            onClick={() => pick(today)}
            className="rounded-md px-2 py-1 text-[12px] text-accent transition-opacity hover:opacity-80"
          >
            Today
          </button>
          {/* Blank is a real answer — no due date is not the same as a date far away. */}
          <button
            type="button"
            onClick={() => {
              onChange('')
              setOpen(false)
            }}
            className="rounded-md px-2 py-1 text-[12px] text-text-dim transition-colors hover:text-text"
          >
            Clear
          </button>
        </footer>
      </Popover>
    </>
  )
}

const startOfMonth = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), 1)
const shiftMonth = (date: Date, by: number): Date =>
  new Date(date.getFullYear(), date.getMonth() + by, 1)
