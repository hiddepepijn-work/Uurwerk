import { useEffect, useState } from 'react'
import type { PendingDraft } from '@core/contract/types.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { formatDuration } from '../../lib/format.js'

/**
 * Drafts that were planned and then left behind.
 *
 * A draft counts toward nothing — not the week grid, not the planned total, not
 * planned-versus-actual, not the report — so a day left in draft is planning that silently
 * did not happen. Nothing in the app used to say so, which is how a fortnight of work ends
 * up invisible and the planner looks broken.
 *
 * Reviewed rather than swept up automatically. Accepting supersedes whatever plan is in
 * force for that day, and doing that to a fortnight without showing which days would be
 * touched is exactly the behaviour that makes people stop trusting a planner. So: every day
 * is listed, the ones that would replace an existing plan say so, and the selection is
 * yours.
 */
export function PendingPlans({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [drafts, setDrafts] = useState<PendingDraft[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ verb: string; count: number } | null>(null)
  /** Deleting planning is not undoable, so it asks once before it happens. */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  useEffect(() => {
    if (!open) return
    setProblem(null)
    setOutcome(null)
    setConfirmingDiscard(false)

    api.plans
      .pending()
      .then((rows) => {
        setDrafts(rows)
        // Everything ticked to start with: the common case is "yes, all of them", and
        // unticking two is less work than ticking twelve.
        setChosen(new Set(rows.map((row) => row.planId)))
      })
      .catch((error: unknown) =>
        setProblem(error instanceof Error ? error.message : String(error))
      )
  }, [open])

  const toggle = (planId: string): void => {
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(planId)) next.delete(planId)
      else next.add(planId)
      return next
    })
  }

  /** Accept and discard differ only in which call they make; the bookkeeping is identical. */
  const applyToChosen = async (
    action: (planIds: string[]) => Promise<number>,
    verb: string
  ): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const count = await action([...chosen])
      setOutcome({ verb, count })
      setDrafts((current) => current.filter((row) => !chosen.has(row.planId)))
      setChosen(new Set())
      setConfirmingDiscard(false)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const totalMin = drafts
    .filter((row) => chosen.has(row.planId))
    .reduce((sum, row) => sum + row.plannedMin, 0)

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      title="Planned but never accepted"
      subtitle="Planned and left in draft, so nothing is counting them. Accept the ones you meant, delete the rest."
      footer={
        confirmingDiscard ? (
          <>
            <span className="text-[13px] text-prio-high">
              Delete {chosen.size} day{chosen.size === 1 ? '' : 's'} of planning —{' '}
              {formatDuration(totalMin)} — for good? Tracked hours are kept.
            </span>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setConfirmingDiscard(false)} disabled={busy}>
                Keep them
              </Button>
              <Button
                variant="danger"
                onClick={() => void applyToChosen(api.plans.discardMany, 'deleted')}
                disabled={busy}
              >
                Delete {chosen.size} day{chosen.size === 1 ? '' : 's'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="text-[13px] text-text-dim">
              {chosen.size === 0
                ? 'Nothing selected.'
                : `${chosen.size} day${chosen.size === 1 ? '' : 's'} · ${formatDuration(totalMin)} planned`}
            </span>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                {outcome ? 'Close' : 'Cancel'}
              </Button>
              <Button
                variant="danger"
                onClick={() => setConfirmingDiscard(true)}
                disabled={busy || chosen.size === 0}
              >
                Delete
              </Button>
              <Button
                variant="primary"
                onClick={() => void applyToChosen(api.plans.acceptMany, 'accepted')}
                disabled={busy || chosen.size === 0}
              >
                Accept {chosen.size > 0 ? chosen.size : ''} day{chosen.size === 1 ? '' : 's'}
              </Button>
            </div>
          </>
        )
      }
    >
      {problem && (
        <div className="mb-5 rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-[13px] text-prio-med">
          {problem}
        </div>
      )}

      {outcome && (
        <div className="mb-5 rounded-[10px] border border-accent/30 bg-accent/5 px-4 py-3 text-[13px] text-text">
          {outcome.count} day{outcome.count === 1 ? '' : 's'} {outcome.verb}.{' '}
          {outcome.verb === 'accepted'
            ? 'They are in your week now.'
            : 'The planning is gone; anything you tracked on those days is untouched.'}
        </div>
      )}

      {drafts.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-text-faint">
          Nothing is waiting. Every plan you have made has been accepted.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {drafts.map((draft) => {
            const ticked = chosen.has(draft.planId)
            return (
              <li key={draft.planId}>
                <label
                  className={`flex cursor-pointer items-center gap-3 rounded-[10px] border px-3.5 py-3 transition-colors ${
                    ticked ? 'border-accent/40 bg-rail-active' : 'border-border hover:bg-card-hover'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={ticked}
                    onChange={() => toggle(draft.planId)}
                    className="accent-accent"
                  />

                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-text">{longDate(draft.periodKey)}</span>
                    <span className="mt-0.5 block text-[12px] text-text-dim">
                      {draft.blockCount} block{draft.blockCount === 1 ? '' : 's'}
                      {draft.replacesAccepted && (
                        <span className="text-prio-med"> · replaces the plan already in force</span>
                      )}
                    </span>
                  </span>

                  <span className="shrink-0 font-mono text-[13px] text-text-dim tabular-nums">
                    {formatDuration(draft.plannedMin)}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      <p className="mt-5 text-[12px] leading-relaxed text-text-faint">
        Accepting makes a day the plan in force. The first plan you ever accept for a day stays
        reachable as its baseline, so the report can still show what you originally intended
        alongside what you ended up doing. Deleting throws the draft away instead — useful for a
        day you planned and never worked. It cannot be undone, and it never touches the hours you
        actually tracked on that day.
      </p>
    </Modal>
  )
}

/** '2026-08-04' → 'Tuesday 4 August 2026'. Week keys are shown as they are. */
function longDate(periodKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodKey)) return periodKey
  return new Date(`${periodKey}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}
