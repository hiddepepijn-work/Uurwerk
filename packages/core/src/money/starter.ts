/**
 * The starting plan, filled in once from what was agreed on 29 September 2026. Every value can
 * be changed in the app afterwards; this only saves typing it all in.
 *
 * The days of the month for the fixed costs were not given and are guesses — they only decide
 * where a dot sits in the calendar and when "komt morgen" fires.
 */

import type { MoneyState, PayProfile } from '../contract/types.js'

export const ADECCO_PROFILE: PayProfile = {
  id: 'profile-adecco',
  name: 'FedEx Duiven · via Adecco',
  hourlyCents: 1569,
  kmOneWay: 8,
  kmCents: 23,
  netFactor: 0.9,
  // Found in the Adecco/FedEx Duiven vacancies: 21:00–00:00 +20%, 00:00–06:00 +30%.
  premiums: [
    { from: '21:00', to: '24:00', percent: 20 },
    { from: '00:00', to: '06:00', percent: 30 }
  ],
  // Breaks: 40 minutes in the evening shifts, 50 at night (from Hidde). Where they fall is a guess.
  templates: [
    { key: 'avond', label: 'Avond', start: '14:30', end: '23:00', breakMinutes: 40, breakAt: '18:30' },
    { key: 'laat', label: 'Laat', start: '17:30', end: '01:00', breakMinutes: 40, breakAt: '20:00' },
    { key: 'nacht', label: 'Nacht', start: '23:00', end: '07:00', breakMinutes: 50, breakAt: '03:00' }
  ]
}

export const STARTER: Omit<MoneyState, 'entries' | 'shifts' | 'closings' | 'accounts' | 'transactions' | 'rules'> = {
  phases: [
    { id: 'phase-stage', name: 'Fase 1 · stage', from: '2026-10-01', until: '2027-01-31', budgetCents: 15000, savingCents: 102000 },
    { id: 'phase-fulltime', name: 'Fase 2 · fulltime', from: '2027-02-01', until: '2027-04-06', budgetCents: 15000, savingCents: null }
  ],
  incomes: [
    { id: 'income-stage', name: 'Stagevergoeding', kind: 'fixed', amountCents: 60000, day: 25, from: null, until: '2027-01-31' },
    { id: 'income-belastingdienst', name: 'Belastingdienst', kind: 'fixed', amountCents: 12900, day: 20, from: null, until: null },
    { id: 'income-adecco-shifts', name: 'Adecco · FedEx', kind: 'shifts', amountCents: null, day: null, from: null, until: '2027-01-31' },
    { id: 'income-adecco-fulltime', name: 'Adecco · fulltime', kind: 'weekly', amountCents: 225000, day: null, from: '2027-02-01', until: '2027-04-04' },
    { id: 'income-maasarend', name: 'Maasarend', kind: 'open', amountCents: null, day: null, from: null, until: null },
    { id: 'income-ecovi', name: 'EcoVi', kind: 'open', amountCents: null, day: null, from: null, until: null }
  ],
  costs: [
    { id: 'cost-zorg', name: 'Zorgverzekering', category: 'Zorg', amountCents: 17629, day: 1, from: null, until: null },
    { id: 'cost-lenzen', name: 'Lenzen', category: 'Zorg', amountCents: 2100, day: 10, from: null, until: null },
    { id: 'cost-school', name: 'Schoolgeld', category: 'School', amountCents: 32336, day: 1, from: null, until: '2027-01-31' },
    { id: 'cost-telefoon', name: 'Telefoon', category: 'Telefoon & digitaal', amountCents: 5400, day: 22, from: null, until: null },
    { id: 'cost-vps', name: 'VPS & tokens', category: 'Telefoon & digitaal', amountCents: 2000, day: 3, from: null, until: null },
    { id: 'cost-hbo', name: 'HBO Max', category: 'Telefoon & digitaal', amountCents: 1200, day: 20, from: null, until: null },
    { id: 'cost-minecraft', name: 'Minecraft-server', category: 'Telefoon & digitaal', amountCents: 1000, day: 18, from: null, until: null },
    { id: 'cost-schade', name: 'Schadevergoeding', category: 'Overig', amountCents: 400, day: 15, from: null, until: null }
  ],
  goal: { id: 'goal-reis', name: 'Reis', onAccountCents: 540000, startCents: 0, date: '2027-04-07' },
  // €1.900 booked ahead, split as in the plan.
  milestones: [
    { id: 'milestone-vlucht', name: 'Lange vlucht', date: '2026-12-15', amountCents: 75000, paid: false },
    { id: 'milestone-azie', name: 'Vluchten Azië', date: '2027-01-31', amountCents: 55000, paid: false },
    { id: 'milestone-vaccinaties', name: 'Vaccinaties', date: '2027-02-05', amountCents: 35000, paid: false },
    { id: 'milestone-verzekering', name: 'Verzekering + e-visa', date: '2027-03-01', amountCents: 25000, paid: false }
  ],
  profile: ADECCO_PROFILE
}
