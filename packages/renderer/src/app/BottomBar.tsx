import { useState } from 'react'
import { MicIcon } from '../ui/icons.js'
import { ITEMS, type Screen } from './IconRail.js'

/** The four a phone needs within reach of a thumb; the rest sit behind "More". */
const PRIMARY: Screen[] = ['today', 'week', 'tasks']

/**
 * The phone's navigation: a bar along the bottom instead of the rail down the side, which
 * would take a third of an iPhone's width. Same screens, same order, same names.
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
        <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setMoreOpen(false)}>
          <div
            className="absolute right-3 bottom-[calc(72px+env(safe-area-inset-bottom))] left-3 grid grid-cols-2 gap-2 rounded-[16px] border border-border bg-card p-3 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            {rest.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => go(id)}
                className={`flex items-center gap-3 rounded-[12px] px-4 py-3.5 text-[15px] ${
                  id === active ? 'bg-rail-active text-accent' : 'text-text'
                }`}
              >
                <Icon size={20} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <nav className="z-50 flex shrink-0 border-t border-border bg-bg pb-[env(safe-area-inset-bottom)]">
        {primary.map(({ id, label, Icon }) => (
          <Tab key={id} label={id === 'week' ? 'Agenda' : label} active={id === active && !moreOpen} onClick={() => go(id)}>
            <Icon size={22} />
          </Tab>
        ))}
        <Tab label="Jarvis" active={false} onClick={onJarvis}>
          <MicIcon size={22} />
        </Tab>
        <Tab label="More" active={moreOpen || inRest} onClick={() => setMoreOpen((open) => !open)}>
          <span className="text-[20px] leading-[22px]">⋯</span>
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
      className={`flex flex-1 flex-col items-center gap-1 pt-2.5 pb-2 ${active ? 'text-accent' : 'text-text-dim'}`}
    >
      {children}
      <span className="text-[11px] font-medium">{label}</span>
    </button>
  )
}
