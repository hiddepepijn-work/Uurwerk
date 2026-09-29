import { useState } from 'react'

import type { IsoDate, MoneyMilestone, MoneyState } from '@core/contract/types.js'
import { daysBetween, monthOf, monthsBetween } from '@core/money/dates.js'
import { phaseFor } from '@core/money/plan.js'
import type { Projection } from '@core/money/projection.js'
import { goalStatus } from '@core/money/status.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { perShift, plannedShifts, tripOutlook } from './derive.js'
import { euro, euroInput, monthShort, parseEuro, shortDate } from './format.js'
import { Big, Chip, Field, Label, Panel, Progress, Row, Segmented, input, useWidth } from './parts.js'

/**
 * The trip: saved against the total, the pot against what must be on the account at departure,
 * and what a different number of shifts a month would do to both.
 */
export function TripTab({ state, today }: { state: MoneyState; today: IsoDate }) {
  const planned = plannedShifts(state, today)
  const [shifts, setShifts] = useState(planned)
  const [editing, setEditing] = useState<Partial<MoneyMilestone> | null>(null)
  const goal = goalStatus(state)
  const outlook = tripOutlook(state, today, shifts)
  const reference = tripOutlook(state, today, planned)
  if (!state.goal || !goal || !outlook || !reference) return <Panel>Nog geen doel. Zet er een neer onder Plan.</Panel>

  const options = [...new Set([Math.max(0, planned - 2), Math.max(0, planned - 1), planned, planned + 1])].map((value) => ({
    value,
    label: value === planned ? `${value} · plan` : String(value)
  }))
  const { projection } = outlook
  const onDate = projection.finalInPotCents + outlook.fromExtraCents

  return (
    <>
      <div className="grid grid-cols-1 gap-3 wide:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] wide:gap-4">
        <Panel>
          <Label>Gespaard voor {state.goal.name.toLowerCase()}</Label>
          <div className="flex items-baseline gap-2">
            <Big>{euro(goal.savedCents, { round: true })}</Big>
            <span className="text-[15px] text-text-dim">van {euro(goal.targetSavedCents, { round: true })}</span>
          </div>
          <Progress value={Math.max(0, goal.savedCents)} max={goal.targetSavedCents} />
          <div className="grid grid-cols-3 gap-2">
            <MiniTile label="In de pot" value={euro(goal.inPotCents, { round: true })} />
            <MiniTile label="Besteed" value={euro(goal.spentCents, { round: true })} />
            <MiniTile label="Bij vertrek" value={euro(goal.onAccountCents, { round: true })} good />
          </div>
          <span className="text-[12px] leading-relaxed text-text-dim">
            {euro(goal.targetSavedCents, { round: true })} = {euro(goal.onAccountCents, { round: true })} op je rekening op {shortDate(state.goal.date)} +{' '}
            {euro(goal.targetSavedCents - goal.onAccountCents, { round: true })} vooraf geboekt. Een betaalde boeking telt als besteed: de balk zakt niet.
          </span>
        </Panel>

        <Panel>
          <PhaseStrip state={state} today={today} />
          <TripChart projection={projection} reference={reference.projection} today={today} goalDate={state.goal.date} />
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-text-dim">
            <Legend color="var(--color-accent)">Gespaard</Legend>
            <Legend color="var(--color-area-school)">In de pot</Legend>
            <Legend dashed color="var(--color-text-faint)">Plan</Legend>
            <Legend dot color="var(--color-warn)">Boeking</Legend>
          </div>
        </Panel>
      </div>

      <Panel>
        <Label>Nachtdiensten per maand tot februari</Label>
        <Segmented options={options} value={shifts} onChange={setShifts} />
        <div className="grid grid-cols-2 gap-2 wide:grid-cols-4">
          <MiniTile
            label={`Op rekening ${shortDate(state.goal.date)}`}
            value={outlook.shortAfterExtraCents > 0 ? `${euro(outlook.shortAfterExtraCents, { round: true })} kort` : euro(onDate, { round: true })}
            bad={outlook.shortAfterExtraCents > 0}
            good={outlook.shortAfterExtraCents === 0}
          />
          <MiniTile label="Naar Extra" value={euro(projection.extraCents, { sign: true, round: true })} />
          <MiniTile label="Uit Extra aangevuld" value={euro(outlook.fromExtraCents, { round: true })} />
          <MiniTile label="Per nacht" value={`±${euro(perShift(state))}`} />
        </div>
        <span className="text-[12px] leading-relaxed text-text-dim">
          Netto is een schatting (factor {String(state.profile?.netFactor ?? 0.9).replace('.', ',')}) plus reiskosten; hij leert van je loonstroken. Adecco betaalt een week later, dus je
          laatste werkweek valt na vertrek. Maasarend en EcoVi tellen mee zodra er bedragen zijn.
        </span>
      </Panel>

      <Panel>
        <div className="flex items-center justify-between">
          <Label>Mijlpalen</Label>
          <Button size="sm" variant="ghost" onClick={() => setEditing({ paid: false })}>
            + Mijlpaal
          </Button>
        </div>
        <div className="flex flex-col">
          {state.milestones.map((milestone) => {
            const check = projection.checks.find((item) => item.milestone.id === milestone.id)
            return (
              <Row
                key={milestone.id}
                left={`${milestone.name} ${euro(milestone.amountCents, { round: true })}`}
                sub={milestone.paid ? 'betaald uit de pot' : check ? `${shortDate(milestone.date)} · verwacht in pot ${euro(check.potCents, { round: true })}` : shortDate(milestone.date)}
                onClick={() => setEditing(milestone)}
                right={
                  milestone.paid ? (
                    <Chip tone="good">betaald</Chip>
                  ) : check && check.shortCents > 0 ? (
                    <Chip tone="bad">{euro(check.shortCents, { round: true })} kort</Chip>
                  ) : (
                    <Chip tone="good">haalbaar</Chip>
                  )
                }
              />
            )
          })}
          <Row
            left={`Vertrek · ${euro(state.goal.onAccountCents, { round: true })} op rekening`}
            sub={shortDate(state.goal.date)}
            right={outlook.shortAfterExtraCents > 0 ? <Chip tone="bad">{euro(outlook.shortAfterExtraCents, { round: true })} kort</Chip> : <Chip tone="good">haalbaar</Chip>}
          />
        </div>
      </Panel>

      {editing && <MilestoneModal milestone={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function MiniTile({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 rounded-[14px] px-3 py-2.5 ${good ? 'bg-rail-active' : bad ? 'bg-danger-soft' : 'bg-input'}`}>
      <span className={`truncate text-[12px] ${good ? 'text-accent-soft' : bad ? 'text-danger-text' : 'text-text-dim'}`}>{label}</span>
      <span className={`truncate text-[17px] font-bold tabular-nums ${good ? 'text-accent-soft' : bad ? 'text-danger-text' : ''}`}>{value}</span>
    </div>
  )
}

function Legend({ color, dashed, dot, children }: { color: string; dashed?: boolean; dot?: boolean; children: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {dot ? (
        <span className="h-2 w-2 rounded-full border-2" style={{ borderColor: color }} />
      ) : (
        <span className="w-3.5" style={dashed ? { borderTop: `2px dashed ${color}` } : { height: 3, borderRadius: 2, background: color }} />
      )}
      {children}
    </span>
  )
}

function PhaseStrip({ state, today }: { state: MoneyState; today: IsoDate }) {
  const goal = state.goal
  if (!goal || state.phases.length === 0) return null
  const start = state.phases[0]!.from
  const total = Math.max(1, daysBetween(start, goal.date))
  const current = phaseFor(state.phases, monthOf(today))
  return (
    <div className="flex h-6 gap-[3px]">
      {state.phases.map((phase, index) => {
        const until = phase.until < goal.date ? phase.until : goal.date
        const share = Math.max(1, daysBetween(phase.from, until) + 1) / total
        const tint = index % 2 === 0 ? 'bg-area-school-tint text-area-school-soft' : 'bg-area-stage-tint text-area-stage-soft'
        return (
          <span
            key={phase.id}
            className={`flex items-center overflow-hidden rounded-[6px] px-2 text-[11px] font-bold whitespace-nowrap ${tint} ${current?.id === phase.id ? 'ring-1 ring-current' : ''}`}
            style={{ width: `${share * 100}%` }}
          >
            {phase.name}
          </span>
        )
      })}
    </div>
  )
}

const H = 210
const TOP = 14
const PLOT = 170

function TripChart({ projection, reference, today, goalDate }: { projection: Projection; reference: Projection; today: IsoDate; goalDate: IsoDate }) {
  const [ref, W] = useWidth<HTMLDivElement>(640)
  const span = Math.max(1, daysBetween(today, goalDate))
  const values = [...projection.points, ...reference.points].flatMap((point) => [point.savedCents, point.inPotCents])
  const max = Math.max(projection.targetSavedCents, ...values) * 1.05
  const min = Math.min(0, ...values)
  const x = (date: IsoDate): number => (Math.min(span, Math.max(0, daysBetween(today, date))) / span) * W
  const y = (cents: number): number => TOP + ((max - cents) / (max - min)) * PLOT
  const line = (points: Projection['points'], key: 'savedCents' | 'inPotCents'): string =>
    points.map((point) => `${x(point.date).toFixed(1)},${y(point[key]).toFixed(1)}`).join(' ')
  const months = monthsBetween(monthOf(today), monthOf(goalDate)).slice(1)
  const target = projection.targetInPotCents

  return (
    <div ref={ref} className="w-full">
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="Reispot tot vertrek">
      {[0, target].map((value) => (
        <line key={value} x1={0} x2={W} y1={y(value)} y2={y(value)} stroke={value === 0 ? 'var(--color-border-strong)' : 'var(--color-accent-soft)'} strokeDasharray={value === 0 ? undefined : '2 5'} />
      ))}
      <text x={0} y={y(target) - 5} fill="var(--color-accent-soft)" fontSize={11} fontWeight={700}>
        {euro(target, { round: true })} bij vertrek
      </text>
      <polyline fill="none" stroke="var(--color-text-faint)" strokeWidth={1.5} strokeDasharray="4 4" points={line(reference.points, 'savedCents')} />
      <polyline fill="none" stroke="var(--color-area-school)" strokeWidth={2} strokeLinejoin="round" points={line(projection.points, 'inPotCents')} />
      <polyline fill="none" stroke="var(--color-accent)" strokeWidth={2.5} strokeLinejoin="round" points={line(projection.points, 'savedCents')} />
      {projection.checks.map((check) => (
        <circle key={check.milestone.id} cx={x(check.milestone.date)} cy={y(check.potCents)} r={4.5} fill="var(--color-bg)" stroke={check.shortCents > 0 ? 'var(--color-danger)' : 'var(--color-warn)'} strokeWidth={2.2} />
      ))}
      {months.map((month) => (
        <text key={month} x={x(`${month}-01`)} y={H - 6} textAnchor="middle" fill="var(--color-text-dim)" fontSize={11} fontWeight={700}>
          {monthShort(month)}
        </text>
      ))}
    </svg>
    </div>
  )
}

function MilestoneModal({ milestone, onClose }: { milestone: Partial<MoneyMilestone>; onClose: () => void }) {
  const [name, setName] = useState(milestone.name ?? '')
  const [date, setDate] = useState(milestone.date ?? '')
  const [amount, setAmount] = useState(euroInput(milestone.amountCents ?? null))
  const [paid, setPaid] = useState(milestone.paid ?? false)
  const [error, setError] = useState<string | null>(null)
  const cents = parseEuro(amount)

  const save = async (): Promise<void> => {
    if (cents === null) return setError('Vul een bedrag in, bv. 750 of 750,00.')
    try {
      await api.money.saveMilestone({ id: milestone.id, name, date, amountCents: cents, paid })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Modal
      open
      width={520}
      title={milestone.id ? milestone.name ?? 'Mijlpaal' : 'Nieuwe mijlpaal'}
      subtitle="Iets wat vóór vertrek uit de pot betaald wordt."
      onClose={onClose}
      footer={
        <>
          {milestone.id ? (
            <Button variant="danger" onClick={() => void api.money.removeMilestone(milestone.id!).then(onClose)}>
              Verwijderen
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" onClick={() => void save()}>
            Opslaan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Naam">
          <input className={input} value={name} onChange={(event) => setName(event.target.value)} placeholder="Lange vlucht" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Datum">
            <input className={input} type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label="Bedrag">
            <input className={input} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="€ 0,00" />
          </Field>
        </div>
        <label className="flex items-center gap-3 text-[15px] font-semibold">
          <input type="checkbox" className="h-5 w-5 accent-[var(--color-accent)]" checked={paid} onChange={(event) => setPaid(event.target.checked)} />
          Betaald uit de pot
        </label>
        {error && <p className="text-[13px] font-bold text-danger-text">{error}</p>}
      </div>
    </Modal>
  )
}

