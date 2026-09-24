/**
 * Screenshot retention.
 *
 * Core decides *what* should go; the main process does the actual unlinking. That split
 * keeps this file filesystem-free, which is what lets core be reused outside Electron.
 *
 * Frames are deleted after RETENTION_DAYS. Timelapses and generated reports are kept:
 * they are small, and they are the artefacts you may need months later.
 */

import type { Artifact, IsoDate } from '../contract/types.js'
import type { Store } from '../db/index.js'
import { addDays, toIsoDate } from '../util/time.js'

export const RETENTION_DAYS = 14

export class RetentionService {
  constructor(private readonly store: Store) {}

  /** The cutoff day; anything strictly older is expired. */
  cutoff(now = Date.now()): IsoDate {
    return toIsoDate(addDays(now, -RETENTION_DAYS))
  }

  /** Expired screenshots, oldest first. Rows are still in the database at this point. */
  expired(now = Date.now()): Artifact[] {
    return this.store.artifacts.screenshotsOlderThan(this.cutoff(now))
  }

  /** Called by the main process once the file is gone from disk. */
  forget(ids: string[]): void {
    this.store.db.transaction(() => {
      for (const id of ids) this.store.artifacts.remove(id)
    })
  }
}
