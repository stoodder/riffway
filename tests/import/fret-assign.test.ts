import { describe, expect, it } from 'vitest';
import { assignFrets, type FretAssignInput, type FretPosition } from '@core/import/fret-assign';
import { STANDARD_TUNING } from '@core/model';

const STD = STANDARD_TUNING;
const DROP_D = [64, 59, 55, 50, 45, 38];
const pitch = (p: FretPosition, tuning: readonly number[] = STD, capo = 0): number => (tuning[p.string - 1] ?? NaN) + capo + p.fret;
const melody = (midis: number[], step = 0.5): FretAssignInput[] => midis.map((midi, i) => ({ time: i * step, midi }));

/** Span rule: within an onset, fretted notes fit one hand window `[lo, lo+3]` (`lo+4` from fret 7). */
function obeysSpan(group: FretPosition[]): boolean {
  const fretted = group.map((p) => p.fret).filter((f) => f > 0);
  if (fretted.length === 0) return true;
  const lo = Math.min(...fretted);
  return Math.max(...fretted) - lo <= (lo >= 7 ? 4 : 3);
}

describe('assignFrets', () => {
  it('returns [] for no notes', () => {
    expect(assignFrets([], STD)).toEqual([]);
  });

  it('keeps every pitch and the input order', () => {
    const input = melody([52, 55, 57, 59, 62, 64, 67, 69, 72, 74, 76, 79]);
    const shuffled = [...input].reverse();
    const out = assignFrets(shuffled, STD);
    expect(out.map((p) => pitch(p))).toEqual(shuffled.map((n) => n.midi));
  });

  it('plays an open-position scale in first position with open strings', () => {
    // C major, C3–C4: the textbook first-position fingering.
    const out = assignFrets(melody([48, 50, 52, 53, 55, 57, 59, 60]), STD);
    expect(out).toEqual([
      { string: 5, fret: 3 },
      { string: 4, fret: 0 },
      { string: 4, fret: 2 },
      { string: 4, fret: 3 },
      { string: 3, fret: 0 },
      { string: 3, fret: 2 },
      { string: 2, fret: 0 },
      { string: 2, fret: 1 },
    ]);
  });

  it('keeps a high phrase inside one hand window instead of shifting along one string', () => {
    // A4 B4 C5 D5 E5 D5 C5 B4: one window around fret 8–12 covers it without a shift.
    const out = assignFrets(melody([69, 71, 72, 74, 76, 74, 72, 71]), STD);
    expect(obeysSpan(out)).toBe(true);
    expect(out.every((p) => p.fret > 0 && p.string <= 2)).toBe(true);
  });

  it('puts chord notes on distinct strings within one hand span', () => {
    const chords: FretAssignInput[] = [
      // A5 power chord, then an open E major, then a barre-ish G at fret 3 (G B D G).
      { time: 0, midi: 45, chordId: 1 },
      { time: 0, midi: 52, chordId: 1 },
      { time: 0, midi: 57, chordId: 1 },
      { time: 1, midi: 40, chordId: 2 },
      { time: 1, midi: 47, chordId: 2 },
      { time: 1, midi: 52, chordId: 2 },
      { time: 1, midi: 56, chordId: 2 },
      { time: 1, midi: 59, chordId: 2 },
      { time: 1, midi: 64, chordId: 2 },
      { time: 2, midi: 43 },
      { time: 2, midi: 47 },
      { time: 2, midi: 50 },
      { time: 2, midi: 55 },
    ];
    const out = assignFrets(chords, STD);
    for (const range of [
      [0, 3],
      [3, 9],
      [9, 13],
    ] as const) {
      const group = out.slice(...range);
      expect(new Set(group.map((p) => p.string)).size).toBe(group.length);
      expect(obeysSpan(group)).toBe(true);
    }
    expect(out.map((p) => pitch(p))).toEqual(chords.map((c) => c.midi));
    expect(out.slice(3, 9).map((p) => p.fret)).toEqual([0, 2, 2, 1, 0, 0]); // the open E shape
  });

  it('prefers frets ≤ 15', () => {
    // E5 (76): string 1 fret 12, not string 2 fret 17.
    expect(assignFrets([{ time: 0, midi: 76 }], STD)).toEqual([{ string: 1, fret: 12 }]);
    expect(assignFrets([{ time: 0, midi: 86 }], STD)).toEqual([{ string: 1, fret: 22 }]); // only option
  });

  it('respects tuning and capo', () => {
    expect(assignFrets([{ time: 0, midi: 38 }], DROP_D)).toEqual([{ string: 6, fret: 0 }]);
    const capoOut = assignFrets(melody([42, 47, 52]), STD, 2);
    expect(capoOut.map((p) => pitch(p, STD, 2))).toEqual([42, 47, 52]);
    expect(capoOut[0]).toEqual({ string: 6, fret: 0 }); // open string under the capo
  });

  it('moves out-of-range pitches by octaves', () => {
    const out = assignFrets([{ time: 0, midi: 28 }, { time: 1, midi: 100 }], STD);
    expect(pitch(out[0] as FretPosition)).toBe(40); // E1 → E2
    expect(pitch(out[1] as FretPosition) % 12).toBe(100 % 12);
    expect(pitch(out[1] as FretPosition)).toBeLessThanOrEqual(64 + 24);
  });

  it('still returns a position per note when a chord has more notes than strings', () => {
    const big = Array.from({ length: 7 }, (_, i) => ({ time: 0, midi: 50 + i * 2, chordId: 1 }));
    const out = assignFrets(big, STD);
    expect(out).toHaveLength(7);
    expect(out.every((p) => p.string >= 1 && p.string <= 6)).toBe(true);
  });

  it('is fast enough for long melodies', () => {
    const long = melody(Array.from({ length: 2000 }, (_, i) => 50 + ((i * 7) % 24)), 0.1);
    const t0 = performance.now();
    expect(assignFrets(long, STD)).toHaveLength(2000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
