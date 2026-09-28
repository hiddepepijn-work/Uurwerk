/**
 * When the microphone counts as someone talking — the gate in front of the live call.
 *
 * Three things it has to get right, each learned from a real morning:
 *   - Jarvis's own voice comes back through the microphone. While he talks, only speech
 *     clearly louder than that echo opens the gate, or he interrupts himself and starts
 *     over.
 *   - A quiet room is not a quiet microphone: the threshold follows the noise floor, but
 *     never drops to where breathing and fans count as talking.
 *   - People pause mid-sentence. The gate stays open well past a breath, so one sentence
 *     with a pause in it goes out as one turn.
 */

export interface GateDecision {
  /** Send this chunk (and, when it just opened, the pre-roll before it). */
  send: boolean
  /** The gate opened on this chunk. */
  opened: boolean
  /** The gate closed on this chunk: the turn is over. */
  closed: boolean
  threshold: number
}

/** Below this nothing counts as speech, however quiet the room. */
export const FLOOR = 0.012
/** While Jarvis talks, interrupting him takes this much, or more. */
export const BARGE_IN = 0.06
/** How long the voice may drop before the turn counts as finished. */
export const HANGOVER_MS = 2000

export class SpeechGate {
  private noise = 0.004
  private open = false
  private lastVoice = 0

  /** `speaking`: Jarvis's voice is playing (or just stopped), so his echo is in the air. */
  hear(rms: number, now: number, speaking: boolean): GateDecision {
    // The room's noise floor, learnt only while nobody is talking.
    if (!this.open && !speaking) this.noise = this.noise * 0.98 + Math.min(rms, 0.05) * 0.02
    const threshold = speaking ? Math.max(BARGE_IN, this.noise * 8) : Math.max(FLOOR, this.noise * 3)
    const voiced = rms > threshold
    if (voiced) this.lastVoice = now

    if (!this.open) {
      if (!voiced) return { send: false, opened: false, closed: false, threshold }
      this.open = true
      return { send: true, opened: true, closed: false, threshold }
    }
    // Open: keep sending through pauses; close once the voice has been gone long enough.
    if (now - this.lastVoice > HANGOVER_MS) {
      this.open = false
      return { send: true, opened: false, closed: true, threshold }
    }
    return { send: true, opened: false, closed: false, threshold }
  }

  get isOpen(): boolean {
    return this.open
  }
}
