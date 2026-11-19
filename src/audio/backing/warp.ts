/**
 * Backing-audio warp model (docs/timing.md § Backing audio alignment). Pure and DOM-free.
 *
 * An `AudioLink` maps song time (seconds at 100%) to audio-file time with **anchors**
 * `[{songTime, audioTime}]`:
 * - 1 anchor = pure offset: `audioTime = songTime + (a0.audioTime − a0.songTime)`.
 * - 2+ anchors = piecewise-linear warp; the slope between two anchors absorbs tempo drift.
 *   Outside the anchors the nearest segment's slope is extrapolated.
 *
 * Slope = audio seconds per song second; the stretcher plays at `rate = speed × slope`.
 * @module
 */
import type { WarpAnchor } from '@shared/storage';

/** Smallest accepted warp slope (audio runs at most 2× faster than the tab). */
export const MIN_SLOPE = 0.5;
/** Largest accepted warp slope (audio runs at most 2× slower than the tab). */
export const MAX_SLOPE = 2;
/** Anchors closer than this in song time are rejected (s). */
export const MIN_ANCHOR_GAP = 0.05;

/** The default link alignment: song 0 = audio 0. */
export const DEFAULT_ANCHORS: readonly WarpAnchor[] = Object.freeze([Object.freeze({ songTime: 0, audioTime: 0 })]);

/** Thrown by {@link normalizeAnchors} for an unusable anchor list. */
export class WarpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarpError';
  }
}

const slopeBetween = (a: WarpAnchor, b: WarpAnchor): number => (b.audioTime - a.audioTime) / (b.songTime - a.songTime);

/** True when two consecutive anchors form a valid warp segment. */
function validPair(a: WarpAnchor, b: WarpAnchor): boolean {
  if (b.songTime - a.songTime < MIN_ANCHOR_GAP) return false;
  const k = slopeBetween(a, b);
  return k >= MIN_SLOPE - 1e-12 && k <= MAX_SLOPE + 1e-12;
}

/**
 * Validate and sort anchors (copies). An empty list becomes {@link DEFAULT_ANCHORS}. Throws
 * {@link WarpError} for non-finite values, anchors closer than {@link MIN_ANCHOR_GAP}, or a
 * segment slope outside [{@link MIN_SLOPE}, {@link MAX_SLOPE}] (which includes audio time going
 * backwards).
 */
export function normalizeAnchors(anchors: readonly WarpAnchor[]): WarpAnchor[] {
  if (anchors.length === 0) return DEFAULT_ANCHORS.map((a) => ({ ...a }));
  const out = anchors.map((a) => ({ songTime: a.songTime, audioTime: a.audioTime }));
  for (const a of out) {
    if (!Number.isFinite(a.songTime) || !Number.isFinite(a.audioTime)) throw new WarpError('Anchor times must be finite numbers');
  }
  out.sort((a, b) => a.songTime - b.songTime);
  for (let i = 1; i < out.length; i++) {
    if (!validPair(out[i - 1]!, out[i]!)) {
      throw new WarpError(
        `Anchors at ${out[i - 1]!.songTime.toFixed(3)} s and ${out[i]!.songTime.toFixed(3)} s give an impossible tempo ratio`,
      );
    }
  }
  return out;
}

/** Index of the warp segment used at `songTime` (left anchor index; clamped for extrapolation). */
function segmentIndex(anchors: readonly WarpAnchor[], songTime: number): number {
  const last = anchors.length - 2;
  if (last <= 0) return 0;
  // Binary search for the last anchor with songTime ≤ t among anchors[0..last].
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (anchors[mid]!.songTime <= songTime) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Warp slope at `songTime`: audio seconds per song second. Right-continuous: at an interior anchor
 * it is the slope of the segment that starts there. 1 for a single anchor.
 */
export function slopeAt(anchors: readonly WarpAnchor[], songTime: number): number {
  if (anchors.length < 2) return 1;
  const i = segmentIndex(anchors, songTime);
  return slopeBetween(anchors[i]!, anchors[i + 1]!);
}

/** Audio-file time heard at `songTime` (piecewise linear, extrapolated outside the anchors). */
export function audioTimeAt(anchors: readonly WarpAnchor[], songTime: number): number {
  const a0 = anchors[0];
  if (!a0) return songTime;
  if (anchors.length === 1) return songTime + (a0.audioTime - a0.songTime);
  const i = segmentIndex(anchors, songTime);
  const a = anchors[i]!;
  return a.audioTime + (songTime - a.songTime) * slopeBetween(a, anchors[i + 1]!);
}

/** Inverse of {@link audioTimeAt}: song time at which `audioTime` is heard. */
export function songTimeAtAudio(anchors: readonly WarpAnchor[], audioTime: number): number {
  const a0 = anchors[0];
  if (!a0) return audioTime;
  if (anchors.length === 1) return audioTime - (a0.audioTime - a0.songTime);
  const last = anchors.length - 2;
  let i = 0;
  while (i < last && anchors[i + 1]!.audioTime <= audioTime) i++;
  const a = anchors[i]!;
  return a.songTime + (audioTime - a.audioTime) / slopeBetween(a, anchors[i + 1]!);
}

/**
 * Song times in the open interval `(from, to)` where the slope changes (interior anchors only:
 * the first and last anchors extend their segment's slope). Ascending.
 */
export function slopeChangesIn(anchors: readonly WarpAnchor[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < anchors.length - 1; i++) {
    const t = anchors[i]!.songTime;
    if (t > from && t < to) out.push(t);
  }
  return out;
}

/**
 * Shift every anchor by `deltaSec` of audio time. Positive = the audio is read further ahead, so the
 * backing is heard **earlier** relative to the tab.
 */
export function shiftAnchors(anchors: readonly WarpAnchor[], deltaSec: number): WarpAnchor[] {
  return anchors.map((a) => ({ songTime: a.songTime, audioTime: a.audioTime + deltaSec }));
}

/** Nudge the backing later (`laterMs > 0`) or earlier (`< 0`) relative to the tab. */
export function nudgeAnchors(anchors: readonly WarpAnchor[], laterMs: number): WarpAnchor[] {
  return shiftAnchors(anchors, -laterMs / 1000);
}

/** Shift the whole warp so that `songTime` is heard at `audioTime` (slopes unchanged). */
export function alignPoint(anchors: readonly WarpAnchor[], songTime: number, audioTime: number): WarpAnchor[] {
  return shiftAnchors(anchors, audioTime - audioTimeAt(anchors, songTime));
}

/**
 * Merge new anchors (e.g. from a tap-along over one passage) into an existing warp. The new anchors
 * are authoritative: existing anchors inside their song-time range are dropped; outside it, the
 * nearest existing anchors are kept while they still form valid segments with the result. A single
 * existing anchor (pure offset) is replaced entirely, so the first tap-along defines offset and tempo
 * for the whole song. Throws {@link WarpError} when `incoming` itself is invalid.
 */
export function mergeAnchors(existing: readonly WarpAnchor[], incoming: readonly WarpAnchor[]): WarpAnchor[] {
  const fresh = normalizeAnchors(incoming);
  if (existing.length <= 1 || incoming.length === 0) return fresh;
  const lo = fresh[0]!.songTime - MIN_ANCHOR_GAP;
  const hi = fresh[fresh.length - 1]!.songTime + MIN_ANCHOR_GAP;
  const sorted = [...existing].sort((a, b) => a.songTime - b.songTime);
  const left = sorted.filter((a) => a.songTime < lo).reverse();
  const right = sorted.filter((a) => a.songTime > hi);
  const out = fresh;
  for (const a of left) {
    if (!validPair(a, out[0]!)) break;
    out.unshift({ ...a });
  }
  for (const a of right) {
    if (!validPair(out[out.length - 1]!, a)) break;
    out.push({ ...a });
  }
  return out;
}

/** Human-readable summary of a warp for the alignment panel. */
export interface WarpSummary {
  /** Audio time at song time 0, ms (where the tab's start lands in the recording). */
  offsetMs: number;
  /** Overall slope between the outermost anchors (1 for a pure offset). */
  slope: number;
  /** Recording tempo relative to the tab, % (`100 / slope`). */
  tempoPercent: number;
  /** Number of anchors. */
  anchors: number;
}

/** Summarise a warp: offset at song 0, overall slope and tempo ratio. */
export function summarizeWarp(anchors: readonly WarpAnchor[]): WarpSummary {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const slope = first && last && anchors.length > 1 ? slopeBetween(first, last) : 1;
  return {
    offsetMs: audioTimeAt(anchors, 0) * 1000,
    slope,
    tempoPercent: 100 / slope,
    anchors: anchors.length,
  };
}
