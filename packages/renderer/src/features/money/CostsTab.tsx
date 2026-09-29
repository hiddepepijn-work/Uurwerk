import { useState } from 'react'

import type { IsoDate, MoneyCost, MoneyIncome, MoneyIncomeKind, MoneyState } from '@core/contract/types.js'
import { activeOn, dayInMonth, monthOf } from '@core/money/dates.js'
import { costsIn, phaseFor } from '@core/money/plan.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { BankPlanCheck } from './BankPlanCheck.js'
import { euro, euroInput, parseEuro, shortDate } from './format.js'
import { Chip, Field, Label, Panel, Row, Segmented, Tile, input } from './parts.js'

/** Fixed costs grouped by kind, what the next phase drops, and every income with its rhythm. */
export function CostsTab({ state, today }: { state: MoneyState; today: IsoDate }) {
  const [cost, setCost] = useState<Partial<MoneyCost> | null>(null)
  const [income, setIncome] = useState<Partial<MoneyIncome> | null>(null)
  const month = monthOf(today)
  const phase = phaseFor(state.phases, month)
  const next = phase ? state.phases.find((candidate) => candidate.from > phase.until) ?? null : state.phases[0] ?? null
  const now = costsIn(state.costs, month)
  const nowTotal = now.reduce((sum, { cost: item }) => sum + item.amountCents, 0)
  const nextTotal = next ? costsIn(state.costs, monthOf(next.from)).reduce((sum, { cost: item }) => sum + item.amountCents, 0) : null

  const groups = new Map<string, MoneyCost[]>()
  for (const item of state.costs) groups.set(item.category, [...(groups.get(item.category) ?? []), item])

  return (
    <>
      <BankPlanCheck state={state} today={today} />
      <div className="grid grid-cols-2 gap-3 wide:grid-cols-4">
        <Tile label={phase ? `${phase.name.split('·')[0]!.trim()} · nu` : 'Nu'} value={euro(nowTotal)} sub="per maand" />
        {next && nextTotal !== null && (
          <Tile
            label={`${next.name.split('·')[0]!.trim()} · vanaf ${shortDate(next.from)}`}
            value={euro(nextTotal)}
            sub={nextTotal < nowTotal ? `${euro(nextTotal - nowTotal)} per maand` : 'per maand'}
            tone={nextTotal < nowTotal ? 'good' : undefined}
          />
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 wide:grid-cols-2 wide:gap-4">
        {[...groups.entries()].map(([category, items]) => {
          const active = items.filter((item) => activeOn(item, dayInMonth(month, item.day)))
          const ends = items.find((item) => item.until !== null && item.until >= today)
          return (
            <Panel key={category}>
              <div className="flex items-baseline justify-between">
                <Label>
                  {category}
                  {ends ? ` · stopt ${shortDate(ends.until!)}` : ''}
                </Label>
                <span className="text-[13px] font-bold text-text-dim tabular-nums">{euro(active.reduce((sum, item) => sum + item.amountCents, 0))}</span>
              </div>
              <div className="flex flex-col">
                {items.map((item) => {
                  const date = dayInMonth(month, item.day)
                  const running = activeOn(item, date)
                  const paidByBank = state.transactions.some((transaction) => transaction.kind === 'cost' && transaction.refId === item.id && monthOf(transaction.date) === month)
                  return (
                    <Row
                      key={item.id}
                      left={item.name}
                      sub={`elke ${item.day}e${item.until ? ` · t/m ${shortDate(item.until)}` : ''}${item.from ? ` · vanaf ${shortDate(item.from)}` : ''}`}
                      onClick={() => setCost(item)}
                      right={
                        <>
                          {paidByBank ? <Chip tone="good">betaald ✓</Chip> : !running ? <Chip>niet deze maand</Chip> : date < today && state.transactions.length > 0 ? <Chip tone="warn">nog niet gezien</Chip> : date <= today ? <Chip tone="good">geweest</Chip> : <Chip>{shortDate(date)}</Chip>}
                          <span className="w-[74px] text-right text-[15px] font-bold tabular-nums">{euro(item.amountCents)}</span>
                        </>
                      }
                    />
                  )
                })}
              </div>
            </Panel>
          )
        })}
      </div>
      <Button variant="secondary" onClick={() => setCost({ day: 1, category: 'Overig', from: null, until: null })}>
        + Vaste last
      </Button>

      <Panel>
        <div className="flex items-center justify-between">
          <Label>Inkomen</Label>
          <Button size="sm" variant="ghost" onClick={() => setIncome({ kind: 'fixed', day: 25, from: null, until: null, amountCents: null })}>
            + Inkomen
          </Button>
        </div>
        <div className="flex flex-col">
          {state.incomes.map((item) => (
            <Row key={item.id} left={item.name} sub={incomeRhythm(item)} onClick={() => setIncome(item)} right={<IncomeAmount income={item} />} />
          ))}
        </div>
        <span className="text-[12px] text-text-dim">Weeklonen tellen mee in de maand waarin ze binnenkomen.</span>
      </Panel>

      {cost && <CostModal cost={cost} onClose={() => setCost(null)} />}
      {income && <IncomeModal income={income} onClose={() => setIncome(null)} />}
    </>
  )
}

function incomeRhythm(income: MoneyIncome): string {
  const range = `${income.from ? ` · vanaf ${shortDate(income.from)}` : ''}${income.until ? ` · t/m ${shortDate(income.until)}` : ''}`
  switch (income.kind) {
    case 'fixed':
      return `elke ${income.day ?? 1}e${range}`
    case 'weekly':
      return `wekelijks do, week later${range}`
    case 'shifts':
      return `per dienst · loonprofiel${range}`
    case 'open':
      return 'open · nog onbekend'
  }
}

function IncomeAmount({ income }: { income: MoneyIncome }) {
  if (income.kind === 'shifts') return <Chip>per dienst</Chip>
  if (income.kind === 'open' || income.amountCents === null) return <Chip>€ ?</Chip>
  return <span className="text-[15px] font-bold text-accent-soft tabular-nums">{euro(income.amountCents)}{income.kind === 'weekly' ? '/mnd' : ''}</span>
}

function useError(): [string | null, (cause: unknown) => void, (message: string | null) => void] {
  const [error, setError] = useState<string | null>(null)
  return [error, (cause) => setError(cause instanceof Error ? cause.message : String(cause)), setError]
}

function CostModal({ cost, onClose }: { cost: Partial<MoneyCost>; onClose: () => void }) {
  const [name, setName] = useState(cost.name ?? '')
  const [category, setCategory] = useState(cost.category ?? 'Overig')
  const [amount, setAmount] = useState(euroInput(cost.amountCents ?? null))
  const [day, setDay] = useState(String(cost.day ?? 1))
  const [from, setFrom] = useState(cost.from ?? '')
  const [until, setUntil] = useState(cost.until ?? '')
  const [error, fail, setError] = useError()

  const save = async (): Promise<void> => {
    const cents = parseEuro(amount)
    if (cents === null) return setError('Vul een bedrag in, bv. 54 of 176,29.')
    try {
      await api.money.saveCost({ id: cost.id, name, category, amountCents: cents, day: Number(day), from: from || null, until: until || null })
      onClose()
    } catch (cause) {
      fail(cause)
    }
  }

  return (
    <Modal
      open
      width={560}
      title={cost.id ? cost.name ?? 'Vaste last' : 'Nieuwe vaste last'}
      onClose={onClose}
      footer={
        <>
          {cost.id ? (
            <Button variant="danger" onClick={() => void api.money.removeCost(cost.id!).then(onClose)}>
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
        <div className="grid grid-cols-2 gap-3">
          <Field label="Naam">
            <input className={input} value={name} onChange={(event) => setName(event.target.value)} placeholder="Telefoon" />
          </Field>
          <Field label="Soort">
            <input className={input} value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Telefoon & digitaal" />
          </Field>
          <Field label="Bedrag per maand">
            <input className={input} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="€ 0,00" />
          </Field>
          <Field label="Dag van de maand">
            <input className={input} type="number" min={1} max={31} value={day} onChange={(event) => setDay(event.target.value)} />
          </Field>
          <Field label="Vanaf (leeg = altijd)">
            <input className={input} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="Tot en met (leeg = loopt door)">
            <input className={input} type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
          </Field>
        </div>
        {error && <p className="text-[13px] font-bold text-danger-text">{error}</p>}
      </div>
    </Modal>
  )
}

const KINDS: Array<{ value: MoneyIncomeKind; label: string }> = [
  { value: 'fixed', label: 'Vast' },
  { value: 'weekly', label: 'Wekelijks' },
  { value: 'shifts', label: 'Per dienst' },
  { value: 'open', label: 'Open' }
]

function IncomeModal({ income, onClose }: { income: Partial<MoneyIncome>; onClose: () => void }) {
  const [name, setName] = useState(income.name ?? '')
  const [kind, setKind] = useState<MoneyIncomeKind>(income.kind ?? 'fixed')
  const [amount, setAmount] = useState(euroInput(income.amountCents ?? null))
  const [day, setDay] = useState(String(income.day ?? 25))
  const [from, setFrom] = useState(income.from ?? '')
  const [until, setUntil] = useState(income.until ?? '')
  const [error, fail, setError] = useError()

  const save = async (): Promise<void> => {
    const cents = kind === 'fixed' || kind === 'weekly' ? parseEuro(amount) : null
    if ((kind === 'fixed' || kind === 'weekly') && cents === null) return setError('Vul een bedrag in.')
    try {
      await api.money.saveIncome({
        id: income.id,
        name,
        kind,
        amountCents: cents,
        day: kind === 'fixed' ? Number(day) : null,
        from: from || null,
        until: until || null
      })
      onClose()
    } catch (cause) {
      fail(cause)
    }
  }

  return (
    <Modal
      open
      width={560}
      title={income.id ? income.name ?? 'Inkomen' : 'Nieuw inkomen'}
      subtitle="Open = nog onbekend: staat in de lijst, telt nergens mee."
      onClose={onClose}
      footer={
        <>
          {income.id ? (
            <Button variant="danger" onClick={() => void api.money.removeIncome(income.id!).then(onClose)}>
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
          <input className={input} value={name} onChange={(event) => setName(event.target.value)} placeholder="Stagevergoeding" />
        </Field>
        <Segmented options={KINDS} value={kind} onChange={setKind} />
        <div className="grid grid-cols-2 gap-3">
          {(kind === 'fixed' || kind === 'weekly') && (
            <Field label={kind === 'weekly' ? 'Bedrag per maand (schatting)' : 'Bedrag'}>
              <input className={input} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="€ 0,00" />
            </Field>
          )}
          {kind === 'fixed' && (
            <Field label="Dag van de maand">
              <input className={input} type="number" min={1} max={31} value={day} onChange={(event) => setDay(event.target.value)} />
            </Field>
          )}
          <Field label="Vanaf">
            <input className={input} type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="Tot en met">
            <input className={input} type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
          </Field>
        </div>
        {error && <p className="text-[13px] font-bold text-danger-text">{error}</p>}
      </div>
    </Modal>
  )
}
