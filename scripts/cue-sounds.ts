/**
 * The app's short cue sounds, synthesised: no samples, no licences, same result every run.
 *
 *   npx tsx scripts/cue-sounds.ts
 *
 * Writes packages/renderer/src/assets/cues/<cue>.wav. The laptop plays the WAVs as they are;
 * the iOS build turns them into .caf for notifications and for the in-app cue.
 *
 *   start    two marimba notes up          ("Opwaarts")
 *   stop     the same two notes down       ("Neerwaarts")
 *   done     an arpeggio with a glint      ("Gelukt")
 *   soon30   one soft bell                 ("Seintje")
 *   soon15   the bell twice, higher        ("Dubbele klok")
 *   begins   timpani roll, run, brass hit  ("Fanfare dramatisch")
 *   countdown  five ticks, one a second, then the start signal at five seconds ("5 sec")
 *   sprintEnd  three bells down and up: the ten minutes are over
 */

import { mkdirSync, writeFileSync } from 'node:fs'

const RATE = 44_100
const OUT = 'packages/renderer/src/assets/cues'

type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle'

interface Voice {
  dur?: number
  gain?: number
  attack?: number
  /** Relative levels of harmonics 2, 3, … on top of the fundamental. */
  overtones?: number[]
  type?: Wave
  /** Glide the pitch here over the first 60% of the note. */
  glideTo?: number | null
}

const N = { C4: 261.63, G4: 392, A4: 440, C5: 523.25, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5, G6: 1567.98 }
const marimba: Voice = { overtones: [0.5, 0.08], dur: 0.35, attack: 0.003 }
const bell: Voice = { overtones: [0.45, 0.25, 0.1], dur: 1.2, attack: 0.004, gain: 0.18 }
const glass: Voice = { overtones: [0.2], dur: 0.9, attack: 0.01, gain: 0.2 }

/** One band-limited period of a wave at phase p (radians), for a fundamental of f Hz. */
function sample(type: Wave, p: number, f: number): number {
  if (type === 'sine') return Math.sin(p)
  let sum = 0
  for (let k = 1; k * f < RATE / 2 - 1000 && k < 60; k++) {
    if (type === 'sawtooth') sum += Math.sin(k * p) / k
    else if (k % 2 === 1) sum += type === 'square' ? Math.sin(k * p) / k : (((k - 1) / 2) % 2 ? -1 : 1) * Math.sin(k * p) / (k * k)
  }
  return type === 'sawtooth' ? (2 / Math.PI) * sum : type === 'square' ? (4 / Math.PI) * sum : (8 / (Math.PI * Math.PI)) * sum
}

class Mix {
  readonly data: Float64Array
  constructor(seconds: number) {
    this.data = new Float64Array(Math.ceil(seconds * RATE))
  }

  /** The same voice the preview page played with Web Audio. */
  tone(at: number, freq: number, voice: Voice = {}): void {
    const { dur = 0.4, gain = 0.22, attack = 0.006, overtones = [0.35, 0.12], type = 'sine', glideTo = null } = voice
    const partials = [1, ...overtones.map((_, index) => index + 2)]
    const levels = [1, ...overtones]
    const start = Math.floor(at * RATE)
    const length = Math.floor((dur + 0.05) * RATE)
    const phases = partials.map(() => 0)
    for (let i = 0; i < length && start + i < this.data.length; i++) {
      const t = i / RATE
      const envelope =
        t < attack ? (gain * t) / attack : t < dur ? gain * Math.pow(0.0001 / gain, (t - attack) / (dur - attack)) : 0
      if (envelope <= 0) continue
      const glide = glideTo ? freq * Math.pow(glideTo / freq, Math.min(1, t / (dur * 0.6))) : freq
      let value = 0
      partials.forEach((mult, index) => {
        phases[index]! += (2 * Math.PI * glide * mult) / RATE
        value += levels[index]! * sample(type, phases[index]!, glide * mult)
      })
      this.data[start + i]! += envelope * value
    }
  }

  /** Peak-normalised 16-bit mono PCM, with 5 ms fades so nothing clicks. */
  wav(): Buffer {
    const peak = this.data.reduce((max, value) => Math.max(max, Math.abs(value)), 0) || 1
    const scale = 0.89 / peak
    const pcm = Buffer.alloc(this.data.length * 2)
    const fade = Math.floor(0.005 * RATE)
    this.data.forEach((value, i) => {
      const edge = Math.min(1, (this.data.length - i) / fade)
      pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value * scale * edge)) * 32767), i * 2)
    })
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcm.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(RATE, 24)
    header.writeUInt32LE(RATE * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcm.length, 40)
    return Buffer.concat([header, pcm])
  }
}

const CUES: Record<string, { seconds: number; play: (mix: Mix) => void }> = {
  start: {
    seconds: 0.5,
    play: (m) => {
      m.tone(0, N.C5, marimba)
      m.tone(0.09, N.G5, marimba)
    }
  },
  stop: {
    seconds: 0.5,
    play: (m) => {
      m.tone(0, N.G5, marimba)
      m.tone(0.1, N.C5, marimba)
    }
  },
  done: {
    seconds: 1.25,
    play: (m) => {
      ;[N.C5, N.E5, N.G5, N.C6].forEach((f, i) => m.tone(i * 0.07, f, marimba))
      m.tone(0.3, N.E6, glass)
    }
  },
  soon30: { seconds: 1.3, play: (m) => m.tone(0, N.A5, bell) },
  soon15: {
    seconds: 1.55,
    play: (m) => {
      m.tone(0, N.C6, bell)
      m.tone(0.28, N.C6, bell)
    }
  },
  begins: {
    seconds: 2.3,
    play: (m) => {
      // A timpani roll that swells into the run.
      for (let i = 0; i < 5; i++) m.tone(i * 0.06, 98, { dur: 0.25, overtones: [0.5], glideTo: 80, gain: 0.18 + i * 0.07, attack: 0.003 })
      const run = 0.34
      ;[N.G5, N.C6, N.E6].forEach((f, i) => {
        m.tone(run + i * 0.1, f, { ...marimba, dur: 0.2, gain: 0.26 })
        m.tone(run + i * 0.1, f / 2, { dur: 0.16, overtones: [], type: 'sawtooth', gain: 0.035 })
      })
      // The brass chord, a low boom, and a bell on top that rings on.
      const hit = run + 0.32
      ;[N.C4, N.G4, N.C5, N.E5, N.G5].forEach((f) => m.tone(hit, f, { dur: 1.5, overtones: [], type: 'sawtooth', gain: 0.045, attack: 0.02 }))
      m.tone(hit, 65, { dur: 0.9, overtones: [0.4], glideTo: 45, gain: 0.55, attack: 0.002 })
      m.tone(hit, N.G6, { ...bell, dur: 1.5, gain: 0.16 })
      m.tone(hit + 0.02, N.C6, { ...bell, dur: 1.5, gain: 0.12 })
    }
  },
  countdown: {
    seconds: 6.6,
    play: (m) => {
      // Five woodblock ticks, one per second, the last one higher: 5, 4, 3, 2, 1.
      for (let i = 0; i < 5; i++) {
        const f = i === 4 ? 1760 : 1320
        m.tone(i, f, { dur: 0.09, overtones: [0.3, 0.1], attack: 0.001, gain: 0.3 })
        m.tone(i, f / 4, { dur: 0.06, overtones: [], attack: 0.001, gain: 0.25 })
      }
      // Go: a bright rising chord with a boom under it.
      const go = 5
      m.tone(go, 65, { dur: 0.6, overtones: [0.4], glideTo: 50, gain: 0.5, attack: 0.002 })
      ;[N.C5, N.E5, N.G5, N.C6].forEach((f, i) => m.tone(go + i * 0.04, f, { ...marimba, dur: 0.5, gain: 0.26 }))
      ;[N.C4, N.G4, N.C5, N.E5].forEach((f) => m.tone(go + 0.12, f, { dur: 1.2, overtones: [], type: "sawtooth", gain: 0.04, attack: 0.02 }))
      m.tone(go + 0.16, N.G6, { ...bell, dur: 1.3, gain: 0.14 })
    }
  },
  sprintEnd: {
    seconds: 2.4,
    play: (m) => {
      m.tone(0, N.G5, bell)
      m.tone(0.25, N.E5, bell)
      m.tone(0.5, N.C6, { ...bell, dur: 1.8, gain: 0.2 })
      m.tone(0.5, N.E6, glass)
    }
  }
}

mkdirSync(OUT, { recursive: true })
for (const [name, cue] of Object.entries(CUES)) {
  const mix = new Mix(cue.seconds)
  cue.play(mix)
  writeFileSync(`${OUT}/${name}.wav`, mix.wav())
  console.log(`${name}.wav`)
}
