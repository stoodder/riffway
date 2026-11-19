/**
 * Latency estimator (docs/timing.md § Latency calibration): pairs scheduled clicks with the events
 * the player (or a loopback cable) produced, drops the settling pairs, rejects outliers by MAD and
 * reports a robust offset with a consistency verdict. Pure and DOM-free, so it is unit-tested in Node
 * on simulated onsets (jitter, outliers, missed plucks, double triggers).
 *
 * All times are context seconds in the judge's domain: click times are the scheduled `when`s, event
 * times are uncalibrated (`frameToEventCtx(frame, sr, 0)` for the guitar, the heard-domain mapping
 * for keyboard taps). The resulting offset is what the judge subtracts from every event.
 * @module
 */
import { RETRIGGER_SEC } from '@core/judge/constants';

/** Click plan and acceptance rules (docs/timing.md). Tune here and update the doc. */
export const CALIBRATION = {
  /** Click tempo. */
  bpm: 90,
  /** Count-in clicks before the measured ones (1 bar of 4/4). */
  countInBeats: 4,
  /** Measured clicks. */
  clicks: 16,
  /** A click pairs with the nearest event within ± this (ms). */
  pairWindowMs: 250,
  /** The first pairs are dropped while the player settles in. */
  settlePairs: 2,
  /** Pairs further than `madK × MAD` from the median are rejected… */
  madK: 2.5,
  /** …but never closer than this (ms), so a near-perfect run (loopback, MAD ≈ 0) keeps its pairs. */
  minRejectMs: 5,
  /** At least this many pairs must survive. */
  minPairs: 8,
  /** And their spread (MAD, ms) must not exceed this. */
  maxSpreadMs: 15,
  /** Events closer than this to the previous one are detector double triggers (s; the judge's guard). */
  retriggerSec: RETRIGGER_SEC,
} as const;

/** Estimator options (defaults from {@link CALIBRATION}). */
export interface EstimatorOptions {
  pairWindowMs: number;
  settlePairs: number;
  madK: number;
  minRejectMs: number;
  minPairs: number;
  maxSpreadMs: number;
  retriggerSec: number;
}

/** What happened to a pair. */
export type PairStatus = 'settling' | 'kept' | 'rejected';

/** One click with the event paired to it. */
export interface CalibrationPair {
  /** Index of the click in the measured clicks. */
  click: number;
  clickCtx: number;
  eventCtx: number;
  /** `eventCtx − clickCtx` in ms (positive = the event came after the click). */
  deltaMs: number;
  status: PairStatus;
}

/** Why an estimate is not usable. */
export type CalibrationFailure = 'no-events' | 'too-few' | 'inconsistent';

/** How consistent a usable estimate is (spread ≤ 5 / ≤ 10 / ≤ 15 ms). */
export type CalibrationQuality = 'excellent' | 'good' | 'fair';

/** Result of {@link estimateOffset}. */
export interface OffsetEstimate {
  /** Usable: enough consistent pairs. */
  ok: boolean;
  failure: CalibrationFailure | null;
  /** Median delta of the kept pairs (ms); also set on `inconsistent` / `too-few` for display. */
  offsetMs: number | null;
  /** MAD of the kept pairs around `offsetMs` (ms). */
  spreadMs: number | null;
  quality: CalibrationQuality | null;
  /** Every paired click, in click order. */
  pairs: CalibrationPair[];
  /** Pairs that count (status `kept`). */
  kept: number;
  /** Measured clicks with no event within the pair window. */
  missed: number;
  /** Events in the measured span that paired with no click (strays, double triggers excluded). */
  extra: number;
}

/** Median of `xs` (NaN when empty). Does not modify `xs`. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median absolute deviation of `xs` around `center` (unscaled; NaN when empty). */
export function mad(xs: readonly number[], center = median(xs)): number {
  return median(xs.map((x) => Math.abs(x - center)));
}

/**
 * Collapse double triggers: an event within `retriggerSec` of the previous kept event is dropped
 * (the first one is the pluck). Returns sorted times.
 */
export function dedupeEvents(events: readonly number[], retriggerSec: number = CALIBRATION.retriggerSec): number[] {
  const sorted = [...events].filter(Number.isFinite).sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) if (out.length === 0 || t - out[out.length - 1]! >= retriggerSec) out.push(t);
  return out;
}

/**
 * Pair each click with the nearest event within ± `windowSec`, each event used at most once:
 * candidates are assigned greedily from the closest pair outwards, so a missed pluck never steals
 * its neighbour's onset. Returns, per click, the index into `events` or -1.
 */
export function pairClicks(clicks: readonly number[], events: readonly number[], windowSec: number): number[] {
  const cands: { c: number; e: number; d: number }[] = [];
  for (let c = 0; c < clicks.length; c++) {
    for (let e = 0; e < events.length; e++) {
      const d = Math.abs(events[e]! - clicks[c]!);
      if (d <= windowSec) cands.push({ c, e, d });
    }
  }
  cands.sort((a, b) => a.d - b.d || a.c - b.c);
  const byClick = new Array<number>(clicks.length).fill(-1);
  const used = new Set<number>();
  for (const { c, e } of cands) {
    if (byClick[c] !== -1 || used.has(e)) continue;
    byClick[c] = e;
    used.add(e);
  }
  return byClick;
}

/**
 * Estimate the offset between `clicks` (measured click times) and the `events` the player produced
 * (docs/timing.md § Latency calibration):
 * 1. collapse double triggers, pair each click with the nearest event within ±250 ms;
 * 2. drop the first 2 pairs (settling);
 * 3. reject pairs further than `max(2.5 × MAD, 5 ms)` from the median;
 * 4. `offsetMs` = median of the rest; usable with ≥ 8 pairs and spread (MAD) ≤ 15 ms.
 */
export function estimateOffset(
  clicks: readonly number[],
  events: readonly number[],
  options: Partial<EstimatorOptions> = {},
): OffsetEstimate {
  const o: EstimatorOptions = { ...CALIBRATION, ...options };
  const evs = dedupeEvents(events, o.retriggerSec);
  const assignment = pairClicks(clicks, evs, o.pairWindowMs / 1000);

  const pairs: CalibrationPair[] = [];
  assignment.forEach((e, c) => {
    if (e < 0) return;
    const clickCtx = clicks[c]!;
    const eventCtx = evs[e]!;
    pairs.push({ click: c, clickCtx, eventCtx, deltaMs: (eventCtx - clickCtx) * 1000, status: 'kept' });
  });
  const missed = clicks.length - pairs.length;
  const used = new Set(assignment.filter((e) => e >= 0));
  const spanStart = clicks.length ? Math.min(...clicks) - o.pairWindowMs / 1000 : 0;
  const spanEnd = clicks.length ? Math.max(...clicks) + o.pairWindowMs / 1000 : 0;
  const extra = evs.filter((t, i) => !used.has(i) && t >= spanStart && t <= spanEnd).length;

  const base = { pairs, missed, extra };
  if (pairs.length === 0) {
    return { ...base, ok: false, failure: 'no-events', offsetMs: null, spreadMs: null, quality: null, kept: 0 };
  }

  for (const p of pairs.slice(0, o.settlePairs)) p.status = 'settling';
  const candidates = pairs.filter((p) => p.status !== 'settling');
  const deltas = candidates.map((p) => p.deltaMs);
  const med = median(deltas);
  const limit = Math.max(o.madK * mad(deltas, med), o.minRejectMs);
  for (const p of candidates) if (Math.abs(p.deltaMs - med) > limit) p.status = 'rejected';

  const keptDeltas = pairs.filter((p) => p.status === 'kept').map((p) => p.deltaMs);
  const kept = keptDeltas.length;
  if (kept === 0) {
    return { ...base, ok: false, failure: 'too-few', offsetMs: null, spreadMs: null, quality: null, kept };
  }
  const offsetMs = median(keptDeltas);
  const spreadMs = mad(keptDeltas, offsetMs);
  let failure: CalibrationFailure | null = null;
  if (kept < o.minPairs) failure = 'too-few';
  else if (spreadMs > o.maxSpreadMs) failure = 'inconsistent';
  return {
    ...base,
    ok: failure === null,
    failure,
    offsetMs,
    spreadMs,
    quality: failure === null ? qualityFor(spreadMs) : null,
    kept,
  };
}

/** Quality band for a spread (ms) that passed the acceptance rule. */
export function qualityFor(spreadMs: number): CalibrationQuality {
  if (spreadMs <= 5) return 'excellent';
  if (spreadMs <= 10) return 'good';
  return 'fair';
}
