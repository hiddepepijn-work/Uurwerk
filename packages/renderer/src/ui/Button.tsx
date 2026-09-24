import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  // Primary is green because green means "running/act" everywhere in this app.
  primary: 'bg-accent text-[#06210F] hover:bg-accent-soft font-semibold',
  secondary: 'bg-card border border-border text-text hover:bg-card-hover hover:border-border-strong',
  ghost: 'text-text-dim hover:text-text hover:bg-card',
  danger: 'bg-transparent border border-prio-high/40 text-prio-high hover:bg-prio-high/10'
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-14 px-6 text-base gap-3'
}

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  /** Right-aligned keyboard hint, e.g. "Ctrl+Alt+S". */
  hint?: string
  full?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  hint,
  full,
  children,
  className = '',
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      className={`no-drag inline-flex items-center justify-center rounded-[12px] transition-colors
        disabled:cursor-not-allowed disabled:opacity-40
        ${variants[variant]} ${sizes[size]} ${full ? 'w-full' : ''} ${className}`}
    >
      {icon}
      {children}
      {hint && <span className="ml-auto pl-4 text-xs opacity-60">{hint}</span>}
    </button>
  )
}
