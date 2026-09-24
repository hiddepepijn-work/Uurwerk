import {
  BarChartIcon,
  CalendarIcon,
  ChecklistIcon,
  ClockIcon,
  DocumentIcon,
  FolderIcon,
  GearIcon
} from '../ui/icons.js'
import { HotkeyLegend } from './HotkeyLegend.js'

export type Screen =
  | 'today'
  | 'week'
  | 'tasks'
  | 'projects'
  | 'reports'
  | 'statistics'
  | 'settings'

const ITEMS: Array<{ id: Screen; label: string; Icon: typeof ClockIcon }> = [
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
  return (
    <nav className="flex w-32 shrink-0 flex-col border-r border-border bg-bg pt-3">
      <div className="flex flex-col gap-1 px-3">
        {ITEMS.map(({ id, label, Icon }) => {
          const isActive = id === active
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className={`relative flex flex-col items-center gap-1.5 rounded-[12px] py-3.5 transition-colors
                ${isActive ? 'bg-rail-active text-accent' : 'text-text-dim hover:bg-card hover:text-text'}`}
            >
              {isActive && (
                <span className="absolute top-1/2 left-0 h-8 w-[3px] -translate-y-1/2 rounded-r bg-accent" />
              )}
              <Icon size={20} />
              <span className="text-[11px] font-medium">{label}</span>
            </button>
          )
        })}
      </div>

      <HotkeyLegend />
    </nav>
  )
}
