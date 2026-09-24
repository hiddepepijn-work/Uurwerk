# Planner redesign — inspection and implementation plan

Adaptive day/week planner, areas, task dependencies, plan versioning, and multi-task
tracking runs, built on the existing Uurwerk architecture. Nothing here replaces the
current structure; every change extends it.

> **Status, 6 August 2026 — this plan has been carried out.** Phases A through G are built,
> along with the mail (7) and publishing (8) phases from the original build plan, and the
> section below describing the repository is the state *before* that work. Two things
> differ from what was planned here: the `sessions` and `planned` tables were left in place
> but lost their repositories, since nothing reads them at runtime any more; and
> `main/src/morning.ts` asks about planning through a notification rather than through the
> tray. Publishing ships switched off and speaks a generic PUT/DELETE contract, so it works
> against whatever host you point it at rather than a provider baked in here.
>
> Current gates: `npm run typecheck`, `npm run lint`, `npm test` (160 tests) and
> `npm run build` all pass.

---

## 1. What the repository looked like before this work

69 TypeScript files. Phases 0–2 of the original build plan are done and running; phases 3–8
are not built.

### Schema — version 2

`packages/core/src/db/migrations/index.ts` holds two applied migrations:

| id | name | tables |
|---|---|---|
| 1 | `init` | `projects`, `tasks`, `sessions`, `planned`, `artifacts`, `reports`, `settings` |
| 2 | `day_reports` | `day_reports`, `published_files` |

Applied ids are tracked in `_migrations`. **Both have run on the live database**, so they
are frozen — all new work goes into migration 3 and up.

### The contract — 11 domains

`packages/core/src/contract/api.ts` defines `TimeTrackerAPI`:
`projects · tasks · timer · planning · stats · days · capture · reports · settings ·
publish · window`

`packages/core/src/contract/channels.ts` is the manifest both sides generate from —
`main/src/ipc.ts` registers a handler per entry, `preload/src/index.ts` builds
`window.api` from the same list. A method missing from the manifest is simply not
reachable, which is the intended loud failure.

### Tracking today — one session, one task

`packages/core/src/services/timer.ts` enforces:
- at most one open session (`sessions.ended_at IS NULL`)
- idle stop backdated to when idling began
- startup repair, capping a crash-orphaned session at 16 hours

`sessions` has a single nullable `task_id`. **This is precisely the assumption the new
model removes**, so it is the highest-risk part of the change.

### Planning today — flat and unversioned

`planned(id, task_id, date, start_min, end_min)`. No versions, no baseline, no locking, no
kinds, no fixed events. `PlanningService.plannedVsActual()` joins planned minutes against
session minutes per task.

### Screens

Built: Today (`TodayScreen` + 5 children), Tasks (`TasksScreen` + 4 children), the
end-of-day wizard (4 steps), quick-add window.
Placeholders reporting their phase: **Week, Reports, Settings**.

### Tests — 20 passing

`timer.test.ts` (12) and `aggregate.test.ts` (8). `npm run typecheck`, `npm run lint` and
`npm test` are all green; the ESLint boundary rule is verified to fire on a renderer
importing `fs`.

---

## 2. Understanding of the change

Five structural moves, in dependency order:

1. **Areas** above projects, carrying the hour-classification and sharing defaults.
   The classification is **copied onto each time segment at start**, so moving a task
   between areas later never rewrites history.
2. **Tracking runs containing time segments.** A run survives task switching; switching
   closes one segment and opens the next with no gap. Actual time is derived from
   segments only.
3. **Plans become versioned documents** (`draft → accepted → superseded`), with a baseline
   that survives revision. Reanalysis produces a *proposal*, never a mutation.
4. **A deterministic scheduler** in core — constraints first, then an explainable score.
   No opaque model in the scheduling path.
5. **Nullable estimates and due dates as first-class**, with a discovery block for
   unknown-length work instead of a fake zero.

### Where this collides with what exists

| collision | resolution |
|---|---|
| `sessions` vs `tracking_runs`/`time_segments` | Migrate every existing session into a single-segment run. `sessions` is kept read-only for one release, then dropped in a later migration. |
| `planned` vs `plans`/`plan_blocks` | Wrap existing rows into one accepted week plan per ISO week, `source = 'imported'`. |
| `projects.shareable` vs area sharing defaults | Area sets the default; the project flag stays as a per-project override. Effective share = area default AND project flag — the more private of the two wins. |
| `TimerService` API used by `ipc.ts`, `useTimer`, `DayReviewService`, `StatsService` | `TimerService` becomes a thin façade over `TrackingService` so nothing breaks mid-migration. |
| `day_reports` end-of-day wizard reads sessions | Switches to segments in Phase C; the wizard's publish gating is untouched. |

### Assumptions taken (flag if wrong)

- Existing tasks are backfilled to **Stage** — this is an internship app, that is what the
  history is.
- Existing sessions inherit `counts_as_stage_hours = 1` from that.
- "Area" is a fixed set of three at first, but stored as a table so more can be added.
- The Dutch report keeps its current shape; only the numbers it draws from change.

---

## 3. File-by-file plan

`+` new · `~` modified · `!` behaviour change worth reviewing

### Phase A — domain and migrations

```
+ core/src/db/migrations/003-planner.ts      areas, task columns, dependencies,
                                             plans, plan_blocks, tracking_runs,
                                             time_segments, proposals, profiles
+ core/src/db/migrations/004-backfill.ts     default areas; tasks -> Stage;
                                             sessions -> runs+segments;
                                             planned -> one imported accepted plan/week
~ core/src/db/migrations/index.ts            register 003 and 004
~ core/src/contract/types.ts                 Area, TaskDependency, DependencyType,
                                             PlanScope, PlanStatus, Plan, PlanBlock,
                                             BlockKind, TrackingRun, TimeSegment,
                                             PlanUpdateProposal, Availability,
                                             FixedEvent, PlanningProfile;
                                             Task gains areaId, earliestStartDate,
                                             postponedCount, blockedReason;
                                             TaskStatus gains in_progress | blocked
+ core/src/db/repositories/areas.ts
+ core/src/db/repositories/dependencies.ts   with cycle detection at write time
+ core/src/db/repositories/plans.ts          plans + plan_blocks, version chain
+ core/src/db/repositories/tracking.ts       runs + segments, adjacency guarantee
+ core/src/db/repositories/availability.ts   weekly availability + fixed events
~ core/src/db/index.ts                       add the five repositories to Store
+ core/src/db/repositories/*.test.ts         migration, backfill and repo tests
```

### Phase B — deterministic planner

```
+ core/src/services/planner/dependency-graph.ts   topological order, cycle detection,
                                                  downstream unlock value
+ core/src/services/planner/remaining-effort.ts   max(estimate - logged, 0); discovery
                                                  block for unknown estimates
+ core/src/services/planner/availability.ts       working windows minus breaks, fixed
                                                  events and unavailable periods
+ core/src/services/planner/candidate-filter.ts   drops hard-blocked, archived, done,
                                                  not-yet-startable tasks
+ core/src/services/planner/priority-score.ts     weighted, every term named
+ core/src/services/planner/explain-score.ts      score -> human sentences
+ core/src/services/planner/schedule-builder.ts   fixed -> locked -> low-slack ->
                                                  unlockers -> value -> optional -> buffer
+ core/src/services/planner/replan.ts             future blocks only, never history
+ core/src/services/planner/plan-diff.ts          two plans -> PlanUpdateProposal
+ core/src/services/planner/index.ts              PlannerService facade
+ core/src/services/planner/*.test.ts             the 21 required cases
```

### Phase C — tracking migration

```
+ core/src/services/tracking.ts        startRun, stopRun, switchTask, completeAndSwitch;
                                       segment adjacency, area classification snapshot
~ core/src/services/timer.ts        !  becomes a façade over TrackingService
~ core/src/services/stats.ts        !  totals derived from segments; stage vs other split
~ core/src/services/day-review.ts   !  reads segments
~ core/src/services/planning.ts     !  plannedVsActual uses accepted plan + segments
~ main/src/index.ts                    idle watchdog closes the segment, not the session
```

### Phase D–E — planner UI

```
~ renderer/src/features/today/*        agenda = accepted plan, timeline = segments,
                                       area badge, stage hours shown separately
+ renderer/src/features/today/DayPlanner.tsx, PlanImpactDialog.tsx
+ renderer/src/features/week/WeekScreen.tsx, WeekGrid.tsx, DayColumn.tsx,
  PlanBlock.tsx, ActualSegment.tsx, CompareOverlay.tsx, UnscheduledPanel.tsx,
  AvailabilityEditor.tsx, PlanUpdateBanner.tsx, ModeToggle.tsx
+ renderer/src/features/switcher/TaskSwitcher.tsx    Ctrl+Alt+Space
+ renderer/src/hooks/usePlanDraft.ts                 local draft + undo/redo, validated
                                                     through core, saved in one transaction
~ renderer/src/features/tasks/*                      area/dependency/blocked UI,
                                                     blank estimate and due date
```

### Phase F — startup and tray

```
+ main/src/tray.ts        icon state from tracking, quick menu
+ main/src/hotkeys.ts     start/stop, switch task, quick add, show/hide, end of day, shot
+ main/src/startup.ts  !  login item via app.setLoginItemSettings, packaged builds only
+ main/src/morning.ts     tray notification when no accepted day plan exists
~ main/src/index.ts       startup order: db -> migrations -> tray -> hotkeys ->
                          session repair -> reanalysis -> morning check
```

### Phase G — reporting

```
~ core/src/report/aggregate.ts   baseline vs current vs actual; stage vs other;
                                 unplanned and postponed work
~ core/src/report/nl.ts          Dutch strings for the new sections
~ core/src/services/snapshot.ts  stage-only by default; area gating on top of the
                                 existing project gating
```

### Contract additions (Phase A onward, per phase)

New domains `areas · tracking · planner · availability · startup`, plus new events
`planner:updateAvailable · planner:accepted · planner:riskDetected ·
tracking:segmentChanged · startup:morningPlanRequired`. Every one goes through
`contract/api.ts` **and** `contract/channels.ts` — adding to one without the other is the
one mistake this architecture will not catch for you.

---

## 4. Order and gates

A → B → C → D → E → F → G. After each phase: `npm run typecheck`, `npm run lint`,
`npm test`, `npm run dev`. A phase with a compile error or a failing test does not hand
over to the next one.

Riskiest step is **C**, because it rewires live tracking. It ships behind the façade so
`TimerService` callers keep working while the segment model takes over underneath.
