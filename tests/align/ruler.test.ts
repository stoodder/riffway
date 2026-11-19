import { describe, expect, it } from 'vitest';
import { asciiToSong } from '@core/import/ascii';
import { buildSections, constantBars, extendBars, midiBars } from '@core/import/align/timing';
import { bytes, expectValidSong, onsets } from '../ascii/song-checks';

const song = (text: string) => asciiToSong({ fileName: 'r.txt', data: bytes(text) });
const staff = (rows: string[]) => ['e', 'B', 'G', 'D', 'A', 'E'].map((l, i) => `${l}${rows[i]}`).join('\n');

describe('beat-ruler rhythm', () => {
  it('guesses 6/8 from a ruler of two beats with three marks each when the header has no time', () => {
    const s = song(['   | . . | . .', staff(['|-0-0-0-0-0-0-|', '|-------------|', '|-------------|', '|-------------|', '|-------------|', '|-------------|'])].join('\n'));
    expect(s.meta.rhythm).toBe('ruler');
    expect(s.timing.bars[0]).toMatchObject({ num: 6, den: 8 });
    expect(s.diagnostics?.map((d) => d.code)).toContain('time-signature-guessed');
    onsets(s).forEach((t, i) => expect(t).toBeCloseTo(i * 0.375, 9));
  });

  it('reads a count-style ruler under the staff (UG "1 & 2 &")', () => {
    const s = song(['time: 2/4  tempo: Q=60', '', staff(['|-0-0-0-0-|', '|---------|', '|---------|', '|---------|', '|---------|', '|---------|']), '   1 & 2 &'].join('\n'));
    expect(s.meta.rhythm).toBe('ruler');
    expect(onsets(s)).toEqual([0, 0.5, 1, 1.5]);
  });

  it('merges bars split by a mid-bar repeat sign back into one musical bar', () => {
    // 3/4: the second musical bar is split as `| . | .` + `| .` around `*||*`.
    const ruler = '0  | . | . | .   | . | .      | .';
    const s = song(['time: 3/4  tempo: Q=60', '', ruler, staff(['|-0-0-0-0-0-0-|-0-0-0-0-*||*-0-0-|', '|-------------|----------||------|', '|-------------|----------||------|', '|-------------|----------||------|', '|-------------|----------||------|', '|-------------|----------||------|'])].join('\n'));
    expectValidSong(s);
    expect(s.meta.rhythm).toBe('ruler');
    expect(s.timing.bars.map((b) => [b.time, b.dur, b.num, b.den])).toEqual([[0, 3, 3, 4], [3, 3, 3, 4]]);
    onsets(s).forEach((t, i) => expect(t).toBeCloseTo(i * 0.5, 9));
  });

  it('places grace notes written before a bar\'s first mark just before that mark', () => {
    const ruler = '1  | . . | . .      | . . | . .';
    const s = song(['time: 6/8', '', ruler, staff(['|-0-0-0-0-0-0-|2g4g5-0-0-0-0-0-|', '|-------------|----------------|', '|-------------|----------------|', '|-------------|----------------|', '|-------------|----------------|', '|-------------|----------------|'])].join('\n'));
    expectValidSong(s);
    const t = onsets(s);
    const e = 0.375;
    expect(t[5]).toBeCloseTo(5 * e, 9);
    expect(t[6]).toBeGreaterThan(5 * e);
    expect(t[7]).toBeGreaterThan(t[6]);
    expect(t[8]).toBeCloseTo(6 * e, 9);
  });

  it('falls back to proportional onsets when only some staves have a ruler', () => {
    const block = staff(['|-0-0-|', '|-----|', '|-----|', '|-----|', '|-----|', '|-----|']);
    const s = song(['  | .', block, '', block].join('\n'));
    expect(s.meta.rhythm).toBe('needs-alignment');
    expect(s.diagnostics?.map((d) => d.code)).toContain('ruler-incomplete');
  });

  it('falls back when the notes do not line up with the ruler marks', () => {
    const s = song(['  | . | .', staff(['|---0----0-----0-|', '|----------------|', '|----------------|', '|----------------|', '|----------------|', '|----------------|'])].join('\n'));
    expect(s.meta.rhythm).toBe('needs-alignment');
    expect(s.diagnostics?.map((d) => d.code)).toContain('ruler-misaligned');
  });
});

describe('bar grids and sections', () => {
  it('constant bars and extension', () => {
    const bars = constantBars(120, [3, 4], 2);
    expect(bars.map((b) => [b.time, b.dur, b.beats])).toEqual([[0, 1.5, [0, 0.5, 1]], [1.5, 1.5, [1.5, 2, 2.5]]]);
    expect(extendBars(bars, 4, 120, [3, 4]).map((b) => b.index)).toEqual([0, 1, 2]);
    expect(extendBars(bars, 2, 120, [3, 4])).toBe(bars);
  });

  it('MIDI bars follow tempo and time-signature changes', () => {
    const bars = midiBars([{ time: 0, bpm: 120 }, { time: 2, bpm: 60 }], [{ time: 0, num: 4, den: 4 }, { time: 4, num: 6, den: 8 }], 7);
    expect(bars.map((b) => [b.time, b.dur, b.num, b.den])).toEqual([
      [0, 2, 4, 4],
      [2, 2, 4, 4],
      [4, 3, 6, 8],
    ]);
    expect(bars[2].beats).toEqual([4, 4.5, 5, 5.5, 6, 6.5]);
  });

  it('MIDI bars end early at a time-signature change inside a bar', () => {
    const bars = midiBars([{ time: 0, bpm: 60 }], [{ time: 0, num: 4, den: 4 }, { time: 3, num: 3, den: 4 }], 6);
    expect(bars.map((b) => [b.time, b.dur, b.num])).toEqual([[0, 3, 4], [3, 3, 3]]);
  });

  it('sections: named starts with an Intro before them, or auto Part n', () => {
    const bars = constantBars(60, [4, 4], 10);
    expect(buildSections(bars, [{ bar: 2, name: 'Verse' }, { bar: 6, name: 'Chorus' }, { bar: 6, name: 'Chorus 2' }, { bar: 99, name: 'Gone' }]).map((s) => [s.name, s.startBar, s.endBar, s.start, s.end])).toEqual([
      ['Intro', 0, 2, 0, 8],
      ['Verse', 2, 6, 8, 24],
      ['Chorus 2', 6, 10, 24, 40],
    ]);
    expect(buildSections(bars, []).map((s) => [s.name, s.startBar, s.endBar])).toEqual([['Part 1', 0, 8], ['Part 2', 8, 10]]);
  });
});
