import { useState } from 'react'

import type { IsoDate, MoneyState, PayProfile } from '@core/contract/types.js'
import { addDays } from '@core/money/dates.js'
import { shiftPay, templateFor } from '@core/money/pay.js'
import { api } from '../../api/client.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { useLiveQuery } from '../../hooks/useLiveQuery.js'
import { shiftsForPayday } from './derive.js'
import { dayDate, euro, euroInput, parseEuro, shortDate } from './format.js'
import { Chip, Field, Label, Panel, Row, input } from './parts.js'

/**
 * Shifts and what they pay: the pay profile, one card per shift type with its net, the shifts
 * you planned or worked, and the Thursday pay-outs against what was predicted — which is how
 * the net factor learns.
 */
export function ShiftsTab({ state, today }: { state: MoneyState; today: IsoDate }) {
  const profile = state.profile
  const [planDate, setPlanDate] = useState(addDays(today, 1))
  const [payAmount, setPayAmount] = useState('')
  const [payDate, setPayDate] = useState(today)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { data: warnings } = useLiveQuery((client) => client.money.shiftWarnings(), ['money', 'planning'], [])
  if (!profile) return <Panel>Nog geen loonprofiel. Laad het startplan of voeg er een toe.</Panel>

  const upcomingShifts = state.shifts.filter((shift) => shift.date >= addDays(today, -28)).sort((a, b) => b.date.localeCompare(a.date))
  const payouts = state.entries.filter((entry) => entry.kind === 'shiftPay').slice(0, 8)
  const measured = measuredFactor(state, profile)

  const addPay = async (): Promise<void> => {
    const cents = parseEuro(payAmount)
    if (cents === null || cents <= 0) return setError('Vul het bedrag in dat binnenkwam.')
    setError(null)
    await api.money.addEntry({ date: payDate, kind: 'shiftPay', amountCents: cents, note: 'Adecco', category: null })
    setPayAmount('')
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-3 wide:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] wide:gap-4">
        <Panel>
          <div className="flex items-center justify-between">
            <Label>{profile.name}</Label>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Aanpassen
            </Button>
          </div>
          <div className="flex flex-col">
            <Row left="Bruto uurloon" right={<b className="tabular-nums">{euro(profile.hourlyCents)}</b>} />
            <Row left="Uitbetaling" sub="woensdag, donderdag op je rekening" right={<b>wekelijks, week later</b>} />
            <Row left="Uren indienen" sub="melding maandag 09:00" right={<Chip tone="warn">ma vóór 12:00</Chip>} />
            <Row left="Reiskosten" sub={`${profile.kmOneWay} km heen + terug × ${euro(profile.kmCents)} · onbelast`} right={<b className="text-accent-soft">+{euro(Math.round(2 * profile.kmOneWay * profile.kmCents))}</b>} />
            <Row
              left="Nettofactor"
              sub={measured ? `gemeten uit ${measured.count} uitbetalingen: ${measured.factor.toFixed(2).replace('.', ',')}` : 'leert van je uitbetalingen'}
              right={<b className="tabular-nums">{profile.netFactor.toFixed(2).replace('.', ',')}</b>}
            />
          </div>
          {measured && Math.abs(measured.factor - profile.netFactor) >= 0.01 && (
            <Button variant="secondary" onClick={() => void api.money.saveProfile({ ...profile, netFactor: Math.round(measured.factor * 100) / 100 })}>
              Nettofactor bijwerken naar {measured.factor.toFixed(2).replace('.', ',')}
            </Button>
          )}
          <span className="text-[12px] leading-relaxed text-text-dim">
            Toeslag per uur: {profile.premiums.map((premium) => `${premium.from}–${premium.to} +${premium.percent}%`).join(', ')}. Weekend: check je loonstrook.
          </span>
        </Panel>

        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label>Dienst plannen</Label>
            <input className={`${input} h-10! w-auto`} type="date" aria-label="Datum" value={planDate} onChange={(event) => setPlanDate(event.target.value)} />
          </div>
          <div className="grid grid-cols-1 gap-2 wide:grid-cols-3">
            {profile.templates.map((template) => {
              const pay = shiftPay(profile, template)
              const premiumMinutes = pay.paidMinutes - (pay.minutesByPercent[0] ?? 0)
              return (
                <button
                  key={template.key}
                  type="button"
                  onClick={() => void api.money.saveShift({ date: planDate, template: template.key, status: planDate <= today ? 'worked' : 'planned' })}
                  className="motion-press flex flex-col gap-1.5 rounded-[16px] bg-input p-3.5 text-left hover:bg-secondary-hover"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-display text-[18px] font-bold">{template.label}</span>
                    <span className="text-[16px] font-bold text-accent-soft tabular-nums">±{euro(pay.totalCents)}</span>
                  </span>
                  <span className="text-[12px] text-text-dim">
                    {template.start}–{template.end} · pauze {template.breakMinutes} min
                  </span>
                  <span className="text-[12px] text-text-dim">
                    {hours(pay.paidMinutes)} betaald · {hours(premiumMinutes)} met toeslag · bruto {euro(pay.grossCents)}
                  </span>
                  <span className="text-[12px] font-bold text-accent-soft">+ op {shortDate(planDate)}</span>
                </button>
              )
            })}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 wide:grid-cols-2 wide:gap-4">
        <Panel>
          <Label>Diensten</Label>
          {upcomingShifts.length === 0 && <span className="text-[14px] text-text-dim">Nog geen diensten. Kies hierboven een datum en een soort.</span>}
          <div className="flex flex-col">
            {upcomingShifts.map((shift) => {
              const template = templateFor(profile, shift.template)
              return (
                <Row
                  key={shift.id}
                  left={`${dayDate(shift.date)} · ${template?.label ?? shift.template}`}
                  sub={template ? `${template.start}–${template.end} · ±${euro(shiftPay(profile, template).totalCents)} · in je agenda` : 'in je agenda'}
                  right={
                    <>
                      {warnings?.includes(shift.id) && shift.date >= today && <Chip tone="bad">stage de ochtend erna</Chip>}
                      <button
                        type="button"
                        onClick={() => void api.money.saveShift({ ...shift, status: shift.status === 'worked' ? 'planned' : 'worked' })}
                        className="motion-press"
                      >
                        <Chip tone={shift.status === 'worked' ? 'good' : 'muted'}>{shift.status === 'worked' ? 'gewerkt' : 'gepland'}</Chip>
                      </button>
                      <button
                        type="button"
                        aria-label="Dienst verwijderen"
                        onClick={() => void api.money.removeShift(shift.id)}
                        className="flex h-9 w-9 items-center justify-center rounded-full text-text-faint hover:bg-input hover:text-text"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </>
                  }
                />
              )
            })}
          </div>
        </Panel>

        <Panel>
          <Label>Uitbetaling binnen</Label>
          <div className="flex gap-2">
            <input className={`${input} flex-1`} inputMode="decimal" aria-label="Bedrag" placeholder="€ 0,00" value={payAmount} onChange={(event) => setPayAmount(event.target.value)} />
            <input className={`${input} w-auto`} type="date" aria-label="Datum" value={payDate} onChange={(event) => setPayDate(event.target.value)} />
            <Button variant="primary" onClick={() => void addPay()}>
              Opslaan
            </Button>
          </div>
          {error && <p className="text-[13px] font-bold text-danger-text">{error}</p>}
          <div className="flex flex-col">
            {payouts.map((entry) => {
              const predicted = predictedFor(state, profile, entry.date)
              const close = predicted > 0 && Math.abs(entry.amountCents - predicted) <= Math.max(300, predicted * 0.03)
              return (
                <Row
                  key={entry.id}
                  left={dayDate(entry.date)}
                  sub={predicted > 0 ? `voorspeld ${euro(predicted)}` : 'geen diensten gevonden voor die week'}
                  right={
                    <>
                      <span className={`text-[15px] font-bold tabular-nums ${close ? 'text-accent-soft' : predicted > 0 ? 'text-warn' : ''}`}>{euro(entry.amountCents)}</span>
                      <button
                        type="button"
                        aria-label="Uitbetaling verwijderen"
                        onClick={() => void api.money.removeEntry(entry.id)}
                        className="flex h-9 w-9 items-center justify-center rounded-full text-text-faint hover:bg-input hover:text-text"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </>
                  }
                />
              )
            })}
          </div>
          <span className="text-[12px] text-text-dim">Een donderdag betaalt de diensten van de week ervoor (ma–zo). Uurwerk zet elke maandag een taak "Uren indienen" klaar.</span>
        </Panel>
      </div>

      {editing && <ProfileModal profile={profile} onClose={() => setEditing(false)} />}
    </>
  )
}

function hours(minutes: number): string {
  return `${Math.floor(minutes / 60)}u${String(minutes % 60).padStart(2, '0')}`
}

function predictedFor(state: MoneyState, profile: PayProfile, payday: IsoDate): number {
  return shiftsForPayday(state, payday).reduce((sum, shift) => {
    const template = templateFor(profile, shift.template)
    return sum + (template ? shiftPay(profile, template).totalCents : 0)
  }, 0)
}

/** Net over gross from pay-outs whose shifts are known: (paid − travel) / gross. */
function measuredFactor(state: MoneyState, profile: PayProfile): { factor: number; count: number } | null {
  let net = 0
  let gross = 0
  let count = 0
  for (const entry of state.entries) {
    if (entry.kind !== 'shiftPay') continue
    const shifts = shiftsForPayday(state, entry.date)
    if (shifts.length === 0) continue
    let entryGross = 0
    let travel = 0
    for (const shift of shifts) {
      const template = templateFor(profile, shift.template)
      if (!template) continue
      const pay = shiftPay(profile, template)
      entryGross += pay.grossCents
      travel += pay.travelCents
    }
    if (entryGross === 0) continue
    net += entry.amountCents - travel
    gross += entryGross
    count += 1
  }
  return count > 0 && gross > 0 ? { factor: net / gross, count } : null
}

function ProfileModal({ profile, onClose }: { profile: PayProfile; onClose: () => void }) {
  const [hourly, setHourly] = useState(euroInput(profile.hourlyCents))
  const [km, setKm] = useState(String(profile.kmOneWay))
  const [kmRate, setKmRate] = useState(euroInput(profile.kmCents))
  const [factor, setFactor] = useState(String(profile.netFactor).replace('.', ','))
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const hourlyCents = parseEuro(hourly)
    const kmCents = parseEuro(kmRate)
    const netFactor = Number(factor.replace(',', '.'))
    if (hourlyCents === null || kmCents === null || !Number.isFinite(netFactor)) return setError('Controleer de bedragen.')
    try {
      await api.money.saveProfile({ ...profile, hourlyCents, kmOneWay: Number(km), kmCents, netFactor })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Modal open width={520} title="Loonprofiel" subtitle={profile.name} onClose={onClose} footer={<><span /><Button variant="primary" onClick={() => void save()}>Opslaan</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Bruto uurloon">
          <input className={input} inputMode="decimal" value={hourly} onChange={(event) => setHourly(event.target.value)} />
        </Field>
        <Field label="Nettofactor">
          <input className={input} inputMode="decimal" value={factor} onChange={(event) => setFactor(event.target.value)} />
        </Field>
        <Field label="Km enkele reis">
          <input className={input} type="number" min={0} value={km} onChange={(event) => setKm(event.target.value)} />
        </Field>
        <Field label="Vergoeding per km">
          <input className={input} inputMode="decimal" value={kmRate} onChange={(event) => setKmRate(event.target.value)} />
        </Field>
      </div>
      {error && <p className="mt-3 text-[13px] font-bold text-danger-text">{error}</p>}
    </Modal>
  )
}
