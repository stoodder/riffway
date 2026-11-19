/**
 * Local-calendar helpers for progress (docs/progress.md): local days `'YYYY-MM-DD'`, ISO weeks
 * `'YYYY-Www'` in local time, and the next-day check time.
 *
 * All arithmetic goes through local `Date` fields at noon, never through fixed 24 h steps in
 * milliseconds, so daylight-saving transitions (23 h / 25 h days) cannot shift a day or a week.
 * @module
 */

/** One day in ms (only for "last 24 h" windows, never for calendar steps). */
export const DAY_MS = 86_400_000;

/** Hour of the next local day at which a next-day check becomes due. */
export const NEXT_DAY_CHECK_HOUR = 4;

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Format a local `Date` as `'YYYY-MM-DD'`. */
function formatDate(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse `'YYYY-MM-DD'` to a local `Date` at noon (DST-safe anchor). */
function parseDate(date: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`Invalid local date "${date}" (expected YYYY-MM-DD)`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

/** Local calendar day `'YYYY-MM-DD'` for an epoch-ms timestamp. */
export function localDate(at: number): string {
  return formatDate(new Date(at));
}

/** `date` shifted by `days` calendar days (negative allowed). */
export function addDays(date: string, days: number): string {
  const d = parseDate(date);
  return formatDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12));
}

/** Monday (ISO day 1) of the week containing `date`. */
export function mondayOf(date: string): string {
  const d = parseDate(date);
  const isoDay = (d.getDay() + 6) % 7; // Monday = 0 … Sunday = 6
  return addDays(date, -isoDay);
}

/**
 * ISO 8601 week key `'YYYY-Www'` of a local day. The ISO year can differ from the calendar year
 * around New Year (2026-12-31 is `2026-W53`, 2027-01-01 is `2026-W53` too).
 */
export function isoWeek(date: string): string {
  const thursday = parseDate(addDays(mondayOf(date), 3));
  const isoYear = thursday.getFullYear();
  const firstThursday = parseDate(addDays(mondayOf(formatDate(new Date(isoYear, 0, 4, 12))), 3));
  // Both anchors are local noon; rounding absorbs a DST hour between them.
  const days = Math.round((thursday.getTime() - firstThursday.getTime()) / DAY_MS);
  return `${pad(isoYear, 4)}-W${pad(days / 7 + 1)}`;
}

/** ISO week key of an epoch-ms timestamp (local time). */
export function isoWeekAt(at: number): string {
  return isoWeek(localDate(at));
}

/** Monday `'YYYY-MM-DD'` of an ISO week key `'YYYY-Www'`. */
export function mondayOfIsoWeek(week: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new RangeError(`Invalid ISO week "${week}" (expected YYYY-Www)`);
  const week1Monday = mondayOf(formatDate(new Date(Number(m[1]), 0, 4, 12)));
  return addDays(week1Monday, (Number(m[2]) - 1) * 7);
}

/** The ISO week after `week`. */
export function nextIsoWeek(week: string): string {
  return isoWeek(addDays(mondayOfIsoWeek(week), 7));
}

/** The ISO week before `week`. */
export function previousIsoWeek(week: string): string {
  return isoWeek(addDays(mondayOfIsoWeek(week), -7));
}

/** When a next-day check becomes due: the next local day at 04:00 (epoch ms). */
export function nextDayCheckAt(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, NEXT_DAY_CHECK_HOUR).getTime();
}
