import type { AppEvents } from '@core/contract/events.js'

type Domain = AppEvents['data:invalidated']['domain']

/** Which screens go stale when rows of these tables arrive from elsewhere. */
export function invalidatedDomains(tables: Set<string>): Domain[] {
  const touched = (...names: string[]): boolean => names.some((name) => tables.has(name))
  const domains: Domain[] = []
  if (touched('tasks', 'task_dependencies', 'projects')) domains.push('tasks')
  if (touched('tracking_runs', 'time_segments', 'calendar_events')) domains.push('sessions')
  if (
    touched('plans', 'plan_blocks', 'availability', 'fixed_events', 'recurring_commitments', 'calendar_events')
  ) {
    domains.push('planning')
  }
  if (touched('artifacts')) domains.push('artifacts')
  if (touched('day_reports', 'reports', 'published_files')) domains.push('reports')
  if (
    touched('settings', 'areas', 'organizations', 'work_types', 'calendar_accounts', 'calendars', 'classification_rules')
  ) {
    domains.push('settings')
  }
  return domains
}
