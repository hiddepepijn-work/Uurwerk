import { useState } from 'react'

import type { MoneyState } from '@core/contract/types.js'
import { addMonths } from '@core/money/dates.js'
import { closingProposal } from '@core/money/status.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { euro, monthName } from './format.js'
import { Label } from './parts.js'

/**
 * Closing a month: the sum of what came in and went out, then the transfers to make. Uurwerk
 * cannot move money — it lists the transfers and records them once you tick them off.
 */
export function ClosingModal({ state, month, onClose }: { state: MoneyState; month: string; onClose: () => void }) {
  const proposal = closingProposal(state, month)
  const [done, setDone] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const toExtra = proposal.extraCents + proposal.budgetLeftCents - proposal.fromExtraCents

  const transfers = [
    { id: 'goal', to: 'Reispot', note: [proposal.borrowedCents > 0 ? `incl. ${euro(proposal.borrowedCents)} terugzetten` : '', proposal.fromExtraCents > 0 ? `${euro(proposal.fromExtraCents)} uit Extra` : ''].filter(Boolean).join(' · ') || 'volgens plan', cents: proposal.savingCents + proposal.fromExtraCents },
    {
      id: 'extra',
      to: toExtra >= 0 ? 'Extra-rekening' : 'Extra → reispot',
      note: toExtra >= 0 ? `${euro(proposal.extraCents)} over + ${euro(proposal.budgetLeftCents)} budgetrest` : 'tekort aanvullen',
      cents: Math.abs(toExtra)
    },
    { id: 'budget', to: 'Budgetrekening', note: monthName(addMonths(month, 1)), cents: proposal.budgetCents }
  ].filter((transfer) => transfer.cents > 0)

  const lines: Array<[string, number, 'in' | 'out' | 'total']> = [
    ['Vast inkomen', proposal.fixedIncomeCents, 'in'],
    ['Adecco / weekloon', proposal.shiftIncomeCents, 'in'],
    ['Vaste lasten', -proposal.costsCents, 'out'],
    ['Budget', -proposal.budgetCents, 'out'],
    ['Inleg reis volgens plan', -proposal.targetCents, 'out'],
    [proposal.availableCents >= proposal.targetCents ? 'Over → Extra' : 'Tekort', proposal.availableCents - proposal.targetCents, 'total']
  ]

  const confirm = async (): Promise<void> => {
    try {
      await api.money.close(month)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const count = transfers.filter((transfer) => done[transfer.id]).length
  return (
    <Modal
      open
      width={560}
      title={`${monthName(month)} afsluiten`}
      subtitle="Maak de overboekingen in je bank-app en vink ze af."
      onClose={onClose}
      footer={
        <>
          <span className="text-[13px] font-bold text-text-dim">
            {count} van {transfers.length} gedaan
          </span>
          <Button variant="primary" onClick={() => void confirm()} disabled={count < transfers.length}>
            Afsluiten
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col">
          {lines.map(([name, cents, kind]) => (
            <div key={name} className={`flex min-h-[38px] items-center justify-between border-t ${kind === 'total' ? 'border-border-strong font-bold' : 'border-border'}`}>
              <span className={kind === 'total' ? 'text-text' : 'text-text-dim'}>{name}</span>
              <span className={`font-bold tabular-nums ${kind === 'in' || (kind === 'total' && cents >= 0) ? 'text-accent-soft' : kind === 'total' ? 'text-danger-text' : ''}`}>
                {euro(cents, { sign: true })}
              </span>
            </div>
          ))}
        </div>
        {proposal.shortCents > 0 && (
          <p className="rounded-[14px] bg-danger-soft px-3 py-2.5 text-[13px] font-bold text-danger-text">
            Ook met Extra nog {euro(proposal.shortCents)} onder de inleg. De reis-projectie laat zien wat dat betekent.
          </p>
        )}
        <div className="flex flex-col gap-2">
          <Label>Overmaken</Label>
          {transfers.map((transfer) => (
            <label key={transfer.id} className="flex min-h-[60px] cursor-pointer items-center gap-3 border-b border-border">
              <input
                type="checkbox"
                className="h-6 w-6 accent-[var(--color-accent)]"
                checked={!!done[transfer.id]}
                onChange={(event) => setDone((current) => ({ ...current, [transfer.id]: event.target.checked }))}
              />
              <span className={`flex flex-1 flex-col ${done[transfer.id] ? 'opacity-55' : ''}`}>
                <span className="text-[16px] font-bold">{transfer.to}</span>
                <span className="text-[12px] text-text-dim">{transfer.note}</span>
              </span>
              <span className={`text-[17px] font-bold tabular-nums ${done[transfer.id] ? 'opacity-55' : ''}`}>{euro(transfer.cents)}</span>
              <button
                type="button"
                aria-label="Kopieer bedrag"
                onClick={(event) => {
                  event.preventDefault()
                  void navigator.clipboard?.writeText((transfer.cents / 100).toFixed(2).replace('.', ','))
                }}
                className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-input text-text-dim hover:text-text"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="12" height="12" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
              </button>
            </label>
          ))}
        </div>
        {error && <p className="text-[13px] font-bold text-danger-text">{error}</p>}
      </div>
    </Modal>
  )
}

