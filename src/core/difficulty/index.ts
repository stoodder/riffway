/**
 * Difficulty analysis (T-013) exactly per docs/difficulty.md. Pure; runs on the server indexer and
 * in the browser. Constants in `./constants.ts` (calibrated by T-029). Signatures frozen by T-010.
 * @module
 */
import type {
  DifficultyFactor,
  DifficultyFactorId,
  DifficultyReport,
  HandPositionAnalysis,
  SectionDifficulty,
  Song,
  Tier,
  TierName,
} from '@shared/song';
import { onsetGroups, type OnsetGroup } from '../model/onset-groups';
import { computePositions } from '../handpos';
import {
  HIGHLIGHT_MAX,
  HIGHLIGHT_MIN_C,
  HIGHLIGHT_PHRASES,
  MIN_SECTION_SEC,
  NORMALISE,
  SKILL_CHORD_MIN_GROUPS,
  SKILL_CHORD_SHARE,
  SKILL_SHIFT_MIN_C,
  SKILL_SKIP_MIN_C,
  SKILL_TECH_MIN_GROUPS,
  SKILL_TECH_SHARE,
  SONG_HARDEST_WEIGHT,
  WEIGHTS,
} from './constants';
import { measureFactors } from './factors';
import { effectiveBpm, mergeSections, type RatedSpan } from './sections';

/** The factors in display / tie-break order. */
export const FACTOR_IDS: readonly DifficultyFactorId[] = ['density', 'tempo', 'shifts', 'span', 'skipping', 'techniques', 'chords'];

/** Tolerance for assigning grid-exact onsets to the section / position that starts at them (s). */
const TIME_EPS = 1e-9;

/** Analyse a song at 100% speed. Pass `positions` to reuse a `computePositions` result. */
export function analyzeDifficulty(song: Song, opts: { positions?: HandPositionAnalysis } = {}): DifficultyReport {
  const { positions } = opts.positions ?? computePositions(song);
  const spans = mergeSections(song);
  const groups = onsetGroups(song);

  // Bucket groups (and their hand-position index) by span; both lists are time-ordered.
  const spanGroups: OnsetGroup[][] = spans.map(() => []);
  const spanPositionOf: number[][] = spans.map(() => []);
  let s = 0;
  let p = -1;
  for (const g of groups) {
    while (s + 1 < spans.length && spans[s + 1]!.start <= g.time + TIME_EPS) s++;
    while (p + 1 < positions.length && positions[p + 1]!.start <= g.time + TIME_EPS) p++;
    spanGroups[s]!.push(g);
    spanPositionOf[s]!.push(p);
  }
  const shiftFrets = spans.map(() => 0);
  s = 0;
  for (let k = 1; k < positions.length; k++) {
    while (s + 1 < spans.length && spans[s + 1]!.start <= positions[k]!.start + TIME_EPS) s++;
    shiftFrets[s]! += Math.abs(positions[k]!.lo - positions[k - 1]!.lo);
  }

  const sections = spans.map((span, i) =>
    rateSection(span, {
      groups: spanGroups[i]!,
      positionOf: spanPositionOf[i]!,
      shiftFrets: shiftFrets[i]!,
      duration: span.end - span.start,
      bpm: effectiveBpm(song.timing.tempos, span.start, span.end),
    }),
  );

  const rating = songRating(sections);
  const tier = tierOf(rating);
  return {
    version: 1,
    rating,
    tier,
    tierName: tierName(tier),
    provisional: song.meta.rhythm === 'needs-alignment',
    sections,
    skills: deriveSkills(groups, sections),
    highlights: deriveHighlights(sections),
  };
}

/** `clamp(round(rating), 1, 10)`. */
export function tierOf(rating: number): Tier {
  return Math.min(10, Math.max(1, Math.round(rating))) as Tier;
}

/** Band name for a tier (1–2 Beginner … 9–10 Expert). */
export function tierName(tier: Tier): TierName {
  if (tier <= 2) return 'Beginner';
  if (tier <= 4) return 'Developing';
  if (tier <= 6) return 'Intermediate';
  if (tier <= 8) return 'Advanced';
  return 'Expert';
}

/** Rating = `round1(1 + 9 × raw)`, `raw = Σ weight × c`. */
function rateSection(span: RatedSpan, input: Parameters<typeof measureFactors>[0]): SectionDifficulty {
  const measures = measureFactors(input);
  let raw = 0;
  const factors = {} as Record<DifficultyFactorId, DifficultyFactor>;
  for (const id of FACTOR_IDS) {
    const { offset, scale } = NORMALISE[id];
    const c = clamp01((measures[id] - offset) / scale);
    factors[id] = { measure: measures[id], c, weight: WEIGHTS[id] };
    raw += WEIGHTS[id] * c;
  }
  const rating = round1(1 + 9 * raw);
  return { sectionIndex: span.sectionIndex, name: span.name, start: span.start, end: span.end, rating, tier: tierOf(rating), raw, factors };
}

/** `round1(0.7 × hardest section ≥ 4 s (any section if none is) + 0.3 × duration-weighted mean)`. */
function songRating(sections: readonly SectionDifficulty[]): number {
  const duration = (sec: SectionDifficulty): number => Math.max(0, sec.end - sec.start);
  const long = sections.filter((sec) => duration(sec) >= MIN_SECTION_SEC - TIME_EPS);
  const hardest = Math.max(...(long.length > 0 ? long : sections).map((sec) => sec.rating));
  let weighted = 0;
  let total = 0;
  for (const sec of sections) {
    weighted += sec.rating * duration(sec);
    total += duration(sec);
  }
  const mean = total > 0 ? weighted / total : hardest;
  return round1(Math.min(10, Math.max(1, SONG_HARDEST_WEIGHT * hardest + (1 - SONG_HARDEST_WEIGHT) * mean)));
}

/** Skill tags, in the order bends, legato, chords, string-skipping, position-shifts. */
function deriveSkills(groups: readonly OnsetGroup[], sections: readonly SectionDifficulty[]): string[] {
  let bends = 0;
  let legato = 0;
  let chords = 0;
  for (const g of groups) {
    if (g.notes.some((n) => n.tech.bend !== undefined)) bends++;
    if (g.notes.some((n) => n.tech.hammerOn === true || n.tech.pullOff === true)) legato++;
    if (g.chord) chords++;
  }
  const techMin = Math.max(SKILL_TECH_MIN_GROUPS, SKILL_TECH_SHARE * groups.length);
  const peak = (id: DifficultyFactorId): number => Math.max(0, ...sections.map((sec) => sec.factors[id].c));
  const skills: string[] = [];
  if (bends >= techMin) skills.push('bends');
  if (legato >= techMin) skills.push('legato');
  if (chords >= Math.max(SKILL_CHORD_MIN_GROUPS, SKILL_CHORD_SHARE * groups.length)) skills.push('chords');
  if (peak('skipping') >= SKILL_SKIP_MIN_C) skills.push('string-skipping');
  if (peak('shifts') >= SKILL_SHIFT_MIN_C - TIME_EPS) skills.push('position-shifts');
  return skills;
}

/** "Why" phrases: factors whose peak `c` ≥ 0.4, by peak `weight × c`, at most 3. */
function deriveHighlights(sections: readonly SectionDifficulty[]): string[] {
  return FACTOR_IDS.map((id) => ({ id, c: Math.max(0, ...sections.map((sec) => sec.factors[id].c)) }))
    .filter((f) => f.c >= HIGHLIGHT_MIN_C)
    .sort((a, b) => WEIGHTS[b.id] * b.c - WEIGHTS[a.id] * a.c)
    .slice(0, HIGHLIGHT_MAX)
    .map((f) => HIGHLIGHT_PHRASES[f.id]);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Round to one decimal (with a nudge so float noise like 2.3499999 rounds as 2.35). */
function round1(x: number): number {
  return Math.round(x * 10 + 1e-9) / 10;
}
