import { ActivityIcon, BellIcon } from '../ui/icons.js'

/**
 * The window's own title bar. `drag-region` makes the empty space draggable, since the
 * native title bar is hidden; the buttons opt out with `no-drag`.
 */
export function TopBar({ running }: { running: boolean }) {
  return (
    <header className="drag-region flex h-10 shrink-0 items-center justify-end gap-4 border-b border-border bg-bg pr-[140px] pl-4">
      <button className="no-drag text-text-dim transition-colors hover:text-text" aria-label="Notifications">
        <BellIcon size={17} />
      </button>

      <div className="no-drag relative text-text-dim">
        <ActivityIcon size={17} />
        {/* Green dot = tracking. Same meaning as the tray icon and the Today header. */}
        {running && (
          <span className="animate-pulse-dot absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-bg" />
        )}
      </div>
    </header>
  )
}
