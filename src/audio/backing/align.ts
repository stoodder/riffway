/**
 * Tap-along alignment math (pure, DOM-free). The player taps the beat of the backing recording,
 * starting on a chosen downbeat; taps are matched to the tab's beat grid and fitted to
 * `audioTime = offset + slope × songTime` (offset + tempo ratio), which becomes warp anchors.
 *
 * - 1 tap (or a short span): offset only — the warp is shifted so the start beat lands on the tap.
 * - Taps spanning ≥ {@link MIN_FIT_SPAN_SEC} of song time with ≥ {@link MIN_FIT_TAPS} matches: a least-squares
 *   line with one round of outlier rejection, turned into two anchors at the first and last matched
 *   beats ({@link mergeAnchors} then merges them into an existing piecewise warp).
 * @module
 */
import type { WarpAnchor } from '@shared/storage';
import { MAX_SLOPE, MIN_SLOPE, alignPoint, mergeAnchors, slopeAt } from './warp';

/** Taps needed before the tempo ratio is fitted (fewer → offset only). */
export const MIN_FIT_TAPS = 4;
/** Song-time span the matched taps must cover before the tempo ratio is fitted (s). */
export const MIN_FIT_SPAN_SEC = 2;
/** A tap further than this fraction of a beat from its predicted beat is ignored as a stray. */
export const MATCH_TOLERANCE_BEATS = 0.35;
/** Residuals above `max(OUTLIER_MAD × MAD, OUTLIER_FLOOR_SEC)` are dropped before the final fit. */
const OUTLIER_MAD = 3;
const OUTLIER_FLOOR_SEC = 0.02;

/** One tap matched to a beat. */
export interface TapMatch {
  /** Index into the beat list. */
  beat: number;
  songTime: number;
  /** Audio-file time of the tap (s). */
  audioTime: number;
}

/**
 * Match taps (audio-file times, ascending) to beats, starting with `taps[0]` on `beats[startBeat]`.
 * Each later tap goes to the nearest beat after the previous match, predicted with the running
 * offset + slope estimate (initially the current warp's slope); taps further than
 * {@link MATCH_TOLERANCE_BEATS} of a beat from any candidate are dropped as strays, and skipped beats
 * are allowed (the player may tap only downbeats).
 */
export function matchTaps(
  taps: readonly number[],
  beats: readonly number[],
  startBeat: number,
  initialSlope = 1,
): TapMatch[] {
  if (taps.length === 0 || startBeat < 0 || startBeat >= beats.length) return [];
  const out: TapMatch[] = [{ beat: startBeat, songTime: beats[startBeat]!, audioTime: taps[0]! }];
  let slope = clampSlope(initialSlope);
  for (let k = 1; k < taps.length; k++) {
    const prev = out[out.length - 1]!;
    if (out.length >= 3) slope = clampSlope(leastSquares(out).slope);
    const predicted = prev.songTime + (taps[k]! - prev.audioTime) / slope;
    let best = -1;
    for (let j = prev.beat + 1; j < beats.length; j++) {
      if (best < 0 || Math.abs(beats[j]! - predicted) < Math.abs(beats[best]! - predicted)) best = j;
      if (beats[j]! > predicted) break;
    }
    if (best < 0) break;
    const period = localPeriod(beats, best);
    if (Math.abs(beats[best]! - predicted) > MATCH_TOLERANCE_BEATS * period) continue;
    out.push({ beat: best, songTime: beats[best]!, audioTime: taps[k]! });
  }
  return out;
}

function localPeriod(beats: readonly number[], i: number): number {
  const next = beats[i + 1];
  const prev = beats[i - 1];
  if (next !== undefined) return next - beats[i]!;
  if (prev !== undefined) return beats[i]! - prev;
  return 0.5;
}

const clampSlope = (k: number): number => (Number.isFinite(k) ? Math.min(MAX_SLOPE, Math.max(MIN_SLOPE, k)) : 1);

/** Least-squares `audio = offset + slope × song` over the matches (slope 1 when degenerate). */
function leastSquares(m: readonly TapMatch[]): { offset: number; slope: number } {
  const n = m.length;
  const ms = m.reduce((s, p) => s + p.songTime, 0) / n;
  const ma = m.reduce((s, p) => s + p.audioTime, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of m) {
    sxy += (p.songTime - ms) * (p.audioTime - ma);
    sxx += (p.songTime - ms) ** 2;
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 1;
  return { offset: ma - slope * ms, slope };
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Result of {@link fitTaps}. */
export interface TapFit {
  /** `'offset'`: shift only (too few taps / too short); `'tempo'`: offset + tempo ratio. */
  kind: 'offset' | 'tempo';
  /** Anchors produced by the fit (1 for offset, 2 for tempo). */
  anchors: WarpAnchor[];
  /** Audio seconds per song second of the fit (the existing slope for `'offset'`). */
  slope: number;
  /** RMS residual of the used taps (ms). */
  residualMs: number;
  /** Matches used after outlier rejection. */
  used: TapMatch[];
  /** Matches rejected as outliers. */
  rejected: TapMatch[];
}

/**
 * Fit matched taps. With fewer than {@link MIN_FIT_TAPS} matches or a span under
 * {@link MIN_FIT_SPAN_SEC}, keeps `currentSlope` and fits the offset (mean residual, one anchor on the
 * first matched beat). Otherwise fits offset + slope by least squares, drops outliers once and refits;
 * a slope outside the warp limits falls back to the offset fit. Returns null for no matches.
 */
export function fitTaps(matches: readonly TapMatch[], currentSlope = 1): TapFit | null {
  if (matches.length === 0) return null;
  const span = matches[matches.length - 1]!.songTime - matches[0]!.songTime;
  const offsetFit = (used: readonly TapMatch[], rejected: TapMatch[]): TapFit => {
    const k = clampSlope(currentSlope);
    const offset = median(used.map((p) => p.audioTime - k * p.songTime));
    const first = used[0]!;
    return {
      kind: 'offset',
      anchors: [{ songTime: first.songTime, audioTime: offset + k * first.songTime }],
      slope: k,
      residualMs: rms(used, offset, k),
      used: [...used],
      rejected,
    };
  };
  if (matches.length < MIN_FIT_TAPS || span < MIN_FIT_SPAN_SEC) return offsetFit(matches, []);

  let fit = leastSquares(matches);
  const residuals = matches.map((p) => p.audioTime - (fit.offset + fit.slope * p.songTime));
  const mad = median(residuals.map((r) => Math.abs(r - median(residuals))));
  const limit = Math.max(OUTLIER_MAD * mad, OUTLIER_FLOOR_SEC);
  const used = matches.filter((_, i) => Math.abs(residuals[i]!) <= limit);
  const rejected = matches.filter((_, i) => Math.abs(residuals[i]!) > limit);
  if (used.length < MIN_FIT_TAPS) return offsetFit(matches, []);
  fit = leastSquares(used);
  if (fit.slope < MIN_SLOPE || fit.slope > MAX_SLOPE) return offsetFit(used, rejected);
  const a = used[0]!.songTime;
  const b = used[used.length - 1]!.songTime;
  return {
    kind: 'tempo',
    anchors: [
      { songTime: a, audioTime: fit.offset + fit.slope * a },
      { songTime: b, audioTime: fit.offset + fit.slope * b },
    ],
    slope: fit.slope,
    residualMs: rms(used, fit.offset, fit.slope),
    used,
    rejected,
  };
}

function rms(m: readonly TapMatch[], offset: number, slope: number): number {
  const sq = m.reduce((s, p) => s + (p.audioTime - offset - slope * p.songTime) ** 2, 0);
  return Math.sqrt(sq / m.length) * 1000;
}

/**
 * Apply a tap fit to the current anchors: an offset fit shifts the whole warp so the fitted line
 * passes through the first matched beat; a tempo fit is merged with {@link mergeAnchors}.
 */
export function applyTapFit(current: readonly WarpAnchor[], fit: TapFit): WarpAnchor[] {
  if (fit.kind === 'offset') {
    const a = fit.anchors[0]!;
    return alignPoint(current, a.songTime, a.audioTime);
  }
  return mergeAnchors(current, fit.anchors);
}

/**
 * Convenience: taps → matches → fit → new anchors. Returns null when no tap matched. The initial
 * slope for matching is the current warp's slope at the start beat.
 */
export function alignFromTaps(
  current: readonly WarpAnchor[],
  taps: readonly number[],
  beats: readonly number[],
  startBeat: number,
): { anchors: WarpAnchor[]; fit: TapFit } | null {
  const start = beats[startBeat];
  if (start === undefined) return null;
  const k = slopeAt(current, start);
  const fit = fitTaps(matchTaps(taps, beats, startBeat, k), k);
  if (!fit) return null;
  return { anchors: applyTapFit(current, fit), fit };
}
