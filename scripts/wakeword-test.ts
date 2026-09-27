/**
 * Does the laptop's wake word hear "Hey Jarvis", and only that? Real speech, several voices,
 * run through the same detector the app uses.
 *
 *   npm run test:wakeword
 *
 * Needs GEMINI_API_KEY (in .env.local) for the voices. Costs well under a cent.
 */

import { existsSync, readFileSync } from 'node:fs'

import { speakGemini } from '../packages/server/app/jarvis/speech.js'
import { WakeWordDetector } from '../packages/main/src/wakeword.js'

function geminiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim()
  const line = existsSync('.env.local')
    ? readFileSync('.env.local', 'utf8').split(/\r?\n/).find((entry) => entry.startsWith('GEMINI_API_KEY='))
    : undefined
  if (!line) throw new Error('Geen GEMINI_API_KEY in .env.local')
  return line.slice('GEMINI_API_KEY='.length).trim()
}

/** 24 kHz WAV from the TTS, down to 16 kHz with a second of quiet around it. */
function to16k(wav: Uint8Array): Int16Array {
  const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.byteLength))
  const speech = new Int16Array(Math.floor((pcm.length * 2) / 3))
  for (let i = 0; i < speech.length; i++) {
    const at = (i * 3) / 2
    const low = Math.floor(at)
    const high = Math.min(low + 1, pcm.length - 1)
    speech[i] = Math.round(pcm[low]! + (pcm[high]! - pcm[low]!) * (at - low))
  }
  const out = new Int16Array(speech.length + 32000)
  // Faint room noise rather than digital silence.
  for (let i = 0; i < out.length; i++) out[i] = Math.round((Math.random() * 2 - 1) * 60)
  out.set(speech, 16000)
  return out
}

/** The TTS allows a few requests a minute: wait and try again when it says so. */
async function voiced(text: string, key: string, voice: string): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await speakGemini(text, key, voice, 'gemini-3.8-flash-tts')
    } catch (error) {
      if (attempt >= 4 || !String(error).includes('429')) throw error
      await new Promise((resolve) => setTimeout(resolve, 20_000))
    }
  }
}

const CASES: Array<{ text: string; voice: string; expect: boolean }> = [
  { text: 'Hey Jarvis!', voice: 'Kore', expect: true },
  { text: 'Hey Jarvis.', voice: 'Orus', expect: true },
  { text: 'Hey Jarvis, what is on my agenda?', voice: 'Puck', expect: true },
  { text: 'Hé Jarvis, wat staat er morgen?', voice: 'Charon', expect: true },
  { text: 'Wat staat er morgen op de planning?', voice: 'Kore', expect: false },
  { text: 'Hey Tessie, zullen we vanavond eten?', voice: 'Orus', expect: false },
  { text: 'Ik ga zo naar de stage in Nieuwendijk.', voice: 'Puck', expect: false },
  { text: 'Harvest, harvest, the garden is ready.', voice: 'Charon', expect: false },
  { text: 'Hé Jarvis!', voice: 'Kore', expect: true },
  { text: 'Hey Jarvis, zet een afspraak.', voice: 'Puck', expect: true },
  { text: 'Hé jij daar, heb je even?', voice: 'Kore', expect: false },
  { text: 'Hey Jasper, alles goed met je?', voice: 'Charon', expect: false },
  { text: 'Heerlijk weer vandaag, zullen we naar buiten?', voice: 'Orus', expect: false },
  { text: 'Hij heeft een garage vol auto spullen.', voice: 'Puck', expect: false },
  { text: 'Jarvis is een figuur uit Iron Man.', voice: 'Kore', expect: false }
]

async function main(): Promise<void> {
  const key = geminiKey()
  const detector = await WakeWordDetector.load('packages/main/assets/wakeword')
  let failures = 0
  for (const entry of CASES) {
    const audio = to16k(await voiced(entry.text, key, entry.voice))
    // In 40 ms pieces, as the microphone delivers it.
    let heard = false
    let best = 0
    for (let at = 0; at < audio.length; at += 640) {
      const result = await detector.push(audio.slice(at, at + 640))
      heard ||= result.heard
      best = Math.max(best, result.best)
    }
    const ok = heard === entry.expect
    if (!ok) failures += 1
    console.log(`${ok ? '✓' : '✗'} ${entry.expect ? 'hoort ' : 'negeert'} "${entry.text}" (${entry.voice})  hoogste score ${best.toFixed(2)}`)
  }
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((error: unknown) => {
  console.error('✗', error instanceof Error ? error.message : error)
  process.exit(1)
})
