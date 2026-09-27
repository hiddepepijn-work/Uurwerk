/**
 * The uurwerk:// links: widget buttons, and the Shortcuts automations that open Jarvis at
 * 08:30 and 21:00 (uurwerk://jarvis?moment=morning, …?moment=evening).
 */

export type LinkAction = 'timer' | 'jarvis' | 'focus' | 'task' | 'appointment' | 'agenda'

export interface Link {
  action: LinkAction | null
  /** For jarvis: open with the morning question or the evening review. */
  moment: 'morning' | 'evening' | null
}

const ACTIONS: readonly string[] = ['timer', 'jarvis', 'focus', 'task', 'appointment', 'agenda']

export function parseLink(url: string): Link {
  const rest = url.replace(/^uurwerk:\/\//i, '')
  const name = rest.split(/[/?#]/)[0]?.toLowerCase() ?? ''
  const query = rest.includes('?') ? rest.slice(rest.indexOf('?') + 1).split('#')[0] : ''
  const moment = new URLSearchParams(query).get('moment')?.toLowerCase()
  return {
    action: ACTIONS.includes(name) ? (name as LinkAction) : null,
    moment: moment === 'morning' || moment === 'evening' ? moment : null
  }
}
