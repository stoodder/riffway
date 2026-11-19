import { describe, expect, it } from 'vitest';
import { barFractions, gridStep, mapTapsToOnsets, proportionalTimes, snapToGrid, type ColumnInfo } from '@core/import/align';
import { parseAsciiTab } from '@core/import/ascii';

/** Groups of one UG-style bar `|-0---2---3---5---|` (bar lines at 0 and 18). */
const ugBar = (bar: number, cols = [2, 6, 10, 14]): ColumnInfo[] => cols.map((column) => ({ bar, column, barStartColumn: 0, barEndColumn: 18 }));

describe('column proportions', () => {
  it('puts the first note after the usual lead dash on the downbeat', () => {
    expect(barFractions(ugBar(0))).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('learns a two-dash lead (ClassTab) from the bars', () => {
    const cols = [4, 6, 8, 10, 12, 14].map((column) => ({ bar: 0, column, barStartColumn: 1, barEndColumn: 16 }));
    expect(barFractions(cols).map((f) => f * 6)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('proportional times follow bars at the given tempo and stay increasing', () => {
    const t = proportionalTimes([...ugBar(0), ...ugBar(1)], 120, [4, 4]);
    expect(t).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
  });

  it('grid steps: eighths, sixteenths, eighth triplets', () => {
    expect(gridStep(120, 8)).toBe(0.25);
    expect(gridStep(120, 16)).toBe(0.125);
    expect(gridStep(120, 12)).toBeCloseTo(1 / 6, 12);
  });
});

describe('snapToGrid', () => {
  it('quantises uneven dash widths to the grid', () => {
    // Sloppy spacing: |-0--2----3---5--|
    const cols = [2, 5, 10, 14].map((column) => ({ bar: 0, column, barStartColumn: 0, barEndColumn: 17 }));
    // Fractions 0, 0.2, 0.53, 0.8 of a 2 s bar.
    expect(snapToGrid(cols, 120, [4, 4], 8)).toEqual([0, 0.5, 1, 1.5]);
    expect(snapToGrid(cols, 120, [4, 4], 16)).toEqual([0, 0.375, 1.125, 1.625]);
  });

  it('places bars back to back and keeps chords together', () => {
    const tab = parseAsciiTab(['e|-0---0---|-3---3---|', 'B|-1-------|---------|', 'G|-0-------|-0-------|', 'D|---------|---------|', 'A|---------|---------|', 'E|---------|---------|'].join('\n'));
    const times = snapToGrid(tab.groups, 60, [2, 4], 8);
    expect(times).toEqual([0, 1, 2, 3]);
    expect(tab.groups[0].notes).toHaveLength(3);
  });

  it('moves colliding groups to the next free slot', () => {
    const cols = [2, 3, 4].map((column) => ({ bar: 0, column, barStartColumn: 0, barEndColumn: 40 }));
    expect(snapToGrid(cols, 120, [4, 4], 8)).toEqual([0, 0.25, 0.5]);
  });

  it('pushes earlier when the end of the bar is crowded', () => {
    const cols = [36, 37, 38].map((column) => ({ bar: 0, column, barStartColumn: 0, barEndColumn: 40 }));
    expect(snapToGrid(cols, 120, [4, 4], 8)).toEqual([1.25, 1.5, 1.75]);
  });

  it('keeps proportional times when a bar has more groups than slots', () => {
    const cols = [2, 4, 6, 8, 10, 12].map((column) => ({ bar: 1, column, barStartColumn: 0, barEndColumn: 14 }));
    const t = snapToGrid(cols, 120, [2, 4], 8);
    expect(t[0]).toBe(1);
    expect(t.every((x, i) => i === 0 || x > t[i - 1])).toBe(true);
  });

  it('supports triplet grids', () => {
    const cols = [2, 6, 10].map((column) => ({ bar: 0, column, barStartColumn: 0, barEndColumn: 14 }));
    expect(snapToGrid(cols, 60, [1, 4], 12).map((x) => x * 3)).toEqual([0, 1, 2]);
  });
});

describe('mapTapsToOnsets', () => {
  const groups = [...ugBar(0), ...ugBar(1)];

  it('maps taps in order (chord = one tap) and drops extra taps', () => {
    const taps = [0.1, 0.6, 1.1, 1.6, 2.1, 2.6, 3.1, 3.6, 4.1, 4.6];
    expect(mapTapsToOnsets(taps, groups)).toEqual(taps.slice(0, 8));
  });

  it('interpolates missing taps at the tapped tempo', () => {
    const t = mapTapsToOnsets([1, 2, 3, 4], groups);
    // Proportional spacing at 80 BPM is 0.75 s per group; the taps are 1 s apart.
    expect(t.slice(4)).toEqual([5, 6, 7, 8]);
  });

  it('with one tap or none, follows the column spacing at the quantise tempo', () => {
    expect(mapTapsToOnsets([2], groups, { bpm: 120, timeSig: [4, 4], subdivision: 8 })).toEqual([2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
    expect(mapTapsToOnsets([], ugBar(0))).toEqual([0, 0.75, 1.5, 2.25]);
    expect(mapTapsToOnsets([1], [])).toEqual([]);
  });

  it('quantises to the grid and keeps onsets strictly increasing', () => {
    const t = mapTapsToOnsets([0.02, 0.27, 0.3, 0.74], ugBar(0), { bpm: 120, timeSig: [4, 4], subdivision: 8 });
    expect(t).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('without quantise, repairs non-increasing taps', () => {
    const t = mapTapsToOnsets([1, 1, 0.5, 2], ugBar(0));
    expect(t[1]).toBeGreaterThan(t[0]);
    expect(t[2]).toBeGreaterThan(t[1]);
    expect(t[3]).toBe(2);
  });
});
