import { describe, expect, it } from 'vitest';
import { asciiToSong } from '@core/import/ascii';
import { snapToGrid } from '@core/import/align';
import { ImportError } from '@core/import/errors';
import { parseAsciiTab, decodeText } from '@core/import/ascii';
import type { RhythmSidecar, SongBundle } from '@shared/song';
import { asciiFixture, bytes, classtab, expectValidSong, onsets } from './song-checks';

const CLASSTAB_SOURCE = { source: 'classtab' as const };

function bundle(tab: string, midi?: string, extra: Partial<SongBundle> = {}): SongBundle {
  return {
    fileName: tab,
    data: classtab(tab),
    source: { ...CLASSTAB_SOURCE, path: tab },
    ...(midi ? { midi: { fileName: midi, data: classtab(midi) } } : {}),
    ...extra,
  };
}

const range = (n: number, start: number, step: number): number[] => Array.from({ length: n }, (_, k) => start + k * step);

describe('asciiToSong: beat ruler', () => {
  it('6/8 with a one-eighth pickup (study, no MIDI)', () => {
    const song = asciiToSong(bundle('riffway_study_no1_in_e.txt'));
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('ruler');
    expect(song.meta.tempoEstimated).toBe(true);
    const e = 60 / 80 / 2; // eighth at the default 80 BPM
    const expected = [0, ...range(6, e, e), ...[7, 8, 10, 11, 12].map((m) => m * e), ...range(6, 13 * e, e), 19 * e];
    onsets(song).forEach((t, i) => expect(t).toBeCloseTo(expected[i], 9));
    expect(song.timing.bars.map((b) => [b.num, b.den])).toEqual([[1, 8], [6, 8], [6, 8], [6, 8], [6, 8]]);
    expect(song.timing.bars[1].time).toBeCloseTo(e, 9);
    expect(song.timing.bars[1].beats).toHaveLength(6);
    // The pickup note sits in the pickup bar; the hammer-on keeps its technique flags.
    expect(song.notes[0]).toMatchObject({ string: 3, fret: 0, bar: 0, midi: 55 });
    const hammer = song.notes.filter((n) => n.string === 3 && n.bar === 2);
    expect(hammer.map((n) => [n.fret, n.tech])).toEqual([[2, {}], [2, { hammerOn: true }], [4, { legatoDest: true }]]);
    // `=` sustain: the bass E rings for the whole first bar.
    const bass = song.notes.find((n) => n.string === 6 && n.bar === 1);
    expect(bass?.dur).toBeCloseTo(6 * e, 9);
  });

  it('3/4 with tempo and two-digit frets (waltz); a mismatched MIDI falls back to the ruler', () => {
    const song = asciiToSong(bundle('riffway_waltz_in_a.txt', 'riffway_waltz_in_a_1.mid'));
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('ruler');
    expect(song.meta.tempoEstimated).toBeUndefined();
    expect(song.meta.tuning).toEqual([64, 59, 55, 50, 45, 38]);
    expect(song.diagnostics?.map((d) => d.code)).toContain('midi-low-match');
    const e = 60 / 90 / 2;
    const slots = [0, 2, 4, 6, 8, 9, 10, 12, 14, 16];
    onsets(song).forEach((t, i) => expect(t).toBeCloseTo(slots[i] * e, 9));
    expect(song.timing.bars.map((b) => [b.num, b.den, b.beats.length])).toEqual([[3, 4, 3], [3, 4, 3], [3, 4, 3]]);
    expect(song.notes.find((n) => n.fret === 10)).toMatchObject({ string: 1, midi: 74, bar: 2 });
    expect(song.notes[0]).toMatchObject({ string: 6, fret: 0, midi: 38 });
  });

  it('4/4 quarter-note ruler with eighths between marks (march, windows-1252, unlabelled staff)', () => {
    const song = asciiToSong({ fileName: 'riffway_march_in_c.txt', data: classtab('riffway_march_in_c.txt') });
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('ruler');
    expect(song.meta.title).toBe('Marche élégante in C');
    expect(song.meta.composer).toBe('Bérénice Exemple');
    const e = 60 / 80 / 2;
    const slots = [...range(8, 0, 1), ...range(8, 8, 1), 16, 18, 20, 22, 24];
    onsets(song).forEach((t, i) => expect(t).toBeCloseTo(slots[i] * e, 9));
    expect(song.timing.bars).toHaveLength(4);
    expect(song.chords.map((c) => c.noteIds.length)).toEqual([2, 2, 5]);
  });
});

describe('asciiToSong: repeat signs', () => {
  it('times repeated bars from the beat ruler and keeps the song valid', () => {
    const text = [
      'time: 2/4  tempo: Q=60',
      '',
      '0  | . | .     | . | .     | . | .',
      'e|-0-0-0-0-||*-1-1-1-1-*||-3-3-3-3-|',
      'B|---------||----------*||---------|',
      'G|---------||*---------*||---------|',
      'D|---------||*----------||---------|',
      'A|---------||-----------||---------|',
      'E|---------||-----------||---------|',
    ].join('\n');
    const song = asciiToSong({ fileName: 'repeat.txt', data: bytes(text) });
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('ruler');
    expect(song.notes.map((n) => n.fret)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 3, 3]);
    onsets(song).forEach((t, i) => expect(t).toBeCloseTo(i * 0.5, 9));
    expect(song.timing.bars).toHaveLength(4);
  });
});

describe('asciiToSong: paired MIDI', () => {
  it('takes onset times and bars from the MIDI (study, ornament skipped, rest bar before the pickup)', () => {
    const song = asciiToSong(bundle('riffway_study_no1_in_e.txt', 'riffway_study_no1_in_e.mid'));
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('midi');
    expect(song.meta.tempoEstimated).toBeUndefined();
    const e = 0.25; // eighth at 120 BPM
    const slots = [5, ...range(6, 6, 1), 12, 13, 15, 16, 17, ...range(6, 18, 1), 24];
    onsets(song).forEach((t, i) => expect(t).toBeCloseTo(slots[i] * e, 4));
    expect(song.timing.tempos).toEqual([{ time: 0, bpm: 120 }]);
    expect(song.timing.bars.map((b) => b.time)).toEqual([0, 1.5, 3, 4.5, 6]);
    expect(song.meta.durationSec).toBeCloseTo(7.5, 6);
    expect(song.notes[0].bar).toBe(0);
    expect(song.meta.source.url).toBe('http://www.classtab.org/riffway_study_no1_in_e.mid');
    // 19 of 20 groups paired; the ornament the tab omits is one skipped MIDI run (R1-P-03): 19 / 20.
    expect(song.diagnostics?.find((d) => d.code === 'midi-aligned')?.message).toContain('95%');
  });

  it('header-URL pair (march)', () => {
    const song = asciiToSong(bundle('riffway_march_in_c.txt', 'riffway_marche_elegante.mid'));
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('midi');
    const slots = [...range(8, 0, 1), ...range(8, 8, 1), 16, 18, 20, 22, 24];
    onsets(song).forEach((t, i) => expect(t).toBeCloseTo(slots[i] * 0.3, 4));
  });

  it('multi-version tab: each version with its numbered MIDI', () => {
    const v1 = asciiToSong(bundle('riffway_two_preludes.txt', 'riffway_two_preludes_01.mid'));
    const v2 = asciiToSong(bundle('riffway_two_preludes.txt', 'riffway_two_preludes_02.mid'), { version: 2 });
    for (const s of [v1, v2]) {
      expectValidSong(s);
      expect(s.meta.rhythm).toBe('midi');
      expect(s.meta.title).toBe('Two Little Preludes');
      expect(s.diagnostics?.map((d) => d.code)).toContain('multiple-versions');
    }
    onsets(v1).forEach((t, i) => expect(t).toBeCloseTo(i * 0.5, 4));
    onsets(v2).forEach((t, i) => expect(t).toBeCloseTo((i * 60) / 72 / 2, 4));
    expect(v1.notes.map((n) => n.midi)).toEqual([45, 57, 60, 64, 45, 57, 60, 57]);
    expect(v2.notes.map((n) => n.midi)).toEqual([40, 56, 59, 64, 40, 56, 59, 68]);
  });

  it('a version MIDI on the wrong version is rejected (< 80% matched)', () => {
    const song = asciiToSong(bundle('riffway_two_preludes.txt', 'riffway_two_preludes_02.mid'));
    expect(song.meta.rhythm).toBe('needs-alignment');
    expect(song.diagnostics?.map((d) => d.code)).toContain('midi-low-match');
  });

  it('unreadable MIDI bytes fall back with a warning', () => {
    const song = asciiToSong({ ...bundle('riffway_study_no1_in_e.txt'), midi: { fileName: 'x.mid', data: bytes('not a midi') } });
    expect(song.meta.rhythm).toBe('ruler');
    expect(song.diagnostics?.find((d) => d.code === 'midi-unreadable')?.severity).toBe('warning');
  });
});

describe('asciiToSong: needs alignment and sidecars', () => {
  it('no MIDI and no ruler → proportional onsets, capo and Drop D prose applied', () => {
    const song = asciiToSong(bundle('riffway_lament_unpaired.txt'));
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('needs-alignment');
    expect(song.meta.tempoEstimated).toBe(true);
    expect(song.meta.capo).toBe(2);
    expect(song.meta.tuning).toEqual([64, 59, 55, 50, 45, 38]);
    expect(song.notes[0]).toMatchObject({ string: 6, fret: 0, midi: 40, column: 3 });
    expect(song.timing.bars.map((b) => b.dur)).toEqual([2.25, 2.25, 2.25]);
    expect(song.sections).toEqual([{ name: 'Part 1', startBar: 0, endBar: 3, start: 0, end: 6.75 }]);
  });

  it('a matching sidecar → rhythm aligned with the sidecar grid', () => {
    const tab = parseAsciiTab(decodeText(classtab('riffway_lament_unpaired.txt')));
    const onsetsSnapped = snapToGrid(tab.groups, 100, [3, 4], 8);
    const sidecar: RhythmSidecar = { schema: 1, bpm: 100, timeSig: [3, 4], grid: 8, onsets: onsetsSnapped, method: 'snap', savedAt: 0 };
    const song = asciiToSong(bundle('riffway_lament_unpaired.txt', undefined, { sidecar }));
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('aligned');
    expect(song.meta.tempoEstimated).toBeUndefined();
    expect(onsets(song)).toEqual(onsetsSnapped);
    expect(song.timing.tempos).toEqual([{ time: 0, bpm: 100 }]);
    expect(song.timing.bars[1].time).toBeCloseTo(1.8, 9);
  });

  it('a sidecar with the wrong onset count is ignored with a warning', () => {
    const sidecar: RhythmSidecar = { schema: 1, bpm: 100, timeSig: [3, 4], grid: 8, onsets: [0, 1], method: 'tap', savedAt: 0 };
    const song = asciiToSong(bundle('riffway_lament_unpaired.txt', undefined, { sidecar }));
    expect(song.meta.rhythm).toBe('needs-alignment');
    expect(song.diagnostics?.map((d) => d.code)).toContain('sidecar-mismatch');
  });

  it('the sidecar wins over a matching MIDI (explicit user alignment)', () => {
    const plain = asciiToSong(bundle('riffway_study_no1_in_e.txt', 'riffway_study_no1_in_e.mid'));
    const times = onsets(plain).map((t) => t * 2);
    const sidecar: RhythmSidecar = { schema: 1, bpm: 60, timeSig: [6, 8], grid: 8, onsets: times, method: 'tap', savedAt: 0 };
    const song = asciiToSong(bundle('riffway_study_no1_in_e.txt', 'riffway_study_no1_in_e.mid', { sidecar }));
    expect(song.meta.rhythm).toBe('aligned');
    expect(onsets(song)).toEqual(times);
  });
});

describe('asciiToSong: UG-style tabs, metadata and errors', () => {
  it('imports the UG-style fixture with sections, chord names and repeats', () => {
    const song = asciiToSong({ fileName: 'ug-style-riff.txt', data: asciiFixture('ug-style-riff.txt'), tags: { genre: ['rock'] } });
    expectValidSong(song);
    expect(song.meta).toMatchObject({ title: 'Synthetic Riff Study', artist: 'The Riffway Testers', rhythm: 'needs-alignment', capo: 0 });
    expect(song.meta.tempoEstimated).toBeUndefined();
    expect(song.meta.source).toEqual({ source: 'local', path: 'ug-style-riff.txt' });
    expect(song.meta.tags).toEqual({ style: [], genre: ['rock'], skills: [] });
    expect(song.meta.tracks).toEqual([{ index: 0, name: 'Guitar', strings: 6, tuning: [64, 59, 55, 50, 45, 38], capo: 0, playable: true, noteCount: song.notes.length }]);
    expect(song.sections.map((s) => [s.name, s.startBar, s.endBar])).toEqual([
      ['Intro', 0, 4],
      ['Verse 1', 4, 6],
      ['Solo', 6, 8],
      ['Outro', 8, 9],
    ]);
    expect(song.timing.bars).toHaveLength(9);
    expect(song.timing.bars[0].dur).toBeCloseTo(2, 9);
    expect(song.chords.filter((c) => c.name).map((c) => c.name)).toEqual(['D5', 'D5', 'D5', 'D5', 'Am']);
    const harmonic = song.notes.find((n) => n.tech.harmonic);
    expect(harmonic).toMatchObject({ string: 1, fret: 12, midi: 76 });
  });

  it('uses "Artist - Title" file names for non-ClassTab sources', () => {
    const tab = ['e|-0-|', 'B|---|', 'G|---|', 'D|---|', 'A|---|', 'E|---|'].join('\n');
    const song = asciiToSong({ fileName: 'The Testers - Open E.txt', data: bytes(`Something Else - Ada Fictional\n${tab}`) }, { id: 'local:abc' });
    expect(song.id).toBe('local:abc');
    expect(song.meta).toMatchObject({ title: 'Open E', artist: 'The Testers' });
    expect(song.meta.composer).toBeUndefined();
  });

  it('throws typed errors for empty input and bass tabs', () => {
    expect(() => asciiToSong({ fileName: 'empty.txt', data: bytes('just some words\n') })).toThrowError(ImportError);
    try {
      asciiToSong({ fileName: 'bass.txt', data: asciiFixture('bass-4-string.txt') });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ImportError);
      expect((err as ImportError).code).toBe('no-playable-track');
      expect((err as ImportError).diagnostics.map((d) => d.code)).toContain('unparsed-line');
    }
    try {
      asciiToSong({ fileName: 'empty.txt', data: bytes('') });
      expect.unreachable();
    } catch (err) {
      expect((err as ImportError).code).toBe('empty');
    }
  });

  it('is JSON-serialisable', () => {
    const song = asciiToSong(bundle('riffway_study_no1_in_e.txt', 'riffway_study_no1_in_e.mid'));
    expect(JSON.parse(JSON.stringify(song))).toEqual(song);
  });
});
