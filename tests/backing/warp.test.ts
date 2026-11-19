import { describe, expect, it } from 'vitest';
import type { WarpAnchor } from '@shared/storage';
import {
  DEFAULT_ANCHORS,
  WarpError,
  alignPoint,
  audioTimeAt,
  mergeAnchors,
  normalizeAnchors,
  nudgeAnchors,
  slopeAt,
  slopeChangesIn,
  songTimeAtAudio,
  summarizeWarp,
} from '../../src/audio/backing/warp';

const A = (songTime: number, audioTime: number): WarpAnchor => ({ songTime, audioTime });

describe('warp model', () => {
  it('1 anchor is a pure offset', () => {
    const w = [A(2, 2.75)];
    expect(audioTimeAt(w, 0)).toBeCloseTo(0.75, 12);
    expect(audioTimeAt(w, 10)).toBeCloseTo(10.75, 12);
    expect(slopeAt(w, 5)).toBe(1);
    expect(songTimeAtAudio(w, 10.75)).toBeCloseTo(10, 12);
    expect(audioTimeAt([], 3)).toBe(3);
  });

  it('2+ anchors are piecewise linear with nearest-segment extrapolation', () => {
    const w = [A(0, 1), A(10, 11.2), A(20, 21)];
    expect(slopeAt(w, -5)).toBeCloseTo(1.02, 12); // before the first anchor: first segment
    expect(audioTimeAt(w, -5)).toBeCloseTo(1 - 5 * 1.02, 12);
    expect(audioTimeAt(w, 5)).toBeCloseTo(1 + 5 * 1.02, 12);
    expect(slopeAt(w, 10)).toBeCloseTo(0.98, 12); // right-continuous at an interior anchor
    expect(audioTimeAt(w, 10)).toBeCloseTo(11.2, 12);
    expect(audioTimeAt(w, 15)).toBeCloseTo(11.2 + 5 * 0.98, 12);
    expect(audioTimeAt(w, 30)).toBeCloseTo(21 + 10 * 0.98, 12); // after the last: last segment
    for (const t of [-3, 0, 4.2, 10, 13.7, 25]) expect(songTimeAtAudio(w, audioTimeAt(w, t))).toBeCloseTo(t, 9);
  });

  it('slope changes only at interior anchors inside the open interval', () => {
    const w = [A(0, 0), A(4, 4), A(8, 8.4), A(12, 12.4)];
    expect(slopeChangesIn(w, -1, 20)).toEqual([4, 8]);
    expect(slopeChangesIn(w, 4, 8)).toEqual([]);
    expect(slopeChangesIn(w, 3.9, 8.1)).toEqual([4, 8]);
    expect(slopeChangesIn([A(0, 0)], -10, 10)).toEqual([]);
  });

  it('normalizeAnchors sorts, copies, defaults and rejects impossible warps', () => {
    const input = [A(8, 8.1), A(0, 0.1)];
    const out = normalizeAnchors(input);
    expect(out).toEqual([A(0, 0.1), A(8, 8.1)]);
    expect(out[0]).not.toBe(input[1]);
    expect(normalizeAnchors([])).toEqual([...DEFAULT_ANCHORS]);
    expect(() => normalizeAnchors([A(0, 0), A(1, 0.4)])).toThrow(WarpError); // slope 0.4
    expect(() => normalizeAnchors([A(0, 0), A(1, 2.5)])).toThrow(WarpError); // slope 2.5
    expect(() => normalizeAnchors([A(0, 1), A(2, 0.5)])).toThrow(WarpError); // audio goes backwards
    expect(() => normalizeAnchors([A(0, 0), A(0.01, 0.01)])).toThrow(WarpError); // too close
    expect(() => normalizeAnchors([A(Number.NaN, 0)])).toThrow(WarpError);
  });

  it('nudge and alignPoint shift the whole warp', () => {
    const w = [A(0, 1), A(10, 11.2)];
    // +10 ms later: the backing is heard later, so a given song time reads earlier audio.
    expect(audioTimeAt(nudgeAnchors(w, 10), 5)).toBeCloseTo(audioTimeAt(w, 5) - 0.01, 12);
    expect(audioTimeAt(nudgeAnchors(w, -10), 5)).toBeCloseTo(audioTimeAt(w, 5) + 0.01, 12);
    const aligned = alignPoint(w, 4, 7);
    expect(audioTimeAt(aligned, 4)).toBeCloseTo(7, 12);
    expect(slopeAt(aligned, 4)).toBeCloseTo(slopeAt(w, 4), 12);
  });

  it('mergeAnchors replaces a pure offset and splices into a piecewise warp', () => {
    expect(mergeAnchors([A(0, 0.5)], [A(4, 4.6), A(12, 12.8)])).toEqual([A(4, 4.6), A(12, 12.8)]);
    const w = [A(0, 0), A(10, 10), A(20, 20), A(30, 30)];
    // New anchors over 9–21 drop the old 10 and 20, keep 0 and 30 (still valid).
    expect(mergeAnchors(w, [A(9, 9.2), A(21, 21.5)])).toEqual([A(0, 0), A(9, 9.2), A(21, 21.5), A(30, 30)]);
    // An old anchor that would make audio run backwards is dropped.
    expect(mergeAnchors([A(0, 0), A(10, 10)], [A(11, 9.6), A(15, 13.6)])).toEqual([A(11, 9.6), A(15, 13.6)]);
    expect(() => mergeAnchors(w, [A(0, 0), A(1, 5)])).toThrow(WarpError);
  });

  it('summarizes offset and tempo ratio', () => {
    expect(summarizeWarp([A(0, 0.25)])).toEqual({ offsetMs: 250, slope: 1, tempoPercent: 100, anchors: 1 });
    const s = summarizeWarp([A(2, 2.5), A(12, 12.7)]);
    expect(s.slope).toBeCloseTo(1.02, 12);
    expect(s.tempoPercent).toBeCloseTo(100 / 1.02, 9);
    expect(s.offsetMs).toBeCloseTo((2.5 - 2 * 1.02) * 1000, 6);
  });
});
