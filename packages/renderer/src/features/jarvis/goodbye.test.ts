import { describe, expect, it } from 'vitest'

import { isGoodbye } from './goodbye.js'

describe('isGoodbye', () => {
  it('hears a goodbye on its own', () => {
    for (const said of [
      'Doei!',
      'doei doei',
      'Dag Jarvis.',
      'Tot later.',
      'Later!',
      'Tot morgen',
      'Welterusten',
      'Sluit maar af.',
      'Sluit jezelf maar af',
      'Je mag afsluiten.',
      'Je mag jezelf wel afsluiten',
      'Je mag gaan',
      'Stop maar.',
      'Klaar.',
      'Dat was het.',
      "Dat was 'm",
      'Dat was hem.',
      'Oké, dat was het, doei!',
      // As the speech model heard it in test:cascade (29 Sep 2026).
      'Oké, dat was it. Doei.',
      "Dat was 't",
      'Bedankt Jarvis, doei',
      'Top, dank je wel, tot straks!'
    ]) {
      expect(isGoodbye(said), said).toBe(true)
    }
  })

  it('takes a goodbye with a yes or no in front of it, whatever he asked', () => {
    expect(isGoodbye('Ja, dat was het.', 'Staat erin. Zal ik nog iets doen?')).toBe(true)
    expect(isGoodbye('Nee dat was het', 'Staat erin. Was dat het?')).toBe(true)
    expect(isGoodbye('Nee hoor, doei!', 'Kan ik nog iets voor je doen?')).toBe(true)
  })

  it('takes a plain yes or no as the answer to his closing question', () => {
    expect(isGoodbye('Ja', 'Staat erin. Was dat het?')).toBe(true)
    expect(isGoodbye('ja hoor', 'Was dat hem?')).toBe(true)
    expect(isGoodbye('Nee.', 'Het staat erin. Nog iets?')).toBe(true)
    expect(isGoodbye('Nee hoor', 'Kan ik nog iets voor je doen?')).toBe(true)
    expect(isGoodbye('Nee, verder niks.', 'Verder nog iets?')).toBe(true)
  })

  it('does not take a yes to a proposal for a goodbye', () => {
    expect(isGoodbye('Ja', 'Ik zet Server regelen met Timo op woensdag. Zal ik dat zo doen?')).toBe(false)
    expect(isGoodbye('Ja', 'Wil je dat ik nog iets inplan?')).toBe(false)
    expect(isGoodbye('Ja, doe maar.', 'Was dat het?')).toBe(false)
  })

  it('reads the closing question the right way round', () => {
    // "Nog iets?" – "ja": there is more. "Was dat het?" – "nee": there is more.
    expect(isGoodbye('Ja', 'Nog iets?')).toBe(false)
    expect(isGoodbye('Nee', 'Was dat het?')).toBe(false)
    // A closing question earlier in his answer does not count; only the one he ended on.
    expect(isGoodbye('Ja', 'Was dat het? Dan zet ik de timer aan. Zal ik dat doen?')).toBe(false)
    expect(isGoodbye('Ja', 'Staat erin.')).toBe(false)
  })

  it('does not close on a sentence that only contains a goodbye word', () => {
    for (const said of [
      'Zet kast fixen op klaar.',
      'Ik ben klaar met de taak.',
      'Stop de timer maar.',
      'Zet het later in de planning.',
      'Welke dag is het morgen?',
      'Was dat het enige wat er morgen staat?',
      'Sluit de dag maar af.',
      'Zet om acht uur een uur kast fixen erin, dat was het.',
      '',
      'Goed is nog even uitzoek, red is laad maar.'
    ]) {
      expect(isGoodbye(said), said).toBe(false)
    }
  })

  it('does not close when the word answers his own question', () => {
    expect(isGoodbye('Later', 'Wil je het nu of later inplannen?')).toBe(false)
    expect(isGoodbye('Klaar', 'Ben je al klaar met kast fixen?')).toBe(false)
    expect(isGoodbye('Stop maar', 'De timer loopt nog. Stoppen?')).toBe(false)
    expect(isGoodbye('Sluit maar af', 'Zal ik de dag afsluiten?')).toBe(false)
    // With "jezelf" it is about him, whatever he asked.
    expect(isGoodbye('Sluit jezelf maar af', 'Zal ik de dag afsluiten?')).toBe(true)
  })
})
