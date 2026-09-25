/**
 * Reading the two answers CalDAV discovery depends on.
 *
 * Both are shaped like iCloud's real replies. Apple answers with a **default namespace** and
 * no prefix at all — `<multistatus xmlns="DAV:">`, `<href>` — where almost every worked
 * example in the wild uses `<d:href>`. A client that only handles the prefixed form finds
 * nothing, reports "no account", and gives no hint why.
 */

import { describe, expect, it } from 'vitest'
import { firstHrefIn } from './caldav.js'

/** iCloud's answer to PROPFIND / for current-user-principal. No prefixes anywhere. */
const APPLE_PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/</href>
    <propstat>
      <prop>
        <current-user-principal>
          <href>/20015551212/principal/</href>
        </current-user-principal>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`

/** The same thing from a server that does use prefixes. */
const PREFIXED_PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal>
          <d:href>/20015551212/principal/</d:href>
        </d:current-user-principal>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`

const APPLE_HOME = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/20015551212/principal/</href>
    <propstat>
      <prop>
        <cal:calendar-home-set>
          <href>https://p42-caldav.icloud.com:443/20015551212/calendars/</href>
        </cal:calendar-home-set>
        <displayname>Hidde</displayname>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`

describe('finding the principal', () => {
  it('reads iCloud’s unprefixed reply', () => {
    expect(firstHrefIn(APPLE_PRINCIPAL, 'current-user-principal')).toBe('/20015551212/principal/')
  })

  it('reads a prefixed reply the same way', () => {
    expect(firstHrefIn(PREFIXED_PRINCIPAL, 'current-user-principal')).toBe(
      '/20015551212/principal/'
    )
  })

  it('takes the href inside the property, not the response’s own href', () => {
    // The response href is `/`. Returning that would send discovery to the wrong place.
    expect(firstHrefIn(APPLE_PRINCIPAL, 'current-user-principal')).not.toBe('/')
  })
})

describe('finding the calendar home', () => {
  it('reads an absolute href on a partition host', () => {
    expect(firstHrefIn(APPLE_HOME, 'calendar-home-set')).toBe(
      'https://p42-caldav.icloud.com:443/20015551212/calendars/'
    )
  })
})

/**
 * The shape that actually broke against iCloud.
 *
 * A multistatus may carry several responses, and a server can answer for a collection it
 * has no principal for with an empty `<current-user-principal/>` before answering properly
 * further down. Reading only the first response turned that into a confident "no account for
 * that Apple ID" — wrong, and impossible to diagnose from.
 */
/**
 * The shape iCloud actually sends.
 *
 * Apple repeats the namespace as an attribute on *every* element — `<response xmlns="DAV:">`,
 * `<href xmlns="DAV:">` — rather than relying on the default declared on `<multistatus>`.
 * Every worked example in the wild writes a bare `<href>`, so a pattern written from those
 * matches nothing here, and the failure looks like an account problem rather than a parsing
 * one.
 */
describe('namespace attributes on every element', () => {
  const REAL = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<multistatus xmlns="DAV:">
  <response xmlns="DAV:">
    <href>/</href>
    <propstat>
      <prop>
        <current-user-principal xmlns="DAV:"><href xmlns="DAV:">/21290039130/principal/</href></current-user-principal>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`

  it('finds the principal when the href carries an xmlns attribute', () => {
    expect(firstHrefIn(REAL, 'current-user-principal')).toBe('/21290039130/principal/')
  })

  it('finds a calendar home whose href carries attributes too', () => {
    const home = `<multistatus xmlns="DAV:"><response xmlns="DAV:"><propstat><prop>
      <calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav">
        <href xmlns="DAV:">https://p42-caldav.icloud.com:443/21290039130/calendars/</href>
      </calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`

    expect(firstHrefIn(home, 'calendar-home-set')).toBe(
      'https://p42-caldav.icloud.com:443/21290039130/calendars/'
    )
  })
})

describe('when the answer is not in the first response', () => {
  const MIXED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<multistatus xmlns="DAV:">
  <response xmlns="DAV:">
    <href>/</href>
    <propstat>
      <prop><current-user-principal xmlns="DAV:"/></prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
  <response xmlns="DAV:">
    <href>/21290039130/principal/</href>
    <propstat>
      <prop>
        <current-user-principal xmlns="DAV:"><href>/21290039130/principal/</href></current-user-principal>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`

  it('skips the empty one and finds the real principal', () => {
    expect(firstHrefIn(MIXED, 'current-user-principal')).toBe('/21290039130/principal/')
  })

  it('is not fooled by the response’s own href', () => {
    // `/` is the first href in the document, and it is not the principal.
    expect(firstHrefIn(MIXED, 'current-user-principal')).not.toBe('/')
  })

  it('handles the whole document on one line, as it arrives over the wire', () => {
    expect(firstHrefIn(MIXED.replace(/\s*\n\s*/g, ''), 'current-user-principal')).toBe(
      '/21290039130/principal/'
    )
  })
})

describe('when there is nothing to find', () => {
  it('returns null rather than guessing', () => {
    expect(firstHrefIn('<multistatus xmlns="DAV:"></multistatus>', 'current-user-principal')).toBeNull()
  })

  it('returns null for a property the server reported as missing', () => {
    const notFound = `<multistatus xmlns="DAV:"><response><href>/</href>
      <propstat><prop><current-user-principal/></prop>
      <status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>`
    expect(firstHrefIn(notFound, 'current-user-principal')).toBeNull()
  })

  it('returns null for an HTML error page instead of throwing', () => {
    expect(firstHrefIn('<html><body>Forbidden</body></html>', 'current-user-principal')).toBeNull()
  })
})
