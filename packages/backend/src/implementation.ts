/**
 * ★ The backend implementation of TimeTrackerAPI. ★
 *
 * One object with a method per channel in core/contract/channels.ts. The laptop exposes it
 * over Electron IPC (packages/main/src/ipc.ts); the server exposes the same object over
 * HTTP. Nothing in here knows which: everything machine-specific goes through host().
 *
 * This file is deliberately thin: it validates, calls a core service, and returns plain
 * data. Domain rules live in core.
 */

import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  CalendarSyncResult,
  DayProposalDto,
  RangeProposalDto,
  TimeTrackerAPI
} from '@core/contract/api.js'
import type { DayPlan, IsoDate, IsoWeek, PublishAudience, Settings } from '@core/contract/types.js'
import { newId } from '@core/db/connection.js'
import type { Store } from '@core/db/index.js'
import { buildIndex } from '@core/services/publish.js'
import { reasons, type DayProposal, type RangeProposal } from '@core/services/planner/index.js'
import { buildReportDocument, packDocument, reportFileName } from '@core/report/docx.js'
import { prefillSummary } from '@core/report/summary.js'
import { dayRange, fromIsoDate, toIsoDate, toIsoWeek, weekRange } from '@core/util/time.js'

import {
  connectIcloud,
  connectIcs,
  disconnectAccount,
  ensureUurwerkCalendar,
  syncAccount
} from './calendar/index.js'
import { pushPlan } from './calendar/push.js'
import type { Backend } from './create.js'
import { emitEvent, host, type SecretKey } from './host.js'
import { log } from './log.js'
import { sendWeekReport } from './mailer.js'
import {
  INDEX_NAMES,
  SNAPSHOT_NAME,
  deleteRemote,
  isConfigured,
  uploadFile,
  uploadJson
} from './publisher.js'


export type Implementation = {
  [D in keyof TimeTrackerAPI]: {
    [M in keyof TimeTrackerAPI[D]]: TimeTrackerAPI[D][M]
  }
}

export function buildImplementation(
  backend: Backend,
  onSettingsChanged?: (settings: Settings) => void
): Implementation {
  const {
    store,
    stats,
    attribution,
    breakdown,
    statistics,
    calendar,
    planning,
    planEdit,
    publishService,
    snapshot,
    reports,
    days,
    trackingService,
    planner,
    projectOverview
  } = backend

  return {
    areas: {
      list: async (includeArchived) => store.areas.list(includeArchived ?? false),
      create: async (area) => store.areas.create(area),
      update: async (id, patch) => {
        const updated = store.areas.update(id, patch)
        emitEvent('data:invalidated', { domain: 'settings' })
        return updated
      },
      archive: async (id) => {
        store.areas.archive(id)
        emitEvent('data:invalidated', { domain: 'settings' })
      }
    },

    organizations: {
      list: async (includeArchived) => store.organizations.list(includeArchived ?? false),
      create: async (organization) => {
        const created = store.organizations.create(organization)
        emitEvent('data:invalidated', { domain: 'settings' })
        return created
      },
      update: async (id, patch) => {
        const updated = store.organizations.update(id, patch)
        emitEvent('data:invalidated', { domain: 'settings' })
        return updated
      },
      archive: async (id) => {
        store.organizations.archive(id)
        emitEvent('data:invalidated', { domain: 'settings' })
      }
    },

    workTypes: {
      list: async (includeArchived) => store.workTypes.list(includeArchived ?? false),
      create: async (workType) => {
        const created = store.workTypes.create(workType)
        emitEvent('data:invalidated', { domain: 'settings' })
        return created
      },
      archive: async (id) => {
        store.workTypes.archive(id)
        emitEvent('data:invalidated', { domain: 'settings' })
      }
    },

    breakdown: {
      day: async (date, filter) => breakdown.day(date, filter),
      week: async (week, filter) => breakdown.week(week, filter),
      range: async (startMs, endMs, filter) => breakdown.range(startMs, endMs, filter)
    },

    attribution: {
      day: async (date) => attribution.day(date),
      /**
       * One call replaces the day's whole division.
       *
       * The service reverts the previous split before applying the new one, so the sheet
       * can send what it shows rather than a diff — and correcting yesterday's guess is the
       * same gesture as making it.
       */
      apply: async (date, shares) => {
        const result = attribution.apply(date, shares)
        emitEvent('data:invalidated', { domain: 'sessions' })
        emitEvent('data:invalidated', { domain: 'tasks' })
        return result
      },
      revert: async (date) => {
        const result = attribution.revert(date)
        emitEvent('data:invalidated', { domain: 'sessions' })
        return result
      },

      stretch: async (id) => attribution.stretch(id),
      addStretch: async (input) => {
        const created = attribution.addStretch(input)
        emitEvent('data:invalidated', { domain: 'sessions' })
        emitEvent('data:invalidated', { domain: 'tasks' })
        return created
      },
      updateStretch: async (id, input) => {
        const updated = attribution.updateStretch(id, input)
        emitEvent('data:invalidated', { domain: 'sessions' })
        emitEvent('data:invalidated', { domain: 'tasks' })
        return updated
      },
      removeStretch: async (id) => {
        attribution.removeStretch(id)
        emitEvent('data:invalidated', { domain: 'sessions' })
      }
    },

    statistics: {
      overview: async (range, filter) => statistics.overview(range, filter)
    },

    projects: {
      list: async () => store.projects.list(),
      create: async (project) => store.projects.create(project),
      update: async (id, patch) => store.projects.update(id, patch),
      setShareable: async (id, shareable) => {
        store.projects.setShareable(id, shareable)
        emitEvent('data:invalidated', { domain: 'settings' })
      },
      overview: async (projectId) => projectOverview.overview(projectId, toIsoDate(Date.now()))
    },

    tasks: {
      list: async (filter) => store.tasks.list(filter),
      get: async (id) => store.tasks.get(id),
      create: async (task) => {
        // Quick-add and the switcher create tasks without an area. Falling back to the
        // configured default keeps those hours countable instead of silently unclassified.
        const created = store.tasks.create({
          ...task,
          areaId: task.areaId ?? store.settings.get().defaultAreaId
        })
        emitEvent('data:invalidated', { domain: 'tasks' })
        return created
      },
      update: async (id, patch) => {
        const updated = store.tasks.update(id, patch)
        emitEvent('data:invalidated', { domain: 'tasks' })
        return updated
      },
      complete: async (id, done) => {
        const updated = store.tasks.complete(id, done)
        emitEvent('data:invalidated', { domain: 'tasks' })
        return updated
      },
      remove: async (id) => {
        store.tasks.remove(id)
        emitEvent('data:invalidated', { domain: 'tasks' })
      }
    },

    dependencies: {
      list: async () => store.dependencies.allDetailed(),
      forTask: async (taskId) => store.dependencies.forTask(taskId),
      set: async (taskId, list) => {
        // Cycle rejection lives in the repository and throws; the handler lets it through
        // so the editor can show which chain it would have created.
        store.dependencies.setForTask(taskId, list)
        emitEvent('data:invalidated', { domain: 'tasks' })
        emitEvent('data:invalidated', { domain: 'planning' })
        return store.dependencies.forTask(taskId)
      },
      remove: async (taskId, dependsOnTaskId) => {
        store.dependencies.remove(taskId, dependsOnTaskId)
        emitEvent('data:invalidated', { domain: 'tasks' })
        emitEvent('data:invalidated', { domain: 'planning' })
      }
    },

    tracking: {
      startRun: async (taskId) => trackingService.startRun(taskId),
      stopRun: async (note) => trackingService.stopRun(Date.now(), note),
      switchTask: async (taskId) => trackingService.switchTask(taskId),
      completeAndSwitch: async (nextTaskId) => {
        const outcome = trackingService.completeAndSwitch(nextTaskId)
        emitEvent('data:invalidated', { domain: 'tasks' })
        return outcome
      },
      blockAndSwitch: async (reason, nextTaskId) => {
        const outcome = trackingService.blockAndSwitch(reason, nextTaskId)
        emitEvent('data:invalidated', { domain: 'tasks' })
        return outcome
      },
      currentRun: async () => trackingService.currentRun(),
      currentSegment: async () => trackingService.currentSegment(),
      segmentsByDay: async (date: IsoDate) => {
        const { startMs, endMs } = dayRange(date)
        return store.tracking.segmentsInRange(startMs, endMs)
      },
      segmentsByWeek: async (week: IsoWeek) => {
        const { startMs, endMs } = weekRange(week)
        return store.tracking.segmentsInRange(startMs, endMs)
      },
      totals: async (week: IsoWeek) => {
        const { startMs, endMs } = weekRange(week)
        return stats.totals(startMs, endMs)
      },
      updateSegment: async (id, patch) => {
        const segment = trackingService.editSegment(id, patch)
        emitEvent('data:invalidated', { domain: 'sessions' })
        return segment
      },
      removeSegment: async (id) => {
        trackingService.removeSegment(id)
        emitEvent('data:invalidated', { domain: 'sessions' })
      }
    },

    planning: {
      week: async (week) => planning.week(week),
      unscheduled: async (week) => planning.unscheduled(week),
      plannedVsActual: async (week) => planning.plannedVsActual(week)
    },

    stats: {
      day: async (date) => stats.day(date),
      week: async (week) => stats.week(week),
      timeline: async (date) => stats.timeline(date)
    },

    days: {
      review: async (date) => days.review(date),
      get: async (date) => days.get(date),
      saveSummary: async (date, summary) => {
        const day = days.saveSummary(date, summary)
        emitEvent('data:invalidated', { domain: 'reports' })
        return day
      },
      saveFlags: async (date, flags) => days.saveFlags(date, flags),
      /**
       * Upload first, stamp second.
       *
       * The consent stamp is what the rest of the app treats as "this is visible to someone
       * else", so it must never be set for a day whose upload failed half way — that would
       * claim more exposure than exists, and Unpublish would then have nothing to revoke.
       */
      publish: async (date) => {
        if (!publishService.hasAnythingToPublish(date)) {
          throw new Error('Nothing is selected to publish. Tick at least one category first.')
        }

        // Republishing replaces: the previous copies come down before the new ones go up,
        // so a frame you have since unticked cannot survive at its old URL.
        await revokePublished(backend, date)

        // Prepared twice, because the two readers do not have the same consent: a project
        // the supervisor may see by name can be masked for the teacher, and the other way
        // round. The images are the same set and are uploaded once, from the supervisor's
        // preparation; approval of a frame is not per audience.
        const forSupervisor = publishService.prepare(date, 'supervisor')
        const forTeacher = publishService.prepare(date, 'teacher')

        for (const file of forSupervisor.files) {
          await uploadFile(backend, file.path, file.remoteName)
        }
        await uploadJson(backend, forSupervisor.payloadName, forSupervisor.payload)
        await uploadJson(backend, forTeacher.payloadName, {
          ...forTeacher.payload,
          // The teacher's payload points at the frames that were actually uploaded.
          ...(forSupervisor.payload.screenshots
            ? { screenshots: forSupervisor.payload.screenshots }
            : {}),
          ...(forSupervisor.payload.timelapse
            ? { timelapse: forSupervisor.payload.timelapse }
            : {})
        })

        const day = days.markPublished(date)
        for (const [audience, prepared] of [
          ['supervisor', forSupervisor],
          ['teacher', forTeacher]
        ] as Array<[PublishAudience, typeof forSupervisor]>) {
          store.published.record({
            id: newId(),
            artifactId: null,
            day: date,
            remoteName: prepared.payloadName,
            audience
          })
        }
        for (const file of forSupervisor.files) {
          store.published.record({
            id: newId(),
            artifactId: file.artifactId,
            day: date,
            remoteName: file.remoteName,
            audience: null
          })
        }

        await refreshIndex(backend)
        log.info('Day published.', { date, files: forSupervisor.files.length })
        emitEvent('data:invalidated', { domain: 'reports' })
        return day
      },

      unpublish: async (date) => {
        // Remote copies go first. Clearing the stamp while a file is still online would
        // leave the app claiming a day is private when it is not.
        await revokePublished(backend, date)
        const day = days.unpublish(date)
        if (isConfigured(backend)) await refreshIndex(backend)

        log.info('Day unpublished; remote copies revoked.', { date })
        emitEvent('data:invalidated', { domain: 'reports' })
        return day
      }
    },

    plans: {
      day: async (date: IsoDate) => readDayPlan(store, date, 'accepted'),
      week: async (week: IsoWeek) => planning.weekBlocks(week),
      draft: async (date: IsoDate) => {
        // Reopening an existing draft rather than stacking a new one each time the
        // planner is opened; otherwise every visit leaves an abandoned version behind.
        const existing = store.plans.draft('day', date)
        if (existing) return readDayPlan(store, date, 'draft')

        const draft = store.plans.createDraft({
          scope: 'day',
          periodKey: date,
          reason: 'Manual day plan'
        })
        const accepted = store.plans.accepted('day', date)
        if (accepted) store.plans.copyBlocks(accepted.id, draft.id)

        emitEvent('data:invalidated', { domain: 'planning' })
        return readDayPlan(store, date, 'draft')
      },
      pending: async () => store.plans.pendingDrafts(),
      accept: async (planId) => {
        const plan = store.plans.accept(planId)
        emitEvent('data:invalidated', { domain: 'planning' })
        return plan
      },
      acceptMany: async (planIds) => {
        // One transaction: promoting half a fortnight and failing is worse than promoting
        // none of it, because there is no way to tell from the result which half took.
        const accepted = store.db.transaction(() => {
          let count = 0
          for (const planId of planIds) {
            store.plans.accept(planId)
            count += 1
          }
          return count
        })
        emitEvent('data:invalidated', { domain: 'planning' })
        return accepted
      },
      discard: async (planId) => {
        store.plans.discardDraft(planId)
        emitEvent('data:invalidated', { domain: 'planning' })
      },
      clearDay: async (date: IsoDate) => {
        store.plans.clearPeriod('day', date)
        emitEvent('data:invalidated', { domain: 'planning' })
      },
      discardMany: async (planIds) => {
        // One transaction, same reasoning as acceptMany: deleting half a selection and
        // failing leaves the user unable to tell which half went.
        const discarded = store.db.transaction(() => {
          let count = 0
          for (const planId of planIds) {
            store.plans.discardDraft(planId)
            count += 1
          }
          return count
        })
        emitEvent('data:invalidated', { domain: 'planning' })
        return discarded
      },
      addBlock: async (planId, block) => {
        const created = store.plans.addBlock(planId, block)
        emitEvent('data:invalidated', { domain: 'planning' })
        return created
      },
      updateBlock: async (id, patch) => {
        // Through the service, not the repository: moving a block to a later day has to
        // raise the task's postponed count, which is what stops work drifting unnoticed.
        const updated = planEdit.updateBlock(id, patch)
        emitEvent('data:invalidated', { domain: 'planning' })
        emitEvent('data:invalidated', { domain: 'tasks' })
        return updated
      },
      removeBlock: async (id) => {
        store.plans.removeBlock(id)
        emitEvent('data:invalidated', { domain: 'planning' })
      }
    },

    planner: {
      proposeDay: async (date: IsoDate, options) => toProposalDto(planner.proposeDay(date, options)),
      fillDraft: async (planId, date: IsoDate, options) => {
        applyProposal(store, planId, planner.proposeDay(date, options))
        emitEvent('data:invalidated', { domain: 'planning' })
        return readDayPlan(store, date, 'draft')
      },
      replanRest: async (planId, date: IsoDate, fromMin: number) => {
        // Only the part of the day that has not happened yet is rewritten.
        applyProposal(store, planId, planner.replanRestOfDay(date, fromMin), fromMin)
        emitEvent('data:invalidated', { domain: 'planning' })
        return readDayPlan(store, date, 'draft')
      },

      proposeRange: async (from: IsoDate, to: IsoDate, options) =>
        toRangeDto(planner.proposeRange(from, to, options)),

      applyRange: async (from: IsoDate, to: IsoDate, options) => {
        const proposal = planner.applyRange(from, to, options)
        emitEvent('data:invalidated', { domain: 'planning' })
        return toRangeDto(proposal)
      }
    },

    calendar: {
      accounts: async () => store.calendar.accounts(),

      connectIcs: async (url, label) => {
        const { accountId, outcome } = await connectIcs(backend, url, label)
        emitEvent('data:invalidated', { domain: 'planning' })
        emitEvent('data:invalidated', { domain: 'settings' })
        return {
          accountId,
          accountName: store.calendar.account(accountId)?.displayName ?? 'Calendar',
          ...outcome,
          error: null
        }
      },

      connectIcloud: async (appleId, appPassword) => {
        const { accountId, outcome } = await connectIcloud(backend, appleId, appPassword)
        emitEvent('data:invalidated', { domain: 'planning' })
        emitEvent('data:invalidated', { domain: 'settings' })
        return {
          accountId,
          accountName: store.calendar.account(accountId)?.displayName ?? 'iCloud',
          ...outcome,
          error: null
        }
      },

      pushPlan: async (from: IsoDate, to: IsoDate) => {
        const account = store.calendar.accounts().find((entry) => entry.provider === 'icloud')
        if (!account) {
          throw new Error('Connect iCloud first — a subscribed link cannot be written to.')
        }

        // Created on first use rather than at connect time: connecting should not silently
        // make things in your iCloud.
        const calendarId = await ensureUurwerkCalendar(backend, account.id)

        const days: IsoDate[] = []
        for (
          let cursor = fromIsoDate(from).getTime();
          cursor <= fromIsoDate(to).getTime();
          cursor = new Date(cursor + 86_400_000).getTime()
        ) {
          days.push(toIsoDate(cursor))
        }

        const outcome = await pushPlan(backend, account.id, calendarId, days)
        emitEvent('data:invalidated', { domain: 'planning' })
        return {
          calendarName: store.calendar.calendar(calendarId)?.name ?? 'Uurwerk',
          ...outcome
        }
      },

      disconnect: async (accountId) => {
        await disconnectAccount(backend, accountId)
        emitEvent('data:invalidated', { domain: 'planning' })
        emitEvent('data:invalidated', { domain: 'settings' })
      },

      syncNow: async (accountId) => {
        const accounts = accountId
          ? [store.calendar.account(accountId)].filter((account) => account !== null)
          : store.calendar.accounts()

        const results: CalendarSyncResult[] = []
        for (const account of accounts) {
          try {
            const outcome = await syncAccount(backend, account.id)
            results.push({
              accountId: account.id,
              accountName: account.displayName,
              ...outcome,
              error: null
            })
          } catch (error) {
            // Reported per account: one broken subscription must not hide the others.
            results.push({
              accountId: account.id,
              accountName: account.displayName,
              imported: 0,
              updated: 0,
              cancelled: 0,
              autoClassified: 0,
              pending: 0,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        }

        emitEvent('data:invalidated', { domain: 'planning' })
        // A rescheduled appointment drags its registered hours to the new time.
        emitEvent('data:invalidated', { domain: 'sessions' })
        return results
      },

      calendars: async (accountId) => store.calendar.calendars(accountId),
      updateCalendar: async (id, patch) => {
        const updated = store.calendar.updateCalendar(id, patch)
        // Defaults change what future events are classified as, so the pending list is stale.
        emitEvent('data:invalidated', { domain: 'planning' })
        return updated
      },

      eventsInRange: async (startMs, endMs) => calendar.eventsInRange(startMs, endMs),
      pending: async () => {
        const settings = store.settings.get()
        return calendar.pending(settings.calendarClassification, settings.calendarAskBelow)
      },
      suggest: async (eventId) => calendar.suggestFor(eventId),

      classify: async (eventId, choice) => {
        const classified = calendar.applyClassification(eventId, choice)
        emitEvent('data:invalidated', { domain: 'planning' })
        // Classifying an event can register hours, so every hours reader is now stale too.
        emitEvent('data:invalidated', { domain: 'sessions' })
        return classified
      },
      ignore: async (eventId) => {
        const ignored = calendar.ignore(eventId)
        emitEvent('data:invalidated', { domain: 'planning' })
        // Unfiling withdraws whatever hours it had registered.
        emitEvent('data:invalidated', { domain: 'sessions' })
        return ignored
      },
      move: async (eventId, startsAt, endsAt) => {
        const moved = calendar.moveEvent(eventId, startsAt, endsAt)
        emitEvent('data:invalidated', { domain: 'planning' })
        // Its registered hours moved with it.
        emitEvent('data:invalidated', { domain: 'sessions' })
        return moved
      },
      createEvent: async (event) => {
        const created = store.calendar.createEvent(event)
        emitEvent('data:invalidated', { domain: 'planning' })
        return created
      },

      rules: async () => store.calendarRules.list(),
      forgetRule: async (id) => {
        store.calendarRules.forget(id)
        emitEvent('data:invalidated', { domain: 'settings' })
      }
    },

    commitments: {
      list: async (includeArchived) => store.commitments.list(includeArchived ?? false),
      create: async (commitment) => {
        const created = store.commitments.create(commitment)
        emitEvent('data:invalidated', { domain: 'planning' })
        return created
      },
      update: async (id, patch) => {
        const updated = store.commitments.update(id, patch)
        emitEvent('data:invalidated', { domain: 'planning' })
        return updated
      },
      end: async (id, lastDay) => {
        const ended = store.commitments.end(id, lastDay)
        emitEvent('data:invalidated', { domain: 'planning' })
        return ended
      },
      archive: async (id) => {
        store.commitments.archive(id)
        emitEvent('data:invalidated', { domain: 'planning' })
      }
    },

    availability: {
      forWeek: async (week) => store.availability.forWeek(week),
      save: async (entry) => {
        const saved = store.availability.upsert(entry)
        emitEvent('data:invalidated', { domain: 'planning' })
        return saved
      },
      events: async (from, to) => store.availability.eventsBetween(from, to),
      addEvent: async (event) => {
        const created = store.availability.addEvent(event)
        emitEvent('data:invalidated', { domain: 'planning' })
        return created
      },
      removeEvent: async (id) => {
        store.availability.removeEvent(id)
        emitEvent('data:invalidated', { domain: 'planning' })
      }
    },

    capture: {
      markNow: async () => host().capture.markNow(),
      listByDay: async (date, kind) => store.artifacts.listByDay(date, kind),
      listByWeek: async (week) => {
        const { from, to } = weekRange(week)
        return store.artifacts.listBetween(from, to)
      },
      setIncluded: async (id, included) => {
        store.artifacts.setIncluded(id, included)
        emitEvent('data:invalidated', { domain: 'artifacts' })
      },
      approveDay: async (date, included) => {
        const touched = store.artifacts.setIncludedForDay(date, 'screenshot', included)
        emitEvent('data:invalidated', { domain: 'artifacts' })
        return touched
      },
      remove: async (id) => {
        // The row goes either way; a file that cannot be deleted must not leave a row
        // pointing at it, or the frame reappears as a broken tile forever.
        const artifact = store.artifacts.get(id)
        if (artifact) {
          try {
            unlinkSync(artifact.path)
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'ENOENT') log.warn('Could not delete a frame from disk.', { id, code })
          }
        }
        store.artifacts.remove(id)
        emitEvent('data:invalidated', { domain: 'artifacts' })
      },
      buildTimelapse: async (date) => host().capture.buildTimelapse(date)
    },

    reports: {
      build: async (week) => {
        const report = reports.build(week)
        // First visit to a week gets a draft summary rather than an empty box.
        if (!report.summary.trim()) {
          const draft = prefillSummary(report, week)
          store.reports.saveSummary(week, draft)
          return { ...report, summary: draft }
        }
        return report
      },
      saveSummary: async (week, summary) => {
        store.reports.saveSummary(week, summary)
        emitEvent('data:invalidated', { domain: 'reports' })
      },
      generateDocx: async (week) => {
        const report = reports.build(week)
        // The approval gate: only included frames are even read from disk.
        const images = await loadIncludedImages(report.screenshots)
        const document = buildReportDocument(report, week, images)
        const buffer = await packDocument(document)

        const directory = host().reportDir(store.settings.get().reportOutputDir)
        const path = join(directory, reportFileName(week))
        writeFileSync(path, buffer)

        store.reports.markGenerated(week, path)
        log.info('Weekly report generated.', { week, path })
        emitEvent('report:generated', { week, docxPath: path })
        return path
      },
      send: async (week) => {
        const outcome = await sendWeekReport(backend, week)
        // Only smtp mode stamps sent_at, so only smtp mode changes what the screen shows.
        if (outcome.sent) emitEvent('data:invalidated', { domain: 'reports' })
        return outcome
      },
      openFile: async (path) => {
        await host().openPath(path)
      }
    },

    settings: {
      get: async () => store.settings.get(),
      update: async (patch) => {
        const settings = store.settings.update(patch)
        emitEvent('data:invalidated', { domain: 'settings' })
        // Rebinding a hotkey in the UI has to reach globalShortcut, or the new
        // combination is stored and silently does nothing.
        if (patch.hotkeys) onSettingsChanged?.(settings)
        return settings
      },
      setSecret: async (key, value) => host().secrets.set(key as SecretKey, value),
      hasSecret: async (key) => host().secrets.has(key as SecretKey)
    },

    publish: {
      preview: async () => snapshot.build(),
      // The live status payload: text and numbers, stage hours only, masked names. It
      // overwrites the same remote name every time, because it is a status, not a record.
      now: async () => {
        await uploadJson(backend, SNAPSHOT_NAME, snapshot.build())
        log.info('Published the live status snapshot.')
      }
    },

    startup: {
      getLoginItemStatus: async () => host().startup.getLoginItemStatus(),
      setAutoLaunch: async (enabled) => {
        store.settings.update({ autoLaunch: enabled })
        emitEvent('data:invalidated', { domain: 'settings' })
        return host().startup.setAutoLaunch(enabled)
      }
    },

    // Only a machine with a window has anything to hide or quit.
    window: {
      minimizeToTray: async () => host().window.minimizeToTray(),
      closeQuickAdd: async () => host().window.closeQuickAdd(),
      quit: async () => host().window.quit()
    }
  }
}

/**
 * Takes down everything ever uploaded for a day and forgets the ledger rows.
 *
 * Safe to call for a day that was never published: with an empty ledger there is nothing to
 * delete, so an unconfigured publisher is not an obstacle to clearing a local stamp.
 */
async function revokePublished(backend: Backend, date: IsoDate): Promise<void> {
  const existing = backend.store.published.listByDay(date)
  if (existing.length === 0) return

  await deleteRemote(
    backend,
    existing.map((file) => file.remoteName)
  )
  backend.store.published.forget(date)
}

/**
 * Rewrites the index the supervisor's page reads.
 *
 * Built from the days that are still stamped, so revoking a day removes it from the listing
 * in the same operation that deletes its files — an index pointing at a payload that is
 * gone is how a "revoked" day keeps showing up as a broken entry.
 */
async function refreshIndex(backend: Backend): Promise<void> {
  const store = backend.store
  const published = store.days.listPublishedBetween('0000-01-01', '9999-12-31')

  for (const audience of ['supervisor', 'teacher'] as PublishAudience[]) {
    const entries: Array<{ date: IsoDate; payload: string }> = []

    for (const day of published) {
      // The payload rows are the ones with no artifact behind them, one per audience. A day
      // published before audiences existed has only the supervisor's, which is what it was.
      const payload = store.published
        .listByDay(day.date)
        .find((file) => file.artifactId === null && file.audience === audience)
      if (payload) entries.push({ date: day.date, payload: payload.remoteName })
    }

    await uploadJson(backend, INDEX_NAMES[audience], buildIndex(entries))
  }
}

/** The range proposal, flattened: the shortfalls are the part the UI has to act on. */
function toRangeDto(proposal: RangeProposal): RangeProposalDto {
  return {
    from: proposal.from,
    to: proposal.to,
    blocks: proposal.blocks,
    shortfalls: proposal.shortfalls,
    unplaced: proposal.unplaced,
    plannedMin: proposal.plannedMin,
    availableMin: proposal.availableMin,
    days: [...new Set(proposal.blocks.map((block) => block.date))].sort()
  }
}

/** Flattens a proposal for the bridge: plain data only, no service objects. */
function toProposalDto(proposal: DayProposal): DayProposalDto {
  return {
    date: proposal.date,
    blocks: proposal.blocks,
    unplaced: proposal.unplaced,
    excluded: proposal.excluded.map((entry) => ({
      taskId: entry.task.id,
      taskTitle: entry.task.title,
      reason: entry.reason,
      explanation: entry.explanation
    })),
    ranked: proposal.ranked.map((entry) => ({
      taskId: entry.task.id,
      taskTitle: entry.task.title,
      score: entry.score,
      reasons: reasons(entry),
      atRisk: entry.atRisk
    })),
    plannedMin: proposal.plannedMin,
    bufferMin: proposal.bufferMin,
    availableMin: proposal.availableMin
  }
}

/**
 * Writes a proposal into a draft.
 *
 * Only planner-placed blocks are replaced: anything you added or moved by hand, locked,
 * or that is a fixed event stays exactly where it is. Accepting a proposal must never
 * quietly undo a decision you already made.
 */
function applyProposal(
  store: Store,
  planId: string,
  proposal: DayProposal,
  fromMin?: number
): void {
  store.db.transaction(() => {
    for (const block of store.plans.blocks(planId)) {
      const isPlanners = block.source === 'planner' && !block.locked && !block.fixed
      const isFuture = fromMin === undefined || block.startMin >= fromMin
      if (isPlanners && isFuture) store.plans.removeBlock(block.id)
    }

    for (const block of proposal.blocks) {
      store.plans.addBlock(planId, block)
    }
  })
}

/**
 * Assembles everything a planning screen needs for one day in a single call: the plan,
 * its blocks, the working window for that weekday, and the fixed events on it.
 */
function readDayPlan(store: Store, date: IsoDate, which: 'accepted' | 'draft'): DayPlan {
  const plan =
    which === 'draft' ? store.plans.draft('day', date) : store.plans.accepted('day', date)

  const week = toIsoWeek(fromIsoDate(date))
  // Date.getDay() is 0=Sunday; availability rows are 1=Monday..7=Sunday.
  const weekday = ((fromIsoDate(date).getDay() + 6) % 7) + 1

  return {
    date,
    plan,
    blocks: plan ? store.plans.blocks(plan.id) : [],
    availability: store.availability.forWeek(week).find((row) => row.weekday === weekday) ?? null,
    events: store.availability.eventsOn(date)
  }
}

/** Reads image bytes for approved screenshots only. Excluded frames are never opened. */
async function loadIncludedImages(
  screenshots: { id: string; path: string; included: boolean }[]
): Promise<Map<string, Uint8Array>> {
  const { readFile } = await import('node:fs/promises')
  const images = new Map<string, Uint8Array>()

  for (const shot of screenshots) {
    if (!shot.included) continue
    try {
      images.set(shot.id, new Uint8Array(await readFile(shot.path)))
    } catch (error) {
      log.warn('Approved screenshot could not be read; skipping it.', { path: shot.path, error })
    }
  }
  return images
}


/** Used by the scheduler and the tray, which need the current week key too. */
export const currentWeek = (): IsoWeek => toIsoWeek(Date.now())
