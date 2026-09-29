import { useState } from 'react'

import type { IsoDate, MoneyGoal, MoneyPhase, MoneyState } from '@core/contract/types.js'
import { monthOf, monthsBetween } from '@core/money/dates.js'
import { monthPlan } from '@core/money/plan.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { euro, euroInput, monthName, parseEuro, shortDate } from './format.js'
import { Chip, Field, Label, Panel, Row, input } from './parts.js'

/**
 * The plan behind the numbers: the goal, each phase month by month, and the closings. This is
 * where the rules live — edit a phase here and every other tab follows.
 */
export function PlanTab({ state, today, onClose }: { state: MoneyState; today: IsoDate; onClose: (month: string) => void }) {
  const [phase, setPhase] = useState<Partial<MoneyPhase> | null>(null)
  const [goal, setGoal] = useState<Partial<MoneyGoal> | null>(null)
  const closed = new Set(state.closings.map((closing) => closing.month))
  const current = monthOf(today)

  return (
    <>
      {state.goal && (
        <Panel>
          <div className="flex items-center justify-between">
            <Label>Doel · {state.goal.name}</Label>
            <Button size="sm" variant="ghost" onClick={() => setGoal(state.goal!)}>
              Aanpassen
            </Button>
          </div>
          <div className="flex flex-col">
            <Row left="Op je rekening bij vertrek" sub={shortDate(state.goal.date)} right={<b className="tabular-nums">{euro(state.goal.onAccountCents)}</b>} />
            <Row
              left="Vooraf geboekt (mijlpalen)"
              sub={`${state.milestones.length} mijlpalen · onder Reis`}
              right={<b className="tabular-nums">{euro(state.milestones.reduce((sum, milestone) => sum + milestone.amountCents, 0))}</b>}
            />
            <Row left="Startpunt" sub="negatief = je begint in de min" right={<b className="tabular-nums">{euro(state.goal.startCents)}</b>} />
          </div>
        </Panel>
      )}

      {state.phases.map((item) => {
        const months = monthsBetween(monthOf(item.from), monthOf(item.until))
        return (
          <Panel key={item.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Chip tone="good">{item.name}</Chip>
                <span className="text-[12px] text-text-dim">
                  {shortDate(item.from)} – {shortDate(item.until)}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setPhase(item)}>
                Aanpassen
              </Button>
            </div>
            <div className="flex flex-col">
              <Row left="Budget per maand" right={<b className="tabular-nums">{euro(item.budgetCents)}</b>} />
              <Row
                left="Inleg reis per maand"
                sub={item.savingCents === null ? 'alles wat overblijft' : undefined}
                right={<b className="tabular-nums">{item.savingCents === null ? 'rest' : euro(item.savingCents)}</b>}
              />
            </div>
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[520px] text-[13px] tabular-nums">
                <thead>
                  <tr className="text-left text-[11px] font-bold tracking-[0.6px] text-text-faint uppercase">
                    <th className="py-2 font-bold">Maand</th>
                    <th className="py-2 text-right font-bold">Vast in</th>
                    <th className="py-2 text-right font-bold">Weekloon</th>
                    <th className="py-2 text-right font-bold">Vaste lasten</th>
                    <th className="py-2 text-right font-bold">Nodig uit diensten</th>
                    <th className="py-2 text-right font-bold">Afsluiting</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((month) => {
                    const plan = monthPlan(state, month)
                    const done = closed.has(month)
                    return (
                      <tr key={month} className="border-t border-border">
                        <td className="py-2 font-semibold">{monthName(month)}</td>
                        <td className="py-2 text-right">{euro(plan.fixedIncomeCents, { round: true })}</td>
                        <td className="py-2 text-right">{plan.weeklyIncomeCents ? euro(plan.weeklyIncomeCents, { round: true }) : '–'}</td>
                        <td className="py-2 text-right">{euro(plan.costsCents, { round: true })}</td>
                        <td className="py-2 text-right">
                          {plan.hasShifts ? `${euro(plan.neededFromShiftsCents, { round: true })} · ${plan.shiftsNeeded} nachten` : '–'}
                        </td>
                        <td className="py-2 text-right">
                          {done ? (
                            <button type="button" onClick={() => void api.money.reopen(month)} title="Afsluiting terugdraaien">
                              <Chip tone="good">afgesloten</Chip>
                            </button>
                          ) : month < current ? (
                            <button type="button" onClick={() => onClose(month)}>
                              <Chip tone="warn">afsluiten</Chip>
                            </button>
                          ) : (
                            <Chip>open</Chip>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        )
      })}

      <Panel>
        <Label>Regels</Label>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-[14px] leading-relaxed">
          <li>Het plan rekent alleen met wat vaststaat. Extra diensten zijn bonus.</li>
          <li>Alles boven het plan gaat bij de maandafsluiting naar de Extra-rekening, net als wat van je budget overblijft.</li>
          <li>Kom je een maand tekort, dan vult Extra de inleg aan.</li>
          <li>Tot april wordt niets belegd. Na terugkomst: eerst een buffer, dan beleggen.</li>
        </ol>
      </Panel>

      {phase && <PhaseModal phase={phase} onClose={() => setPhase(null)} />}
      {goal && <GoalModal goal={goal} onClose={() => setGoal(null)} />}
    </>
  )
}

function PhaseModal({ phase, onClose }: { phase: Partial<MoneyPhase>; onClose: () => void }) {
  const [name, setName] = useState(phase.name ?? '')
  const [from, setFrom] = useState(phase.from ?? '')
  const [until, setUntil] = useState(phase.until ?? '')
  const [budget, setBudget] = useState(euroInput(phase.budgetCents ?? 15000))
  const [saving, setSaving] = useState(euroInput(phase.savingCents ?? null))
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const budgetCents = parseEuro(budget)
    const savingCents = saving.trim() ? parseEuro(saving) : null
    if (budgetCents === null || (saving.trim() && savingCents === null)) return setError('Controleer de bedragen.')
    try {
      await api.money.savePhase({ id: phase.id, name, from, until, budgetCents, savingCents })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Modal open width={560} title={phase.name ?? 'Fase'} subtitle="Leeg bij inleg = alles wat overblijft gaat naar de reis." onClose={onClose} footer={<><span /><Button variant="primary" onClick={() => void save()}>Opslaan</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label="Naam">
            <input className={input} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
        </div>
        <Field label="Van">
          <input className={input} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label="Tot en met">
          <input className={input} type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
        </Field>
        <Field label="Budget per maand">
          <input className={input} inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} />
        </Field>
        <Field label="Inleg reis per maand">
          <input className={input} inputMode="decimal" value={saving} placeholder="rest" onChange={(event) => setSaving(event.target.value)} />
        </Field>
      </div>
      {error && <p className="mt-3 text-[13px] font-bold text-danger-text">{error}</p>}
    </Modal>
  )
}

function GoalModal({ goal, onClose }: { goal: Partial<MoneyGoal>; onClose: () => void }) {
  const [name, setName] = useState(goal.name ?? 'Reis')
  const [date, setDate] = useState(goal.date ?? '')
  const [onAccount, setOnAccount] = useState(euroInput(goal.onAccountCents ?? null))
  const [start, setStart] = useState(euroInput(goal.startCents ?? 0))
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const onAccountCents = parseEuro(onAccount)
    const startCents = parseEuro(start)
    if (onAccountCents === null || startCents === null) return setError('Controleer de bedragen.')
    try {
      await api.money.saveGoal({ id: goal.id, name, date, onAccountCents, startCents })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Modal open width={520} title="Doel" subtitle="Wat er op je rekening moet staan op de dag zelf, na alles wat vooraf betaald is." onClose={onClose} footer={<><span /><Button variant="primary" onClick={() => void save()}>Opslaan</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Naam">
          <input className={input} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Datum">
          <input className={input} type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <Field label="Op rekening bij vertrek">
          <input className={input} inputMode="decimal" value={onAccount} onChange={(event) => setOnAccount(event.target.value)} />
        </Field>
        <Field label="Startpunt">
          <input className={input} inputMode="decimal" value={start} onChange={(event) => setStart(event.target.value)} />
        </Field>
      </div>
      {error && <p className="mt-3 text-[13px] font-bold text-danger-text">{error}</p>}
    </Modal>
  )
}
