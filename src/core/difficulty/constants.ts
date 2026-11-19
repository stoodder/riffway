/**
 * Difficulty constants (docs/difficulty.md). Owned by T-013, calibrated by T-029 against the starter
 * library (every item within ±1 of its target tier). Change a value → update docs/difficulty.md.
 * @module
 */
import type { DifficultyFactorId } from '@shared/song';

/** Factor weights (sum = 1). */
export const WEIGHTS: Readonly<Record<DifficultyFactorId, number>> = {
  density: 0.35,
  tempo: 0.05,
  shifts: 0.15,
  span: 0.1,
  skipping: 0.1,
  techniques: 0.15,
  chords: 0.1,
};

/** Normalisation constants for each factor's `c = clamp((measure − offset) / scale)`. */
export const NORMALISE: Readonly<Record<DifficultyFactorId, { offset: number; scale: number }>> = {
  density: { offset: 1, scale: 7 },
  tempo: { offset: 60, scale: 120 },
  shifts: { offset: 0, scale: 3 },
  span: { offset: 3, scale: 3 },
  skipping: { offset: 0, scale: 0.4 },
  techniques: { offset: 0, scale: 2 },
  chords: { offset: 0, scale: 3 },
};

/** Technique weights per onset group (distinct techniques summed). */
export const TECHNIQUE_WEIGHTS = {
  bend: 1.0,
  /** Added to `bend` when the bend is ≥ 2 semitones. */
  bendWide: 0.5,
  harmonic: 0.8,
  slide: 0.6,
  legato: 0.5,
  vibrato: 0.3,
  dead: 0.2,
  palmMute: 0.1,
  letRing: 0,
} as const;

/** Song rating = HARDEST × max(section ≥ MIN_SECTION_SEC) + (1 − HARDEST) × weighted mean. */
export const SONG_HARDEST_WEIGHT = 0.7;
/** Sections shorter than this merge into the next (s). */
export const MERGE_SECTION_SEC = 2;
/** Only sections at least this long count for the hardest-section term (s). */
export const MIN_SECTION_SEC = 4;
/** Peak-density window (s). */
export const PEAK_WINDOW_SEC = 2;
