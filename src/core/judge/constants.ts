/**
 * Judge constants (docs/game-mechanics.md). Tune here and update the doc. Owned by T-014.
 * @module
 */
import type { InputSource, Outcome, TimingWindows } from '@shared/judge';

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
/**
 * Retrigger guard (s): an event this close to an already-assigned event is a detector double
 * trigger and is ignored, unless the song itself asks for notes that close together (see
 * docs/game-mechanics.md § Retrigger guard).
 */
export const RETRIGGER_SEC = 0.05;
/** Notes within this are one onset group (s); shared with difficulty. */
export { GROUP_WINDOW_SEC } from '../model/onset-groups';
/** Clean run: accuracy ≥ this %… */
export const CLEAN_ACCURACY = 90;
/** …and no more than this many consecutive non-hits (WrongNote or Miss groups). */
export const CLEAN_MAX_CONSECUTIVE_MISSES = 2;
/** Histogram bin width and range (ms). */
export const HISTOGRAM = { binMs: 10, minMs: -120, maxMs: 120 } as const;

/**
 * Comparison tolerance for window edges (s). `Δ` is a difference of two context times around
 * 10³–10⁴ s, so it carries ~1e-12 s of float noise; 1 µs keeps `|Δ| = 35 ms` a Perfect.
 */
export const TIME_EPS_SEC = 1e-6;

/** A follow-up pitch (`refines`) matches a pending onset whose `ctxTime` is within this (s). */
export const REFINE_MATCH_SEC = 0.0005;

/**
 * Timing-bias tracker used to choose between candidates in dense passages: an exponential moving
 * average of hit deltas (`alpha` per hit), clamped to ± the Great window. A player who is
 * consistently 60 ms late on a fast tremolo keeps being matched to the note they meant.
 */
export const TIMING_BIAS_ALPHA = 0.2;

/**
 * How long after an event's (calibrated) context time it can still reach the judge, per source,
 * excluding the calibration offset itself (s). Guitar: 25 ms pitch measurement + up to 40 ms
 * follow-up pitch + message hop. Keyboard: event dispatch. Test injections are immediate.
 * Used by `inputHorizon` in `./input.ts`.
 */
export const INPUT_LAG_SEC: Readonly<Record<InputSource, number>> = { guitar: 0.09, keyboard: 0.02, test: 0 };
