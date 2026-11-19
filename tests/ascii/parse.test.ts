import { describe, expect, it } from 'vitest';
import { decodeText, parseAsciiTab, splitVersions, type AsciiTab } from '@core/import/ascii';
import { asciiFixture, classtab } from './song-checks';

const DROP_D = [64, 59, 55, 50, 45, 38];

/** Notes of the whole tab as `s<string>f<fret>` in group order. */
const flat = (tab: AsciiTab): string[] => tab.groups.flatMap((g) => g.notes.map((n) => `s${n.string}f${n.fret}`));
/** The single note on `string` in group `i`. */
const noteAt = (tab: AsciiTab, i: number, string = tab.groups[i].notes[0].string) => {
  const n = tab.groups[i].notes.find((x) => x.string === string);
  if (!n) throw new Error(`no note on string ${string} in group ${i}`);
  return n;
};

describe('parseAsciiTab: staff blocks', () => {
  it('reads a labelled block: top line = string 1, columns, bar lines, chords', () => {
    const tab = parseAsciiTab(['e|-----0---|', 'B|---1-----|', 'G|-2-------|', 'D|-2-------|', 'A|-0-------|', 'E|---------|'].join('\n'));
    expect(tab.blocks).toHaveLength(1);
    const [block] = tab.blocks;
    expect(block.startLine).toBe(1);
    expect(block.labels).toEqual(['e', 'B', 'G', 'D', 'A', 'E']);
    expect(block.barColumns).toEqual([1, 11]);
    expect(tab.groups.map((g) => g.column)).toEqual([3, 5, 7]);
    expect(tab.groups[0].notes.map((n) => [n.string, n.fret])).toEqual([[3, 2], [4, 2], [5, 0]]);
    expect(noteAt(tab, 2).line).toBe(1);
    expect(tab.groups.every((g) => g.bar === 0 && g.barStartColumn === 1 && g.barEndColumn === 11)).toBe(true);
  });

  it('reads unlabelled blocks with and without bar lines', () => {
    const barred = parseAsciiTab([' |-0---|-----|', ' |-----|-1---|', ' |-----|-----|', ' |-----|-----|', ' |-----|-----|', ' |-----|-----|'].join('\n'));
    expect(barred.blocks[0].labels).toEqual([null, null, null, null, null, null]);
    expect(barred.groups.map((g) => [g.bar, g.column])).toEqual([[0, 3], [1, 9]]);

    const bare = parseAsciiTab(['--0--2--3--', '-----------', '-----------', '-----------', '-----------', '-----------'].join('\n'));
    expect(bare.groups.map((g) => g.column)).toEqual([2, 5, 8]);
    // Without bar lines the block is one bar.
    expect(new Set(bare.groups.map((g) => g.bar))).toEqual(new Set([0]));
  });

  it('reads multi-digit frets, left- or right-aligned chord columns', () => {
    const tab = parseAsciiTab(['e|-12--3-|', 'B|--3-15-|', 'G|-------|', 'D|-------|', 'A|-------|', 'E|-------|'].join('\n'));
    expect(tab.groups.map((g) => g.notes.map((n) => `s${n.string}f${n.fret}`))).toEqual([['s1f12', 's2f3'], ['s1f3', 's2f15']]);
  });

  it('splits implausible digit runs into single frets', () => {
    const tab = parseAsciiTab(['e|-35-|', 'B|----|', 'G|----|', 'D|----|', 'A|----|', 'E|----|'].join('\n'));
    expect(flat(tab)).toEqual(['s1f3', 's1f5']);
  });

  it('ignores `=` sustains and `*` repeat dots, and records the sustain end', () => {
    const tab = parseAsciiTab(['e|*-0=====-2-*|', 'B|-------------|', 'G|-------------|', 'D|-------------|', 'A|-------------|', 'E|-------------|'].join('\n'));
    expect(flat(tab)).toEqual(['s1f0', 's1f2']);
    expect(noteAt(tab, 0).sustainEnd).toBe(10);
  });

  it('tolerates tabs, NBSP and Unicode dashes from web pastes', () => {
    const tab = parseAsciiTab(['e|——0—|', 'B|----|', 'G|----|', 'D|----|', 'A|----|', 'E|----|'].join('\n'));
    expect(flat(tab)).toEqual(['s1f0']);
  });

  it('splits stacked blocks and skips separator rules', () => {
    const block = ['e|-0-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', 'E|---|'];
    const tab = parseAsciiTab(['---------------', ...block, ...block.map((l) => l.replace('0', '1'))].join('\n'));
    expect(tab.blocks).toHaveLength(2);
    expect(flat(tab)).toEqual(['s1f0', 's1f1']);
    expect(tab.unparsed).toEqual([]);
  });

  it('reports 4- and 7-line staves as unparsed lines with numbers', () => {
    const bass = parseAsciiTab(decodeText(asciiFixture('bass-4-string.txt')));
    expect(bass.blocks).toEqual([]);
    expect(bass.unparsed.map((u) => u.line)).toEqual([2, 3, 4, 5]);
    expect(bass.diagnostics.map((d) => d.code)).toContain('staff-line-count');
    expect(bass.diagnostics.find((d) => d.code === 'unparsed-line')?.line).toBe(2);

    const seven = parseAsciiTab(['e|-0-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', 'E|---|', 'B|-2-|'].join('\n'));
    expect(seven.blocks).toEqual([]);
    expect(seven.unparsed).toHaveLength(7);
  });

  it('does not treat prose, chord lines or fingering lines as tab', () => {
    const tab = parseAsciiTab(['Some prose - with a dash', 'Am   G   F', '  1 2   3 4', ...['e|-0-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', 'E|---|']].join('\n'));
    expect(tab.blocks).toHaveLength(1);
    expect(tab.unparsed).toEqual([]);
  });
});

describe('parseAsciiTab: techniques', () => {
  const one = (line: string) =>
    parseAsciiTab([line, 'B|-----------------|', 'G|-----------------|', 'D|-----------------|', 'A|-----------------|', 'E|-----------------|'].join('\n'));

  it('hammer-on and pull-off set origin by pitch direction and mark the destination', () => {
    const tab = one('e|-5h7p5-------|');
    expect(flat(tab)).toEqual(['s1f5', 's1f7', 's1f5']);
    expect(noteAt(tab, 0).tech).toEqual({ hammerOn: true });
    expect(noteAt(tab, 1).tech).toEqual({ legatoDest: true, pullOff: true });
    expect(noteAt(tab, 2).tech).toEqual({ legatoDest: true });
  });

  it('slides: legato between notes, in from nowhere, out to nowhere', () => {
    const legato = one('e|-5/7-9\\7s5---|');
    expect(noteAt(legato, 0).tech).toEqual({ slide: 'legato' });
    expect(noteAt(legato, 1).tech).toEqual({ legatoDest: true });
    expect(noteAt(legato, 2).tech).toEqual({ slide: 'legato' });
    expect(noteAt(legato, 3).tech).toEqual({ legatoDest: true, slide: 'legato' });
    expect(noteAt(legato, 4).tech).toEqual({ legatoDest: true });

    const edges = one('e|-/5---7\\--\\3--9/-|');
    expect(edges.groups.map((g) => g.notes[0].tech.slide)).toEqual(['in-below', 'out-down', 'in-above', 'out-up']);
  });

  it('bends: target fret consumed, release, bend without target', () => {
    const tab = one('e|-7b9--7b9r7--12b(14)--5b--|');
    expect(flat(tab)).toEqual(['s1f7', 's1f7', 's1f12', 's1f5']);
    expect(tab.groups.map((g) => g.notes[0].tech.bend)).toEqual([
      { semitones: 2 },
      { semitones: 2, release: true },
      { semitones: 2 },
      { semitones: 2 },
    ]);
  });

  it('vibrato, dead notes, ghost notes, natural harmonics, taps', () => {
    const tab = one('e|-7~~--x--(5)--<12>--<7>-12t15-|');
    expect(noteAt(tab, 0).tech).toEqual({ vibrato: true });
    expect(noteAt(tab, 1)).toMatchObject({ fret: 0, tech: { dead: true } });
    expect(noteAt(tab, 2)).toMatchObject({ fret: 5, tech: { ghost: true } });
    expect(noteAt(tab, 3)).toMatchObject({ fret: 12, tech: { harmonic: 'natural' } });
    expect(noteAt(tab, 4)).toMatchObject({ fret: 7, tech: { harmonic: 'natural' } });
    expect(noteAt(tab, 6).tech).toEqual({ legatoDest: true });
  });

  it('palm-mute and let-ring lines mark the notes under their spans', () => {
    const tab = parseAsciiTab(
      ['PM----     P.M.-|', 'e|-0-0-0-0-0-0-0-|', 'B|---------------|', 'G|---------------|', 'D|---------------|', 'A|---------------|', 'E|---------------|', 'let ring---'].join('\n'),
    );
    expect(tab.blocks[0].palmMute).toEqual([[0, 6], [11, 17]]);
    expect(tab.groups.map((g) => g.notes[0].tech.palmMute === true)).toEqual([true, true, false, false, true, true, true]);
    expect(tab.groups.map((g) => g.notes[0].tech.letRing === true)).toEqual([true, true, true, true, false, false, false]);
  });
});

describe('parseAsciiTab: annotations', () => {
  it('reads the UG-style fixture: chord names, sections, repeats, lyrics, Drop D labels', () => {
    const tab = parseAsciiTab(decodeText(asciiFixture('ug-style-riff.txt')));
    expect(tab.unparsed).toEqual([]);
    expect(tab.tuning).toEqual(DROP_D);
    expect(tab.header).toMatchObject({ title: 'Synthetic Riff Study', artist: 'The Riffway Testers', tempo: 120, timeSig: [4, 4], capo: 0 });
    expect(tab.blocks.map((b) => [b.section, b.repeat])).toEqual([
      ['Intro', 2],
      ['Verse 1', undefined],
      ['Solo', undefined],
      ['Outro', undefined],
    ]);
    // Intro (2 bars) played twice, then 2 + 2 + 1 bars.
    expect(Math.max(...tab.groups.map((g) => g.bar))).toBe(8);
    expect(tab.groups.filter((g) => g.block === 0)).toHaveLength(16);
    expect(tab.groups.filter((g) => g.chordName).map((g) => g.chordName)).toEqual(['D5', 'D5', 'D5', 'D5', 'Am']);
    // PM span ends before the last power chord of bar 1.
    expect(tab.groups.slice(0, 4).map((g) => g.notes.every((n) => n.tech.palmMute === true))).toEqual([true, true, true, false]);
    const solo = tab.groups.filter((g) => g.block === 2).map((g) => g.notes[0]);
    expect(solo.map((n) => n.fret)).toEqual([10, 12, 13, 15, 13, 12, 14, 12, 10, 8, 7]);
    expect(solo[7].tech.bend).toEqual({ semitones: 2, release: true });
    expect(solo[10].tech.vibrato).toBe(true);
    const outro = tab.groups.filter((g) => g.block === 3);
    expect(outro.every((g) => g.notes.every((n) => n.tech.letRing))).toBe(true);
    expect(outro[outro.length - 1].notes.map((n) => n.tech.dead)).toEqual([true, true, true, true]);
  });

  it('reads repeat markers on their own line under a block', () => {
    const tab = parseAsciiTab(['e|-0-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', 'E|---|', '(repeat 3 times)'].join('\n'));
    expect(tab.blocks[0].repeat).toBe(3);
    expect(tab.groups.map((g) => g.bar)).toEqual([0, 1, 2]);
  });

  it('takes tuning from labels (Drop D, three-character Eb labels)', () => {
    const drop = parseAsciiTab(['e|-0-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', 'D|---|'].join('\n'));
    expect(drop.tuning).toEqual(DROP_D);
    const eb = parseAsciiTab(['Eb|-0-|', 'Bb|---|', 'Gb|---|', 'Db|---|', 'Ab|---|', 'Eb|---|'].join('\n'));
    expect(eb.tuning).toEqual([63, 58, 54, 49, 44, 39]);
  });

  it('aligns blocks whose labels have different widths', () => {
    const tab = parseAsciiTab(['e |-0-|', 'B |---|', 'G |---|', 'D#|-1-|', 'A |---|', 'E |---|'].join('\n'));
    expect(tab.groups).toHaveLength(1);
    expect(tab.tuning[3]).toBe(51);
  });

  it('header tuning wins over standard labels; non-standard labels win over the header', () => {
    const staff = (low: string) => ['E|-0-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', `${low}|---|`].join('\n');
    expect(parseAsciiTab(`tuning: D A D G B E\n\n${staff('E')}`).tuning).toEqual(DROP_D);
    expect(parseAsciiTab(`tuning: E A D G B E\n\n${staff('D')}`).tuning).toEqual(DROP_D);
    expect(parseAsciiTab(staff('E')).tuning).toEqual([64, 59, 55, 50, 45, 40]);
  });
});

describe('parseAsciiTab: ClassTab house style', () => {
  it('reads the synthetic study: header, ruler, sustains, Notes & Legend skipped', () => {
    const tab = parseAsciiTab(decodeText(classtab('riffway_study_no1_in_e.txt')));
    expect(tab.header).toMatchObject({
      title: 'Study No 1 in E minor',
      composer: 'Ada Fictional',
      key: 'E minor',
      timeSig: [6, 8],
      midiUrl: 'http://www.classtab.org/riffway_study_no1_in_e.mid',
    });
    expect(tab.header.tempo).toBeUndefined();
    expect(tab.blocks).toHaveLength(1);
    expect(tab.blocks[0].ruler).toEqual({ line: 8, text: '0   .   | . . | . .   | . . | . .   | . . | . .   | . . | . .' });
    expect(tab.groups).toHaveLength(19);
    expect(tab.diagnostics.map((d) => d.code)).toEqual(['notes-section']);
    expect(tab.unparsed).toEqual([]);
  });

  it('reports line numbers relative to the file for a version region', () => {
    const regions = splitVersions(decodeText(classtab('riffway_two_preludes.txt')));
    expect(regions.map((r) => r.version)).toEqual([1, 2]);
    const v2 = parseAsciiTab(regions[1].text, { lineOffset: regions[1].startLine });
    expect(v2.blocks[0].startLine).toBe(27);
    expect(v2.header.tempo).toBe(72);
  });

  it('keeps single-version files whole', () => {
    expect(splitVersions(decodeText(classtab('riffway_study_no1_in_e.txt')))).toHaveLength(1);
  });
});
