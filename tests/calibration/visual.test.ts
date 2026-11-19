/**
 * Visual offset maths (same formula as the highway: drawn time = heard − offset) and the endless
 * click loop on a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClickLoop, VISUAL_OFFSET, clampVisualOffset, nudgeVisualOffset, visualFrame } from '../../src/audio/calibration';

describe('visual offset', () => {
  it('clamps, rounds and nudges in 5 ms steps', () => {
    expect(VISUAL_OFFSET.step).toBe(5);
    expect(nudgeVisualOffset(0, 1)).toBe(5);
    expect(nudgeVisualOffset(-3, -2)).toBe(-13);
    expect(nudgeVisualOffset(148, 1)).toBe(VISUAL_OFFSET.max);
    expect(clampVisualOffset(-400)).toBe(VISUAL_OFFSET.min);
    expect(clampVisualOffset(Number.NaN)).toBe(0);
    expect(clampVisualOffset(12.4)).toBe(12);
  });

  it('flashes when a click reaches the line, later by a positive offset', () => {
    const first = 10;
    const period = 0.5;
    expect(visualFrame(9.9, 0, first, period)).toMatchObject({ beat: -1, flash: 0 });
    expect(visualFrame(9.9, 0, first, period).untilNext).toBeCloseTo(0.1, 9);
    const onBeat = visualFrame(10.5, 0, first, period);
    expect(onBeat.beat).toBe(1);
    expect(onBeat.flash).toBeCloseTo(1, 9);
    expect(onBeat.untilNext).toBeCloseTo(0.5, 9);
    // +20 ms offset: at the heard click time the visual is still 20 ms away from the line.
    const later = visualFrame(10.5, 20, first, period);
    expect(later.beat).toBe(0);
    expect(later.untilNext).toBeCloseTo(0.02, 9);
    expect(visualFrame(10.52, 20, first, period).flash).toBeCloseTo(1, 9);
    expect(visualFrame(10.6, 0, first, period).flash).toBeLessThan(0.2);
  });
});

describe('ClickLoop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps clicks scheduled a little ahead, accents every 4th, stops cleanly', async () => {
    let time = 5;
    const scheduled: { when: number; accent: boolean; cancelled: boolean }[] = [];
    const loop = new ClickLoop(
      {
        now: () => time,
        clicks: {
          schedule: (when, accent) => {
            const c = { when, accent, cancelled: false };
            scheduled.push(c);
            return { cancel: () => void (c.cancelled = true) };
          },
        },
      },
      0.25,
    );
    expect(loop.firstClick).toBeCloseTo(5.2, 9);
    expect(scheduled.map((c) => c.when)).toEqual([expect.closeTo(5.2, 9)]);
    for (let i = 0; i < 40; i++) {
      time += 0.05;
      await vi.advanceTimersByTimeAsync(50);
    }
    // 2 s later: clicks up to now + 0.3 s, no duplicates.
    const whens = scheduled.map((c) => c.when);
    expect(new Set(whens.map((w) => w.toFixed(6))).size).toBe(whens.length);
    expect(Math.max(...whens)).toBeGreaterThan(time);
    expect(Math.max(...whens)).toBeLessThan(time + 0.3 + 1e-9);
    expect(scheduled.filter((c) => c.accent).map((c) => c.when)).toEqual(whens.filter((_, i) => i % 4 === 0));
    loop.stop();
    expect(scheduled.filter((c) => c.when > time).every((c) => c.cancelled)).toBe(true);
    const n = scheduled.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(scheduled).toHaveLength(n);
  });
});
