import type { IsoDate } from '../../contract/types.js'
import { Db } from '../connection.js'

/**
 * Minutes the machine was awake, per local day.
 *
 * Deliberately an accumulator rather than a log of intervals: every reader wants a day
 * total, and a counter cannot be left half-open by a crash the way an interval can.
 */
export class ScreenTimeRepo {
  constructor(private readonly db: Db) {}

  /** Adds minutes to a day. Fractions are kept by the caller, not lost here. */
  add(date: IsoDate, minutes: number): void {
    if (minutes <= 0) return
    this.db.run(
      `INSERT INTO device_awake (date, awake_min, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         awake_min = awake_min + excluded.awake_min,
         updated_at = excluded.updated_at`,
      [date, Math.round(minutes), Date.now()]
    )
  }

  forDay(date: IsoDate): number {
    return (
      this.db.get<{ awake_min: number }>('SELECT awake_min FROM device_awake WHERE date = ?', [
        date
      ])?.awake_min ?? 0
    )
  }

  /** Day totals across a range, as a map so callers can bucket them however they like. */
  between(from: IsoDate, to: IsoDate): Map<IsoDate, number> {
    const rows = this.db.all<{ date: string; awake_min: number }>(
      'SELECT date, awake_min FROM device_awake WHERE date BETWEEN ? AND ? ORDER BY date',
      [from, to]
    )
    return new Map(rows.map((row) => [row.date, row.awake_min]))
  }

  /** True once anything has been recorded — the screen says "no data yet" rather than "0". */
  hasAny(): boolean {
    return (this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device_awake')?.n ?? 0) > 0
  }
}
