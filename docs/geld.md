# Geld — bouwplan

Module voor persoonlijke financiën in Uurwerk: vaste lasten, €150 budget per maand, reispot
(€5.400 op de rekening bij vertrek op 7 april 2027, €7.300 in totaal), fases (stage t/m januari,
fulltime februari–april), Adecco-diensten met toeslagen, Extra-rekening en maandafsluiting.
Ontwerp: https://claude.ai/artifact/DfCwRJ1bqMEqh9d2ZTEc1d

## Uitgangspunten

- **Lokaal en privé.** Alle tabellen beginnen met `_geld_`: de rij-sync slaat underscore-tabellen
  over, dus niets gaat leesbaar naar de VPS. Begeleider en docent zien het nooit, Jarvis ook niet.
- **Geen migratie.** Elke sync-ronde vergelijkt de schemaversie (MAX `_migrations.id`) tussen
  apparaat en server. Een migratie zou laptop en telefoon laten weigeren tot server en iPhone-app
  bijgewerkt zijn. De tabellen worden daarom met `CREATE TABLE IF NOT EXISTS` aangemaakt bij het
  openen (`money/schema.ts`). Ze horen niet bij het gedeelde schema, dus dat mag.
- **Koppel-snapshot zonder geld.** Koppelen met "upload" stuurt het hele DB-bestand; daaruit
  worden de `_geld_`-tabellen gewist (secure_delete) vóór het versturen.
- **Rekenen in centen**, pure functies in `core/src/money`, getest met de echte bedragen.
- Code Engels, alles wat je ziet Nederlands.

## Stappen

- **A (gebouwd):** tabellen, rekenkern, repository, API, schermen laptop + telefoon, plek in de navigatie,
  startplan met je eigen cijfers.
- **B (gebouwd):** versleutelde sync tussen laptop en telefoon. Elke rij als eigen record, AES-GCM,
  opgeslagen onder een HMAC van tabel+id; sleutel via PBKDF2 uit een wachtwoordzin. De server
  bewaart alleen die records in `geld-vault.json` (niet in de database) en seint de andere apparaten
  live. Triggers vullen `_geld_outbox`; laatste wijziging wint per rij.
- **C:** meldingen: maandafsluiting (1e, 09:00), uren indienen (ma 09:00), Adecco-loon (do).
- **D:** ABN AMRO-import (CAMT.053/CSV) met herkenregels.

## Scriptkaart (stap A)

| Bestand | Wat |
|---|---|
| `core/src/money/schema.ts` | `ensureMoneySchema(db)`: de `_geld_*`-tabellen, idempotent |
| `core/src/money/dates.ts` | maanden, dagen, donderdagen, "actief op datum" |
| `core/src/money/pay.ts` (+test) | loon per dienst: toeslagvensters per minuut, pauze, netto, reiskosten |
| `core/src/money/plan.ts` (+test) | fase per maand, maandplan, nodig uit diensten, weekloon met vertraging |
| `core/src/money/projection.ts` (+test) | reispot tot vertrek: gespaard, in de pot, mijlpalen, Extra |
| `core/src/money/status.ts` (+test) | budgetstand, reisstand, voorstel maandafsluiting |
| `core/src/money/starter.ts` | startplan met je eigen vaste lasten, inkomens, fases, doel, loonprofiel |
| `core/src/db/repositories/money.ts` (+test) | `MoneyRepo`: lezen/opslaan/verwijderen, afsluiten, startplan; test dat niets gesynct wordt |
| `core/src/db/index.ts` | `money: MoneyRepo` in de store |
| `core/src/contract/types.ts` | Geld-DTO's |
| `core/src/contract/api.ts`, `channels.ts`, `events.ts` | domein `money`, refetch-domein `money` |
| `backend/src/implementation.ts` | dunne laag naar `store.money` |
| `backend/src/sync-client.ts` | geld-tabellen uit de upload-snapshot |
| `renderer/src/ui/icons.tsx` | `WalletIcon` |
| `renderer/src/app/IconRail.tsx` | item Geld onder een scheidingslijn, vóór Instellingen |
| `renderer/src/app/BottomBar.tsx` | Geld als brede tegel bovenaan in Meer |
| `renderer/src/app/App.tsx` | scherm `money` |
| `renderer/src/features/money/*` | `MoneyScreen` (tabs), `Overview`, `Trip`, `Costs`, `Budget`, `PlanPage`, `ShiftsPage`, `ClosingPage`, `SetupPage`, `format.ts` |
| `renderer/src/features/today/TodayScreen.tsx` | Geld-kaartje |

## Scriptkaart (stap B)

| Bestand | Wat |
|---|---|
| `core/src/money/vault.ts` (+test) | sleutel uit wachtwoordzin, seal/unseal, `MoneyVault`: setup, push, pull, wie-wint |
| `core/src/money/schema.ts` | `_geld_outbox`, `_geld_sync_state` en de triggers die elke wijziging in de outbox zetten |
| `server/app/geld-vault.ts` (+test) | de kluis op de server: genummerde versleutelde records, zout eenmalig |
| `server/app/index.ts` | `GET/POST /api/geld/vault`, live-sein; `money` uitgesloten van `/api/rpc` |
| `backend/src/sync-client.ts`, `mobile/src/sync.ts` | Geld-ronde na elke sync-ronde; sleutel in DPAPI (laptop) / Preferences (telefoon) |
| `backend/src/host.ts`, `main/src/host.ts`, `mobile/src/main.tsx` | `moneyVault` op de host; `geldKey` als geheim |
| `backend/src/announce.ts` | `_geld_*` → scherm Geld ververst |
| `renderer/src/features/money/VaultModal.tsx` | wachtwoordzin invoeren, status, sleutel vergeten |

## Bank (stap D, gebouwd): ABN AMRO via Enable Banking

- Alleen lezen (PSD2 AIS, "restricted mode", gratis voor eigen rekeningen). Sleutel (.pem),
  Application ID en sessie in DPAPI op de laptop; nooit in de database of op de server.
- ABN AMRO deelt via PSD2 alleen de betaalrekening. De spaarrekening (reispot) wordt met de hand
  toegevoegd (IBAN + saldo op een datum) en bijgehouden uit de overboekingen op de betaalrekening.
- Ophalen: laptop, hooguit om de 6 uur op de achtergrond (PSD2: 4× per dag), elke 5 min als Geld open is.
  Transacties gaan via de versleutelde kluis naar de telefoon.
- Indelen (`core/src/money/bank/classify.ts`): regels → eigen rekeningen (sparen / mijlpaal / geleend)
  → Adecco → vaste inkomens → vaste lasten → vlucht-betaling → kleine uitgaven = budget → rest nakijken.
- Slot op de spaarrekening: opname vóór de datum die geen mijlpaal is = "geleend", melding, en bij de
  maandafsluiting bovenop de inleg terug.
- Terugkeeradres: `https://uurwerk.duckdns.org/geld/bank` (server/src/geld-pages.js), plus /geld/privacy
  en /geld/voorwaarden.

| Bestand | Wat |
|---|---|
| `core/src/money/bank/enable.ts` | API-client, JWT RS256 met WebCrypto |
| `core/src/money/bank/map.ts` | bankformaat → centen, stabiele id's, saldo kiezen |
| `core/src/money/bank/classify.ts` (+`bank.test.ts`) | indelen |
| `backend/src/bank.ts` | `BankLink`: verbinden, afronden, ophalen, meldingen |
| `renderer/src/features/money/BankTab.tsx` | koppelen, spaarrekening, nakijken, regels |

## Koppeling met agenda en taken (`core/src/money/link.ts`, +test)

- Dienst in Geld ↔ afspraak "FedEx · Nacht" (organisatie `organization-fedex`, gebied werk, 12 min reis
  heen en terug). Verplaatsen/verwijderen werkt beide kanten op; een FedEx-afspraak uit de agenda wordt
  een dienst `agenda-<eventId>`.
- Mijlpaal → taak "<naam> (reis)" met deadline, afgevinkt zodra betaald. Afsluiting → taak "Geld: <maand>
  afsluiten". Week met diensten → taak "Uren indienen Adecco" op maandag.
- Nooit bedragen in agenda of taken (die gaan leesbaar naar server en iCloud). Markering "geld:…" in
  beschrijving/notitie; dubbelen van twee apparaten worden opgeruimd.
- Waarschuwing "stage de ochtend erna": nachtdienst die eindigt op een dag met stage vóór 12:00
  (beschikbaarheid in Instellingen).
