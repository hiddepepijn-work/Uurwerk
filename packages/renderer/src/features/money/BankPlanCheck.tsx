import { useState } from 'react'

import type { IsoDate, MoneyState } from '@core/contract/types.js'
import { checkPlan, type Recurring } from '@core/money/bank/recurring.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { euro, shortDate } from './format.js'
import { Chip, Label, Panel, Row } from './parts.js'

/**
 * The plan set against four months of bank history: update what the bank knows better, add
 * what the plan forgot, drop what the bank never shows. Nothing changes until you tap.
 */
export function BankPlanCheck({ state, today }: { state: MoneyState; today: IsoDate }) {
  const [busy, setBusy] = useState<string | null>(null)
  if (state.transactions.length === 0) return null
  const check = checkPlan(state, today)
  const updates = check.recurring.filter((item) => item.differs)
  const fresh = check.recurring.filter((item) => !item.match)
  if (updates.length === 0 && fresh.length === 0 && check.missing.length === 0) {
    return (
      <Panel>
        <Label>Uit je bank</Label>
        <span className="text-[14px] text-accent-soft">Je vaste lasten en inkomens kloppen met de afgelopen 4 maanden.</span>
      </Panel>
    )
  }

  const act = async (key: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await work()
    } finally {
      setBusy(null)
    }
  }

  const update = (item: Recurring) => {
    if (!item.match || !item.differs) return Promise.resolve()
    if (item.match.type === 'cost') {
      return api.money.saveCost({ ...item.match.item, day: item.differs.day ?? item.match.item.day, amountCents: item.differs.amountCents ?? item.match.item.amountCents })
    }
    return api.money.saveIncome({ ...item.match.item, day: item.differs.day ?? item.match.item.day, amountCents: item.differs.amountCents ?? item.match.item.amountCents })
  }

  const add = (item: Recurring) =>
    item.direction === 'out'
      ? api.money.saveCost({ name: item.name, category: 'Uit de bank', amountCents: item.amountCents, day: item.day, from: null, until: null })
      : api.money.saveIncome({ name: item.name, kind: 'fixed', amountCents: item.amountCents, day: item.day, from: null, until: null })

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>Uit je bank · sinds {shortDate(check.fromDate)}</Label>
        {updates.length > 1 && (
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void act('all', async () => {
            for (const item of updates) await update(item)
          })}>
            Alles bijwerken ({updates.length})
          </Button>
        )}
      </div>

      <div className="flex flex-col">
        {updates.map((item) => (
          <Row
            key={item.key}
            left={`${item.match!.item.name}: ${[
              item.differs!.day !== undefined ? `dag ${item.match!.item.day ?? '?'} → ${item.differs!.day}` : '',
              item.differs!.amountCents !== undefined ? `${euro(item.match!.item.amountCents ?? 0)} → ${euro(item.differs!.amountCents)}` : ''
            ].filter(Boolean).join(', ')}`}
            sub={`${item.name} · ${item.months} maanden gezien`}
            right={
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void act(item.key, () => update(item))}>
                Bijwerken
              </Button>
            }
          />
        ))}
        {fresh.map((item) => (
          <Row
            key={item.key}
            left={`${item.name} · ${euro(item.amountCents)}`}
            sub={`${item.direction === 'in' ? 'komt binnen' : 'gaat eraf'} rond de ${item.day}e · ${item.months} maanden gezien, laatst ${shortDate(item.lastDate)}`}
            right={
              <span className="flex gap-1.5">
                <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void act(item.key, () => add(item))}>
                  {item.direction === 'in' ? '+ Inkomen' : '+ Vaste last'}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(item.key, () => api.money.sortTransaction(item.lastId, 'ignore', null, true))}>
                  Negeren
                </Button>
              </span>
            }
          />
        ))}
        {check.missing.map((item) => (
          <Row
            key={item.id}
            left={item.name}
            sub="staat in je plan, maar de bank zag hem niet in 4 maanden"
            right={
              <span className="flex items-center gap-1.5">
                <Chip tone="warn">niet gezien</Chip>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void act(item.id, () => (item.type === 'cost' ? api.money.removeCost(item.id) : api.money.removeIncome(item.id)))}
                >
                  Weg
                </Button>
              </span>
            }
          />
        ))}
      </div>
    </Panel>
  )
}
