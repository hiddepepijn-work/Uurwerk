/**
 * Reading CalDAV multistatus bodies.
 *
 * The bodies here are shaped like the ones iCloud actually returns, prefixes and all —
 * `<d:...>` for WebDAV, `<cal:...>` for CalDAV, `<cs:...>` for the Apple extensions. Getting
 * the prefixes wrong is the classic way a hand-rolled DAV client silently reads nothing.
 */

import { describe, expect, it } from 'vitest'
import { childNames, decodeEntities, element, elements, escapeXml, parseMultistatus } from './dav-xml.js'

describe('namespace prefixes', () => {
  it('reads the same element whatever prefix it wears', () => {
    expect(element('<d:href>/a/</d:href>', 'href')).toBe('/a/')
    expect(element('<D:href>/a/</D:href>', 'href')).toBe('/a/')
    expect(element('<href>/a/</href>', 'href')).toBe('/a/')
    expect(element('<caldav:href>/a/</caldav:href>', 'href')).toBe('/a/')
  })

  it('does not mistake one element for another that ends the same way', () => {
    // `getetag` must not be found by a search for `etag`.
    expect(element('<d:getetag>"abc"</d:getetag>', 'etag')).toBeNull()
    expect(element('<d:getetag>"abc"</d:getetag>', 'getetag')).toBe('"abc"')
  })

  it('finds a self-closing element as an empty value', () => {
    expect(element('<cal:calendar/>', 'calendar')).toBe('')
  })

  it('keeps siblings apart instead of swallowing them into one', () => {
    expect(elements('<d:href>/a/</d:href><d:href>/b/</d:href>', 'href')).toEqual(['/a/', '/b/'])
  })
})

describe('entities', () => {
  it('decodes the five named ones and numeric escapes', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      `a & b <c> "d" 'e'`
    )
    expect(decodeEntities('caf&#233; &#x2014; werk')).toBe('café — werk')
  })

  it('escapes what has to be escaped on the way out', () => {
    expect(escapeXml('Overleg & "planning" <fase 2>')).toBe(
      'Overleg &amp; &quot;planning&quot; &lt;fase 2&gt;'
    )
  })
})

describe('resourcetype', () => {
  it('lists the markers that say what a collection is', () => {
    expect(childNames('<d:collection/><cal:calendar/>')).toEqual(['collection', 'calendar'])
  })
})

const CALENDAR_LIST = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>/1234567/calendars/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/1234567/calendars/work/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Werk &amp; stage</d:displayname>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <cs:getctag>ctag-1</cs:getctag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><cal:calendar-timezone/></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`

describe('a calendar listing', () => {
  const responses = parseMultistatus(CALENDAR_LIST, ['displayname', 'getctag'])

  it('returns one entry per response', () => {
    expect(responses).toHaveLength(2)
  })

  it('reads the href and the decoded display name', () => {
    expect(responses[1]!.href).toBe('/1234567/calendars/work/')
    expect(responses[1]!.props['displayname']).toBe('Werk & stage')
    expect(responses[1]!.props['getctag']).toBe('ctag-1')
  })

  it('tells a calendar apart from a plain collection', () => {
    expect(responses[0]!.flags).toContain('collection')
    expect(responses[0]!.flags).not.toContain('calendar')
    expect(responses[1]!.flags).toContain('calendar')
  })

  it('ignores properties the server reported as missing', () => {
    // The 404 propstat must not contribute an empty calendar-timezone.
    expect(parseMultistatus(CALENDAR_LIST, ['calendar-timezone'])[1]!.props).toEqual({})
  })
})

const EVENT_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/1234567/calendars/work/abc.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-42"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:abc
SUMMARY:Overleg &amp; planning
DTSTART:20260822T090000Z
DTEND:20260822T100000Z
END:VEVENT
END:VCALENDAR
</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`

describe('an event report', () => {
  const [response] = parseMultistatus(EVENT_REPORT, ['getetag', 'calendar-data'])

  it('carries the etag, which is what makes a safe update possible', () => {
    expect(response!.props['getetag']).toBe('"etag-42"')
  })

  it('returns the whole iCalendar body intact, colons and newlines and all', () => {
    const data = response!.props['calendar-data']!
    expect(data).toContain('BEGIN:VCALENDAR')
    expect(data).toContain('DTSTART:20260822T090000Z')
    expect(data.trimEnd().endsWith('END:VCALENDAR')).toBe(true)
  })

  it('decodes entities inside the calendar body', () => {
    expect(response!.props['calendar-data']).toContain('SUMMARY:Overleg & planning')
  })
})
