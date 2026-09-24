/**
 * ★ SECURITY-CRITICAL ★
 *
 * What one reader is allowed to see, assembled from what the app uploaded.
 *
 * The desktop app already decided what may leave the machine, and it prepared each day
 * twice: once under the supervisor's consent, once under the teacher's. The two land in
 * `index-supervisor.json` and `index-teacher.json`, and this file is what makes sure the
 * two never cross.
 *
 * That matters most for the images. Every uploaded file has an unguessable name, but "hard
 * to guess" is not an access rule — so `/bestand/…` is not served from disk directly.
 * A name is served only when it appears in *this reader's* index, or in one of the day
 * payloads that index points at. Anything else is a 404, whether it exists or not.
 *
 * The listing is cached for a few seconds and dropped outright whenever an upload arrives,
 * so a published day shows up immediately and a withdrawn one disappears just as fast.
 */

const INDEX_FILES = {
  supervisor: 'index-supervisor.json',
  teacher: 'index-teacher.json'
}

/**
 * The name the app used before it published per audience.
 *
 * Kept as a fallback for the supervisor only, because that is whose rules those payloads
 * were built under. Giving them to the teacher would hand out a view they never consented
 * to, on the strength of a filename.
 */
const LEGACY_INDEX = 'index.json'

const SNAPSHOT = 'snapshot.json'
const CACHE_MS = 5_000

export class Library {
  constructor(blobs) {
    this.blobs = blobs
    this.cache = new Map()
  }

  /** Called after every upload or delete: the next read rebuilds from disk. */
  invalidate() {
    this.cache.clear()
  }

  async view(role) {
    const cached = this.cache.get(role)
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value

    const value = await this.build(role)
    this.cache.set(role, { at: Date.now(), value })
    return value
  }

  async build(role) {
    const file = INDEX_FILES[role]
    let index = file ? await this.blobs.readJson(file) : null
    if (!index && role === 'supervisor') index = await this.blobs.readJson(LEGACY_INDEX)

    const entries = Array.isArray(index?.days) ? index.days : []
    const days = []
    /** Every name this reader may fetch. The index payloads, and the files they name. */
    const allowed = new Set()

    for (const entry of entries) {
      if (typeof entry?.payload !== 'string' || typeof entry?.date !== 'string') continue

      const payload = await this.blobs.readJson(entry.payload)
      if (!payload) continue

      allowed.add(entry.payload)
      for (const shot of payload.screenshots ?? []) {
        if (typeof shot === 'string') allowed.add(shot)
      }
      if (typeof payload.timelapse === 'string') allowed.add(payload.timelapse)

      days.push({ ...payload, date: entry.date, payloadName: entry.payload })
    }

    days.sort((a, b) => (a.date < b.date ? 1 : -1))
    return { days, allowed }
  }

  async days(role) {
    return (await this.view(role)).days
  }

  async day(role, date) {
    return (await this.view(role)).days.find((day) => day.date === date) ?? null
  }

  /** The gate in front of every file request. Default deny. */
  async mayRead(role, name) {
    return (await this.view(role)).allowed.has(name)
  }

  /**
   * Takes one day off the server by hand.
   *
   * The normal way to withdraw a day is Ontpubliceren in the app: it deletes the files and
   * clears the consent stamp, which is the record of what is online. This is the other
   * route — the one you want from a phone, when the laptop is not there and something is
   * online that should not be.
   *
   * It removes the day from both indexes, deletes both payloads, and deletes the images the
   * day pointed at unless another day still points at them. The app's own ledger does not
   * know this happened, so its next Ontpubliceren for that day deletes names that are
   * already gone — which this server answers with "fine, it is gone" rather than an error.
   */
  async withdraw(date) {
    const names = new Set()
    const keep = new Set()

    for (const role of Object.keys(INDEX_FILES)) {
      const file = INDEX_FILES[role]
      const index = (await this.blobs.readJson(file)) ?? { updatedAt: Date.now(), days: [] }
      const days = Array.isArray(index.days) ? index.days : []

      for (const entry of days) {
        if (typeof entry?.payload !== 'string') continue
        const payload = await this.blobs.readJson(entry.payload)
        const referenced = [
          entry.payload,
          ...(payload?.screenshots ?? []),
          ...(payload?.timelapse ? [payload.timelapse] : [])
        ].filter((name) => typeof name === 'string')

        // A file belongs to the day being withdrawn, or it is spoken for by another day.
        for (const name of referenced) (entry.date === date ? names : keep).add(name)
      }

      const remaining = days.filter((entry) => entry?.date !== date)
      if (remaining.length !== days.length) {
        await this.blobs.put(
          file,
          Buffer.from(JSON.stringify({ updatedAt: Date.now(), days: remaining }), 'utf8')
        )
      }
    }

    let removed = 0
    for (const name of names) {
      if (keep.has(name)) continue
      await this.blobs.remove(name)
      removed += 1
    }

    this.invalidate()
    return removed
  }

  /** Both listings side by side, for the admin overview. */
  async overview() {
    const rows = new Map()

    for (const role of Object.keys(INDEX_FILES)) {
      for (const day of await this.days(role)) {
        const row = rows.get(day.date) ?? { date: day.date, roles: [], files: 0 }
        row.roles.push(role)
        row.files = Math.max(row.files, (day.screenshots?.length ?? 0) + (day.timelapse ? 1 : 0))
        row.trackedMin = row.trackedMin ?? day.trackedMin
        rows.set(day.date, row)
      }
    }

    return [...rows.values()].sort((a, b) => (a.date < b.date ? 1 : -1))
  }

  /**
   * The live card, for the supervisor and nobody else.
   *
   * It is built in the app against the supervisor's sharing rules — a task the teacher may
   * not see by name is not masked in it. Until there is a snapshot per audience, the honest
   * thing is to show it to the audience it was written for.
   */
  async snapshot(role) {
    if (role !== 'supervisor') return null
    return this.blobs.readJson(SNAPSHOT)
  }
}
