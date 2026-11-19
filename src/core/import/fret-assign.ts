/**
 * Fret assignment for MusicXML without tab data (T-011): dynamic programming over candidate
 * (string, fret) positions minimising hand-position shifts and span (window rule from
 * docs/game-mechanics.md § Hand-position cue), frets ≤ 15 preferred, open strings allowed.
 *
 * Model: the hand sits in a window `[lo, lo + 3]` (`lo + 4` when `lo ≥ 7`). Notes are grouped into
 * onsets (same time or same `chordId`); each group picks one assignment of distinct strings. The DP
 * state is the window's `lo` after the group; a group whose fretted notes leave the window moves the
 * hand (shift cost grows with the distance). Open strings never move the hand. An assignment whose
 * own span does not fit one window is heavily penalised, so it is only used when nothing else fits.
 * @module
 */
import type { StringNumber } from '@shared/song';

/** A pitched event to place on the fretboard. */
export interface FretAssignInput {
  time: number;
  midi: number;
  /** Notes sharing a chord id must land on distinct strings. */
  chordId?: number;
}

/** Assigned position, same order as the input. */
export interface FretPosition {
  string: StringNumber;
  fret: number;
}

/** Highest fret considered. */
const MAX_FRET = 24;
/** Frets above this cost extra ("frets ≤ 15 preferred"). */
const PREFERRED_MAX_FRET = 15;
const COST_HIGH_FRET = 6;
/** Per-fret height cost: lower positions win ties. */
const COST_PER_FRET = 0.25;
/** Fixed cost of any hand shift, plus `COST_SHIFT_PER_FRET` per fret moved. */
const COST_SHIFT = 2;
const COST_SHIFT_PER_FRET = 0.5;
/** Penalty for an assignment wider than one hand window. */
const COST_SPAN = 50;
/** Upper bound on enumerated assignments per onset group. */
const MAX_ASSIGNMENTS = 4096;
/** Onsets closer than this (seconds) form one group. */
const SAME_TIME = 1e-6;
/** DP state for "no fretted note seen yet". */
const UNSET = -1;

/** Width of the hand window above `lo`: 3 (4 frets), or 4 (5 frets) when `lo ≥ 7`. */
function windowWidth(lo: number): number {
  return lo >= 7 ? 4 : 3;
}

interface Assignment {
  /** Position per note of the group (group order). */
  positions: FretPosition[];
  /** Min / max fretted (non-open) fret, or null when every note is open. */
  minFret: number | null;
  maxFret: number | null;
  cost: number;
}

/** Candidate positions for a pitch; octave-shifted into range when it cannot be played as written. */
function candidates(midi: number, tuning: readonly number[], capo: number): FretPosition[] {
  const strings = Math.min(6, tuning.length);
  const highest = Math.max(...tuning.slice(0, strings)) + capo + MAX_FRET;
  const lowest = Math.min(...tuning.slice(0, strings)) + capo;
  let m = midi;
  while (m < lowest) m += 12;
  while (m > highest) m -= 12;
  const out: FretPosition[] = [];
  for (let s = 1; s <= strings; s++) {
    const fret = m - (tuning[s - 1] ?? 0) - capo;
    if (fret >= 0 && fret <= MAX_FRET) out.push({ string: s as StringNumber, fret });
  }
  return out;
}

function makeAssignment(positions: FretPosition[]): Assignment {
  let minFret: number | null = null;
  let maxFret: number | null = null;
  let cost = 0;
  for (const p of positions) {
    cost += p.fret * COST_PER_FRET + (p.fret > PREFERRED_MAX_FRET ? COST_HIGH_FRET : 0);
    if (p.fret === 0) continue;
    minFret = minFret === null ? p.fret : Math.min(minFret, p.fret);
    maxFret = maxFret === null ? p.fret : Math.max(maxFret, p.fret);
  }
  if (minFret !== null && maxFret !== null && maxFret - minFret > windowWidth(minFret)) cost += COST_SPAN;
  return { positions, minFret, maxFret, cost };
}

/** Every assignment of the group's notes to distinct strings (bounded); falls back to best-per-note. */
function groupAssignments(cands: FretPosition[][]): Assignment[] {
  const out: Assignment[] = [];
  const chosen: FretPosition[] = [];
  const used = new Set<number>();
  const walk = (i: number): void => {
    if (out.length >= MAX_ASSIGNMENTS) return;
    if (i === cands.length) {
      out.push(makeAssignment([...chosen]));
      return;
    }
    for (const c of cands[i] ?? []) {
      if (used.has(c.string)) continue;
      used.add(c.string);
      chosen.push(c);
      walk(i + 1);
      chosen.pop();
      used.delete(c.string);
    }
  };
  walk(0);
  if (out.length === 0) {
    // More notes than strings (or unplayable pitches): keep each note's cheapest position.
    out.push(makeAssignment(cands.map((cs) => cs.reduce((a, b) => (b.fret < a.fret ? b : a), cs[0] ?? { string: 1, fret: 0 }))));
  }
  return out;
}

/**
 * Hand windows reachable after playing `a` from window `lo`, each with its shift cost. Staying put
 * is free when the fretted notes fit; otherwise every window that covers them is a candidate, so
 * the DP can anticipate the next notes instead of creeping up fret by fret.
 */
function transitions(lo: number, a: Assignment): { lo: number; cost: number }[] {
  if (a.minFret === null || a.maxFret === null) return [{ lo, cost: 0 }];
  if (lo !== UNSET && a.minFret >= lo && a.maxFret <= lo + windowWidth(lo)) return [{ lo, cost: 0 }];
  const out: { lo: number; cost: number }[] = [];
  for (let next = a.minFret; next >= 1 && a.maxFret <= next + windowWidth(next); next--) {
    out.push({ lo: next, cost: lo === UNSET ? 0 : COST_SHIFT + COST_SHIFT_PER_FRET * Math.abs(next - lo) });
  }
  if (out.length === 0) out.push({ lo: a.minFret, cost: lo === UNSET ? 0 : COST_SHIFT + COST_SHIFT_PER_FRET * Math.abs(a.minFret - lo) });
  return out;
}

/**
 * Assign strings/frets for `notes` given a tuning (high → low) and capo. Returns one position per
 * input note, in input order. Notes in one onset group (same time or same `chordId`) land on
 * distinct strings whenever that is possible. A pitch outside the instrument's range is placed an
 * octave (or more) up/down, so the caller should recompute `midi` from the returned position.
 */
export function assignFrets(notes: readonly FretAssignInput[], tuning: readonly number[], capo = 0): FretPosition[] {
  if (notes.length === 0 || tuning.length === 0) return notes.map(() => ({ string: 1, fret: 0 }));

  // Onset groups over notes in time order (stable for equal times).
  const order = notes.map((_, i) => i).sort((a, b) => (notes[a]?.time ?? 0) - (notes[b]?.time ?? 0) || a - b);
  const groups: number[][] = [];
  for (const idx of order) {
    const n = notes[idx] as FretAssignInput;
    const group = groups[groups.length - 1];
    const head = group ? (notes[group[0] as number] as FretAssignInput) : undefined;
    const together =
      head !== undefined &&
      (Math.abs(n.time - head.time) <= SAME_TIME || (n.chordId !== undefined && group?.some((g) => notes[g]?.chordId === n.chordId)));
    if (group && together) group.push(idx);
    else groups.push([idx]);
  }

  // DP over hand position. `dp` maps state lo → best cost; `back` records the path per group.
  let dp = new Map<number, number>([[UNSET, 0]]);
  const back: Map<number, { prev: number; assignment: Assignment }>[] = [];
  for (const group of groups) {
    const options = groupAssignments(group.map((i) => candidates((notes[i] as FretAssignInput).midi, tuning, capo)));
    const next = new Map<number, number>();
    const step = new Map<number, { prev: number; assignment: Assignment }>();
    for (const [lo, base] of dp) {
      for (const a of options) {
        for (const t of transitions(lo, a)) {
          const cost = base + a.cost + t.cost;
          if (cost < (next.get(t.lo) ?? Number.POSITIVE_INFINITY)) {
            next.set(t.lo, cost);
            step.set(t.lo, { prev: lo, assignment: a });
          }
        }
      }
    }
    back.push(step);
    dp = next;
  }

  // Backtrack from the cheapest final state.
  let state = UNSET;
  let best = Number.POSITIVE_INFINITY;
  for (const [lo, cost] of dp) {
    if (cost < best) {
      best = cost;
      state = lo;
    }
  }
  const out: FretPosition[] = new Array<FretPosition>(notes.length);
  for (let g = groups.length - 1; g >= 0; g--) {
    const entry = back[g]?.get(state);
    const group = groups[g];
    if (!entry || !group) break;
    group.forEach((noteIdx, k) => {
      out[noteIdx] = entry.assignment.positions[k] ?? { string: 1, fret: 0 };
    });
    state = entry.prev;
  }
  return out;
}
