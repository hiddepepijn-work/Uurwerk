import { useEffect, useState } from 'react'

import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { WalletIcon } from '../../ui/icons.js'
import { BankTab } from './BankTab.js'
import { BudgetTab } from './BudgetTab.js'
import { ClosingModal } from './ClosingModal.js'
import { CostsTab } from './CostsTab.js'
import { dayDate } from './format.js'
import { OverviewTab } from './OverviewTab.js'
import { PlanTab } from './PlanTab.js'
import { ShiftsTab } from './ShiftsTab.js'
import { TripTab } from './TripTab.js'
import { useMoney } from './useMoney.js'
import { VaultModal } from './VaultModal.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'

export type MoneyTab = 'overview' | 'trip' | 'costs' | 'budget' | 'shifts' | 'bank' | 'plan'

const TABS: Array<{ id: MoneyTab; label: string }> = [
  { id: 'overview', label: 'Overzicht' },
  { id: 'trip', label: 'Reis' },
  { id: 'costs', label: 'Vaste lasten' },
  { id: 'budget', label: 'Budget' },
  { id: 'shifts', label: 'Diensten' },
  { id: 'bank', label: 'Bank' },
  { id: 'plan', label: 'Plan' }
]

/**
 * Geld: vaste lasten, the monthly budget, the trip pot and the shifts that pay for it.
 *
 * Everything on this screen is computed from one read of the state (useMoney) with the pure
 * functions in core/money. The data never leaves this copy; the lock chip in the header says so.
 */
export function MoneyScreen() {
  const { state, error, today } = useMoney()
  const [tab, setTab] = useState<MoneyTab>('overview')
  const [closing, setClosing] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [vaultOpen, setVaultOpen] = useState(false)
  const { data: vault } = useLiveQuery((client) => client.money.vaultStatus(), ['money'], [])
  const { data: bank } = useLiveQuery((client) => client.money.bankStatus(), ['money'], [])
  // Opening Geld is "you are looking": the bank allows a read now (the laptop throttles it).
  useEffect(() => {
    void api.money.bankRefresh().catch(() => undefined)
  }, [])

  if (error) return <p className="p-8 text-danger-text">{error}</p>
  if (!state) return null

  const empty = state.phases.length === 0 && !state.goal
  const loadStarter = async (): Promise<void> => {
    setLoading(true)
    try {
      await api.money.loadStarter()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="px-4 pt-4 pb-28 wide:px-8 wide:pt-7 wide:pb-10">
      <header className="mb-4 flex items-end justify-between gap-3 wide:mb-6">
        <div className="flex min-w-0 flex-col gap-1 wide:gap-1.5">
          <h1 className="display-title text-[34px] tracking-[-1px] wide:text-[40px]">Geld</h1>
          <p className="text-[14px] font-medium text-text-dim wide:text-[15px] wide:font-normal">{dayDate(today)}</p>
        </div>
        <button
          type="button"
          onClick={() => setVaultOpen(true)}
          title="Versleuteld. Nooit leesbaar op de server, niet voor begeleider of docent, niet voor Jarvis."
          className={`motion-press flex h-9 shrink-0 items-center gap-1.5 rounded-pill px-3 text-[12px] font-bold ${
            vault?.lastError ? 'bg-danger-soft text-danger-text' : vault?.enabled ? 'bg-rail-active text-accent-soft' : 'bg-input text-text-dim'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          {vault?.lastError ? 'Sync-fout' : vault?.enabled ? 'Versleuteld · live' : 'Alleen hier'}
        </button>
      </header>

      {empty ? (
        <div className="rounded-card bg-card">
          <EmptyState
            icon={<WalletIcon size={30} />}
            title="Nog niets ingevuld"
            hint="Staat Geld al op je andere apparaat? Haal het op met je wachtwoordzin. Anders zet het startplan je vaste lasten, inkomens, fases, het reisdoel en het Adecco-loonprofiel klaar."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" onClick={() => setVaultOpen(true)}>
                  Ophalen van ander apparaat
                </Button>
                <Button variant="primary" onClick={() => void loadStarter()} disabled={loading}>
                  Startplan laden
                </Button>
              </div>
            }
          />
        </div>
      ) : (
        <>
          <nav aria-label="Geld" className="-mx-4 mb-4 overflow-x-auto px-4 wide:mx-0 wide:mb-6 wide:px-0">
            <div className="flex w-max min-w-full gap-1 rounded-[14px] bg-card p-1 wide:w-auto">
              {TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  aria-current={tab === item.id ? 'page' : undefined}
                  className={`motion-press h-9 flex-1 rounded-[11px] px-3.5 text-[13px] font-bold whitespace-nowrap transition-colors duration-300 ${
                    tab === item.id ? 'bg-text text-bg' : 'text-text-dim hover:text-text'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </nav>

          <div key={tab} className="stagger-children flex flex-col gap-3 wide:gap-4">
            {tab === 'overview' && <OverviewTab state={state} today={today} onTab={setTab} onClose={setClosing} />}
            {tab === 'trip' && <TripTab state={state} today={today} />}
            {tab === 'costs' && <CostsTab state={state} today={today} />}
            {tab === 'budget' && <BudgetTab state={state} today={today} />}
            {tab === 'shifts' && <ShiftsTab state={state} today={today} />}
            {tab === 'bank' && <BankTab state={state} today={today} status={bank} />}
            {tab === 'plan' && <PlanTab state={state} today={today} onClose={setClosing} />}
          </div>
        </>
      )}

      {closing && <ClosingModal state={state} month={closing} onClose={() => setClosing(null)} />}
      {vaultOpen && vault && <VaultModal status={vault} onClose={() => setVaultOpen(false)} />}
    </div>
  )
}
