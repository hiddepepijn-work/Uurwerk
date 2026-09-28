import { useMemo } from 'react'
import type { CalendarEvent, IsoDate, PlanBlock } from '@core/contract/types.js'
import { Card, CardAction } from '../../ui/Card.js'
import { formatDuration } from '../../lib/format.js'
import { DayTimeline } from '../agenda/PhoneAgenda.js'
import { agendaFor } from '../agenda/agenda-model.js'

/**
 * Today on one card, in the same look as the phone's agenda and its widget: the accepted
 * day plan and the calendar's appointments on one timeline, opened at the present.
 */
export function AgendaList({
  date,
  blocks,
  events,
  onPlanDay
}: {
  date: IsoDate
  blocks: PlanBlock[]
  events: CalendarEvent[]
  onPlanDay: () => void
}) {
  const { items } = useMemo(() => agendaFor(date, blocks, events), [date, blocks, events])
  const total = blocks
    .filter((block) => block.kind === 'task')
    .reduce((sum, block) => sum + (block.endMin - block.startMin), 0)
  const now = new Date()

  return (
    <Card
      title="Today's agenda"
      action={<CardAction onClick={onPlanDay}>{blocks.length > 0 ? 'Edit' : 'Plan'}</CardAction>}
      padded={false}
    >
      {/* Always the timeline, empty or not: clicking an empty moment is how you plan it. */}
      <DayTimeline
        date={date}
        items={items}
        nowMinute={now.getHours() * 60 + now.getMinutes()}
        hourPx={52}
        className="mt-3 h-[420px] px-4 pb-4"
      />
      <footer className="border-t border-border px-5 py-3 text-[13px] text-text-dim">
        {items.length === 0 ? 'Niets gepland. Klik op een tijd om iets in te plannen.' : `${formatDuration(total)} planned`}
      </footer>
    </Card>
  )
}
