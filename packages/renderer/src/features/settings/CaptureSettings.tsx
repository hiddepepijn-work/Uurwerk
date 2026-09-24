import { useState } from 'react'
import {
  CAPTURE_PROFILES,
  estimateStorage,
  type CaptureQuality,
  type Settings
} from '@core/contract/types.js'
import { SettingRow, SettingsSection, Toggle, numberField } from './SettingsSection.js'

interface Props {
  settings: Settings
  onPatch: (changes: Partial<Settings>) => void
}

const QUALITIES = Object.values(CAPTURE_PROFILES)

/**
 * Everything about screen capture, including the parts that are easy to get wrong.
 *
 * Two decisions are visible here rather than buried. The storage estimate is a *range* from
 * measured JPEG sizes, because a single number would be a promise that only holds for a dark
 * editor. And the blocklist gets a real editor rather than a comma-separated field — it is
 * the control that decides whether a video call ends up in a screenshot, so it should read
 * as a list you can check at a glance.
 */
export function CaptureSettings({ settings, onPatch }: Props) {
  const [draft, setDraft] = useState('')

  const addEntry = (): void => {
    const value = draft.trim().toLowerCase()
    if (!value) return
    if (settings.captureBlocklist.some((entry) => entry.toLowerCase() === value)) {
      setDraft('')
      return
    }
    onPatch({ captureBlocklist: [...settings.captureBlocklist, value] })
    setDraft('')
  }

  const removeEntry = (entry: string): void => {
    onPatch({ captureBlocklist: settings.captureBlocklist.filter((item) => item !== entry) })
  }

  const cost = estimateStorage(settings.captureQuality, settings.captureIntervalMin)
  const videoSeconds = Math.max(1, Math.round(cost.framesPerDay / Math.max(1, settings.timelapseFps)))

  return (
    <SettingsSection
      title="Screen capture"
      description="Screenshots are taken only while the timer runs, only of your primary monitor, and never while you are idle or working in a blocked window. Nothing captured is shared until you approve it frame by frame in the end-of-day wizard."
    >
      <SettingRow
        label="Capture screenshots while tracking"
        hint="Stopping the timer always stops capture; this switch turns it off even while tracking"
      >
        <Toggle
          checked={settings.captureEnabled}
          onChange={(next) => onPatch({ captureEnabled: next })}
        />
      </SettingRow>

      <SettingRow label="Quality" hint="Frames are never scaled up beyond your screen's own resolution">
        <select
          value={settings.captureQuality}
          onChange={(event) => onPatch({ captureQuality: event.target.value as CaptureQuality })}
          className="rounded-[8px] border border-border bg-bg px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
        >
          {QUALITIES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label} · ~{profile.kbPerFrame} KB
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow label="Minutes between screenshots">
        <input
          type="number"
          min="1"
          max="120"
          value={settings.captureIntervalMin}
          onChange={(event) =>
            onPatch({ captureIntervalMin: Math.max(1, Number(event.target.value)) })
          }
          className={numberField}
        />
      </SettingRow>

      <div className="mt-2 mb-5 rounded-[10px] border border-border bg-bg px-4 py-3 text-[13px] leading-relaxed text-text-dim">
        <span className="font-mono text-text">{cost.framesPerDay}</span> frames on an eight-hour
        day — about <span className="font-mono text-text">{cost.mbPerDayLow}–{cost.mbPerDayHigh} MB</span>,
        so roughly <span className="font-mono text-text">{cost.mbRetainedHigh} MB</span> on disk
        once the 14-day window is full. It stops growing there: frames older than that are
        deleted automatically, and timelapses are kept because they are small.
        <br />
        <span className="text-text-faint">
          The lower figure is measured on a code editor, which compresses well; a browser or a
          map lands nearer the upper one.
        </span>
      </div>

      <SettingRow
        label="Timelapse speed (frames per second)"
        hint={`A full day becomes about ${videoSeconds} second${videoSeconds === 1 ? '' : 's'} of video. Encoding runs in real time, so that is also roughly how long building it takes.`}
      >
        <input
          type="number"
          min="1"
          max="30"
          value={settings.timelapseFps}
          onChange={(event) =>
            onPatch({ timelapseFps: Math.min(30, Math.max(1, Number(event.target.value))) })
          }
          className={numberField}
        />
      </SettingRow>

      <div className="mt-4 rounded-[12px] border border-border p-4">
        <div className="mb-1 text-[14px] text-text">Never capture these windows</div>
        <p className="mb-4 max-w-xl text-[12px] leading-relaxed text-text-faint">
          A screenshot is skipped when the window you are working in has any of these words in
          its title. Matching is case-insensitive and partial, so <code>teams</code> covers
          &ldquo;Chat | Microsoft Teams&rdquo;. Note what this cannot do: the screenshot is of
          your whole screen, so a blocked app sitting open behind something else is still in
          the frame. That is what the per-frame approval is for.
        </p>

        <div className="mb-4 flex flex-wrap gap-2">
          {settings.captureBlocklist.length === 0 && (
            <span className="text-[13px] text-prio-med">
              Empty — nothing is excluded from capture.
            </span>
          )}
          {settings.captureBlocklist.map((entry) => (
            <button
              key={entry}
              onClick={() => removeEntry(entry)}
              title="Remove from the blocklist"
              className="group flex items-center gap-2 rounded-full border border-border bg-bg px-3 py-1.5 text-[13px] text-text-dim hover:border-prio-high/50 hover:text-text"
            >
              {entry}
              <span className="text-text-faint group-hover:text-prio-high">×</span>
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addEntry()
              }
            }}
            placeholder="Add a word from the window title, e.g. signal"
            className="flex-1 rounded-[8px] border border-border bg-bg px-3 py-2 text-[14px] text-text outline-none focus:border-accent"
          />
          <button
            onClick={addEntry}
            className="rounded-[8px] border border-border bg-bg px-4 text-[13px] text-text-dim hover:text-text"
          >
            Add
          </button>
        </div>
      </div>
    </SettingsSection>
  )
}
