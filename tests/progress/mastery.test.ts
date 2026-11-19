import { describe, expect, it, vi } from 'vitest';
import {
  applySectionRun,
  isCheckDue,
  isPlateau,
  PLATEAU_PASSES,
  songMastery,
  speedBucket,
  type SectionRunInput,
} from '@core/progress';
import type { SectionProgress } from '@shared/storage';

vi.mock('@core/practice', async (importOriginal) => {
  const { withTrainerFallback } = await import('./trainer-fallback');
  return withTrainerFallback(await importOriginal());
});

/** Local time on 2026-11-`day` at `h:mm`. */
const at = (day: number, h: number, m = 0): number => new Date(2026, 10, day, h, m).getTime();

function run(over: Partial<SectionRunInput> = {}): SectionRunInput {
  return {
    songId: 'starter:ode',
    arrangement: 0,
    sectionIdx: 1,
    accuracy: 95,
    clean: true,
    speed: 1,
    at: at(19, 20),
    sessionId: 's1',
    sectionTier: 3,
    comfortTier: 2,
    ...over,
  };
}

/** Apply runs in order from scratch. */
function play(...runs: SectionRunInput[]): SectionProgress {
  return runs.reduce<SectionProgress | null>((p, r) => applySectionRun(p, r), null)!;
}

describe('speedBucket', () => {
  it('rounds to 5% as an integer percent', () => {
    expect(speedBucket(1)).toBe(100);
    expect(speedBucket(0.7)).toBe(70);
    expect(speedBucket(0.72)).toBe(70);
    expect(speedBucket(0.73)).toBe(75);
    expect(speedBucket(0.7 + 6 * 0.05)).toBe(100);
    expect(speedBucket(1.1)).toBe(110);
  });
});

describe('applySectionRun: counters and trainer', () => {
  it('creates a record on the first run and counts clean runs', () => {
    const p = applySectionRun(null, run({ speed: 0.7, accuracy: 92 }));
    expect(p).toMatchObject({ songId: 'starter:ode', arrangement: 0, sectionIdx: 1, cleanRuns: 1, cleanRunsAt100: 0, lastSpeed: 0.7 });
    expect(p.bestAccuracy).toBe(92);
    expect(p.passesSinceGain).toBe(0);
    expect(p.trainer.speed).toBeCloseTo(0.75);
    expect(p.masteredAt).toBeUndefined();
  });

  it('steps the trainer down 5% after two failed runs in a row', () => {
    const p = play(run({ speed: 0.8, accuracy: 60, clean: false }), run({ speed: 0.8, accuracy: 50, clean: false }));
    expect(p.trainer.speed).toBeCloseTo(0.75);
    expect(p.cleanRuns).toBe(0);
  });

  it('follows the speed actually played', () => {
    const p = play(run({ speed: 0.7 }), run({ speed: 0.9 }));
    expect(p.trainer.speed).toBeCloseTo(0.95);
    expect(p.lastSpeed).toBe(0.9);
  });

  it('does not mutate the previous record', () => {
    const prev = applySectionRun(null, run({ speed: 0.7 }));
    const copy = structuredClone(prev);
    applySectionRun(prev, run({ speed: 0.75 }));
    expect(prev).toEqual(copy);
  });
});

describe('applySectionRun: mastery and next-day check', () => {
  it('masters on the 2nd clean run at 100% in one session; check due next local day 04:00', () => {
    const one = play(run({ at: at(19, 20, 0) }));
    expect(one.masteredAt).toBeUndefined();
    const two = applySectionRun(one, run({ at: at(19, 20, 5) }));
    expect(two.masteredAt).toBe(at(19, 20, 5));
    expect(two.nextCheckAt).toBe(at(20, 4));
    expect(two.cleanRunsAt100).toBe(2);
  });

  it('does not master across sessions or below full speed', () => {
    expect(play(run({ sessionId: 'a' }), run({ sessionId: 'b' })).masteredAt).toBeUndefined();
    expect(play(run({ speed: 0.95 }), run({ speed: 0.95 })).masteredAt).toBeUndefined();
    expect(play(run(), run({ clean: false, accuracy: 85 }), run({ speed: 0.9 })).masteredAt).toBeUndefined();
  });

  it('counts overspeed (110%) as full speed', () => {
    expect(play(run({ speed: 1.1 }), run({ speed: 1.1 })).masteredAt).toBeDefined();
  });

  it('locks in on a clean run at 100% once the check is due', () => {
    const mastered = play(run(), run());
    expect(isCheckDue(mastered, at(20, 3, 59))).toBe(false);
    expect(isCheckDue(mastered, at(20, 4))).toBe(true);
    const locked = applySectionRun(mastered, run({ at: at(20, 18), sessionId: 's2' }));
    expect(locked.lockedInAt).toBe(at(20, 18));
    expect('nextCheckAt' in locked).toBe(false);
    expect(locked.masteredAt).toBe(mastered.masteredAt);
    expect(isCheckDue(locked, at(30, 12))).toBe(false);
  });

  it('a clean run before the check is due does not lock in', () => {
    const mastered = play(run(), run());
    const later = applySectionRun(mastered, run({ at: at(19, 23) }));
    expect(later.lockedInAt).toBeUndefined();
    expect(later.nextCheckAt).toBe(at(20, 4));
  });

  it('runs below full speed while the check is due are warm-ups, not the check', () => {
    const mastered = play(run(), run());
    const warm = applySectionRun(mastered, run({ at: at(20, 18), speed: 0.8, clean: false, accuracy: 60, sessionId: 's2' }));
    expect(warm.masteredAt).toBe(mastered.masteredAt);
    expect(warm.nextCheckAt).toBe(mastered.nextCheckAt);
  });

  it('failing the check resets mastery and restarts the trainer at 85%; it can be mastered again', () => {
    const mastered = play(run(), run());
    const failed = applySectionRun(mastered, run({ at: at(20, 18), accuracy: 80, clean: false, sessionId: 's2' }));
    expect('masteredAt' in failed).toBe(false);
    expect('nextCheckAt' in failed).toBe(false);
    expect(failed.trainer).toEqual({ speed: 0.85, failStreak: 0 });
    expect(failed.session).toEqual({ id: 's2', cleanRunsAt100: 0 });

    const again = [run({ at: at(20, 18, 5), sessionId: 's2' }), run({ at: at(20, 18, 10), sessionId: 's2' })].reduce(applySectionRun, failed);
    expect(again.masteredAt).toBe(at(20, 18, 10));
    expect(again.nextCheckAt).toBe(at(21, 4));
  });
});

describe('plateau', () => {
  it(`nudges after ${PLATEAU_PASSES} passes without an accuracy gain and resets on a gain`, () => {
    let p = play(run({ accuracy: 80, clean: false, speed: 0.8 }));
    for (let i = 0; i < PLATEAU_PASSES - 1; i++) p = applySectionRun(p, run({ accuracy: 78, clean: false, speed: 0.8 }));
    expect(isPlateau(p)).toBe(false);
    p = applySectionRun(p, run({ accuracy: 80, clean: false, speed: 0.8 }));
    expect(p.passesSinceGain).toBe(PLATEAU_PASSES);
    expect(isPlateau(p)).toBe(true);
    p = applySectionRun(p, run({ accuracy: 81, clean: false, speed: 0.8 }));
    expect(p.passesSinceGain).toBe(0);
    expect(p.bestAccuracy).toBe(81);
  });

  it('does not nudge while clean runs raise the speed, even as accuracy dips (R1-P-04)', () => {
    const accuracies = [95, 93, 92, 91, 90, 92, 91];
    const p = play(...accuracies.map((accuracy, i) => run({ accuracy, clean: true, speed: 0.7 + i * 0.05 })));
    expect(p.passesSinceGain).toBe(0);
    expect(isPlateau(p)).toBe(false);
  });

  it('does not nudge on clean runs at full speed below the best accuracy', () => {
    let p = play(run({ accuracy: 100, clean: true, speed: 1 }));
    for (let i = 0; i < PLATEAU_PASSES + 2; i++) p = applySectionRun(p, run({ accuracy: 96, clean: true, speed: 1, sessionId: `s${i}` }));
    expect(isPlateau(p)).toBe(false);
  });

  it('restarts the count when the played speed bucket changes, then nudges on a real plateau at that speed', () => {
    let p = play(run({ accuracy: 95, clean: true, speed: 0.8 }));
    // Up a notch: accuracy dips below the all-time best, which is expected, not a plateau.
    p = applySectionRun(p, run({ accuracy: 75, clean: false, speed: 0.9 }));
    expect(p.passesSinceGain).toBe(0);
    for (let i = 0; i < PLATEAU_PASSES - 1; i++) p = applySectionRun(p, run({ accuracy: 76, clean: false, speed: 0.9 }));
    expect(isPlateau(p)).toBe(false);
    p = applySectionRun(p, run({ accuracy: 76, clean: false, speed: 0.9 }));
    expect(isPlateau(p)).toBe(true);
    expect(p.bestAccuracy).toBe(95);
  });
});

describe('songMastery', () => {
  const rec = (sectionIdx: number, extra: Partial<SectionProgress> = {}): SectionProgress => ({
    ...play(run({ sectionIdx, speed: 0.7 })),
    ...extra,
  });

  it('requires every section mastered (song) or locked in (repertoire)', () => {
    expect(songMastery([rec(0, { masteredAt: 1 }), rec(1, { masteredAt: 1 })], 3)).toMatchObject({ mastered: false, masteredSections: 2 });
    expect(songMastery([rec(0, { masteredAt: 1 }), rec(1, { masteredAt: 1, lockedInAt: 2 })], 2)).toMatchObject({
      mastered: true,
      repertoire: false,
      lockedInSections: 1,
    });
    expect(songMastery([rec(0, { masteredAt: 1, lockedInAt: 2 }), rec(1, { masteredAt: 1, lockedInAt: 2 })], 2).repertoire).toBe(true);
    expect(songMastery([], 0)).toMatchObject({ mastered: false, repertoire: false });
  });
});
