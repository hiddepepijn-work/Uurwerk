/**
 * Did Hidde just say goodbye? A plain check on his words (and on what Jarvis said just before),
 * so the conversation ends even when the model forgets its end_conversation tool: on 28 Sep
 * 2026 "Succes ermee en welterusten straks! Doei!" was said, and the call stayed open.
 *
 * The whole sentence has to be a goodbye: "doei", "dat was het", "sluit jezelf maar af", with
 * "oké", "bedankt" or "Jarvis" around it. "Zet de taak op klaar" is not one. A bare "ja" or
 * "nee" only counts as the answer to his own closing question: "ja" to "was dat het?", "nee"
 * to "nog iets?". A "ja" to "Zal ik dat zo doen?" is a yes to the proposal.
 */

/** Lowercase, no accents or punctuation; "dat was 'm" reads as "dat was hem". */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/'m\b/g, ' hem')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

interface Phrase {
  pattern: RegExp
  /** Not a goodbye when Jarvis's last words match this: then it answers his question. */
  unless?: RegExp
}

const SELF = '(?:je|jezelf|jou|jouzelf)'
const SOFT = '(?:wel|nu|maar|nou|gerust|dan)'

/** Goodbyes, longest first so "tot later" goes before "later". */
const PHRASES: Phrase[] = [
  { pattern: /\bdat (?:was|is) (?:het|hem|alles|t|it|em)(?:(?:wel|voor nu|voor vandaag|even))?\b/g },
  { pattern: new RegExp(`\\b(?:je|jij) (?:mag|kan|kunt) (?:${SELF} )?(?:${SOFT} )*(?:afsluiten|uitzetten|uitgaan|gaan|stoppen|ophangen)\\b`, 'g') },
  { pattern: new RegExp(`\\b(?:sluit|zet) ${SELF} (?:${SOFT} )*(?:af|uit)\\b`, 'g') },
  { pattern: new RegExp(`\\bsluit (?:${SOFT} )*af\\b`, 'g'), unless: /\b(?:sluit|afslu\w*|dagafslu\w*)/ },
  { pattern: /\bafsluiten\b/g, unless: /\b(?:sluit|afslu\w*|dagafslu\w*)/ },
  { pattern: /\bstop (?:maar|nu|dan)\b/g, unless: /\bstop\w*/ },
  { pattern: /\btot (?:later|straks|zo|morgen|ziens|snel|de volgende keer|kijk)\b/g },
  { pattern: /\b(?:doei|doeg|dooi|daag|dahag)+(?: (?:doei|doeg|daag))*\b/g },
  { pattern: /\bdag\b/g, unless: /\bdag\b/ },
  { pattern: /\b(?:welterusten|slaap lekker|fijne (?:avond|dag|middag)|houdoe|ciao|goodbye|bye(?: bye)?|adios)\b/g },
  { pattern: /\blater\b/g, unless: /\blater\b/ },
  { pattern: /\b(?:we zijn |ik ben )?klaar(?: hoor| ermee)?\b/g, unless: /\bklaar\b/ }
]

/** Words around a goodbye that change nothing: "oké, bedankt Jarvis, doei". */
const FILLERS =
  /\b(?:oke|okay|ok|oki|prima|is goed|goed|top|mooi|super|perfect|fijn|nice|alright|nou|hoor|dan|even|wel|verder|echt|jarvis|bedankt|dankjewel|dankje|dank je wel|dank je|dank u wel|dank u|thanks|thank you|merci)\b/g

/** A yes or a no, and nothing else. */
const YES = /^(?:ja|jawel|jep|jazeker|yes|klopt|zeker)(?: (?:ja|klopt|zeker|dat klopt))*$/
const NO = /^(?:nee|neen|nope|no|niks|niets)(?: (?:nee|niks|niets|meer|anders))*$/

/** Jarvis's closing questions: "was dat het?" takes a yes, "nog iets?" a no. */
const ASKS_DONE = /\b(?:was dat (?:het|hem|alles)|is dat (?:het|alles)|was dit het|dat was het)\b/
const ASKS_MORE = /\b(?:nog (?:iets|wat|meer|een vraag|andere)|iets anders|verder nog|anders nog|kan ik (?:je )?(?:nog|verder))\b/
/** A proposal in the same question: then his "ja" is a yes to that. */
const OFFERS = /\b(?:zal ik|wil je|moet ik|zullen we|zet ik|plan ik|doe ik|mag ik)\b/

/** The question Jarvis ended on, if he ended on one. */
function closingQuestion(lastAssistantText: string): string | null {
  const sentences = lastAssistantText.trim().split(/(?<=[.!?])\s+/)
  const last = sentences[sentences.length - 1] ?? ''
  if (!last.trim().endsWith('?')) return null
  const question = normalize(last)
  return OFFERS.test(question) ? null : question
}

export function isGoodbye(userText: string, lastAssistantText = ''): boolean {
  let rest = normalize(userText)
  if (!rest) return false
  const before = normalize(lastAssistantText)

  let found = false
  for (const { pattern, unless } of PHRASES) {
    rest = rest.replace(pattern, (match) => {
      if (unless?.test(before)) return match
      found = true
      return ' '
    })
  }
  rest = rest.replace(FILLERS, ' ').replace(/\s+/g, ' ').trim()

  // "Ja, dat was het", "nee hoor, doei": a goodbye with a yes or no around it.
  if (found) return rest === '' || YES.test(rest) || NO.test(rest)

  const question = closingQuestion(lastAssistantText)
  if (!question) return false
  return (ASKS_DONE.test(question) && YES.test(rest)) || (ASKS_MORE.test(question) && NO.test(rest))
}
