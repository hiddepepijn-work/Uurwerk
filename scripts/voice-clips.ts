/**
 * The phone's spoken notification sounds, in Jarvis's own voice (Gemini TTS, Orus).
 *
 *   npx tsx scripts/voice-clips.ts      (needs GEMINI_API_KEY in .env.local)
 *
 * Writes packages/mobile/sounds/<name>.wav; the iOS build turns them into .caf.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { speakGemini } from '../packages/server/app/jarvis/speech.js'

const CLIPS: Record<string, string> = {
  ochtend: 'Hoi Hidde. Goedemorgen. Hoe ziet je ochtend eruit?',
  avond: 'Hey Hidde, dagafsluiting. Is alles gelukt vandaag?',
  herinnering: 'Yo Hidde, even een herinnering.',
  vertrek: 'Hidde, lukt het? Nog een kwartier, dan moet je in de auto zitten. Pak je spullen.'
}

const key = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/)
  .find((line) => line.startsWith('GEMINI_API_KEY='))!
  .slice('GEMINI_API_KEY='.length)
  .trim()

const only = process.argv.slice(2)
for (const [name, text] of Object.entries(CLIPS)) {
  if (only.length > 0 && !only.includes(name)) continue
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(`packages/mobile/sounds/${name}.wav`, await speakGemini(text, key, 'Orus', process.env.TTS_MODEL ?? 'gemini-3.8-flash-tts'))
      console.log(`${name}.wav`)
      break
    } catch (error) {
      if (attempt >= 4 || !String(error).includes('429')) throw error
      await new Promise((resolve) => setTimeout(resolve, 20_000))
    }
  }
}
