/**
 * T-103: ClassTab rhythm recall. Beat-ruler variants (tuplet brackets, bar numbers against the first
 * mark, `,` / `+` subdivisions, directions between marks, fermata lines), duet systems, `o` repeat dots
 * and majority-voted string labels. Fixtures in `tests/fixtures/classtab-synthetic/recall/` are authored
 * lookalikes of ClassTab's house style (TASKS.md D2), not ClassTab files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asciiToSong, parseAsciiTab } from '@core/import/ascii';
import { isFermataLine, isTupletRuler, parseRuler, parseStaffLine } from '@core/import/ascii/lines';
import { parseTabDetailed } from '@core/import/ascii/parse';
import { CLASSTAB_DIR, bytes, expectValidSong, onsets } from './song-checks';

const recall = (name: string): Uint8Array => new Uint8Array(readFileSync(join(CLASSTAB_DIR, 'recall', name)));
const classtabSong = (name: string) => asciiToSong({ fileName: name, data: recall(name), source: { source: 'classtab', path: name } });
const range = (n: number, start: number, step: number): number[] => Array.from({ length: n }, (_, k) => start + k * step);
/** A labelled staff from six bodies (top = high e). */
const staff = (rows: readonly string[], labels = ['e', 'B', 'G', 'D', 'A', 'E']): string => labels.map((l, i) => `${l}${rows[i]}`).join('\n');
const empty = (body: string): string => body.replace(/[^|]/g, '-');
const columns = (text: string, position: 'above' | 'below' = 'above') => parseRuler(text, position)?.map((m) => m.column) ?? null;

describe('parseRuler: ClassTab variants', () => {
  it('reads a bar number written against the first mark, in brackets or with a period', () => {
    expect(columns('108|   .   |   .')).toEqual([3, 7, 11, 15]);
    expect(columns('(12) | . | .')).toEqual([5, 7, 9, 11]);
    expect(columns('3.    |  .  .')).toEqual([6, 9, 12]);
  });

  it('reads `,` and `+` subdivisions and an apostrophe pulse after a bar number', () => {
    expect(parseRuler('1  |   ,   .   ,   |', 'above')?.map((m) => m.beat)).toEqual([true, false, false, false, true]);
    expect(columns('5  | + | + |')).toEqual([3, 5, 7, 9, 11]);
    expect(columns("1     '      '      '")).toEqual([6, 13, 20]);
  });

  it('blanks directions between marks: a segno, Fine, D.C. and a metre change', () => {
    expect(columns('16 | . | . Fine | . |')).toEqual([3, 5, 7, 9, 16, 18, 20]);
    expect(columns('4  | . $ | .')).toEqual([3, 5, 9, 11]);
    expect(columns('44 | . . 3/8 | . .')).toEqual([3, 5, 7, 13, 15, 17]);
  });

  it('spreads n marks evenly across a tuplet bracket, the first a beat when the bracket opens with `|`', () => {
    const marks = parseRuler('3  |--3--| |   .', 'above');
    expect(marks).toEqual([
      { column: 3, beat: true, tuplet: { n: 3, k: 0 } },
      { column: 6, beat: false, tuplet: { n: 3, k: 1 } },
      { column: 9, beat: false, tuplet: { n: 3, k: 2 } },
      { column: 11, beat: true },
      { column: 15, beat: false },
    ]);
    expect(columns('5  |-3-| |-3-|')).toEqual([3, 5, 7, 9, 11, 13]);
    expect(columns('7  |----6----|')).toEqual([3, 5, 7, 9, 11, 13]);
  });

  it('rejects staff lines, stray bar lines and fingering lines', () => {
    expect(parseRuler('|-2---|-3-|', 'above')).toBeNull();
    expect(parseRuler('|-0-----------|', 'above')).toBeNull();
    expect(parseRuler(' |                   ||', 'above')).toBeNull();
    expect(parseRuler(' | m   i   m   i     |', 'above')).toBeNull();
    expect(parseRuler('   3   1   4', 'above')).toBeNull();
    // A ClassTab ruler is only read above a staff; count style still works below.
    expect(parseRuler('0  | . | .', 'below')).toBeNull();
    expect(columns('   1 + 2 +', 'below')).toEqual([3, 5, 7, 9]);
  });

  it('a tuplet-bracket ruler is not a staff line; fermata lines are recognised', () => {
    const ruler = '25 |---3---|   |---3---|';
    expect(isTupletRuler(ruler)).toBe(true);
    expect(parseStaffLine(ruler)).toBeNull();
    expect(isTupletRuler('e|---3---|---3---|')).toBe(false);
    expect(parseStaffLine('|---3---|---5---|')).not.toBeNull();
    expect(isFermataLine('      /.\\')).toBe(true);
    expect(isFermataLine('  /.\\      /.\\')).toBe(true);
    expect(isFermataLine('  rit. /.\\')).toBe(false);
  });
});

describe('beat-ruler rhythm: T-103 variants', () => {
  it('triplet etude: tuplet brackets, a bracket-only ruler, finer marks in one beat, a fermata line (fixture)', () => {
    const song = classtabSong('riffway_triplet_etude.txt');
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('ruler');
    expect(song.diagnostics?.map((d) => d.code)).not.toContain('staff-line-count');
    // 3/4 at Q=60: eighths 0.5 s; triplet eighths 1/3 s; the `| , . ,` beat holds sixteenths.
    const third = 1 / 3;
    const expected = [
      ...range(6, 0, 0.5),
      3, 3 + third, 3 + 2 * third, ...range(4, 4, 0.5),
      ...range(9, 6, third),
      ...range(6, 9, 0.5),
      12, 12.5, 13, 13.25, 13.5, 13.75, 14, 14.5,
    ];
    const got = onsets(song);
    expect(got).toHaveLength(expected.length);
    got.forEach((t, i) => expect(t).toBeCloseTo(expected[i], 6));
    expect(song.timing.bars.map((b) => [b.time, b.num, b.den])).toEqual([0, 3, 6, 9, 12].map((t) => [expect.closeTo(t, 6), 3, 4]));
  });

  it('a bracket that replaces half a beat keeps the bar full (`|-3-| .`)', () => {
    const s = asciiToSong({
      fileName: 'b.txt',
      data: bytes(['time: 2/4  tempo: Q=60', '', '1  | . | .   |-3-| . | .', staff(['|-0-0-0-0-|-0-0-0-0-0-0-|', ...Array(5).fill(empty('|-0-0-0-0-|-0-0-0-0-0-0-|'))])].join('\n')),
    });
    expect(s.meta.rhythm).toBe('ruler');
    // Bar 2: three triplet sixteenths in the first eighth, then eighths.
    const sixth = 0.5 / 3;
    [0, 0.5, 1, 1.5, 2, 2 + sixth, 2 + 2 * sixth, 2.5, 3, 3.5].forEach((t, i) => expect(onsets(s)[i]).toBeCloseTo(t, 6));
  });

  it('a ruler right above a fermata line still counts as the staff\'s ruler', () => {
    const d = parseTabDetailed(['0  | . | .', '     /.\\', staff(['|-0-0-0-0-|', ...Array(5).fill('|---------|')])].join('\n'));
    expect(d.played[0].ruler?.map((m) => m.column)).toEqual([3, 5, 7, 9]);
    expect(d.tab.header.title).toBeUndefined();
  });
});

describe('duet systems', () => {
  it('imports guitar 1 of each system and uses its ruler (fixture)', () => {
    const song = classtabSong('riffway_duo_rondino.txt');
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('ruler');
    expect(song.diagnostics?.find((d) => d.code === 'ensemble-parts')?.message).toMatch(/2 guitars/);
    // 2/4 at Q=60, eighths: two bars, then one bar played twice (`||o` … `o||` repeat dots).
    onsets(song).forEach((t, i) => expect(t).toBeCloseTo(i * 0.5, 9));
    expect(onsets(song)).toHaveLength(16);
    expect(song.notes.every((n) => n.string === 1)).toBe(true);
    expect(song.notes.map((n) => n.fret)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3, 3, 3]);
  });

  it('marks the lower staves as parts and keeps them out of the played order', () => {
    const tab = parseAsciiTab(new TextDecoder().decode(recall('riffway_duo_rondino.txt')));
    expect(tab.blocks.map((b) => b.part ?? 0)).toEqual([0, 1, 0, 1]);
    expect(new Set(tab.groups.map((g) => g.block))).toEqual(new Set([0, 2]));
  });

  it('separate staves (a blank line between them) are not a system', () => {
    const block = staff(['|-0-0-|', ...Array(5).fill('|-----|')]);
    const tab = parseAsciiTab([block, '', block].join('\n'));
    expect(tab.blocks.map((b) => b.part)).toEqual([undefined, undefined]);
    expect(tab.diagnostics.map((d) => d.code)).not.toContain('ensemble-parts');
  });
});

describe('staff reading', () => {
  it('reads `o` repeat dots next to bar lines as `*`', () => {
    const line = parseStaffLine('G||o-2---2-o||');
    expect(line?.text).toBe('G||*-2---2-*||');
    expect(line?.bodyEnd).toBe(14);
  });

  it('takes the tuning from the string labels most staves carry (a typo in one staff is outvoted)', () => {
    const body = ['|-0-|', ...Array(5).fill('|---|')];
    const typo = staff(body, ['e', 'A', 'G', 'D', 'A', 'E']);
    const ok = staff(body);
    expect(parseAsciiTab([typo, '', ok, '', ok].join('\n')).tuning).toEqual([64, 59, 55, 50, 45, 40]);
    // A real alternate tuning on every staff still wins.
    const dropD = staff(body, ['e', 'B', 'G', 'D', 'A', 'D']);
    expect(parseAsciiTab([dropD, '', dropD].join('\n')).tuning).toEqual([64, 59, 55, 50, 45, 38]);
  });

  it('`repeats: false` keeps the written order (one pass of `x2` blocks and `|*` … `*|` repeats)', () => {
    const text = [staff(['|-0-1-|', ...Array(5).fill('|-----|')]), 'x2'].join('\n');
    expect(parseTabDetailed(text).tab.groups).toHaveLength(4);
    expect(parseTabDetailed(text, { repeats: false }).tab.groups).toHaveLength(2);
  });
});
