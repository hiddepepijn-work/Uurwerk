/**
 * What changed between two plans, in words.
 *
 * Reanalysis never edits an accepted plan; it produces a proposal, and a proposal is only
 * useful if you can see what it would do. Blocks are matched through `originalBlockId`
 * so a shifted block reads as "moved from 10:00 to 13:30" instead of one disappearing and
 * an unrelated one appearing.
 */

import type { IsoDate, PlanBlock, PlanChange } from '../../contract/types.js'
import { formatClock, formatDuration } from './format.js'

const label = (block: PlanBlock): string => block.taskTitle ?? block.title ?? 'Untitled'

const at = (block: PlanBlock): { date: IsoDate; startMin: number; endMin: number } => ({
  date: block.date,
  startMin: block.startMin,
  endMin: block.endMin
})

/** Traces a block back to whichever ancestor both plans share. */
const lineage = (block: PlanBlock): string => block.originalBlockId ?? block.id

export function diffPlans(before: PlanBlock[], after: PlanBlock[]): PlanChange[] {
  const changes: PlanChange[] = []
  const beforeByLineage = new Map(before.map((block) => [lineage(block), block]))
  const seen = new Set<string>()

  for (const block of after) {
    const key = lineage(block)
    const previous = beforeByLineage.get(key)
    seen.add(key)

    if (!previous) {
      changes.push({
        kind: 'add',
        blockId: block.id,
        taskTitle: label(block),
        from: null,
        to: at(block),
        explanation: `${label(block)} added at ${formatClock(block.startMin)} on ${block.date}.`
      })
      continue
    }

    const moved = previous.date !== block.date || previous.startMin !== block.startMin
    const resized =
      previous.endMin - previous.startMin !== block.endMin - block.startMin

    if (moved) {
      const sameDay = previous.date === block.date
      changes.push({
        kind: 'move',
        blockId: block.id,
        taskTitle: label(block),
        from: at(previous),
        to: at(block),
        explanation: sameDay
          ? `${label(block)} moved from ${formatClock(previous.startMin)} to ${formatClock(block.startMin)}.`
          : `${label(block)} moved from ${previous.date} to ${block.date} at ${formatClock(block.startMin)}.`
      })
    } else if (resized) {
      const wasMin = previous.endMin - previous.startMin
      const isMin = block.endMin - block.startMin
      changes.push({
        kind: 'resize',
        blockId: block.id,
        taskTitle: label(block),
        from: at(previous),
        to: at(block),
        explanation: `${label(block)} ${isMin > wasMin ? 'extended' : 'shortened'} from ${formatDuration(wasMin)} to ${formatDuration(isMin)}.`
      })
    }
  }

  for (const [key, block] of beforeByLineage) {
    if (seen.has(key)) continue
    changes.push({
      kind: 'remove',
      blockId: block.id,
      taskTitle: label(block),
      from: at(block),
      to: null,
      explanation: `${label(block)} removed from ${block.date}.`
    })
  }

  return changes
}

/** The days a set of changes touches — what the review UI needs to highlight. */
export function affectedDays(changes: PlanChange[]): IsoDate[] {
  const days = new Set<IsoDate>()
  for (const change of changes) {
    if (change.from) days.add(change.from.date)
    if (change.to) days.add(change.to.date)
  }
  return [...days].sort()
}

/** True when the two plans are the same in every way that matters to the user. */
export const isUnchanged = (changes: PlanChange[]): boolean => changes.length === 0
