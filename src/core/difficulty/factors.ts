/**
 * The seven difficulty factor measures for one section (docs/difficulty.md § Factors).
 * @module
 */
import type { DifficultyFactorId, Note } from '@shared/song';
import type { OnsetGroup } from '../model/onset-groups';
import { isFretted } from '../handpos';
import {
  BEND_WIDE_SEMITONES,
  CHORD_LOAD,
  CHORD_WIDE_SPAN,
  DENSITY_MEAN_WEIGHT,
  DENSITY_PEAK_WEIGHT,
  PEAK_WINDOW_SEC,
  SKIP_FREE,
  SKIP_FULL,
  SPAN_GROUP_RUN,
  TECHNIQUE_WEIGHTS,
} from './constants';

/** Tolerance for time comparisons (s), so grid-exact onsets at a window edge count once. */
const TIME_EPS = 1e-9;

/** Everything one section contributes to the measures. */
export interface SectionInput {
  /** Onset groups in the section, in time order. */
  groups: readonly OnsetGroup[];
  /** Hand-position index per entry of `groups` (−1 before the first position). */
  positionOf: readonly number[];
  /** Σ|Δlo| of shifts whose new position starts in the section. */
  shiftFrets: number;
  /** Section duration `T` (s). */
  duration: number;
  /** Effective tempo (BPM). */
  bpm: number;
}

/** Raw measure of every factor (before normalisation). */
export function measureFactors(input: SectionInput): Record<DifficultyFactorId, number> {
  const { groups, duration: T } = input;
  const perSec = (x: number): number => (T > 0 ? x / T : 0);
  return {
    density: DENSITY_MEAN_WEIGHT * perSec(groups.length) + DENSITY_PEAK_WEIGHT * (peakWindowCount(groups) / PEAK_WINDOW_SEC),
    tempo: input.bpm,
    shifts: perSec(input.shiftFrets),
    span: maxFretSpan(groups, input.positionOf),
    skipping: stringSkipping(groups),
    techniques: perSec(sum(groups, techniqueWeight)),
    chords: perSec(sum(groups, chordLoad)),
  };
}

/** Most groups whose onset lies in any half-open window `[t, t + PEAK_WINDOW_SEC)`. */
export function peakWindowCount(groups: readonly OnsetGroup[]): number {
  let best = 0;
  let j = 0;
  for (let i = 0; i < groups.length; i++) {
    const limit = groups[i]!.time + PEAK_WINDOW_SEC - TIME_EPS;
    if (j < i) j = i;
    while (j < groups.length && groups[j]!.time < limit) j++;
    best = Math.max(best, j - i);
  }
  return best;
}

/**
 * `F`: the widest fretted span inside one chord, or across `SPAN_GROUP_RUN` consecutive groups
 * that share one hand position (fewer when the section has fewer groups).
 */
export function maxFretSpan(groups: readonly OnsetGroup[], positionOf: readonly number[]): number {
  let best = 0;
  for (const g of groups) if (g.chord) best = Math.max(best, fretSpan(g.notes));
  const run = Math.min(SPAN_GROUP_RUN, groups.length);
  for (let i = 0; i + run <= groups.length && run > 0; i++) {
    const pos = positionOf[i];
    let same = true;
    for (let k = i + 1; k < i + run && same; k++) same = positionOf[k] === pos;
    if (!same) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = i; k < i + run; k++) {
      for (const note of groups[k]!.notes) {
        if (!isFretted(note)) continue;
        lo = Math.min(lo, note.fret);
        hi = Math.max(hi, note.fret);
      }
    }
    if (hi >= lo) best = Math.max(best, hi - lo);
  }
  return best;
}

/** `K`: mean skip score over consecutive single-note pairs (0 without pairs). */
export function stringSkipping(groups: readonly OnsetGroup[]): number {
  let total = 0;
  let pairs = 0;
  for (let i = 1; i < groups.length; i++) {
    const a = groups[i - 1]!;
    const b = groups[i]!;
    if (a.chord || b.chord) continue;
    const jump = Math.abs(a.notes[0]!.string - b.notes[0]!.string);
    total += Math.min(1, Math.max(0, jump - SKIP_FREE) / SKIP_FULL);
    pairs++;
  }
  return pairs > 0 ? total / pairs : 0;
}

/**
 * Sum of the distinct technique weights in a group. Hammer-ons and pull-offs count on their origin
 * note; a bend of ≥ `BEND_WIDE_SEMITONES` adds `bendWide`.
 */
export function techniqueWeight(group: OnsetGroup): number {
  let bend = false;
  let bendWide = false;
  let harmonic = false;
  let slide = false;
  let legato = false;
  let vibrato = false;
  let dead = false;
  let palmMute = false;
  let letRing = false;
  for (const { tech } of group.notes) {
    if (tech.bend) {
      bend = true;
      if (tech.bend.semitones >= BEND_WIDE_SEMITONES) bendWide = true;
    }
    harmonic ||= tech.harmonic !== undefined;
    slide ||= tech.slide !== undefined;
    legato ||= tech.hammerOn === true || tech.pullOff === true;
    vibrato ||= tech.vibrato === true;
    dead ||= tech.dead === true;
    palmMute ||= tech.palmMute === true;
    letRing ||= tech.letRing === true;
  }
  const w = TECHNIQUE_WEIGHTS;
  return (
    (bend ? w.bend : 0) +
    (bendWide ? w.bendWide : 0) +
    (harmonic ? w.harmonic : 0) +
    (slide ? w.slide : 0) +
    (legato ? w.legato : 0) +
    (vibrato ? w.vibrato : 0) +
    (dead ? w.dead : 0) +
    (palmMute ? w.palmMute : 0) +
    (letRing ? w.letRing : 0)
  );
}

/** Chord load: 0 for a single note, 0.5 for 2 notes, 1.0 for 3+, +0.5 for a fretted span ≥ 3. */
export function chordLoad(group: OnsetGroup): number {
  if (!group.chord) return 0;
  const base = group.notes.length >= 3 ? CHORD_LOAD.threePlus : CHORD_LOAD.two;
  return base + (fretSpan(group.notes) >= CHORD_WIDE_SPAN ? CHORD_LOAD.wideBonus : 0);
}

/** Max − min fret over the fretted notes (0 with fewer than two). */
function fretSpan(notes: readonly Note[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const note of notes) {
    if (!isFretted(note)) continue;
    lo = Math.min(lo, note.fret);
    hi = Math.max(hi, note.fret);
  }
  return hi >= lo ? hi - lo : 0;
}

function sum(groups: readonly OnsetGroup[], f: (g: OnsetGroup) => number): number {
  let total = 0;
  for (const g of groups) total += f(g);
  return total;
}
