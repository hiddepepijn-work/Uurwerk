/**
 * What the home-screen widgets show, written for them after every change.
 *
 * The widgets cannot read the database or reach the server; the app hands them a small
 * JSON file in the App Group they share (native side: setWidgetData in
 * packages/capacitor-audio-focus). Today and tomorrow, in the same shape the agenda uses.
 */

import type { Backend } from '@backend/create.js'
import { toIsoDate } from '@core/util/time.js'
import { agendaFor } from '@renderer/features/agenda/agenda-model.js'

export function widgetData(backend: Backend, focus: string | null = null): string {
  const now = Date.now()
  const today = toIsoDate(now)
  const days = [today, toIsoDate(now + 86_400_000)].map((date) => {
    const plan = backend.store.plans.accepted('day', date)
    const blocks = plan ? backend.store.plans.blocks(plan.id) : []
    const start = new Date(`${date}T00:00:00`).getTime()
    const events = backend.calendar.eventsInRange(start, start + 86_400_000)
    return {
      date,
      items: agendaFor(date, blocks, events).items.map((item) => ({
        start: item.startMin,
        end: item.endMin,
        title: item.title,
        kind: item.kind,
        area: item.areaId,
        meta: item.meta,
        lane: item.lane,
        lanes: item.lanes,
        overlay: item.overlay,
        coveredMin: item.coveredMin
      }))
    }
  })

  const overdue = backend.store.tasks
    .list({ status: 'active' })
    .filter((task) => task.dueDate !== null && task.dueDate < today)
    .map((task) => task.title)

  const segment = backend.trackingService.currentSegment()
  const running = segment
    ? (segment.taskId ? backend.store.tasks.get(segment.taskId)?.title : null) ?? 'Timer loopt'
    : null

  return JSON.stringify({ generatedAt: now, days, overdue, running, focus })
}
