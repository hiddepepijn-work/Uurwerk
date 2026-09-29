import type { IsoDate, MoneyState } from '@core/contract/types.js'
import { daysBetween, lastOfMonth, monthOf } from '@core/money/dates.js'
import type { MilestoneCheck } from '@core/money/projection.js'
import { monthPlan } from '@core/money/plan.js'
import { borrowedIn, budgetStatus, extraBalance, goalStatus, shiftPayIn, type GoalStatus } from '@core/money/status.js'
import { Button } from '../../ui/Button.js'
import { derivedShiftsThisMonth } from './shifts.js'
import { hoursDeadline, monthToClose, phaseProgress, tripOutlook, upcoming, type TripOutlook } from './derive.js'
import { dayDate, euro, monthName, shortDate, weekdayShort } from './format.js'
import type { MoneyTab } from './MoneyScreen.js'
import { Bar, Big, Chip, Label, Panel, Progress, Tile } from './parts.js'

/** The first tab: where the month, the budget and the trip stand, and what is coming. */
export function OverviewTab({
  state,
  today,
  onTab,
  onClose
}: {
  state: MoneyState
  today: IsoDate
  onTab: (tab: MoneyTab) => void
  onClose: (month: string) => void
}) {
  const phase = phaseProgress(state, today)
  const goal = goalStatus(state)
  const outlook = tripOutlook(state, today)
  const budget = budgetStatus(state, today)
  const extra = extraBalance(state)
  const month = monthOf(today)
  const plan = monthPlan(state, month)
  const shifts = derivedShiftsThisMonth(state, today)
  const received = shiftPayIn(state, month)
  const deadline = hoursDeadline(state, today)
  const toClose = monthToClose(state, today)
  const coming = upcoming(state, today)
  const nextCheck = outlook?.projection.checks[0] ?? null
  const borrowed = borrowedIn(state, month)
  const current = state.accounts.find((account) => account.role === 'betaal' && account.balanceCents !== null) ?? null
  const firstPhase = state.phases.map((item) => item.from).filter((from) => from > today).sort()[0] ?? null
  const rest = upcoming(state, today, daysBetween(today, lastOfMonth(month)) + 1)
  const monthIn = rest.filter((item) => item.cents > 0).reduce((sum, item) => sum + item.cents, 0)
  const monthOut = rest.filter((item) => item.cents < 0).reduce((sum, item) => sum + item.cents, 0)
  const review = state.transactions.filter((transaction) => transaction.kind === null && !transaction.pending).length

  return (
    <>
      {borrowed > 0 && (
        <button type="button" onClick={() => onTab('bank')} className="motion-press rounded-card bg-danger-soft p-4 text-left">
          <span className="block text-[16px] font-bold text-danger-text">{euro(borrowed)} geleend van je reispot</span>
          <span className="text-[13px] text-danger-text/80">Afgehaald terwijl hij op slot staat. Het komt bij de maandafsluiting als eerste terug.</span>
        </button>
      )}
      {review > 0 && (
        <button type="button" onClick={() => onTab('bank')} className="motion-press flex items-center justify-between rounded-card bg-warn-soft px-4 py-3 text-left">
          <span className="text-[14px] font-bold text-warn">{review} {review === 1 ? 'transactie' : 'transacties'} nakijken</span>
          <span className="text-[13px] font-bold text-warn">Bank ›</span>
        </button>
      )}
      {toClose && (
        <Panel className="bg-rail-active!">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[16px] font-bold text-accent-soft">{monthName(toClose)} afsluiten</span>
              <span className="text-[13px] text-text-dim">Inleg naar de reis, de rest naar Extra. Duurt twee minuten.</span>
            </div>
            <Button variant="primary" onClick={() => onClose(toClose)}>
              Afsluiten
            </Button>
          </div>
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-3 wide:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] wide:gap-4">
        {current ? (
          <button type="button" onClick={() => onTab('bank')} className="motion-press flex flex-col gap-3 rounded-card bg-card p-4 text-left wide:p-5">
            <div className="flex items-center justify-between">
              <Label>Saldo betaalrekening</Label>
              <span className="text-[12px] text-text-dim">ABN AMRO{current.balanceDate ? ` · ${shortDate(current.balanceDate)}` : ''}</span>
            </div>
            <Big>{euro(current.balanceCents ?? 0)}</Big>
            <div className="grid grid-cols-3 gap-2">
              <Mini label={`Nog erin t/m ${shortDate(lastOfMonth(month))}`} value={euro(monthIn, { sign: true })} good />
              <Mini label="Nog eraf" value={euro(monthOut)} />
              <Mini label="Verwacht eind maand" value={euro((current.balanceCents ?? 0) + monthIn + monthOut)} />
            </div>
            <span className="text-[12px] text-text-dim">Verwacht: vaste lasten, inkomens, Adecco en mijlpalen uit je plan tot het eind van de maand. Je budget zit er niet in.</span>
          </button>
        ) : (
          <TripCard state={state} goal={goal} outlook={outlook} nextCheck={nextCheck} big onOpen={() => onTab('trip')} />
        )}

        <div className="flex flex-col gap-3">
          {phase && (
            <Panel>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[14px] font-bold">{phase.name}</span>
                <span className="text-[12px] text-text-dim">
                  dag {phase.day} van {phase.days} · t/m {shortDate(phase.until)}
                </span>
              </div>
              <Bar parts={[{ value: phase.day, color: 'var(--color-area-school)' }, { value: phase.days - phase.day, color: 'var(--color-area-school-tint)' }]} height={8} />
            </Panel>
          )}
          <div className="grid grid-cols-2 gap-3">
            <button type="button" onClick={() => onTab('budget')} className="motion-press text-left">
              {budget.budgetCents > 0 ? (
                <Tile
                  label={`Budget ${monthName(month).slice(0, 3)}`}
                  value={euro(budget.leftCents)}
                  sub={budget.aheadCents >= 0 ? `${euro(budget.aheadCents)} onder schema` : `${euro(-budget.aheadCents)} boven schema`}
                  tone={budget.aheadCents >= 0 ? 'good' : 'warn'}
                />
              ) : (
                <Tile label="Budget" value="–" sub={firstPhase ? `start ${shortDate(firstPhase)} · deze maand ${euro(budget.spentCents)} gepind` : 'geen fase deze maand'} />
              )}
            </button>
            <Tile label="Extra-rekening" value={euro(extra)} sub="alles boven het plan" />
          </div>
          {current && <TripCard state={state} goal={goal} outlook={outlook} nextCheck={nextCheck} onOpen={() => onTab('trip')} />}
        </div>
      </div>

      {plan.hasShifts && (
        <button type="button" onClick={() => onTab('shifts')} className="motion-press flex flex-col gap-3 rounded-card bg-card p-4 text-left wide:p-5">
          <div className="flex items-baseline justify-between gap-2">
            <Label>Adecco deze maand</Label>
            <span className="text-[12px] text-text-dim">nodig voor het plan: {euro(plan.neededFromShiftsCents)}</span>
          </div>
          <Bar
            parts={[
              { value: received, color: 'var(--color-accent)' },
              { value: shifts.expectedCents, color: 'var(--color-accent-dim)' },
              { value: Math.max(0, plan.neededFromShiftsCents - received - shifts.expectedCents), color: 'var(--color-danger)' }
            ]}
          />
          <div className="flex flex-wrap justify-between gap-2 text-[13px]">
            <span>
              <b>{euro(received)}</b> <span className="text-text-dim">binnen</span>
            </span>
            <span>
              <b>±{euro(shifts.expectedCents, { round: true })}</b> <span className="text-text-dim">nog verwacht ({shifts.expectedCount} {shifts.expectedCount === 1 ? 'dienst' : 'diensten'})</span>
            </span>
          </div>
          {received + shifts.expectedCents < plan.neededFromShiftsCents && (
            <span className="text-[12px] font-bold text-danger-text">
              Nog ±{euro(plan.neededFromShiftsCents - received - shifts.expectedCents, { round: true })} onder plan: plan een dienst, of Extra vult het aan bij de afsluiting.
            </span>
          )}
          {deadline && (
            <span className="rounded-[14px] bg-warn-soft px-3 py-2.5 text-[13px] font-bold text-warn">
              {dayDate(deadline.monday)} vóór 12:00 uren indienen · {deadline.shifts.length} {deadline.shifts.length === 1 ? 'dienst' : 'diensten'}
            </span>
          )}
        </button>
      )}

      <Panel>
        <div className="flex items-baseline justify-between">
          <Label>Komende 7 dagen</Label>
          <span className="text-[15px] font-bold tabular-nums">{euro(coming.reduce((sum, item) => sum + item.cents, 0), { sign: true })}</span>
        </div>
        {coming.length === 0 && <span className="text-[14px] text-text-dim">Niets gepland deze week.</span>}
        <div className="flex flex-col gap-2.5">
          {coming.map((item, index) => (
            <div key={index} className="flex items-center gap-3">
              <span className="flex w-11 shrink-0 flex-col items-center rounded-[10px] bg-input py-1">
                <span className="text-[10px] font-bold text-text-dim uppercase">{weekdayShort(item.date)}</span>
                <span className="text-[16px] font-bold">{Number(item.date.slice(8))}</span>
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-semibold">{item.name}</span>
                <span className="text-[12px] text-text-dim">{item.sub}</span>
              </span>
              <span className={`text-[15px] font-bold tabular-nums ${item.cents > 0 ? 'text-accent-soft' : ''}`}>{euro(item.cents, { sign: true })}</span>
            </div>
          ))}
        </div>
      </Panel>
    </>
  )
}

function Mini({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-[14px] bg-input px-3 py-2.5">
      <span className="truncate text-[12px] text-text-dim">{label}</span>
      <span className={`truncate text-[16px] font-bold tabular-nums ${good ? 'text-accent-soft' : ''}`}>{value}</span>
    </div>
  )
}

/** The trip pot: large when it is the main card, compact beside the balance. */
function TripCard({
  state,
  goal,
  outlook,
  nextCheck,
  big,
  onOpen
}: {
  state: MoneyState
  goal: GoalStatus | null
  outlook: TripOutlook | null
  nextCheck: MilestoneCheck | null
  big?: boolean
  onOpen: () => void
}) {
  return (
    <button type="button" onClick={onOpen} className="motion-press flex flex-col gap-3 rounded-card bg-card p-4 text-left wide:p-5">
      <div className="flex items-center justify-between">
        <Label>{state.goal?.name ?? 'Doel'}pot</Label>
        {outlook && (
          <Chip tone={outlook.shortAfterExtraCents > 0 ? 'bad' : 'good'}>
            {outlook.shortAfterExtraCents > 0 ? `${euro(outlook.shortAfterExtraCents, { round: true })} achter` : 'op schema'}
          </Chip>
        )}
      </div>
      {goal && (
        <>
          <div className="flex items-baseline gap-2">
            {big ? (
              <Big>{euro(goal.savedCents, { round: true })}</Big>
            ) : (
              <span className="font-display text-[26px] leading-none font-bold tracking-[-0.6px] tabular-nums">{euro(goal.savedCents, { round: true })}</span>
            )}
            <span className="text-[14px] text-text-dim">van {euro(goal.targetSavedCents, { round: true })} gespaard</span>
          </div>
          <Progress value={Math.max(0, goal.savedCents)} max={goal.targetSavedCents} />
        </>
      )}
      {nextCheck && (
        <div className="flex items-center gap-3 rounded-[14px] bg-input px-3 py-2.5">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14px] font-bold">
              {dayDate(nextCheck.milestone.date)} · {nextCheck.milestone.name} {euro(nextCheck.milestone.amountCents, { round: true })}
            </span>
            <span className="text-[12px] text-text-dim">dan verwacht in de pot: {euro(nextCheck.potCents, { round: true })}</span>
          </span>
          <Chip tone={nextCheck.shortCents > 0 ? 'bad' : 'good'}>{nextCheck.shortCents > 0 ? `${euro(nextCheck.shortCents, { round: true })} kort` : 'haalbaar'}</Chip>
        </div>
      )}
    </button>
  )
}
