import { describe, expect, it } from 'vitest'

import { SentenceChunker } from './voice.js'

const chunk = (pieces: string[]): string[] => {
  const out: string[] = []
  const chunker = new SentenceChunker((sentence) => out.push(sentence))
  for (const piece of pieces) chunker.push(piece)
  chunker.flush()
  return out
}

describe('SentenceChunker', () => {
  it('speaks whole sentences as soon as they are complete', () => {
    expect(chunk(['Morgen heb je ', 'stage. Daarna ', 'ben je vrij', '. Zal ik iets inplannen?'])).toEqual([
      'Morgen heb je stage.',
      'Daarna ben je vrij.',
      'Zal ik iets inplannen?'
    ])
  })

  it('does not cut a time or a number in half', () => {
    expect(chunk(['Om 20:00 staat kast fixen, 1.5 uur later ben je klaar.'])).toEqual(['Om 20:00 staat kast fixen, 1.5 uur later ben je klaar.'])
  })

  it('cuts a long clause at a comma so he can start talking', () => {
    const long = 'Morgen staat van negen tot twaalf en van half een tot vijf stage gepland voor je architectuuronderzoek, en daarna nog broeken in de zak doen'
    const out = chunk([long])
    expect(out.length).toBeGreaterThan(1)
    expect(out.join(' ')).toBe(long)
  })
})
