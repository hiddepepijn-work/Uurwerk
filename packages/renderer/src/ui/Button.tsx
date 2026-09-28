import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  // Primary is green because green means "running/act" everywhere in this app.
  primary: 'bg-accent text-accent-ink hover:bg-accent-soft font-bold',
  secondary: 'bg-secondary text-text hover:bg-secondary-hover font-bold',
  ghost: 'text-text-dim hover:text-text hover:bg-card-hover font-semibold',
  danger: 'bg-danger-soft text-danger-text hover:brightness-125 font-bold'
}

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-[13px] gap-1.5',
  md: 'h-11 px-4 text-sm gap-2',
  lg: 'h-[52px] px-6 text-base gap-3'
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
  // Presses sink to .95; filled buttons also lift 2px on hover where there is a real pointer
  // (globals.css: motion-press / motion-lift). Ghost buttons stay flat — a shadow under text reads as a bug.
  return (
    <button
      {...rest}
      className={`no-drag inline-flex items-center justify-center ${size === 'lg' ? 'rounded-[16px]' : 'rounded-button'} motion-press ${variant === 'ghost' ? '' : 'motion-lift'}
        disabled:cursor-not-allowed disabled:opacity-40
        ${variants[variant]} ${sizes[size]} ${full ? 'w-full' : ''} ${className}`}
    >
      {icon}
      {children}
      {/* A keyboard hint means nothing on a phone. */}
      {hint && <span className="ml-auto hidden pl-4 text-xs font-semibold opacity-60 wide:inline">{hint}</span>}
    </button>
  )
}
