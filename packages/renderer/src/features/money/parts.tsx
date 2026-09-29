import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { useSlidingThumb } from '../../ui/useSlidingThumb.js'

/**
 * The small pieces every Geld tab is built from, in the Inkt look: uppercase labels, flat
 * cards, a white block under whatever is selected.
 */

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`text-[12px] font-bold tracking-[0.8px] text-text-faint uppercase ${className}`}>{children}</span>
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`flex flex-col gap-3 rounded-card bg-card p-4 wide:p-5 ${className}`}>{children}</section>
}

export function Big({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-display text-[40px] leading-none font-bold tracking-[-1px] tabular-nums wide:text-[44px] ${className}`}>
      {children}
    </span>
  )
}

export function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  const subTone = tone === 'good' ? 'text-accent-soft font-bold' : tone === 'warn' ? 'text-warn font-bold' : tone === 'bad' ? 'text-danger-text font-bold' : 'text-text-dim'
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-card bg-card p-4">
      <Label>{label}</Label>
      <span className="font-display text-[26px] leading-none font-bold tracking-[-0.6px] tabular-nums wide:text-[30px]">{value}</span>
      {sub && <span className={`text-[13px] ${subTone}`}>{sub}</span>}
    </div>
  )
}

export function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'good' | 'warn' | 'bad' }) {
  const styles = {
    muted: 'bg-input text-text-dim',
    good: 'bg-rail-active text-accent-soft',
    warn: 'bg-warn-soft text-warn',
    bad: 'bg-danger-soft text-danger-text'
  }[tone]
  return <span className={`inline-flex shrink-0 items-center rounded-pill px-2.5 py-0.5 text-[11px] font-bold whitespace-nowrap ${styles}`}>{children}</span>
}

/** A thin bar split into parts; `marker` is a white tick at a fraction (the schedule). */
export function Bar({ parts, marker, height = 10 }: { parts: Array<{ value: number; color: string }>; marker?: number; height?: number }) {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0) || 1
  return (
    <div className="relative w-full" style={{ height }}>
      <div className="flex h-full w-full gap-[3px] overflow-hidden rounded-pill bg-track">
        {parts
          .filter((part) => part.value > 0)
          .map((part, index) => (
            <span key={index} className="h-full" style={{ width: `${(part.value / total) * 100}%`, background: part.color, transition: 'width 1.1s var(--spring-soft)' }} />
          ))}
      </div>
      {marker !== undefined && (
        <span
          aria-hidden="true"
          className="absolute rounded-[2px] bg-text"
          style={{ left: `${Math.min(100, Math.max(0, marker * 100))}%`, top: -4, width: 2, height: height + 8 }}
        />
      )}
    </div>
  )
}

/** A progress bar against a max, with the schedule tick. */
export function Progress({ value, max, marker }: { value: number; max: number; marker?: number }) {
  const fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  return <Bar parts={[{ value: fraction, color: 'var(--color-accent)' }, { value: 1 - fraction, color: 'transparent' }]} marker={marker} />
}

/** Segmented control with the sliding white block. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  small
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  small?: boolean
}) {
  const { containerRef, thumbStyle } = useSlidingThumb<HTMLDivElement>(value)
  return (
    <div ref={containerRef} className="relative flex gap-1 rounded-[12px] bg-input p-[3px]">
      <span aria-hidden="true" className="absolute rounded-[10px] bg-text" style={thumbStyle} />
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          data-active={option.value === value}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`relative z-[1] flex-1 rounded-[10px] px-2 font-bold whitespace-nowrap transition-colors duration-300 ${small ? 'h-8 text-[12px]' : 'h-9 text-[13px]'} ${
            option.value === value ? 'text-bg' : 'text-text-dim hover:text-text'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Row({ left, sub, right, onClick, children }: { left: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; children?: ReactNode }) {
  const body = (
    <>
      {children}
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate text-[15px] font-semibold">{left}</span>
        {sub && <span className="truncate text-[12px] text-text-dim">{sub}</span>}
      </span>
      {right}
    </>
  )
  const className = 'flex min-h-[52px] w-full items-center gap-3 border-t border-border first:border-t-0'
  return onClick ? (
    <button type="button" onClick={onClick} className={`${className} motion-press transition-colors hover:bg-card-hover`}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  )
}

export const input =
  'h-11 w-full rounded-input border border-border-strong bg-input px-3 text-[15px] font-semibold text-text outline-none placeholder:text-text-faint focus:border-accent-dim'

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-bold tracking-[0.6px] text-text-faint uppercase">{label}</span>
      {children}
    </label>
  )
}

/**
 * The width a chart really gets, so its text stays 11–12 px on a phone instead of shrinking
 * with a fixed viewBox.
 */
export function useWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(fallback)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = (): void => setWidth(Math.max(200, Math.round(element.getBoundingClientRect().width)))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}
