import { useLiveQuery } from '../hooks/useLiveQuery.js'

/**
 * Pinned to the bottom of the rail, straight from the mockups.
 *
 * This is the best detail in the whole design: the app's real interface on a working day is
 * the hotkeys, not the window. Showing them permanently teaches them without a tutorial,
 * and the day you stop needing the window is the day the app is doing its job.
 */
export function HotkeyLegend() {
  const { data: settings } = useLiveQuery((api) => api.settings.get(), ['settings'])

  const pretty = (accelerator: string): string =>
    accelerator.replace('CommandOrControl', 'Ctrl').replace(/\+/g, '+')

  const rows = settings
    ? [
        { label: 'Start / Stop', key: pretty(settings.hotkeys.startStop) },
        { label: 'Quick add', key: pretty(settings.hotkeys.quickAdd) },
        { label: 'End of day', key: pretty(settings.hotkeys.endOfDay) }
      ]
    : []

  return (
    <div className="mt-auto border-t border-border px-3 py-4">
      <p className="mb-2.5 px-1 text-[11px] font-medium text-text-dim">Hotkeys</p>
      <div className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <div key={row.label} className="px-1">
            <div className="text-[11px] text-text-faint">{row.label}</div>
            <kbd className="mt-1 inline-block rounded-md border border-border bg-card px-1.5 py-1 font-mono text-[10px] text-text-dim">
              {row.key}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  )
}
