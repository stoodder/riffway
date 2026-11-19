/**
 * Latency estimator on simulated players (docs/timing.md § Latency calibration): pairing, settling,
 * MAD rejection, acceptance thresholds and failure reasons.
 */
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION,
  clickPlan,
  dedupeEvents,
  estimateOffset,
  mad,
  measuredTimes,
  median,
  pairClicks,
  qualityFor,
} from '../../src/audio/calibration';
import { simulate } from './helpers';

const clicks = measuredTimes(clickPlan(10));

describe('click plan', () => {
  it('is one bar of count-in then 16 measured clicks at 90 BPM, downbeats accented', () => {
    const plan = clickPlan(2);
    expect(plan).toHaveLength(20);
    expect(plan.filter((c) => !c.measured)).toHaveLength(4);
    expect(plan.slice(0, 4).every((c) => !c.measured)).toBe(true);
    expect(plan[1]!.ctxTime - plan[0]!.ctxTime).toBeCloseTo(60 / 90, 12);
    expect(plan.map((c) => c.accent)).toEqual(plan.map((_, i) => i % 4 === 0));
    expect(measuredTimes(plan)[0]).toBeCloseTo(2 + 4 * (60 / 90), 12);
  });
});

describe('median / MAD / dedupe', () => {
  it('computes medians of odd and even lists without mutating them', () => {
    const xs = [5, 1, 3];
    expect(median(xs)).toBe(3);
    expect(xs).toEqual([5, 1, 3]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
  });

  it('collapses double triggers within 50 ms and keeps the first', () => {
    expect(dedupeEvents([1.03, 1, 2, 1.06, 2.049])).toEqual([1, 1.06, 2]);
  });
});

describe('pairClicks', () => {
  it('pairs each click with the nearest event within the window, each event once', () => {
    expect(pairClicks([1, 2, 3], [1.04, 2.3, 2.9], 0.25)).toEqual([0, -1, 2]);
    // A missed click never steals its neighbour's event, even when both are in range.
    expect(pairClicks([1, 1.3], [1.05], 0.25)).toEqual([0, -1]);
    expect(pairClicks([1, 1.3], [1.2], 0.25)).toEqual([-1, 0]);
  });
});

describe('estimateOffset', () => {
  it('recovers a clean offset exactly', () => {
    const r = estimateOffset(clicks, simulate(clicks, { offsetMs: 37 }));
    expect(r.ok).toBe(true);
    expect(r.offsetMs).toBeCloseTo(37, 6);
    expect(r.spreadMs).toBeCloseTo(0, 6);
    expect(r.quality).toBe('excellent');
    expect(r.kept).toBe(14);
    expect(r.pairs.slice(0, 2).map((p) => p.status)).toEqual(['settling', 'settling']);
    expect(r.missed).toBe(0);
    expect(r.extra).toBe(0);
  });

  it('stays close with 6 ms jitter across many seeds (median of 14 pairs: σ ≈ 2 ms)', () => {
    const errors: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const r = estimateOffset(clicks, simulate(clicks, { offsetMs: 42, jitterMs: 6, seed }));
      expect(r.ok, `seed ${seed}`).toBe(true);
      errors.push(Math.abs(r.offsetMs! - 42));
    }
    expect(Math.max(...errors)).toBeLessThan(8);
    expect(errors.filter((e) => e <= 3).length / errors.length).toBeGreaterThan(0.75);
  });

  it('is within ±4 ms with 3 ms jitter for every seed (95 % within ±2.5 ms)', () => {
    const errors: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const r = estimateOffset(clicks, simulate(clicks, { offsetMs: 42, jitterMs: 3, seed }));
      errors.push(Math.abs(r.offsetMs! - 42));
    }
    expect(Math.max(...errors)).toBeLessThanOrEqual(4);
    expect(errors.filter((e) => e <= 2.5).length / errors.length).toBeGreaterThanOrEqual(0.95);
  });

  it('rejects outliers beyond 2.5 × MAD and is not pulled by them', () => {
    const events = simulate(clicks, { offsetMs: 30, jitterMs: 3, outliers: { 5: 120, 9: -150, 12: 90 }, seed: 3 });
    const r = estimateOffset(clicks, events);
    expect(r.ok).toBe(true);
    expect(Math.abs(r.offsetMs! - 30)).toBeLessThan(2.5);
    const rejected = r.pairs.filter((p) => p.status === 'rejected').map((p) => p.click);
    expect(rejected).toEqual(expect.arrayContaining([5, 9, 12]));
    // The mean would have been dragged far off.
    const kept = r.pairs.filter((p) => p.status !== 'settling').map((p) => p.deltaMs);
    expect(Math.abs(kept.reduce((a, b) => a + b, 0) / kept.length - 30)).toBeGreaterThan(3);
  });

  it('copes with missed plucks, double triggers and strays', () => {
    const events = simulate(clicks, { offsetMs: 55, jitterMs: 4, missed: [3, 7, 11], doubles: [2, 8], strays: [clicks[5]! + 0.33], seed: 9 });
    const r = estimateOffset(clicks, events);
    expect(r.ok).toBe(true);
    expect(Math.abs(r.offsetMs! - 55)).toBeLessThan(3);
    expect(r.missed).toBe(3);
    expect(r.extra).toBe(1);
    expect(r.pairs.every((p) => Math.abs(p.deltaMs - 55) < 20 || p.status !== 'kept')).toBe(true);
  });

  it('drops the first two pairs even when the first clicks were missed', () => {
    const events = simulate(clicks, { offsetMs: 20, missed: [0], outliers: { 1: 200, 2: -180 } });
    const r = estimateOffset(clicks, events);
    expect(r.pairs.filter((p) => p.status === 'settling').map((p) => p.click)).toEqual([1, 2]);
    expect(r.offsetMs).toBeCloseTo(20, 6);
  });

  it('handles negative offsets (player habitually early)', () => {
    const r = estimateOffset(clicks, simulate(clicks, { offsetMs: -25, jitterMs: 4, seed: 4 }));
    expect(r.ok).toBe(true);
    expect(Math.abs(r.offsetMs! + 25)).toBeLessThan(3);
  });

  it('keeps near-identical loopback pairs (minimum rejection distance)', () => {
    const events = simulate(clicks, { offsetMs: 38.2, jitterMs: 0.05, seed: 2 });
    const r = estimateOffset(clicks, events);
    expect(r.kept).toBe(14);
    expect(r.offsetMs).toBeCloseTo(38.2, 1);
    expect(r.quality).toBe('excellent');
  });

  it('fails with "no-events" when nothing was played', () => {
    const r = estimateOffset(clicks, []);
    expect(r).toMatchObject({ ok: false, failure: 'no-events', offsetMs: null, kept: 0, missed: 16 });
    // Events far from every click are not pairs either.
    expect(estimateOffset(clicks, [clicks[0]! - 2]).failure).toBe('no-events');
  });

  it('fails with "too-few" below 8 valid pairs, but still reports the provisional offset', () => {
    const missed = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const r = estimateOffset(clicks, simulate(clicks, { offsetMs: 40, missed }));
    expect(r.kept).toBe(5);
    expect(r.failure).toBe('too-few');
    expect(r.ok).toBe(false);
    expect(r.offsetMs).toBeCloseTo(40, 6);
    expect(r.quality).toBeNull();
  });

  it('accepts exactly 8 pairs', () => {
    const r = estimateOffset(clicks, simulate(clicks, { offsetMs: 40, missed: [10, 11, 12, 13, 14, 15] }));
    expect(r.kept).toBe(8);
    expect(r.ok).toBe(true);
  });

  it('fails with "inconsistent" when the spread exceeds 15 ms', () => {
    // Deltas alternate ±20 ms around 50: MAD = 20 ms, nothing is rejected (2.5 × MAD = 50 ms).
    const events = clicks.map((c, i) => c + (50 + (i % 2 ? 20 : -20)) / 1000);
    const r = estimateOffset(clicks, events);
    expect(r.failure).toBe('inconsistent');
    expect(r.spreadMs).toBeCloseTo(20, 6);
    expect(r.ok).toBe(false);
  });

  it('accepts a spread of exactly 15 ms and grades quality', () => {
    const events = clicks.map((c, i) => c + (50 + (i % 2 ? 15 : -15)) / 1000);
    const r = estimateOffset(clicks, events);
    expect(r.spreadMs).toBeCloseTo(15, 6);
    expect(r.ok).toBe(true);
    expect(r.quality).toBe('fair');
    expect(qualityFor(5)).toBe('excellent');
    expect(qualityFor(5.1)).toBe('good');
    expect(qualityFor(10)).toBe('good');
    expect(qualityFor(10.1)).toBe('fair');
  });

  it('ignores events outside ±250 ms of every click', () => {
    const events = clicks.map((c) => c + 0.26);
    expect(estimateOffset(clicks, events).failure).toBe('no-events');
    expect(CALIBRATION.pairWindowMs).toBe(250);
  });

  it('pairs a late player to the click they meant, not the next one', () => {
    // 230 ms late at 90 BPM (667 ms between clicks): still nearest to its own click.
    const r = estimateOffset(clicks, simulate(clicks, { offsetMs: 230, jitterMs: 3, seed: 5 }));
    expect(r.ok).toBe(true);
    expect(Math.abs(r.offsetMs! - 230)).toBeLessThan(3);
  });
});
