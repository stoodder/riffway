import { describe, expect, it } from 'vitest';
import { beatsInRange, countInClicks, meterAt, nextBarLine } from '../../src/audio/engine/beats';
import { makeTimeline } from './helpers';

const tl = makeTimeline([
  { bpm: 120, num: 4, bars: 2 }, // 0, 2
  { bpm: 90, num: 3, bars: 1 }, // 4 (beats 0.6667)
  { bpm: 120, num: 6, den: 8, bars: 1 }, // 6 (beats 0.25)
]);

describe('beatsInRange', () => {
  it('returns grid beats in [lo, hi) with downbeat accents across meter changes', () => {
    const got = beatsInRange(tl, 3.5, 6.5);
    expect(got.map((b) => b.time)).toEqual([3.5, 4, 4 + 2 / 3, 4 + 4 / 3, 6, 6.25]);
    expect(got.map((b) => b.accent)).toEqual([false, true, false, false, true, false]);
  });

  it('is half-open and gap-free when ranges are chained', () => {
    const a = beatsInRange(tl, 0, 4);
    const b = beatsInRange(tl, 4, 7.5);
    expect([...a, ...b].map((x) => x.time)).toEqual(beatsInRange(tl, 0, 7.5).map((x) => x.time));
    expect(a.at(-1)!.time).toBe(3.5);
  });

  it('extrapolates the first bar backwards (pre-roll before the song start)', () => {
    const got = beatsInRange(makeTimeline([{ bpm: 120, num: 4, bars: 1 }], 1), -1.2, 1);
    expect(got.map((b) => b.time)).toEqual([-1, -0.5, 0, 0.5]);
    expect(got.map((b) => b.accent)).toEqual([true, false, false, false]);
  });

  it('has no beats after the last bar; empty timeline is an endless 120 BPM 4/4 grid', () => {
    expect(beatsInRange(tl, 7.5, 20)).toEqual([]);
    const free = beatsInRange({ durationSec: Infinity, bars: [] }, -1, 1.1);
    expect(free.map((b) => [b.time, b.accent])).toEqual([
      [-1, false],
      [-0.5, false],
      [0, true],
      [0.5, false],
      [1, false],
    ]);
  });
});

describe('meterAt / countInClicks / nextBarLine', () => {
  it('reads the beat length and bar size at a position', () => {
    expect(meterAt(tl, 1)).toEqual({ beatSec: 0.5, beatsPerBar: 4 });
    expect(meterAt(tl, 4.7).beatSec).toBeCloseTo(2 / 3, 12);
    expect(meterAt(tl, 4.7).beatsPerBar).toBe(3);
    expect(meterAt(tl, -3)).toEqual({ beatSec: 0.5, beatsPerBar: 4 });
  });

  it('count-in: bars × beats clicks ending one beat before `from`, accent per count-in bar', () => {
    const { start, clicks } = countInClicks(tl, 4, 2);
    expect(clicks).toHaveLength(6);
    expect(start).toBeCloseTo(0, 12);
    clicks.forEach((c, i) => expect(c.time).toBeCloseTo((i * 2) / 3, 12));
    expect(clicks.map((c) => c.accent)).toEqual([true, false, false, true, false, false]);
    expect(countInClicks(tl, 4, 0)).toEqual({ start: 4, clicks: [] });
  });

  it('finds the next bar line (inclusive), extrapolating before the first bar', () => {
    expect(nextBarLine(tl, 0.1)).toBe(2);
    expect(nextBarLine(tl, 2)).toBe(2);
    expect(nextBarLine(tl, 4.1)).toBe(6);
    expect(nextBarLine(tl, 6.1)).toBeNull();
    expect(nextBarLine(tl, -3.9)).toBe(-2);
    expect(nextBarLine({ durationSec: Infinity, bars: [] }, 2.1)).toBe(4);
  });
});
