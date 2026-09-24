import { useEffect, useRef, useState } from 'react'
import { ClockIcon } from './icons.js'
import { Popover } from './Popover.js'

/**
 * Two scrollable columns instead of a stepper.
 *
 * The browser's time input wants you to hit a two-character box and type, or nudge one
 * minute at a time — miserable for "start at half nine" and the source of the `24:00`
 * warning the app used to log, since Chromium rejects that value outright while the planner
 * legitimately means "midnight at the end of this day".
 *
 * Owning the control fixes both: hours and minutes scroll and snap, and end-of-day can be
 * shown as 24:00 because nothing here has to satisfy an HTML time parser.
 *
 * The value is minutes since midnight, which is what plan blocks and availability already
 * speak — no parsing back and forth at every call site.
 */

const pad = (n: number): string => String(n).padStart(2, '0')

export const formatMinute = (minute: number): string =>
  `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`

export function TimeField({
  value,
  onChange,
  /** Allows 24:00, which the planner uses to mean the end of the day. */
  allowEndOfDay = false,
  step = 5,
  className = ''
}: {
  value: number
  onChange: (minuteOfDay: number) => void
  allowEndOfDay?: boolean
  step?: number
  className?: string
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const hours = Array.from({ length: allowEndOfDay ? 25 : 24 }, (_, index) => index)
  const minutes = Array.from({ length: Math.ceil(60 / step) }, (_, index) => index * step)

  const hour = Math.floor(value / 60)
  const minute = value % 60

  const set = (nextHour: number, nextMinute: number): void => {
    // 24:00 is the end of the day and has no minutes past it.
    if (nextHour === 24) return onChange(24 * 60)
    onChange(nextHour * 60 + nextMinute)
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={`flex items-center gap-2 rounded-[8px] border px-2.5 py-1.5 font-mono text-[13px] tabular-nums transition-colors ${
          open ? 'border-accent' : 'border-border hover:border-border-strong'
        } bg-bg text-text ${className}`}
      >
        <span className="text-text-dim">
          <ClockIcon size={13} />
        </span>
        {formatMinute(value)}
      </button>

      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={196}>
        <div className="flex gap-2">
          <Column
            items={hours}
            selected={hour}
            open={open}
            onSelect={(next) => set(next, minute)}
            label="Hour"
          />
          <Column
            items={minutes}
            selected={minute}
            open={open}
            onSelect={(next) => set(hour, next)}
            label="Minute"
            disabled={hour === 24}
          />
        </div>

        <footer className="mt-2 flex items-center justify-between border-t border-border pt-2">
          <button
            type="button"
            onClick={() => {
              const now = new Date()
              // Rounded to the step, because nobody plans a block to start at 09:37.
              const rounded = Math.round((now.getHours() * 60 + now.getMinutes()) / step) * step
              onChange(Math.min(rounded, allowEndOfDay ? 24 * 60 : 23 * 60 + 55))
            }}
            className="rounded-md px-2 py-1 text-[12px] text-accent transition-opacity hover:opacity-80"
          >
            Now
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md px-2 py-1 text-[12px] text-text-dim transition-colors hover:text-text"
          >
            Done
          </button>
        </footer>
      </Popover>
    </>
  )
}

/**
 * One scrolling column.
 *
 * Snap points make it land on a value rather than between two, and the selection is
 * scrolled to the middle when the panel opens — otherwise picking 17:00 starts at midnight
 * and means a long drag every time.
 */
function Column({
  items,
  selected,
  open,
  onSelect,
  label,
  disabled = false
}: {
  items: number[]
  selected: number
  open: boolean
  onSelect: (value: number) => void
  label: string
  disabled?: boolean
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    // After the panel has been placed, not during: scrolling an unpositioned element does
    // nothing useful.
    const id = requestAnimationFrame(() => {
      const list = listRef.current
      const active = activeRef.current
      if (!list || !active) return
      list.scrollTop = active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2
    })
    return () => cancelAnimationFrame(id)
  }, [open, selected])

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-center text-[11px] text-text-faint">{label}</div>
      <div
        ref={listRef}
        className={`h-40 snap-y snap-mandatory overflow-y-auto rounded-[8px] border border-border bg-bg ${
          disabled ? 'pointer-events-none opacity-40' : ''
        }`}
      >
        {items.map((item) => {
          const isSelected = item === selected
          return (
            <button
              key={item}
              ref={isSelected ? activeRef : undefined}
              type="button"
              onClick={() => onSelect(item)}
              className={`block w-full snap-center py-2 text-center font-mono text-[13px] tabular-nums transition-colors ${
                isSelected ? 'bg-accent/15 font-medium text-accent' : 'text-text-dim hover:bg-card-hover hover:text-text'
              }`}
            >
              {pad(item)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
