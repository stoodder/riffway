// Weeks are local; Europe/Berlin has DST changes on 2026-03-29 and 2026-10-25.
process.env.TZ = 'Europe/Berlin';

import { describe, expect, it } from 'vitest';
import type { PracticeDay, StreakState } from '@shared/storage';
import {
  addDays,
  evaluateStreak,
  isoWeek,
  localDate,
  MAX_FREEZES,
  mondayOfIsoWeek,
  nextDayCheckAt,
  nextIsoWeek,
  previousIsoWeek,
} from '@core/progress';

const noon = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 12).getTime();
};

/** `count` practice days (10 min each) starting on `monday`. */
const week = (monday: string, count: number): PracticeDay[] =>
  Array.from({ length: count }, (_, i) => ({ date: addDays(monday, i), activeSec: 600, runs: 3 }));

/** Practice-day counts for consecutive weeks starting on Monday `first`. */
const weeks = (first: string, counts: number[]): PracticeDay[] => counts.flatMap((n, i) => week(addDays(first, 7 * i), n));

const MON = '2026-10-05'; // ISO week 2026-W41

describe('local dates and ISO weeks', () => {
  it('runs in Europe/Berlin (DST-sensitive zone)', () => {
    expect(new Date(2026, 9, 24, 12).getTimezoneOffset()).toBe(-120);
    expect(new Date(2026, 9, 26, 12).getTimezoneOffset()).toBe(-60);
  });

  it('formats local days', () => {
    expect(localDate(new Date(2026, 10, 19, 23, 59).getTime())).toBe('2026-11-19');
    expect(localDate(new Date(2026, 10, 20, 0, 1).getTime())).toBe('2026-11-20');
  });

  it('handles the year boundary (2026 has 53 ISO weeks)', () => {
    expect(isoWeek('2026-12-28')).toBe('2026-W53');
    expect(isoWeek('2027-01-03')).toBe('2026-W53');
    expect(isoWeek('2027-01-04')).toBe('2027-W01');
    expect(isoWeek('2024-12-30')).toBe('2025-W01');
    expect(isoWeek('2026-01-01')).toBe('2026-W01');
    expect(nextIsoWeek('2026-W53')).toBe('2027-W01');
    expect(previousIsoWeek('2027-W01')).toBe('2026-W53');
    expect(nextIsoWeek('2025-W52')).toBe('2026-W01');
    expect(mondayOfIsoWeek('2027-W01')).toBe('2027-01-04');
  });

  it('is DST-safe: 23 h and 25 h days do not shift days or weeks', () => {
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(isoWeek('2026-10-25')).toBe('2026-W43');
    expect(isoWeek('2026-10-26')).toBe('2026-W44');
    expect(nextIsoWeek('2026-W43')).toBe('2026-W44');
    expect(nextIsoWeek('2026-W13')).toBe('2026-W14');
    const checkAt = new Date(nextDayCheckAt(new Date(2026, 9, 24, 22).getTime()));
    expect([checkAt.getDate(), checkAt.getHours()]).toEqual([25, 4]);
    const spring = new Date(nextDayCheckAt(new Date(2026, 2, 28, 23, 30).getTime()));
    expect([spring.getDate(), spring.getHours()]).toEqual([29, 4]);
  });
});

describe('evaluateStreak', () => {
  it('counts consecutive met weeks and earns a freeze per 2 weeks', () => {
    const s = evaluateStreak(null, weeks(MON, [4, 5, 4]), noon(addDays(MON, 21)), 4);
    expect(s).toMatchObject({ current: 3, best: 3, freezes: 1, weeksTowardFreeze: 1, lastEvaluatedWeek: '2026-W43' });
  });

  it('only counts days with at least 5 minutes of active play', () => {
    const days = week(MON, 4).map((d, i) => (i === 0 ? { ...d, activeSec: 299 } : d));
    expect(evaluateStreak(null, days, noon(addDays(MON, 7)), 4).current).toBe(0);
  });

  it('finalises the current week as soon as it is met, and is idempotent', () => {
    const days = weeks(MON, [4, 4]);
    const now = noon(addDays(MON, 7 + 3)); // Thursday of week 2, already 4 days
    const s = evaluateStreak(null, days, now, 4);
    expect(s).toMatchObject({ current: 2, lastEvaluatedWeek: '2026-W42' });
    expect(evaluateStreak(s, days, now, 4)).toEqual(s);
    expect(evaluateStreak(s, days, noon(addDays(MON, 13)), 4)).toEqual(s);
  });

  it('does not end a running streak while the current week is still open', () => {
    const s = evaluateStreak(null, weeks(MON, [4, 1]), noon(addDays(MON, 9)), 4);
    expect(s).toMatchObject({ current: 1, lastEvaluatedWeek: '2026-W41' });
  });

  it('applies a held freeze automatically to a missed week (streak kept, not extended)', () => {
    const s = evaluateStreak(null, weeks(MON, [4, 4, 1, 4]), noon(addDays(MON, 28)), 4);
    expect(s).toMatchObject({ current: 3, best: 3, freezes: 0, weeksTowardFreeze: 1 });
    expect(s.repairWeek).toBeUndefined();
  });

  it(`holds at most ${MAX_FREEZES} freezes`, () => {
    const s = evaluateStreak(null, weeks(MON, [4, 4, 4, 4, 4, 4]), noon(addDays(MON, 42)), 4);
    expect(s).toMatchObject({ current: 6, freezes: MAX_FREEZES, weeksTowardFreeze: 0 });
  });

  it('grace: a missed week without a freeze is repaired by 2 extra practice days the next week', () => {
    const held = evaluateStreak(null, weeks(MON, [4, 0]), noon(addDays(MON, 15)), 4);
    expect(held).toMatchObject({ current: 1, repairWeek: '2026-W42', freezes: 0 });

    const repaired = evaluateStreak(held, weeks(MON, [4, 0, 6]), noon(addDays(MON, 21)), 4);
    expect(repaired).toMatchObject({ current: 2, best: 2 });
    expect(repaired.repairWeek).toBeUndefined();
  });

  it('grace: the repair week is finalised early once it has target + 2 days, not at target', () => {
    const atTarget = evaluateStreak(null, weeks(MON, [4, 0, 4]), noon(addDays(MON, 18)), 4);
    expect(atTarget).toMatchObject({ current: 1, repairWeek: '2026-W42', lastEvaluatedWeek: '2026-W42' });
    const atSix = evaluateStreak(null, weeks(MON, [4, 0, 6]), noon(addDays(MON, 20)), 4);
    expect(atSix).toMatchObject({ current: 2, lastEvaluatedWeek: '2026-W43' });
  });

  it('grace not used: meeting only the target restarts at 1; missing again ends the streak silently', () => {
    expect(evaluateStreak(null, weeks(MON, [4, 4, 4, 0, 0, 4]), noon(addDays(MON, 42)), 4)).toMatchObject({
      current: 1,
      best: 3,
      freezes: 1, // used on week 4; re-earned by the 2nd met week since the last earn
    });
    const restart = evaluateStreak(null, weeks(MON, [4, 0, 4]), noon(addDays(MON, 21)), 4);
    expect(restart).toMatchObject({ current: 1, best: 1 });
    const ended = evaluateStreak(null, weeks(MON, [4, 0, 0]), noon(addDays(MON, 21)), 4);
    expect(ended).toMatchObject({ current: 0, best: 1 });
    expect(ended.repairWeek).toBeUndefined();
    expect(Object.keys(ended).sort()).toEqual(['best', 'current', 'freezes', 'lastEvaluatedWeek', 'weekTarget', 'weeksTowardFreeze']);
  });

  it('a missed week with no running streak uses nothing', () => {
    const s = evaluateStreak(null, [...week(MON, 1), ...week(addDays(MON, 14), 4)], noon(addDays(MON, 21)), 4);
    expect(s).toMatchObject({ current: 1, freezes: 0 });
    expect(s.repairWeek).toBeUndefined();
  });

  it('evaluates lazily across a long gap in one call', () => {
    const s = evaluateStreak(null, weeks(MON, [4, 4, 4, 4]), noon(addDays(MON, 7 * 20)), 4);
    expect(s).toMatchObject({ current: 0, best: 4, freezes: 0, lastEvaluatedWeek: isoWeek(addDays(MON, 7 * 19)) });
  });

  it('crosses the year boundary', () => {
    const s = evaluateStreak(null, weeks('2026-12-21', [4, 4, 4]), noon('2027-01-11'), 4);
    expect(s).toMatchObject({ current: 3, lastEvaluatedWeek: '2027-W01' });
  });

  it('crosses DST changes (25 h and 23 h weeks)', () => {
    const autumn = weeks('2026-10-19', [7, 7]);
    expect(evaluateStreak(null, autumn, noon('2026-11-02'), 7)).toMatchObject({ current: 2, lastEvaluatedWeek: '2026-W44' });
    const spring = weeks('2026-03-23', [7, 7]);
    expect(evaluateStreak(null, spring, noon('2026-04-06'), 7)).toMatchObject({ current: 2, lastEvaluatedWeek: '2026-W14' });
  });

  it('clamps the weekly target to 2–7 and applies a changed target to newly evaluated weeks', () => {
    expect(evaluateStreak(null, [], noon(MON), 9).weekTarget).toBe(7);
    expect(evaluateStreak(null, [], noon(MON), 1).weekTarget).toBe(2);
    const first = evaluateStreak(null, weeks(MON, [4]), noon(addDays(MON, 7)), 4);
    const next: StreakState = evaluateStreak(first, weeks(MON, [4, 2]), noon(addDays(MON, 14)), 2);
    expect(next).toMatchObject({ weekTarget: 2, current: 2 });
  });

  it('starts empty without practice days', () => {
    expect(evaluateStreak(null, [], noon(MON), 4)).toEqual({
      weekTarget: 4,
      current: 0,
      best: 0,
      freezes: 0,
      weeksTowardFreeze: 0,
      lastEvaluatedWeek: null,
    });
  });
});
