/**
 * What only the server does. On a paired device these are sent to the server rather than
 * run on the local copy: the calendar secrets and the published library live there, and a
 * calendar synced from two places would import every appointment twice.
 */
export const SERVER_ONLY: Record<string, readonly string[]> = {
  calendar: ['connectIcs', 'connectIcloud', 'pushPlan', 'disconnect', 'syncNow'],
  days: ['publish', 'unpublish'],
  publish: ['now'],
  jarvis: ['ask', 'status']
}

export const isServerOnly = (domain: string, method: string): boolean =>
  SERVER_ONLY[domain]?.includes(method) ?? false
