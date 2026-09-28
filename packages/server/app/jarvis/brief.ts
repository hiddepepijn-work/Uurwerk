/**
 * The part of docs/jarvis.md that Jarvis reads.
 *
 * The brief is written for Hidde as much as for Jarvis: how it is built, what the app does
 * without him, the open questions. Jarvis reads his instruction again on every turn, and
 * every token of it is paid for on every turn, so he gets only what shapes his behaviour.
 * The file stays the one place to change him; this only leaves out:
 *
 *   - the introduction and the sections "Wat Jarvis is", "Privacy" and "Techniek"
 *   - the paragraphs about what the app already does on its own ("In de app nu al",
 *     "Al in de app")
 *   - open questions (❓): a line that is only a question goes, a fact with a question
 *     after it keeps the fact
 */

const LEFT_OUT_SECTIONS = new Set(['Wat Jarvis is', 'Privacy', 'Techniek'])
const LEFT_OUT_PARAGRAPHS = [/^In de app nu al/, /^\*\*Al in de app\*\*/]

export function briefForModel(markdown: string): string {
  const out: string[] = []
  let section: string | null = null
  let skippingParagraph = false

  for (const raw of markdown.split(/\r?\n/)) {
    const heading = raw.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      skippingParagraph = false
      if (heading[1] === '#') {
        section = 'intro'
        continue
      }
      if (heading[1] === '##') section = heading[2]!.trim()
      if (section && LEFT_OUT_SECTIONS.has(section)) continue
      out.push(raw)
      continue
    }
    if (section === 'intro' || (section && LEFT_OUT_SECTIONS.has(section))) continue

    if (raw.trim() === '') {
      skippingParagraph = false
      out.push('')
      continue
    }
    if (skippingParagraph) continue
    if (LEFT_OUT_PARAGRAPHS.some((pattern) => pattern.test(raw.trim()))) {
      skippingParagraph = true
      continue
    }

    const question = raw.indexOf('❓')
    if (question >= 0) {
      const before = raw.slice(0, question).replace(/\s+$/, '')
      // "- ❓ …" is only a question; "- fact … ❓ question" keeps the fact.
      if (/^\s*[-*]?\s*$/.test(before)) continue
      out.push(before)
      continue
    }
    out.push(raw)
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
