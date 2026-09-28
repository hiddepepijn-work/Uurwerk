import { useLiveQuery } from '../hooks/useLiveQuery.js'

/**
 * Pinned to the bottom of the sidebar, straight from the mockups.
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
    <div className="mt-auto flex flex-col gap-2.5 rounded-[18px] bg-card p-3.5">
      <p className="label-caps">Hotkeys</p>
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col items-start gap-1">
          <div className="text-[13px] font-semibold text-text-dim">{row.label}</div>
          <kbd className="rounded-[8px] bg-input px-2 py-[3px] font-sans text-[12px] font-bold text-text tabular-nums">
            {row.key}
          </kbd>
        </div>
      ))}
    </div>
  )
}
