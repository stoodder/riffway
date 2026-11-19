/**
 * Judge constants (docs/game-mechanics.md). Tune here and update the doc. Owned by T-014.
 * @module
 */
import type { Outcome, TimingWindows } from '@shared/judge';

/** Timing windows in real seconds (never scaled by speed). */
export const WINDOWS: Readonly<TimingWindows> = { perfect: 0.035, great: 0.07, good: 0.12 };

/** Base points per outcome. */
export const BASE_POINTS: Readonly<Record<Outcome, number>> = { Perfect: 100, Great: 75, Good: 50, WrongNote: 0, Miss: 0 };

/** Timing-score value per hit outcome. */
export const TIMING_VALUE: Readonly<Record<'Perfect' | 'Great' | 'Good', number>> = { Perfect: 1, Great: 0.75, Good: 0.5 };

/** Combo thresholds for ×2, ×3, ×4. */
export const MULTIPLIER_STEPS: readonly number[] = [10, 20, 30];

/** Accuracy % needed for 1–5 stars. */
export const STAR_THRESHOLDS: readonly number[] = [50, 70, 80, 90, 97];

/** Pitch match tolerance in cents. */
export const PITCH_TOLERANCE_CENTS = 50;
/** An unpitched onset waits this long for a follow-up pitch before counting as WrongNote (s). */
export const PITCH_WAIT_SEC = 0.04;
/** Same-pitch event within this of an already-matched event is ignored (s). */
export const RETRIGGER_SEC = 0.05;
/** Notes within this are one onset group (s); shared with difficulty. */
export { GROUP_WINDOW_SEC } from '../model/onset-groups';
/** Clean run: accuracy ≥ this %… */
export const CLEAN_ACCURACY = 90;
/** …and no more than this many consecutive misses. */
export const CLEAN_MAX_CONSECUTIVE_MISSES = 2;
/** Histogram bin width and range (ms). */
export const HISTOGRAM = { binMs: 10, minMs: -120, maxMs: 120 } as const;
