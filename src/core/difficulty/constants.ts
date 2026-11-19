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

/** Density measure = `DENSITY_MEAN_WEIGHT · D + DENSITY_PEAK_WEIGHT · Dp`. */
export const DENSITY_MEAN_WEIGHT = 0.6;
export const DENSITY_PEAK_WEIGHT = 0.4;
/** Fret span is measured inside one chord or across this many consecutive groups without a shift. */
export const SPAN_GROUP_RUN = 4;
/** String skipping per pair: `min(1, max(0, |Δstring| − SKIP_FREE) / SKIP_FULL)`. */
export const SKIP_FREE = 1;
export const SKIP_FULL = 2;
/** Chord load: 2 notes, 3+ notes, and the bonus for a fretted span ≥ `CHORD_WIDE_SPAN`. */
export const CHORD_LOAD = { two: 0.5, threePlus: 1.0, wideBonus: 0.5 } as const;
export const CHORD_WIDE_SPAN = 3;
/** A bend of at least this many semitones earns `TECHNIQUE_WEIGHTS.bendWide`. */
export const BEND_WIDE_SEMITONES = 2;
/** Tempo used when a song has no tempo map (BPM). */
export const DEFAULT_BPM = 120;

/** Skill tags: a technique tag needs ≥ max(`SKILL_TECH_MIN_GROUPS`, `SKILL_TECH_SHARE` × groups) groups with it. */
export const SKILL_TECH_MIN_GROUPS = 3;
export const SKILL_TECH_SHARE = 0.05;
/** `chords` tag: ≥ max(`SKILL_CHORD_MIN_GROUPS`, `SKILL_CHORD_SHARE` × groups) chord groups. */
export const SKILL_CHORD_MIN_GROUPS = 4;
export const SKILL_CHORD_SHARE = 0.25;
/** `string-skipping` / `position-shifts` tags: some section's `c` reaches this. */
export const SKILL_SKIP_MIN_C = 0.5;
export const SKILL_SHIFT_MIN_C = 1 / 3;

/** Highlights: factors whose peak section `c` reaches this, ordered by peak `weight × c`, at most `HIGHLIGHT_MAX`. */
export const HIGHLIGHT_MIN_C = 0.4;
export const HIGHLIGHT_MAX = 3;
/** Highlight phrase per factor. */
export const HIGHLIGHT_PHRASES: Readonly<Record<DifficultyFactorId, string>> = {
  density: 'dense, fast notes',
  tempo: 'fast tempo',
  shifts: 'fast position shifts',
  span: 'wide fret stretches',
  skipping: 'string skipping',
  techniques: 'technique-heavy',
  chords: 'frequent chords',
};
