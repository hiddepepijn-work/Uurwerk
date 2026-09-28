/**
 * The uurwerk:// links: widget buttons, and the Shortcuts automations that open Jarvis at
 * 08:30 and 21:00 (uurwerk://jarvis?moment=morning, …?moment=evening).
 */

export type LinkAction = 'timer' | 'jarvis' | 'focus' | 'task' | 'appointment' | 'agenda' | 'checkin'

export interface Link {
  action: LinkAction | null
  /** For jarvis: open with the morning question or the evening review. */
  moment: 'morning' | 'evening' | null
  /** For checkin (the Live Activity's "Nog niet"): which task, and what was answered. */
  checkin?: { taskId: string; answer: 'notyet' | 'notdone'; stage: 'midway' | 'end'; important: boolean; task: string }
}

const ACTIONS: readonly string[] = ['timer', 'jarvis', 'focus', 'task', 'appointment', 'agenda', 'checkin']

export function parseLink(url: string): Link {
  const rest = url.replace(/^uurwerk:\/\//i, '')
  const name = rest.split(/[/?#]/)[0]?.toLowerCase() ?? ''
  const query = rest.includes('?') ? rest.slice(rest.indexOf('?') + 1).split('#')[0] : ''
  const params = new URLSearchParams(query)
  const moment = params.get('moment')?.toLowerCase()
  const link: Link = {
    action: ACTIONS.includes(name) ? (name as LinkAction) : null,
    moment: moment === 'morning' || moment === 'evening' ? moment : null
  }
  const taskId = params.get('task')
  if (link.action === 'checkin') {
    if (!taskId) return { action: null, moment: null }
    const stage = params.get('stage') === 'midway' ? 'midway' : 'end'
    link.checkin = {
      taskId,
      answer: stage === 'midway' ? 'notyet' : 'notdone',
      stage,
      important: params.get('important') === '1',
      task: params.get('title') || 'je taak'
    }
  }
  return link
}
