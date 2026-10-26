# Stage-uren, schooluren, weekend

De werkdag heeft sinds deze wijziging twee grenzen in plaats van één.

**Werkvenster** (`availability.start_min` / `end_min`) — wanneer je überhaupt wilt werken.
In een drukke veertien dagen is dat 09:00–22:00.

**Stage-venster** (`availability.stage_start_min` / `stage_end_min`) — welk deel daarvan van
de stage is. Standaard maandag t/m vrijdag 09:00–17:30, zaterdag en zondag leeg (tot 26 okt 2026 was het
18:00; migratie 022 zette rijen die nog op 18:00 stonden op 17:30).

De planner behandelt dat onderscheid als een harde regel, niet als voorkeur:

| Taak in gebied | Mag alleen in |
| --- | --- |
| Stage (`countsAsStageHours`) | het stage-venster |
| School, persoonlijk, betaald werk | álles buiten het stage-venster |

Vul je dus 09:00–22:00 in, dan komt stage-werk tussen 9 en 6, en school- en privéwerk
ervoor of erna. Een dag zonder stage-venster (zaterdag) krijgt nooit stage-werk, maar wel
ander werk.

Dat werkt door in de deadline-rekensom: uren waar een taak niet mag staan tellen niet mee
als ruimte voor die taak. Een stage-klus die alleen haalbaar is door 's avonds door te
werken geeft nu een tekort te zien in plaats van een plan dat niemand draait.

## Pauze

Eén vaste pauze: 12:30–13:00, maandag t/m vrijdag, als terugkerende afspraak
(`recurring_commitments`, migratie 016). De planner plant eromheen, net als om een
vergadering.

Tussen blokken zit verder niets meer. De planner wrikte er vroeger vijftien minuten achter
elk blok, wat een dag veranderde in een zigzag van werk en niets. Blokken die elkaar
opvolgen sluiten nu aan.

## Twee blokken per stagedag

Stagewerk wordt niet meer in stukken van anderhalf uur gesneden. Een stagedag heeft twee
blokken: de ochtend 09:00–12:30 en de middag 13:00–17:30. De planner geeft elk blok in
z'n geheel aan één taak (`takeWhole` in `range.ts`, idem in `schedule-builder.ts`). Een
taak van een uur krijgt dus de hele ochtend; een taak van tien uur krijgt ochtend + middag
+ de ochtend erna. Een afspraak midden in de ochtend is een muur: de stukken ervoor en
erna worden dan elk één blok (mits ≥ 25 min). Werk buiten de stage-uren (school, privé)
wordt nog wel in focusblokken van 90 min gesneden.

## Weekend

Zaterdag en zondag zijn echte capaciteit, maar worden als laatste gevuld. De planner loopt
elk gat twee keer langs: eerst de werkweek, dan pas het weekend. Werk dat doordeweeks past,
staat doordeweeks; een weekenddag wordt gepakt als een deadline dat écht vraagt.

## Waar het staat

| Bestand | Wat |
| --- | --- |
| `packages/core/src/db/migrations/016-stage-window.ts` | kolommen, standaardweek, lunchafspraak |
| `packages/core/src/domain/stage-hours.ts` | de standaard 09:00–17:30, één keer |
| `packages/core/src/services/planner/availability.ts` | knipt vrije gaten op de stage-grens, labelt ze `stage` / `reserve` |
| `packages/core/src/services/planner/schedule-builder.ts` | dagplanner: gat moet bij de taak passen |
| `packages/core/src/services/planner/range.ts` | weekplanner: idem, plus weekend-als-laatste |
| `packages/renderer/src/features/week/RangePlanner.tsx` | de regel "Stage 09:00–18:00" onder elke dag |

Aanpassen doe je in het venster **Werkuren** in de weekplanner: per dag of in je normale
week, met het vinkje **Stage** eronder. Uitgevinkt = die dag geen stage-uren.
