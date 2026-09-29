import { useState } from 'react'

import type { IsoDate, MoneyState } from '@core/contract/types.js'
import { daysInMonth, monthOf } from '@core/money/dates.js'
import { budgetStatus } from '@core/money/status.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { euro, monthName, parseEuro, shortDate } from './format.js'
import { Big, Chip, Label, Panel, Row, input, useWidth } from './parts.js'

const CATEGORIES = ['Eten buiten', 'Uitgaan', 'Kleding', 'Overig']

/** The monthly budget: what is left, per day, and a quick way to note a spend. */
export function BudgetTab({ state, today }: { state: MoneyState; today: IsoDate }) {
  const status = budgetStatus(state, today)
  const month = monthOf(today)
  // Typed in and paid by card alike, newest first. A Tikkie back is a negative spend.
  const spends = [
    ...state.entries
      .filter((entry) => entry.kind === 'spend' && monthOf(entry.date) === month)
      .map((entry) => ({ id: entry.id, date: entry.date, name: entry.note || entry.category || 'Uitgave', sub: entry.category ?? 'handmatig', cents: entry.amountCents, manual: true })),
    ...state.transactions
      .filter((transaction) => transaction.kind === 'spend' && monthOf(transaction.date) === month)
      .map((transaction) => ({ id: transaction.id, date: transaction.date, name: transaction.counterparty || 'Pinbetaling', sub: transaction.amountCents > 0 ? 'terugbetaald' : 'bank', cents: -transaction.amountCents, manual: false }))
  ].sort((a, b) => b.date.localeCompare(a.date))
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [category, setCategory] = useState(CATEGORIES[0]!)
  const [error, setError] = useState<string | null>(null)

  const add = async (): Promise<void> => {
    const cents = parseEuro(amount)
    if (cents === null || cents <= 0) return setError('Vul een bedrag in, bv. 12,50.')
    setError(null)
    await api.money.addEntry({ date: today, kind: 'spend', amountCents: cents, note: note || category, category })
    setAmount('')
    setNote('')
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-3 wide:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] wide:gap-4">
        <Panel>
          <div className="flex items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <Label>Nog te besteden · {monthName(month)}</Label>
              <Big>{euro(status.leftCents)}</Big>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[20px] font-bold tabular-nums">{euro(status.perDayCents)}</span>
              <span className="text-[12px] text-text-dim">per dag, {status.daysLeft} dagen</span>
            </div>
          </div>
          <DayChart state={state} today={today} />
          <div>
            <Chip tone={status.aheadCents >= 0 ? 'good' : 'warn'}>
              {status.aheadCents >= 0 ? `${euro(status.aheadCents)} onder schema` : `${euro(-status.aheadCents)} boven schema`}
            </Chip>
          </div>
        </Panel>

        <Panel>
          <Label>Snel toevoegen</Label>
          <div className="flex gap-2">
            <input
              className={`${input} flex-1`}
              inputMode="decimal"
              aria-label="Bedrag"
              placeholder="€ 0,00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void add()}
            />
            <Button variant="primary" onClick={() => void add()}>
              Toevoegen
            </Button>
          </div>
          <input className={input} aria-label="Omschrijving" placeholder="Omschrijving (mag leeg)" value={note} onChange={(event) => setNote(event.target.value)} />
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setCategory(name)}
                className={`motion-press h-8 rounded-pill px-3 text-[13px] font-bold ${name === category ? 'bg-rail-active text-accent-soft' : 'bg-input text-text-dim'}`}
              >
                {name}
              </button>
            ))}
          </div>
          {error && <p className="text-[13px] font-bold text-danger-text">{error}</p>}
          <span className="text-[12px] text-text-dim">Pinbetalingen komen vanzelf uit de bank; typ alleen contant of Revolut in. Wat overblijft gaat bij de afsluiting naar Extra.</span>
        </Panel>
      </div>

      <Panel>
        <div className="flex items-baseline justify-between">
          <Label>Uitgegeven</Label>
          <span className="text-[13px] font-bold text-text-dim tabular-nums">{euro(status.spentCents)}</span>
        </div>
        {spends.length === 0 && <span className="text-[14px] text-text-dim">Nog niets deze maand.</span>}
        <div className="flex flex-col">
          {spends.map((spend) => (
            <Row
              key={spend.id}
              left={spend.name}
              sub={`${shortDate(spend.date)} · ${spend.sub}`}
              right={
                <>
                  <span className={`text-[15px] font-bold tabular-nums ${spend.cents < 0 ? 'text-accent-soft' : ''}`}>{euro(spend.cents)}</span>
                  {spend.manual ? (
                    <button
                      type="button"
                      aria-label="Verwijderen"
                      onClick={() => void api.money.removeEntry(spend.id)}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-text-faint hover:bg-input hover:text-text"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  ) : (
                    <span className="w-9" />
                  )}
                </>
              }
            />
          ))}
        </div>
      </Panel>
    </>
  )
}

/** Spend per day against an even pace; the days still to come show what they may cost. */
function DayChart({ state, today }: { state: MoneyState; today: IsoDate }) {
  const month = monthOf(today)
  const days = daysInMonth(month)
  const status = budgetStatus(state, today)
  const dayOfMonth = Number(today.slice(8, 10))
  const perDay = new Map<number, number>()
  for (const entry of state.entries) {
    if (entry.kind === 'spend' && monthOf(entry.date) === month) {
      const day = Number(entry.date.slice(8, 10))
      perDay.set(day, (perDay.get(day) ?? 0) + entry.amountCents)
    }
  }
  for (const transaction of state.transactions) {
    if (transaction.kind === 'spend' && monthOf(transaction.date) === month) {
      const day = Number(transaction.date.slice(8, 10))
      perDay.set(day, (perDay.get(day) ?? 0) - transaction.amountCents)
    }
  }
  const pace = status.budgetCents / days
  const max = Math.max(pace * 3, ...perDay.values(), status.perDayCents, 1)
  const [ref, W] = useWidth<HTMLDivElement>(560)
  const H = 110
  const step = W / days
  const bar = Math.max(4, step * 0.62)
  const height = (cents: number): number => Math.max(2, (cents / max) * (H - 10))

  return (
    <div ref={ref} className="w-full">
    <svg width={W} height={H + 18} viewBox={`0 0 ${W} ${H + 18}`} className="block" role="img" aria-label="Uitgaven per dag">
      <line x1={0} x2={W} y1={H} y2={H} stroke="var(--color-border-strong)" />
      <line x1={0} x2={W} y1={H - height(pace)} y2={H - height(pace)} stroke="var(--color-text)" strokeDasharray="3 4" opacity={0.4} />
      {Array.from({ length: days }, (_, index) => {
        const day = index + 1
        const past = day <= dayOfMonth
        const value = past ? perDay.get(day) ?? 0 : status.perDayCents
        const h = height(value)
        return (
          <rect
            key={day}
            x={index * step + (step - bar) / 2}
            y={H - h}
            width={bar}
            height={h}
            rx={2}
            fill={past ? (value > pace * 2 ? 'var(--color-warn)' : 'var(--color-accent)') : 'var(--color-track)'}
          />
        )
      })}
      <text x={2} y={H + 15} fill="var(--color-text-dim)" fontSize={11}>
        1
      </text>
      <text x={(dayOfMonth - 0.5) * step} y={H + 15} textAnchor="middle" fill="var(--color-text)" fontSize={11} fontWeight={700}>
        vandaag
      </text>
      <text x={W - 2} y={H + 15} textAnchor="end" fill="var(--color-text-dim)" fontSize={11}>
        {days}
      </text>
    </svg>
    </div>
  )
}
