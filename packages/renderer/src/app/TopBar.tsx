import { ActivityIcon, BellIcon, MicIcon } from '../ui/icons.js'

/**
 * The window's own title bar. `drag-region` makes the empty space draggable, since the
 * native title bar is hidden; the buttons opt out with `no-drag`. The right padding keeps
 * clear of the window buttons, which the main process draws 56px tall to match.
 */
export function TopBar({ running, onJarvis }: { running: boolean; onJarvis: () => void }) {
  return (
    <header className="drag-region flex h-14 shrink-0 items-center justify-end gap-2.5 border-b border-border bg-bg pr-[152px] pl-7">
      <button
        onClick={onJarvis}
        className="no-drag flex h-9 items-center gap-2 rounded-full bg-input pr-3.5 pl-3 text-[14px] font-bold text-text transition-colors hover:bg-secondary-hover"
        aria-label="Jarvis"
      >
        <MicIcon size={16} />
        Jarvis
      </button>

      <button
        className="no-drag flex h-9 w-9 items-center justify-center rounded-full text-text-dim transition-colors hover:bg-card hover:text-text"
        aria-label="Notifications"
        title="Notifications"
      >
        <BellIcon size={18} />
      </button>

      <div className="no-drag relative flex h-9 w-9 items-center justify-center text-text-dim" aria-label="Tracking">
        <ActivityIcon size={18} />
        {/* Green dot = tracking. Same meaning as the tray icon and the Today header. */}
        {running && (
          <span className="animate-pulse-dot absolute top-[7px] right-1.5 h-2 w-2 rounded-full bg-accent shadow-[0_0_0_3px_rgba(93,174,134,0.25)]" />
        )}
      </div>
    </header>
  )
}
