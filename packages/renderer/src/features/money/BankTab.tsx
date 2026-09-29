import { useState } from 'react'

import type { IsoDate, MoneyBankStatus, MoneyState, MoneyTransaction, MoneyTransactionKind } from '@core/contract/types.js'
import { potAccount } from '@core/money/projection.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { dayDate, euro, euroInput, parseEuro, shortDate } from './format.js'
import { Chip, Field, Label, Panel, Row, input } from './parts.js'

const KIND_LABEL: Record<MoneyTransactionKind, string> = {
  spend: 'Budget',
  income: 'Inkomen',
  shiftPay: 'Adecco',
  cost: 'Vaste last',
  saving: 'Naar reispot',
  milestone: 'Mijlpaal',
  borrowed: 'Geleend van reis',
  transfer: 'Eigen rekening',
  ignore: 'Telt niet mee'
}

const KIND_TONE: Partial<Record<MoneyTransactionKind, 'good' | 'warn' | 'bad'>> = {
  saving: 'good',
  income: 'good',
  shiftPay: 'good',
  borrowed: 'bad'
}

/**
 * The bank: linking ABN AMRO through Enable Banking, the savings account the bank does not
 * share, what still needs sorting, and the rules learnt from sorting.
 */
export function BankTab({ state, today, status }: { state: MoneyState; today: IsoDate; status: MoneyBankStatus | null }) {
  const [sorting, setSorting] = useState<MoneyTransaction | null>(null)
  const [savingsOpen, setSavingsOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const review = state.transactions.filter((transaction) => transaction.kind === null && !transaction.pending)
  const recent = state.transactions.slice(0, 40)
  const current = state.accounts.filter((account) => account.role !== 'spaar')
  const pot = potAccount(state)
  const savings = state.accounts.find((account) => account.role === 'spaar') ?? null
  const daysLeft = status?.validUntil ? Math.round((Date.parse(status.validUntil) - Date.now()) / 86_400_000) : null

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      await api.money.bankRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <>
      {status?.canFetch && status.connected ? (
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label>ABN AMRO · gekoppeld</Label>
            <Button size="sm" variant="secondary" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? 'Ophalen…' : 'Nu ophalen'}
            </Button>
          </div>
          <span className="text-[13px] text-text-dim">
            Laatst opgehaald: {status.lastFetchAt ? new Date(status.lastFetchAt).toLocaleString('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'nog niet'} · vanzelf om de 6 uur en als je Geld opent
          </span>
          {daysLeft !== null && daysLeft <= 14 && (
            <span className="rounded-[14px] bg-warn-soft px-3 py-2.5 text-[13px] font-bold text-warn">
              De koppeling verloopt over {Math.max(0, daysLeft)} dagen. Verbind opnieuw en bevestig in de ABN AMRO-app.
            </span>
          )}
          {(status.lastError || error) && <span className="text-[13px] font-bold text-danger-text">{status.lastError ?? error}</span>}
        </Panel>
      ) : status && !status.here ? (
        <Panel>
          <Label>Bank</Label>
          <span className="text-[14px] text-text-dim">Je laptop haalt de transacties op en zet ze versleuteld hier neer.</span>
        </Panel>
      ) : (
        <ConnectPanel status={status} />
      )}

      <div className="grid grid-cols-1 gap-3 wide:grid-cols-2 wide:gap-4">
        {current.map((account) => (
          <Panel key={account.uid}>
            <Label>{account.name}</Label>
            <span className="font-display text-[30px] leading-none font-bold tabular-nums">{account.balanceCents === null ? '–' : euro(account.balanceCents)}</span>
            <span className="text-[12px] text-text-dim">
              {account.iban} {account.balanceDate ? `· ${shortDate(account.balanceDate)}` : ''}
            </span>
          </Panel>
        ))}
        <Panel>
          <div className="flex items-center justify-between">
            <Label>{savings?.name ?? 'Spaarrekening'} · reispot</Label>
            <Button size="sm" variant="ghost" onClick={() => setSavingsOpen(true)}>
              {savings ? 'Aanpassen' : 'Instellen'}
            </Button>
          </div>
          {pot ? (
            <>
              <span className="font-display text-[30px] leading-none font-bold tabular-nums">{euro(pot.balanceCents ?? 0)}</span>
              <span className="text-[12px] text-text-dim">
                {savings?.lockedUntil ? `op slot tot ${shortDate(savings.lockedUntil)} · ` : ''}
                {savings?.uid.startsWith('manual:') ? 'bijgehouden via je betaalrekening (zonder rente)' : ''}
              </span>
            </>
          ) : (
            <span className="text-[13px] text-text-dim">
              ABN AMRO deelt spaarrekeningen niet via de bank-API. Vul één keer het IBAN en het saldo in; overboekingen van en naar je betaalrekening houden het daarna bij.
            </span>
          )}
        </Panel>
      </div>

      <Panel>
        <div className="flex items-baseline justify-between">
          <Label>Nakijken</Label>
          <span className="text-[13px] font-bold text-text-dim">{review.length}</span>
        </div>
        {review.length === 0 && <span className="text-[14px] text-text-dim">Alles is ingedeeld.</span>}
        <div className="flex flex-col">
          {review.map((transaction) => (
            <TransactionRow key={transaction.id} transaction={transaction} onClick={() => setSorting(transaction)} />
          ))}
        </div>
      </Panel>

      <Panel>
        <Label>Laatste transacties</Label>
        {recent.length === 0 && <span className="text-[14px] text-text-dim">Nog niets opgehaald.</span>}
        <div className="flex flex-col">
          {recent.map((transaction) => (
            <TransactionRow key={transaction.id} transaction={transaction} onClick={() => setSorting(transaction)} />
          ))}
        </div>
      </Panel>

      {state.rules.length > 0 && (
        <Panel>
          <Label>Geleerde regels</Label>
          <div className="flex flex-col">
            {state.rules.map((rule) => (
              <Row
                key={rule.id}
                left={`"${rule.pattern}"`}
                sub={`→ ${KIND_LABEL[rule.kind]}`}
                right={
                  <Button size="sm" variant="ghost" onClick={() => void api.money.removeRule(rule.id)}>
                    Weg
                  </Button>
                }
              />
            ))}
          </div>
        </Panel>
      )}

      {sorting && <SortModal state={state} transaction={sorting} onClose={() => setSorting(null)} />}
      {savingsOpen && <SavingsModal state={state} today={today} onClose={() => setSavingsOpen(false)} />}
    </>
  )
}

function TransactionRow({ transaction, onClick }: { transaction: MoneyTransaction; onClick: () => void }) {
  return (
    <Row
      left={transaction.counterparty || transaction.description || 'Transactie'}
      sub={`${dayDate(transaction.date)}${transaction.pending ? ' · nog niet verwerkt' : ''}${transaction.description && transaction.counterparty ? ` · ${transaction.description}` : ''}`}
      onClick={onClick}
      right={
        <>
          {transaction.kind ? <Chip tone={KIND_TONE[transaction.kind] ?? 'muted'}>{KIND_LABEL[transaction.kind]}</Chip> : <Chip tone="warn">nakijken</Chip>}
          <span className={`w-[82px] text-right text-[15px] font-bold tabular-nums ${transaction.amountCents > 0 ? 'text-accent-soft' : ''}`}>{euro(transaction.amountCents, { sign: true })}</span>
        </>
      }
    />
  )
}

function ConnectPanel({ status }: { status: MoneyBankStatus | null }) {
  const [applicationId, setApplicationId] = useState('')
  const [pem, setPem] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<1 | 2>(status?.canFetch ? 2 : 1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel>
      <Label>ABN AMRO koppelen</Label>
      {step === 1 ? (
        <>
          <span className="text-[13px] leading-relaxed text-text-dim">
            Alleen lezen: Uurwerk kan geen geld verplaatsen. De sleutel gaat versleuteld in Windows en verlaat je laptop niet.
          </span>
          <Field label="Application ID (Enable Banking)">
            <input className={input} value={applicationId} onChange={(event) => setApplicationId(event.target.value)} placeholder="xxxxxxxx-xxxx-…" />
          </Field>
          <Field label="Sleutel (.pem)">
            <input
              className="text-[14px] text-text-dim file:mr-3 file:h-10 file:rounded-[12px] file:border-0 file:bg-input file:px-3 file:font-bold file:text-text"
              type="file"
              accept=".pem,.key,.txt"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (!file) return
                setFileName(file.name)
                void file.text().then(setPem)
              }}
            />
          </Field>
          {fileName && <span className="text-[12px] text-text-dim">{fileName} gelezen</span>}
          <Button
            variant="primary"
            disabled={busy || !applicationId || !pem}
            onClick={() =>
              void run(async () => {
                await api.money.bankConnect(applicationId, pem!)
                setPem(null)
                setStep(2)
              })
            }
          >
            {busy ? 'Bezig…' : 'Verbinden'}
          </Button>
        </>
      ) : (
        <>
          <span className="text-[13px] leading-relaxed text-text-dim">
            Je browser opende de bank. Bevestig in de ABN AMRO-app; je komt uit op een pagina van je server met een code. Kopieer de adresbalk of de code en plak hem hier.
          </span>
          <Field label="Code of adres">
            <input className={input} value={code} onChange={(event) => setCode(event.target.value)} placeholder="https://uurwerk.duckdns.org/geld/bank?code=…" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy || !code} onClick={() => void run(() => api.money.bankFinish(code))}>
              {busy ? 'Bezig…' : 'Afronden'}
            </Button>
            <Button variant="ghost" onClick={() => setStep(1)}>
              Opnieuw beginnen
            </Button>
          </div>
        </>
      )}
      {error && <span className="text-[13px] font-bold text-danger-text">{error}</span>}
    </Panel>
  )
}

function SortModal({ state, transaction, onClose }: { state: MoneyState; transaction: MoneyTransaction; onClose: () => void }) {
  const [kind, setKind] = useState<MoneyTransactionKind | null>(transaction.kind)
  const [refId, setRefId] = useState<string | null>(transaction.refId)
  const [remember, setRemember] = useState(true)
  const options = transaction.amountCents > 0 ? (['income', 'shiftPay', 'transfer', 'ignore'] as const) : (['spend', 'cost', 'saving', 'milestone', 'borrowed', 'transfer', 'ignore'] as const)
  const refs =
    kind === 'cost'
      ? state.costs.map((cost) => ({ id: cost.id, name: `${cost.name} · ${euro(cost.amountCents)}` }))
      : kind === 'income'
        ? state.incomes.filter((income) => income.kind === 'fixed').map((income) => ({ id: income.id, name: income.name }))
        : kind === 'milestone'
          ? state.milestones.map((milestone) => ({ id: milestone.id, name: `${milestone.name} · ${euro(milestone.amountCents)}` }))
          : []

  const save = async (): Promise<void> => {
    await api.money.sortTransaction(transaction.id, kind, refs.length ? refId ?? refs[0]?.id ?? null : null, remember)
    onClose()
  }

  return (
    <Modal
      open
      width={560}
      title={transaction.counterparty || 'Transactie'}
      subtitle={`${dayDate(transaction.date)} · ${euro(transaction.amountCents, { sign: true })}${transaction.description ? ` · ${transaction.description}` : ''}`}
      onClose={onClose}
      footer={
        <>
          <label className="flex items-center gap-2 text-[14px] font-semibold">
            <input type="checkbox" className="h-5 w-5 accent-[var(--color-accent)]" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Onthouden voor "{transaction.counterparty || transaction.description}"
          </label>
          <Button variant="primary" onClick={() => void save()} disabled={!kind}>
            Opslaan
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-1.5">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setKind(option)
                setRefId(null)
              }}
              className={`motion-press h-9 rounded-pill px-3.5 text-[13px] font-bold ${kind === option ? 'bg-text text-bg' : 'bg-input text-text-dim'}`}
            >
              {KIND_LABEL[option]}
            </button>
          ))}
        </div>
        {refs.length > 0 && (
          <Field label="Welke">
            <select className={input} value={refId ?? refs[0]!.id} onChange={(event) => setRefId(event.target.value)}>
              {refs.map((ref) => (
                <option key={ref.id} value={ref.id}>
                  {ref.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
    </Modal>
  )
}

function SavingsModal({ state, today, onClose }: { state: MoneyState; today: IsoDate; onClose: () => void }) {
  const existing = state.accounts.find((account) => account.role === 'spaar') ?? null
  const [iban, setIban] = useState(existing?.iban ?? '')
  const [name, setName] = useState(existing?.name ?? 'Spaarrekening reis')
  const [balance, setBalance] = useState(euroInput(potAccount(state)?.balanceCents ?? null))
  const [lockedUntil, setLockedUntil] = useState(existing?.lockedUntil ?? state.goal?.date ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const cents = parseEuro(balance)
    if (cents === null) return setError('Vul het huidige saldo in.')
    try {
      await api.money.saveManualSavings({ iban, name, balanceCents: cents, date: today, lockedUntil: lockedUntil || null })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Modal
      open
      width={560}
      title="Spaarrekening · reispot"
      subtitle="Het saldo van vandaag. Daarna houden overboekingen van en naar je betaalrekening het bij; werk het bij als er rente bij kwam."
      onClose={onClose}
      footer={
        <>
          <span />
          <Button variant="primary" onClick={() => void save()}>
            Opslaan
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label="IBAN spaarrekening">
            <input className={input} value={iban} onChange={(event) => setIban(event.target.value)} placeholder="NL.. ABNA .... .... .." />
          </Field>
        </div>
        <Field label="Naam">
          <input className={input} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Saldo vandaag">
          <input className={input} inputMode="decimal" value={balance} onChange={(event) => setBalance(event.target.value)} placeholder="€ 0,00" />
        </Field>
        <div className="col-span-2">
          <Field label="Op slot tot">
            <input className={input} type="date" value={lockedUntil} onChange={(event) => setLockedUntil(event.target.value)} />
          </Field>
        </div>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-text-dim">
        Op slot: wat er vóór die datum af gaat en geen mijlpaal is, telt als geleend van de reis. Je krijgt een melding en het komt bij de maandafsluiting terug.
      </p>
      {error && <p className="mt-3 text-[13px] font-bold text-danger-text">{error}</p>}
    </Modal>
  )
}
