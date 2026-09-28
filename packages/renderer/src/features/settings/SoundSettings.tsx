import { useState } from 'react'
import { playCue, type Cue } from '../../lib/cues.js'
import { Button } from '../../ui/Button.js'
import { SettingRow, SettingsCard, SettingsSection } from './SettingsSection.js'

declare global {
  interface Window {
    /** Phone only: schedules the two test notifications (packages/mobile/src/notifications.ts). */
    phoneCues?: { test(): Promise<void> }
  }
}

const CUES: { cue: Cue; label: string; hint: string }[] = [
  { cue: 'start', label: 'Start', hint: 'Two notes up' },
  { cue: 'stop', label: 'Stop', hint: 'The same two notes down' },
  { cue: 'done', label: 'Done', hint: 'An arpeggio with a glint' },
  { cue: 'soon30', label: '30 minutes before', hint: 'One soft bell' },
  { cue: 'soon15', label: '15 minutes before', hint: 'The bell twice, higher' },
  { cue: 'begins', label: 'It starts now', hint: 'Timpani, a run and a brass hit' }
]

/**
 * The sounds for starting, stopping and finishing, and the three before something starts.
 * On the phone the ring/silent switch decides: sound when it rings, a tap when it is silent.
 */
export function SoundSettings() {
  const phone = typeof window !== 'undefined' ? window.phoneCues : undefined
  const [testing, setTesting] = useState(false)

  return (
    <SettingsSection
      title="Sounds"
      description="Start, stop and done make a sound; so do 30 and 15 minutes before a task and the moment it starts. On the phone the silent switch turns them into a tap."
    >
      <SettingsCard>
        {CUES.map(({ cue, label, hint }) => (
          <SettingRow key={cue} label={label} hint={hint}>
            <Button size="sm" onClick={() => playCue(cue)}>
              Play
            </Button>
          </SettingRow>
        ))}
        {phone && (
          <SettingRow
            label="Test the quiet notification"
            hint="Close the app after tapping. In 10 seconds one arrives with no text at all, in 25 seconds one with a short line."
          >
            <Button
              size="sm"
              disabled={testing}
              onClick={() => {
                setTesting(true)
                void phone.test().finally(() => setTimeout(() => setTesting(false), 25_000))
              }}
            >
              {testing ? 'Scheduled' : 'Test'}
            </Button>
          </SettingRow>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
