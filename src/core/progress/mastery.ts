/**
 * Section mastery (docs/progress.md § Section mastery, D8). Progress counts **clean runs**, not
 * minutes or plays. Pure; the speed-trainer arithmetic itself is `src/core/practice` (T-014).
 *
 * Lifecycle of one section:
 * 1. Practising: the trainer follows the speed actually played (+5% after a clean run, −5% after two
 *    failed runs, see `trainerStep`).
 * 2. **Mastered:** the 2nd clean run at 100% within one practice session. Sets `masteredAt` and
 *    `nextCheckAt` (next local day 04:00).
 * 3. **Next-day check:** once `nextCheckAt` is due, the first run at full speed is the check. Clean →
 *    **locked in** (`lockedInAt`, `nextCheckAt` cleared). Not clean → mastery is reset and the trainer
 *    restarts at 85%; the section can be mastered again.
 * @module
 */
import type { SectionProgress } from '@shared/storage';
import { TRAINER, initialTrainerState, trainerStep } from '@core/practice';
import { nextDayCheckAt } from './dates';

/** Clean runs at 100% needed within one session to master a section. */
export const MASTERY_CLEAN_RUNS = 2;

/**
 * Passes without progress before the plateau nudge. A pass makes progress when it sets a new best
 * accuracy, is clean, or is played at a different speed bucket from the previous pass (a new speed
 * restarts the count: accuracy dips after a speed-up are expected, not a plateau).
 */
export const PLATEAU_PASSES = 6;

/** Plateau nudge text (learning research row 10). */
export const PLATEAU_MESSAGE = 'Good place to stop — this usually improves after sleep.';

/** Tolerance when comparing speed fractions (0.7 + 6 × 0.05 is not exactly 1). */
const SPEED_EPSILON = 1e-6;

/** Run facts needed to update one section's progress. */
export interface SectionRunInput {
  songId: string;
  arrangement: number;
  sectionIdx: number;
  /** Section accuracy %. */
  accuracy: number;
  clean: boolean;
  /** Speed fraction. */
  speed: number;
  at: number;
  /** Identifies the practice session (mastery needs 2 clean runs at 100% in one session). */
  sessionId: string;
  /** Section tier and the player's comfort tier (trainer start). */
  sectionTier: number;
  comfortTier: number;
}

/** Speed fraction → bucket (rounded to 5%, integer percent; 100 = full speed). */
export function speedBucket(speed: number): number {
  return Math.round(speed * 20) * 5;
}

/** True when `speed` is full speed (100%) or overspeed. */
export function isFullSpeed(speed: number): boolean {
  return speed >= TRAINER.cap - SPEED_EPSILON;
}

/** True when the section's next-day check is due at `now` (mastered, not locked in, time reached). */
export function isCheckDue(p: SectionProgress, now: number): boolean {
  return p.masteredAt !== undefined && p.lockedInAt === undefined && p.nextCheckAt !== undefined && p.nextCheckAt <= now;
}

/** True when the plateau nudge should be shown ({@link PLATEAU_MESSAGE}). */
export function isPlateau(p: SectionProgress): boolean {
  return p.passesSinceGain >= PLATEAU_PASSES;
}

/**
 * Apply a run to a section's progress: clean-run counters, speed trainer, mastery, the next-day check
 * and the plateau counter (`passesSinceGain`: passes without progress, see {@link PLATEAU_PASSES}). Returns a new record (the input is not mutated); optional fields that no
 * longer apply are omitted rather than set to `undefined`, so records stay JSON round-trip stable.
 */
export function applySectionRun(prev: SectionProgress | null, run: SectionRunInput): SectionProgress {
  const full = isFullSpeed(run.speed);
  const cleanAtFull = run.clean && full;
  const trainerBefore = prev?.trainer ?? initialTrainerState(run.sectionTier, run.comfortTier);
  const step = trainerStep({ speed: run.speed, failStreak: trainerBefore.failStreak }, run.accuracy, run.clean);
  const sessionBefore = prev?.session?.id === run.sessionId ? prev.session.cleanRunsAt100 : 0;
  const gained = prev === null || run.accuracy > prev.bestAccuracy;
  const progressed = prev === null || gained || run.clean || speedBucket(run.speed) !== speedBucket(prev.lastSpeed);

  const next: SectionProgress = {
    songId: run.songId,
    arrangement: run.arrangement,
    sectionIdx: run.sectionIdx,
    cleanRuns: (prev?.cleanRuns ?? 0) + (run.clean ? 1 : 0),
    cleanRunsAt100: (prev?.cleanRunsAt100 ?? 0) + (cleanAtFull ? 1 : 0),
    lastSpeed: run.speed,
    trainer: step.state,
    bestAccuracy: gained ? run.accuracy : (prev?.bestAccuracy ?? run.accuracy),
    passesSinceGain: progressed ? 0 : (prev?.passesSinceGain ?? 0) + 1,
    session: { id: run.sessionId, cleanRunsAt100: sessionBefore + (cleanAtFull ? 1 : 0) },
  };
  if (prev?.masteredAt !== undefined) next.masteredAt = prev.masteredAt;
  if (prev?.lockedInAt !== undefined) next.lockedInAt = prev.lockedInAt;
  if (prev?.nextCheckAt !== undefined) next.nextCheckAt = prev.nextCheckAt;

  if (prev && full && isCheckDue(prev, run.at)) {
    if (run.clean) {
      next.lockedInAt = run.at;
      delete next.nextCheckAt;
    } else {
      // Failed check: back to practising, a notch below full speed; this session starts over.
      delete next.masteredAt;
      delete next.nextCheckAt;
      next.trainer = { speed: TRAINER.recheckStart, failStreak: 0 };
      next.session = { id: run.sessionId, cleanRunsAt100: 0 };
    }
  } else if (next.masteredAt === undefined && (next.session?.cleanRunsAt100 ?? 0) >= MASTERY_CLEAN_RUNS) {
    next.masteredAt = run.at;
    next.nextCheckAt = nextDayCheckAt(run.at);
  }
  return next;
}

/** Mastery summary of one arrangement. */
export interface SongMastery {
  sectionCount: number;
  masteredSections: number;
  lockedInSections: number;
  /** Every section mastered (locked-in sections count as mastered). */
  mastered: boolean;
  /** Every section locked in: the arrangement is part of the player's repertoire. */
  repertoire: boolean;
}

/**
 * Summarise section progress for an arrangement with `sectionCount` sections. Sections without a
 * record count as not mastered. A song with no sections is never mastered.
 */
export function songMastery(progress: readonly SectionProgress[], sectionCount: number): SongMastery {
  const inRange = progress.filter((p) => p.sectionIdx >= 0 && p.sectionIdx < sectionCount);
  const lockedIn = new Set(inRange.filter((p) => p.lockedInAt !== undefined).map((p) => p.sectionIdx));
  const mastered = new Set(inRange.filter((p) => p.masteredAt !== undefined || p.lockedInAt !== undefined).map((p) => p.sectionIdx));
  return {
    sectionCount,
    masteredSections: mastered.size,
    lockedInSections: lockedIn.size,
    mastered: sectionCount > 0 && mastered.size === sectionCount,
    repertoire: sectionCount > 0 && lockedIn.size === sectionCount,
  };
}
