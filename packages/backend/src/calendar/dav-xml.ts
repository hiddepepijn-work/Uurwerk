/**
 * Just enough XML to read a CalDAV multistatus.
 *
 * A DOM parser would be the obvious tool and would be a new runtime dependency for a job
 * that is genuinely small: CalDAV replies are machine-generated, deeply predictable, and we
 * need exactly three things out of them — the href of each response, one or two property
 * values per response, and the status that says whether those properties were found.
 *
 * Two things make a naive `indexOf` approach wrong, and both are handled here:
 *
 *   1. **Namespace prefixes vary.** iCloud writes `<d:href>`, others write `<D:href>` or a
 *      bare `<href>` with a default namespace. So everything matches on *local* name.
 *   2. **`calendar-data` contains an entire iCalendar body**, which is full of colons and
 *      newlines and may itself contain escaped XML entities. It has to be decoded, not
 *      pattern-matched.
 *
 * What this is not: a general XML parser. It does not handle CDATA, comments, or attributes
 * beyond ignoring them. If a server ever needs that, this should become a real parser rather
 * than growing more special cases.
 */

/** One `<response>` inside a `<multistatus>`. */
export interface DavResponse {
  href: string
  /** Property values by local element name, from propstats that reported 200. */
  props: Record<string, string>
  /** Local names of elements present as empty markers, e.g. resourcetype children. */
  flags: string[]
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'"
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (match) => ENTITIES[match] ?? match)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
}

/** Escapes a value being written into a request body. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Strips any namespace prefix: `d:href` and `D:href` and `href` are all `href`. */
const localName = (tag: string): string => {
  const bare = tag.replace(/^\/*/, '').split(/[\s>/]/)[0] ?? ''
  const colon = bare.indexOf(':')
  return (colon === -1 ? bare : bare.slice(colon + 1)).toLowerCase()
}

/**
 * Every occurrence of one element's inner text, by local name.
 *
 * Returns raw inner content — callers decode it if it is text, or scan it further if it is
 * a container. Self-closing elements yield an empty string, which is how a marker element
 * like `<calendar/>` is detected.
 */
export function elements(xml: string, name: string): string[] {
  const out: string[] = []
  const target = name.toLowerCase()
  // Matches an opening tag with an optional prefix, then lazily to its matching close. The
  // laziness is what keeps sibling elements from being swallowed into one another.
  const pattern = new RegExp(
    `<((?:[A-Za-z0-9_.-]+:)?${target})(\\s[^>]*?)?(/)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${target}\\s*>|` +
      `<((?:[A-Za-z0-9_.-]+:)?${target})(\\s[^>]*?)?/>`,
    'gi'
  )

  for (const match of xml.matchAll(pattern)) {
    // Group 4 is the body of a paired element; a self-closing match has none.
    out.push(match[4] ?? '')
  }
  return out
}

/** The first occurrence, or null. */
export const element = (xml: string, name: string): string | null => elements(xml, name)[0] ?? null

/** Local names of the direct child elements of a fragment. */
export function childNames(xml: string): string[] {
  return [...xml.matchAll(/<([A-Za-z0-9_.:-]+)(?:\s[^>]*)?\/?>/g)]
    .map((match) => localName(match[1] ?? ''))
    .filter((name) => name.length > 0)
}

/**
 * Parses a `<multistatus>` body into one entry per `<response>`.
 *
 * Only propstats whose status line says 200 contribute properties. A server answering "404
 * for this property" inside an otherwise successful response is normal, and treating that
 * as a value is how an empty display name ends up overwriting a real one.
 */
export function parseMultistatus(xml: string, wanted: string[]): DavResponse[] {
  return elements(xml, 'response').map((body) => {
    const props: Record<string, string> = {}
    const flags: string[] = []

    for (const propstat of elements(body, 'propstat')) {
      const status = element(propstat, 'status') ?? ''
      if (!/\s200\s/.test(status)) continue

      for (const prop of elements(propstat, 'prop')) {
        for (const name of wanted) {
          const value = element(prop, name)
          if (value !== null) props[name] = decodeEntities(value).trim()
        }
        // `resourcetype` is a container of markers rather than a value, and it is how a
        // calendar collection is told apart from a plain folder.
        const resourcetype = element(prop, 'resourcetype')
        if (resourcetype) flags.push(...childNames(resourcetype))
      }
    }

    return {
      href: decodeEntities(element(body, 'href') ?? '').trim(),
      props,
      flags
    }
  })
}
