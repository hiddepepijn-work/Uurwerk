import {
  BarChartIcon,
  CalendarIcon,
  ChecklistIcon,
  ClockIcon,
  DocumentIcon,
  FolderIcon,
  GearIcon
} from '../ui/icons.js'
import mark from '../assets/uurwerk-mark.png'
import wordmark from '../assets/uurwerk-wordmark.png'
import { HotkeyLegend } from './HotkeyLegend.js'
import { useSlidingThumb } from '../ui/useSlidingThumb.js'

export type Screen =
  | 'today'
  | 'week'
  | 'tasks'
  | 'projects'
  | 'reports'
  | 'statistics'
  | 'settings'

export const ITEMS: Array<{ id: Screen; label: string; Icon: typeof ClockIcon }> = [
  { id: 'today', label: 'Today', Icon: ClockIcon },
  { id: 'week', label: 'Week', Icon: CalendarIcon },
  { id: 'tasks', label: 'Tasks', Icon: ChecklistIcon },
  // Beside Tasks on purpose: same work, read in dependency order rather than by priority.
  { id: 'projects', label: 'Projects', Icon: FolderIcon },
  { id: 'reports', label: 'Reports', Icon: DocumentIcon },
  { id: 'statistics', label: 'Statistics', Icon: BarChartIcon },
  { id: 'settings', label: 'Settings', Icon: GearIcon }
]

/**
 * Six items.
 *
 * This said "five, never six" for most of the app's life, and the reasoning still holds for
 * anything that is a variation on planning or reviewing: it belongs inside Today, Week or
 * Tasks. Statistics earned the exception because it answers a different question from all of
 * them — not "what now" but "what happened" — over ranges the other screens do not cover.
 * A seventh needs the same argument, and "it did not fit anywhere" is not one.
 */
export function IconRail({
  active,
  onNavigate
}: {
  active: Screen
  onNavigate: (screen: Screen) => void
}) {
  const { containerRef, thumbStyle } = useSlidingThumb<HTMLDivElement>(active, { duration: 550 })

  return (
    <nav className="flex w-[232px] shrink-0 flex-col gap-1 overflow-y-auto bg-sidebar px-4 py-[22px]">
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-6">
        <img src={mark} alt="" className="h-[30px] w-[30px]" draggable={false} />
        <img src={wordmark} alt="Uurwerk" className="h-[19px] w-auto" draggable={false} />
      </div>

      <div ref={containerRef} className="relative flex shrink-0 flex-col gap-1">
        {/* The light pill: springs to the active item instead of jumping there. */}
        <span aria-hidden="true" className="rounded-[12px] bg-text" style={thumbStyle} />
        {ITEMS.map(({ id, label, Icon }) => {
          const isActive = id === active
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              aria-current={isActive ? 'page' : undefined}
              data-active={isActive}
              className={`relative z-[1] flex h-[42px] shrink-0 items-center gap-3 rounded-[12px] px-3 text-[15px] transition-colors duration-300 ${
                isActive ? 'font-bold text-bg' : 'font-semibold text-text-dim hover:bg-card hover:text-text'
              }`}
            >
              <span className="rail-icon">
                <Icon size={19} />
              </span>
              <span>{label}</span>
            </button>
          )
        })}
      </div>

      <HotkeyLegend />
    </nav>
  )
}
