import { describe, expect, it } from 'vitest';
import type { WarpAnchor } from '@shared/storage';
import { MIN_FIT_TAPS, alignFromTaps, applyTapFit, fitTaps, matchTaps } from '../../src/audio/backing/align';
import { audioTimeAt, slopeAt } from '../../src/audio/backing/warp';

/** 120 BPM 4/4 beats for `n` beats. */
const beats = (n: number, period = 0.5): number[] => Array.from({ length: n }, (_, i) => i * period);
/** Deterministic pseudo-random jitter in ±`ms`. */
const jitter = (i: number, ms: number): number => (((i * 7919) % 13) / 6 - 1) * (ms / 1000);

describe('matchTaps', () => {
  it('matches sequential taps, skipping beats the player did not tap', () => {
    const b = beats(32);
    // Recording: offset 0.8 s, 1.5 % slower. Taps on every beat from beat 4, then only downbeats.
    const truth = (s: number): number => 0.8 + s * 1.015;
    const tapped = [4, 5, 6, 7, 8, 12, 16, 20];
    const m = matchTaps(
      tapped.map((i) => truth(b[i]!)),
      b,
      4,
    );
    expect(m.map((x) => x.beat)).toEqual(tapped);
  });

  it('drops stray taps between beats', () => {
    const b = beats(16);
    // Offset 0.5 s: 1.74 lands at song 1.24, half-way between beats 2 (1.0) and 3 (1.5).
    const taps = [1.0, 1.5, 1.74, 2.0, 2.5];
    const m = matchTaps(taps, b, 1);
    expect(m.map((x) => x.beat)).toEqual([1, 2, 3, 4]);
  });

  it('returns nothing for no taps or a bad start beat', () => {
    expect(matchTaps([], beats(4), 0)).toEqual([]);
    expect(matchTaps([1], beats(4), 9)).toEqual([]);
  });
});

describe('fitTaps', () => {
  it('recovers offset and tempo ratio from jittery taps within 1 ms of the truth', () => {
    const b = beats(40);
    const truth = (s: number): number => 1.234 + s * 0.985;
    const taps = b.slice(8, 40).map((s, i) => truth(s) + jitter(i, 12));
    const fit = fitTaps(matchTaps(taps, b, 8))!;
    expect(fit.kind).toBe('tempo');
    expect(fit.slope).toBeCloseTo(0.985, 3);
    for (const a of fit.anchors) expect(Math.abs(a.audioTime - truth(a.songTime))).toBeLessThan(0.002);
    expect(fit.residualMs).toBeLessThan(12);
  });

  it('rejects an outlier tap before the final fit', () => {
    const b = beats(16);
    const truth = (s: number): number => 0.5 + s;
    const taps = b.slice(0, 12).map(truth);
    taps[6] = taps[6]! + 0.12; // one sloppy tap (still nearest its own beat)
    const fit = fitTaps(matchTaps(taps, b, 0))!;
    expect(fit.rejected.map((m) => m.beat)).toEqual([6]);
    expect(fit.slope).toBeCloseTo(1, 6);
    expect(fit.anchors[0]!.audioTime).toBeCloseTo(0.5, 6);
  });

  it('falls back to an offset fit with few taps or a short span, keeping the current slope', () => {
    const b = beats(16);
    const one = fitTaps(matchTaps([2.3], b, 2), 1.01)!;
    expect(one.kind).toBe('offset');
    expect(one.anchors).toEqual([{ songTime: 1, audioTime: 2.3 }]);
    expect(one.slope).toBe(1.01);
    const short = fitTaps(matchTaps([2.3, 2.8, 3.3], b, 2))!;
    expect(short.kind).toBe('offset');
    expect(MIN_FIT_TAPS).toBeGreaterThan(3);
    expect(fitTaps([])).toBeNull();
  });
});

describe('applying a fit', () => {
  it('an offset fit shifts the warp so the tapped beat lands on the tap', () => {
    const current: WarpAnchor[] = [{ songTime: 0, audioTime: 0 }];
    const out = alignFromTaps(current, [3.21], beats(16), 4)!;
    expect(out.fit.kind).toBe('offset');
    expect(audioTimeAt(out.anchors, 2)).toBeCloseTo(3.21, 12);
    expect(slopeAt(out.anchors, 2)).toBe(1);
  });

  it('the first tempo fit replaces a pure offset; a later one refines a passage', () => {
    const b = beats(80);
    const first = alignFromTaps(
      [{ songTime: 0, audioTime: 0 }],
      b.slice(0, 16).map((s) => 0.6 + s * 1.02),
      b,
      0,
    )!;
    expect(first.anchors).toHaveLength(2);
    expect(slopeAt(first.anchors, 20)).toBeCloseTo(1.02, 6);
    // The band drifts later in the song: tap 30–37.5 s.
    const later = (s: number): number => audioTimeAt(first.anchors, 30) + (s - 30) * 0.99;
    const second = alignFromTaps(
      first.anchors,
      b.slice(60, 76).map(later),
      b,
      60,
    )!;
    expect(second.fit.kind).toBe('tempo');
    expect(second.anchors).toHaveLength(4);
    expect(audioTimeAt(second.anchors, 33)).toBeCloseTo(later(33), 6);
    expect(audioTimeAt(second.anchors, 5)).toBeCloseTo(0.6 + 5 * 1.02, 6);
    expect(applyTapFit(first.anchors, second.fit)).toEqual(second.anchors);
  });

  it('returns null when nothing can be matched', () => {
    expect(alignFromTaps([{ songTime: 0, audioTime: 0 }], [], beats(8), 0)).toBeNull();
    expect(alignFromTaps([{ songTime: 0, audioTime: 0 }], [1], beats(8), 20)).toBeNull();
  });
});
