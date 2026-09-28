import { useState } from 'react'
import { MicIcon } from '../ui/icons.js'
import { ITEMS, type Screen } from './IconRail.js'

/** The four a phone needs within reach of a thumb; the rest sit behind "More". */
const PRIMARY: Screen[] = ['today', 'week', 'tasks']

/**
 * The phone's navigation: a pill floating along the bottom instead of the rail down the
 * side, which would take a third of an iPhone's width. Same screens, same order, same names.
 *
 * The gap under the pill is 26px on an iPhone (its 34px home-indicator inset less 8) and
 * 14px where there is no inset: `max(14px, inset - 8px)`.
 */
export function BottomBar({
  active,
  onNavigate,
  onJarvis
}: {
  active: Screen
  onNavigate: (screen: Screen) => void
  onJarvis: () => void
}) {
  const [moreOpen, setMoreOpen] = useState(false)
  const primary = ITEMS.filter((item) => PRIMARY.includes(item.id))
  const rest = ITEMS.filter((item) => !PRIMARY.includes(item.id))
  const inRest = rest.some((item) => item.id === active)

  const go = (screen: Screen): void => {
    setMoreOpen(false)
    onNavigate(screen)
  }

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-40 bg-scrim" onClick={() => setMoreOpen(false)}>
          <div
            role="dialog"
            aria-label="More"
            // Pill height (66) + its top margin (8) + 8 of air above it, over the bottom gap.
            className="absolute right-3.5 bottom-[calc(82px+max(14px,calc(env(safe-area-inset-bottom)-8px)))] left-3.5 grid grid-cols-2 gap-2 rounded-[24px] border border-border bg-card p-2.5"
            onClick={(event) => event.stopPropagation()}
          >
            {rest.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => go(id)}
                className={`flex h-16 items-center gap-3 rounded-[16px] px-4 text-[15px] font-bold ${
                  id === active ? 'bg-rail-active text-accent-soft' : 'bg-input text-text'
                }`}
              >
                <Icon size={22} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <nav
        aria-label="Main"
        className="z-50 mx-3.5 mt-2 mb-[max(14px,calc(env(safe-area-inset-bottom)-8px))] flex h-[66px] shrink-0 items-center justify-around rounded-[33px] bg-tabbar px-2"
      >
        {primary.map(({ id, label, Icon }) => (
          <Tab key={id} label={id === 'week' ? 'Agenda' : label} active={id === active && !moreOpen} onClick={() => go(id)}>
            <Icon size={22} />
          </Tab>
        ))}
        <Tab label="Jarvis" active={false} onClick={onJarvis}>
          {/* The one accent in the bar: talking is the default way in. */}
          <span className="-mt-1 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-accent text-accent-ink">
            <MicIcon size={17} />
          </span>
        </Tab>
        <Tab label="More" active={moreOpen || inRest} onClick={() => setMoreOpen((open) => !open)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </Tab>
      </nav>
    </>
  )
}

function Tab({
  label,
  active,
  onClick,
  children
}: {
  label: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex w-[62px] flex-col items-center gap-0.5 text-[11px] font-bold transition-colors ${
        active ? 'text-text' : 'text-text-faint'
      }`}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}
