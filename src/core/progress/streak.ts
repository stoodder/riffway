/**
 * Weekly streak (docs/progress.md § Streaks, learning research row 15). Forgiving by design:
 * automatic freezes, a grace repair, silent misses and no "streak lost" state — the record only
 * holds numbers to show (current and best side by side). Pure; evaluated lazily on app open and
 * after each run.
 *
 * Rules, per ISO week (local time):
 * - A **practice day** has ≥ {@link PRACTICE_DAY_SEC} s of active play. A week is **met** when it has
 *   ≥ `weekTarget` practice days; the streak (`current`) counts consecutive met weeks.
 * - Every {@link WEEKS_PER_FREEZE} met weeks earn a freeze (hold at most {@link MAX_FREEZES}).
 * - A missed week while a streak is running uses a freeze automatically (streak kept, not extended).
 * - Without a freeze the week becomes `repairWeek` and the streak is held, not reset: the next week
 *   repairs it with `weekTarget + 2` practice days (it then counts as met). Meeting only the target
 *   restarts the streak at 1; missing again ends it (0). Nothing is ever announced.
 * - The current week is finalised early as soon as it is met (or repaired), so the player sees it
 *   count immediately; otherwise it is evaluated once it is over.
 * @module
 */
import type { PracticeDay, StreakState } from '@shared/storage';
import { isoWeek, isoWeekAt, nextIsoWeek, previousIsoWeek } from './dates';

/** A practice day needs at least this much active play (s). */
export const PRACTICE_DAY_SEC = 300;
/** Met weeks per earned freeze. */
export const WEEKS_PER_FREEZE = 2;
/** Most freezes held at once. */
export const MAX_FREEZES = 2;
/** Extra practice days (above the target) that repair a missed week. */
export const GRACE_EXTRA_DAYS = 2;
/** Allowed weekly targets. */
export const WEEK_TARGET_MIN = 2;
export const WEEK_TARGET_MAX = 7;

/** A fresh streak record. */
export function initialStreak(weekTarget: number): StreakState {
  return {
    weekTarget: clampTarget(weekTarget),
    current: 0,
    best: 0,
    freezes: 0,
    weeksTowardFreeze: 0,
    lastEvaluatedWeek: null,
  };
}

function clampTarget(t: number): number {
  return Math.min(WEEK_TARGET_MAX, Math.max(WEEK_TARGET_MIN, Math.round(t)));
}

/** Practice days per ISO week. */
function practiceDaysPerWeek(days: readonly PracticeDay[]): Map<string, number> {
  const perWeek = new Map<string, number>();
  for (const d of days) {
    if (d.activeSec < PRACTICE_DAY_SEC) continue;
    const w = isoWeek(d.date);
    perWeek.set(w, (perWeek.get(w) ?? 0) + 1);
  }
  return perWeek;
}

/** Apply one finished (or finalised) week to the state. Mutates `s`. */
function applyWeek(s: StreakState, week: string, practiceDays: number): void {
  const repairing = s.repairWeek !== undefined && s.repairWeek === previousIsoWeek(week);
  delete s.repairWeek;
  if (repairing && practiceDays >= s.weekTarget + GRACE_EXTRA_DAYS) {
    met(s, s.current + 1);
  } else if (practiceDays >= s.weekTarget) {
    met(s, repairing ? 1 : s.current + 1);
  } else if (repairing) {
    s.current = 0; // second miss in a row: the held streak ends (silently)
  } else if (s.current > 0) {
    if (s.freezes > 0) s.freezes -= 1;
    else s.repairWeek = week;
  }
  s.lastEvaluatedWeek = week;
}

function met(s: StreakState, current: number): void {
  s.current = current;
  s.best = Math.max(s.best, current);
  s.weeksTowardFreeze += 1;
  if (s.weeksTowardFreeze >= WEEKS_PER_FREEZE) {
    s.weeksTowardFreeze = 0;
    s.freezes = Math.min(MAX_FREEZES, s.freezes + 1);
  }
}

/**
 * Lazily evaluate the weekly streak up to `now`: every week after `prev.lastEvaluatedWeek` that has
 * ended is applied in order (freeze earn/apply, grace repair), then the current week if it is
 * already met. Idempotent: evaluating again with the same input returns an equal state.
 * `weekTarget` (clamped to 2–7) applies to the weeks evaluated by this call.
 */
export function evaluateStreak(prev: StreakState | null, days: readonly PracticeDay[], now: number, weekTarget: number): StreakState {
  const s: StreakState = prev ? { ...prev } : initialStreak(weekTarget);
  s.weekTarget = clampTarget(weekTarget);
  const perWeek = practiceDaysPerWeek(days);
  const currentWeek = isoWeekAt(now);

  let week: string | null = s.lastEvaluatedWeek ? nextIsoWeek(s.lastEvaluatedWeek) : firstWeek(days);
  if (week === null) return s;
  for (; week < currentWeek; week = nextIsoWeek(week)) applyWeek(s, week, perWeek.get(week) ?? 0);

  if (week === currentWeek) {
    const count = perWeek.get(week) ?? 0;
    const repairing = s.repairWeek !== undefined && s.repairWeek === previousIsoWeek(week);
    const needed = s.weekTarget + (repairing ? GRACE_EXTRA_DAYS : 0);
    if (count >= needed) applyWeek(s, week, count);
  }
  return s;
}

/** ISO week of the earliest recorded day, or null without any day. */
function firstWeek(days: readonly PracticeDay[]): string | null {
  let first: string | null = null;
  for (const d of days) if (first === null || d.date < first) first = d.date;
  return first === null ? null : isoWeek(first);
}
