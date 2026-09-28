/**
 * The short sounds for starting, stopping and finishing, and for what is coming up.
 *
 * The laptop plays the WAVs in the window; the phone swaps in a native player (see
 * packages/mobile/src/main.tsx) so the ring/silent switch decides between sound and a tap.
 * The files are made by scripts/cue-sounds.ts.
 */

import begins from '../assets/cues/begins.wav?url'
import done from '../assets/cues/done.wav?url'
import soon15 from '../assets/cues/soon15.wav?url'
import soon30 from '../assets/cues/soon30.wav?url'
import start from '../assets/cues/start.wav?url'
import stop from '../assets/cues/stop.wav?url'

export type Cue = 'start' | 'stop' | 'done' | 'soon30' | 'soon15' | 'begins'

const FILES: Record<Cue, string> = { start, stop, done, soon30, soon15, begins }

const playInWindow = (cue: Cue): void => {
  const audio = new Audio(FILES[cue])
  audio.volume = 0.8
  // A browser that refuses sound before the first click just stays quiet.
  void audio.play().catch(() => undefined)
}

let player: (cue: Cue) => void = playInWindow

export function setCuePlayer(play: (cue: Cue) => void): void {
  player = play
}

export function playCue(cue: Cue): void {
  try {
    player(cue)
  } catch {
    // A sound is never worth an error.
  }
}
