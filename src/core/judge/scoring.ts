/**
 * Scoring primitives (docs/game-mechanics.md § Combo, score, accuracy, stars): grades from timing,
 * early/late labels, multiplier tiers, stars, the timing histogram, combo tracking in note order and
 * per-pass statistics. Pure.
 * @module
 */
import type { Judgement, Outcome, Stars, TimingHistogram, TimingLabel, TimingWindows } from '@shared/judge';
import {
  CLEAN_ACCURACY,
  CLEAN_MAX_CONSECUTIVE_MISSES,
  HISTOGRAM,
  MULTIPLIER_STEPS,
  STAR_THRESHOLDS,
  TIME_EPS_SEC,
} from './constants';

/** A hit outcome. */
export type HitOutcome = 'Perfect' | 'Great' | 'Good';

/** True for Perfect / Great / Good (DEC-15: a hit is Good or better with the correct pitch). */
export function isHit(outcome: Outcome): outcome is HitOutcome {
  return outcome === 'Perfect' || outcome === 'Great' || outcome === 'Good';
}

/**
 * Timing grade for `deltaSec` (real seconds): `|Δ| ≤ perfect` → Perfect, `≤ great` → Great,
 * `≤ good` → Good, else `null` (outside every window). Edges are inclusive within 1 µs.
 */
export function gradeFor(deltaSec: number, windows: TimingWindows): HitOutcome | null {
  const abs = Math.abs(deltaSec);
  if (abs <= windows.perfect + TIME_EPS_SEC) return 'Perfect';
  if (abs <= windows.great + TIME_EPS_SEC) return 'Great';
  if (abs <= windows.good + TIME_EPS_SEC) return 'Good';
  return null;
}

/** Early/late label: only when `|Δ|` is beyond the Great window (bandwidth feedback), else `null`. */
export function timingLabelFor(deltaSec: number, windows: TimingWindows): TimingLabel {
  if (Math.abs(deltaSec) <= windows.great + TIME_EPS_SEC) return null;
  return deltaSec < 0 ? 'early' : 'late';
}

/** Combo → multiplier (0–9 ×1, 10–19 ×2, 20–29 ×3, 30+ ×4). */
export function multiplierFor(combo: number): 1 | 2 | 3 | 4 {
  let tier = 1;
  for (const step of MULTIPLIER_STEPS) if (combo >= step) tier++;
  return tier as 1 | 2 | 3 | 4;
}

/** Accuracy % → stars (≥ 50/70/80/90/97). */
export function starsFor(accuracy: number): Stars {
  let stars = 0;
  for (const threshold of STAR_THRESHOLDS) if (accuracy + 1e-9 >= threshold) stars++;
  return stars as Stars;
}

/** Accuracy % from hit notes over judged notes (0 when nothing is judged). */
export function accuracyOf(hitNotes: number, judgedNotes: number): number {
  return judgedNotes > 0 ? (hitNotes * 100) / judgedNotes : 0;
}

/** Clean-run rule: accuracy ≥ 90% and at most 2 non-hit groups in a row. */
export function isCleanRun(accuracy: number, maxConsecutiveMisses: number): boolean {
  return accuracy + 1e-9 >= CLEAN_ACCURACY && maxConsecutiveMisses <= CLEAN_MAX_CONSECUTIVE_MISSES;
}

/** An empty timing histogram (−120 … +120 ms in 10 ms bins). */
export function emptyHistogram(): TimingHistogram {
  const bins = new Array<number>((HISTOGRAM.maxMs - HISTOGRAM.minMs) / HISTOGRAM.binMs).fill(0);
  return { binMs: HISTOGRAM.binMs, minMs: HISTOGRAM.minMs, bins };
}

/** Add one delta (ms) to `hist`; values outside the range land in the first / last bin. */
export function addToHistogram(hist: TimingHistogram, deltaMs: number): void {
  const raw = Math.floor((deltaMs - hist.minMs) / hist.binMs);
  const idx = Math.min(hist.bins.length - 1, Math.max(0, raw));
  hist.bins[idx] = (hist.bins[idx] ?? 0) + 1;
}

/**
 * Combo in **note order**: the combo is the number of hit groups after the latest break (WrongNote or
 * Miss) in song order, across loop passes. A break that is finalised late (a Miss closes 120 ms after
 * its note) therefore keeps the hits on later notes that were already registered.
 */
export class ComboTracker {
  private lastBreak = -Infinity;
  /** Order keys of hits after `lastBreak`, ascending. */
  private keys: number[] = [];
  private best = 0;

  /** Current combo. */
  get combo(): number {
    return this.keys.length;
  }

  /** Highest combo so far. */
  get maxCombo(): number {
    return this.best;
  }

  /** Register a hit at `key` (pass-major note order). */
  hit(key: number): void {
    if (key <= this.lastBreak) return;
    const idx = upperBound(this.keys, key);
    this.keys.splice(idx, 0, key);
    if (this.keys.length > this.best) this.best = this.keys.length;
  }

  /** Register a break at `key`: hits at or before it no longer count. */
  break(key: number): void {
    if (key <= this.lastBreak) return;
    this.lastBreak = key;
    this.keys = this.keys.slice(upperBound(this.keys, key));
  }
}

/** First index in sorted `arr` whose value is > `v`. */
function upperBound(arr: readonly number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as number) <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Longest run of `true` in `flags`. */
export function longestRun(flags: Iterable<boolean>): number {
  let best = 0;
  let run = 0;
  for (const f of flags) {
    run = f ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** Statistics of one loop pass (or any subset of judgements), as the speed trainer needs them. */
export interface PassStats {
  judgedNotes: number;
  hitNotes: number;
  /** % (DEC-15). */
  accuracy: number;
  /** Longest run of non-hit groups (WrongNote/Miss) in note order. */
  maxConsecutiveMisses: number;
  /** Clean-run rule (≥ 90% and ≤ 2 non-hits in a row). */
  clean: boolean;
}

/**
 * Per-pass statistics from a judgement stream (as emitted by the judge; provisional judgements are
 * superseded by the final one for the same notes). Only final judgements count.
 *
 * @param pass Restrict to this loop pass; omit for all.
 */
export function passStats(judgements: readonly Judgement[], pass?: number): PassStats {
  const latest = new Map<string, Judgement>();
  for (const j of judgements) {
    if (pass !== undefined && j.pass !== pass) continue;
    latest.set(`${j.pass}:${j.noteIds[0] ?? -1}`, j);
  }
  const finals = [...latest.values()].filter((j) => j.final).sort((a, b) => a.pass - b.pass || a.songTime - b.songTime);
  let judgedNotes = 0;
  let hitNotes = 0;
  for (const j of finals) {
    judgedNotes += j.noteIds.length;
    if (isHit(j.outcome)) hitNotes += j.noteIds.length;
  }
  const accuracy = accuracyOf(hitNotes, judgedNotes);
  const maxConsecutiveMisses = longestRun(finals.map((j) => !isHit(j.outcome)));
  return { judgedNotes, hitNotes, accuracy, maxConsecutiveMisses, clean: judgedNotes > 0 && isCleanRun(accuracy, maxConsecutiveMisses) };
}
