/**
 * Uurwerk Focus: asks the Uurwerk app on this laptop whether focus is on, and while it is,
 * redirects the blocked sites to blocked.html. The app answers on 127.0.0.1:47811/focus;
 * when it does not answer (app closed), the blocks are lifted — never locked out by accident.
 *
 * Service workers sleep when idle, so the 10-second poll only runs while this one is awake;
 * the alarm (Chrome's minimum, 30 s) wakes it up again. Every wake starts from scratch and
 * the first poll rewrites the rules, so rules left over from a closed browser do not linger.
 */

const FOCUS_URL = 'http://127.0.0.1:47811/focus'
const POLL_MS = 10_000
const BLOCKED_PAGE = '/blocked.html'

/** Last state seen; null until the first poll of this wake. */
let state = null

async function fetchState() {
  try {
    const response = await fetch(FOCUS_URL, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    return {
      focus: body.focus === true,
      task: typeof body.task === 'string' ? body.task : null,
      sites: Array.isArray(body.sites) ? body.sites.filter((site) => typeof site === 'string' && site) : []
    }
  } catch {
    return { focus: false, task: null, sites: [] }
  }
}

/** Redirect where Chrome lets us (host permission granted), plain block elsewhere. */
async function rulesFor(sites) {
  const rules = []
  for (const [index, site] of sites.entries()) {
    const redirect = await chrome.permissions.contains({ origins: [`*://${site}/*`] })
    rules.push({
      id: index + 1,
      priority: 1,
      action: redirect ? { type: 'redirect', redirect: { extensionPath: BLOCKED_PAGE } } : { type: 'block' },
      // requestDomains matches the domain and all its subdomains.
      condition: { requestDomains: [site], resourceTypes: ['main_frame'] }
    })
  }
  return rules
}

async function setRules(sites) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules()
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: sites.length ? await rulesFor(sites) : []
  })
}

const onSite = (url, sites) => {
  try {
    const host = new URL(url).hostname
    return sites.some((site) => host === site || host.endsWith(`.${site}`))
  } catch {
    return false
  }
}

/** Tabs already open on a blocked site. */
async function redirectOpenTabs(sites) {
  const page = chrome.runtime.getURL(BLOCKED_PAGE)
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined && tab.url && onSite(tab.url, sites)) await chrome.tabs.update(tab.id, { url: page })
  }
}

let running = null

/** One poll at a time; callers share the one in flight. */
function poll() {
  running ??= (async () => {
    try {
      const previous = state
      const next = await fetchState()
      state = next
      const changed =
        !previous || next.focus !== previous.focus || next.sites.join(',') !== previous.sites.join(',')
      if (changed) await setRules(next.focus ? next.sites : [])
      if (next.focus && changed) await redirectOpenTabs(next.sites)
    } catch (error) {
      console.warn('Uurwerk Focus: poll failed', error)
    } finally {
      running = null
    }
  })()
  return running
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message !== 'state') return false
  if (state) reply(state)
  else void poll().then(() => reply(state))
  return true
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'poll') void poll()
})

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('poll', { periodInMinutes: 0.5 }))
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('poll', { periodInMinutes: 0.5 }))

setInterval(() => void poll(), POLL_MS)
void poll()
