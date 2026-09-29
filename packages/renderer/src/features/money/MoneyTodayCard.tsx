import type { IsoDate } from '@core/contract/types.js'
import { budgetStatus, goalStatus } from '@core/money/status.js'
import { WalletIcon } from '../../ui/icons.js'
import { hoursDeadline, monthToClose } from './derive.js'
import { euro, monthName, weekdayShort } from './format.js'
import { useMoney } from './useMoney.js'

/**
 * Geld on the Today screen: the budget left, the trip, and the one thing to do (close last
 * month, hand in hours). One tap opens Geld. Nothing shows until there is a plan.
 */
export function MoneyTodayCard({ onOpen }: { onOpen: () => void }) {
  const { state, today } = useMoney()
  if (!state || (!state.goal && state.phases.length === 0)) return null
  const budget = budgetStatus(state, today)
  const goal = goalStatus(state)
  const toClose = monthToClose(state, today)
  const deadline = hoursDeadline(state, today)
  const todo = toClose ? `${monthName(toClose)} afsluiten` : deadline ? `${weekdayShort(deadline.monday as IsoDate)} uren indienen` : null

  return (
    <button type="button" onClick={onOpen} className="motion-press flex items-center gap-3 rounded-card bg-card p-4 text-left shadow-[inset_0_0_0_2px_var(--color-accent-dim)]">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-rail-active text-accent-soft">
        <WalletIcon size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-bold tabular-nums">{euro(budget.leftCents)} budget over</span>
        <span className="truncate text-[12px] text-text-dim">
          {goal ? `${state.goal?.name ?? 'Doel'} ${euro(goal.savedCents, { round: true })} / ${euro(goal.targetSavedCents, { round: true })}` : ''}
          {todo ? ` · ${todo}` : ''}
        </span>
      </span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-text-faint" aria-hidden="true">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  )
}
