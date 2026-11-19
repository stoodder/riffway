import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importer, midi, Settings, type model } from '@coderline/alphatab';
import type { Song, Tech } from '@shared/song';
import { alphaTabToSong, alphaTabTracks, loadAlphaTabScore } from '@core/import/alphatab';
import { loadSong } from '@core/import/load-song';
import { describeTuning, onsetGroups, validateSong } from '@core/model';
import { FIXTURES, fixture, ms, musicalContent, summarize } from './helpers';

const load = (rel: string): Song => loadSong(fixture(rel));
const barTimesMs = (song: Song): number[] => song.timing.bars.map((b) => ms(b.time));

/** alphaTab's own bar timeline: sync points carry the start of bars where the tempo is (re)stated. */
function syncPoints(rel: string): { bar: number; occurrence: number; ms: number }[] {
  const score = loadAlphaTabScore(fixture(rel)).score;
  return midi.MidiFileGenerator.generateSyncPoints(score, true).map((p) => ({ bar: p.masterBarIndex, occurrence: p.masterBarOccurence, ms: p.synthTime }));
}

/** Played bar index of the `occurrence`-th pass over written bar `sourceIndex`. */
function playedBar(song: Song, sourceIndex: number, occurrence: number): number {
  let seen = -1;
  return song.timing.bars.findIndex((b) => b.sourceIndex === sourceIndex && ++seen === occurrence);
}

describe('alphaTab import: the libraries.md example (riff.atex)', () => {
  const song = load('riff.atex');

  it('reproduces 21 notes and the played-order bar times 0 / 2000 / 4666.7 / 6666.7 / 9333.3 ms', () => {
    expect(song.notes).toHaveLength(21);
    const expected = [0, 2000, 4666.7, 6666.7, 9333.3];
    song.timing.bars.forEach((b, i) => expect(Math.abs(b.time * 1000 - (expected[i] ?? NaN))).toBeLessThanOrEqual(1));
    expect(song.timing.bars.map((b) => b.sourceIndex)).toEqual([0, 1, 0, 1, 2]);
    expect(ms(song.meta.durationSec)).toBe(12000);
    expect(song.timing.tempos.map((t) => [ms(t.time), t.bpm])).toEqual([
      [0, 120],
      [2000, 90],
      [4666.7, 120],
      [6666.7, 90],
    ]);
  });

  it('flips strings (alphaTab 1 = lowest → our 6) and keeps the tuning high-first; Drop D detected', () => {
    expect(song.meta.tuning).toEqual([64, 59, 55, 50, 45, 38]);
    expect(describeTuning(song.meta.tuning)).toEqual({ id: 'drop-d', label: 'Drop D' });
    const score = loadAlphaTabScore(fixture('riff.atex')).score;
    const first = score.tracks[0]?.staves[0]?.bars[0]?.voices[0]?.beats[0]?.notes[0];
    expect(first?.string).toBe(1); // alphaTab: lowest string
    expect(song.notes[0]).toMatchObject({ string: 6, fret: 0, midi: 38 }); // ours: low D
    expect(song.notes[6]).toMatchObject({ string: 3, fret: 7, midi: 62 }); // G string, written "7.3"
  });

  it('maps sections, techniques and chords', () => {
    expect(song.sections.map((s) => [s.name, s.startBar, s.endBar])).toEqual([
      ['Intro', 0, 2],
      ['Intro', 2, 4],
      ['Verse', 4, 5],
    ]);
    expect(song.notes[1]?.tech).toEqual({ hammerOn: true });
    expect(song.notes[2]?.tech).toEqual({ legatoDest: true });
    expect(song.notes[4]?.tech).toEqual({ slide: 'legato' });
    expect(song.notes[6]?.tech).toEqual({ bend: { semitones: 2 } });
    expect(song.notes[7]?.tech).toEqual({ palmMute: true });
    expect(song.chords.map((c) => c.noteIds)).toEqual([
      [16, 17, 18],
      [19, 20],
    ]);
  });

  it('agrees with MidiFileGenerator.generateSyncPoints', () => {
    const points = syncPoints('riff.atex');
    expect(points.length).toBeGreaterThan(2);
    for (const p of points) {
      if (p.occurrence < 0) {
        expect(Math.abs(song.meta.durationSec * 1000 - p.ms)).toBeLessThan(1e-6); // end of song
        continue;
      }
      const bar = song.timing.bars[playedBar(song, p.bar, p.occurrence)];
      expect(Math.abs((bar?.time ?? NaN) * 1000 - p.ms)).toBeLessThan(1e-6);
    }
  });

  it('is valid and matches its golden file', async () => {
    expect(validateSong(song)).toEqual([]);
    await expect(JSON.stringify(summarize(song), null, 2)).toMatchFileSnapshot('../fixtures/import/golden/riff.json');
  });
});

describe('alphaTab import: midi invariant', () => {
  it.each(['riff.atex', 'capo.atex', 'gp/capo.gp', 'tab-dropd.musicxml'])('realValue = tuning + capo + fret after the flip (%s)', (rel) => {
    const { score } = loadAlphaTabScore(fixture(rel));
    const staff = score.tracks[0]?.staves[0] as model.Staff;
    const tuning = staff.tuning;
    let checked = 0;
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const n of beat.notes) {
            if (n.isHarmonic) continue;
            const ours = tuning.length - n.string + 1;
            expect((tuning[ours - 1] ?? NaN) + staff.capo + n.fret).toBe(n.realValue);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(3);
    expect(validateSong(load(rel))).toEqual([]);
  });

  it('applies the capo to every note and to natural harmonics', () => {
    const song = load('capo.atex');
    expect(song.meta.capo).toBe(2);
    expect(song.meta.artist).toBe('Riffway');
    expect(song.notes[0]).toMatchObject({ string: 6, fret: 0, midi: 42 }); // E2 + 2
    expect(song.notes.at(-1)).toMatchObject({ string: 3, fret: 7, midi: 57 + 19, tech: { harmonic: 'natural' } });
    expect(song.chords[0]?.name).toBe('E5');
  });
});

describe('alphaTab import: repeats, voltas, pickup, 6/8 and tempo changes (voltas.atex)', () => {
  const song = load('voltas.atex');

  it('expands the repeat with first/second endings', () => {
    expect(song.timing.bars.map((b) => b.sourceIndex)).toEqual([0, 1, 2, 1, 3, 4]);
    expect(barTimesMs(song)).toEqual([0, 600, 2400, 4200, 6000, 7800]);
    expect(ms(song.meta.durationSec)).toBe(9000);
    expect(song.timing.tempos.map((t) => [ms(t.time), t.bpm])).toEqual([
      [0, 100],
      [7800, 150],
    ]);
  });

  it('builds the beat grid from the time signature (pickup keeps only its beats)', () => {
    const [pickup, a] = song.timing.bars;
    expect(pickup).toMatchObject({ num: 4, den: 4, beats: [0] });
    expect(a?.num).toBe(6);
    expect(a?.den).toBe(8);
    expect(a?.beats.map(ms)).toEqual([600, 900, 1200, 1500, 1800, 2100]);
    expect(song.timing.bars[5]?.beats.map(ms)).toEqual([7800, 8000, 8200, 8400, 8600, 8800]);
  });

  it('repeats sections per pass and agrees with alphaTab sync points', () => {
    expect(song.sections.map((s) => [s.name, s.startBar, s.endBar])).toEqual([
      ['Pickup', 0, 1],
      ['A', 1, 3],
      ['A', 3, 5],
      ['B', 5, 6],
    ]);
    for (const p of syncPoints('voltas.atex')) {
      if (p.occurrence < 0) continue;
      expect(Math.abs((song.timing.bars[playedBar(song, p.bar, p.occurrence)]?.time ?? NaN) * 1000 - p.ms)).toBeLessThan(1e-6);
    }
    expect(validateSong(song)).toEqual([]);
  });

  it('matches its golden file', async () => {
    await expect(JSON.stringify(summarize(song), null, 2)).toMatchFileSnapshot('../fixtures/import/golden/voltas.json');
  });
});

describe('alphaTab import: one fixture per technique flag', () => {
  const cases: [file: string, expected: Tech[]][] = [
    ['hammer-on', [{ hammerOn: true }, { legatoDest: true }]],
    ['pull-off', [{ pullOff: true }, { legatoDest: true }]],
    ['slide-legato', [{ slide: 'legato' }, { legatoDest: true }]],
    ['slide-shift', [{ slide: 'shift' }, {}]],
    ['slide-in-below', [{ slide: 'in-below' }]],
    ['slide-in-above', [{ slide: 'in-above' }]],
    ['slide-out-up', [{ slide: 'out-up' }]],
    ['slide-out-down', [{ slide: 'out-down' }]],
    ['bend', [{ bend: { semitones: 2 } }, { bend: { semitones: 1 } }]],
    ['bend-release', [{ bend: { semitones: 2, release: true } }]],
    ['palm-mute', [{ palmMute: true }, { palmMute: true }, {}]],
    ['let-ring', [{ letRing: true }, { letRing: true }]],
    ['vibrato', [{ vibrato: true }]],
    ['harmonic', [{ harmonic: 'natural' }, { harmonic: 'natural' }, { harmonic: 'artificial' }]],
    ['dead', [{ dead: true }, { dead: true }, {}]],
    ['ghost', [{ ghost: true }, {}]],
    ['tie', [{}, {}, {}]],
  ];

  it.each(cases)('%s.atex and its GP7 export', (name, expected) => {
    for (const rel of [`techniques/${name}.atex`, `gp/techniques/${name}.gp`]) {
      const song = load(rel);
      expect(song.notes.map((n) => n.tech)).toEqual(expected);
      expect(validateSong(song)).toEqual([]);
    }
  });

  it('harmonics sound at the harmonic pitch (12th = +12, 7th = +19, AH 12 = fretted + 12)', () => {
    expect(load('techniques/harmonic.atex').notes.map((n) => n.midi)).toEqual([55 + 12, 55 + 19, 59 + 5 + 12]);
  });

  it('tied destinations keep tiedFrom and are not judge targets', () => {
    const song = load('techniques/tie.atex');
    expect(song.notes[1]).toMatchObject({ tiedFrom: 0, string: 3, fret: 5 });
    const groups = onsetGroups(song);
    expect(groups.map((g) => g.notes.map((n) => n.id))).toEqual([[0], [2]]);
  });

  it('groups chord notes and keeps chord names', () => {
    const song = load('techniques/chord.atex');
    expect(song.chords).toEqual([
      { id: 0, time: 0, noteIds: [0, 1, 2], name: 'D5' },
      { id: 1, time: 0.5, noteIds: [3, 4, 5] },
    ]);
    expect(song.notes.map((n) => n.chordId)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(song.notes.slice(0, 3).map((n) => n.string)).toEqual([4, 5, 6]);
  });
});

describe('alphaTab import: GP7 round trip', () => {
  const texFiles = ['riff', 'capo', 'voltas', 'tracks', ...readdirSync(join(FIXTURES, 'techniques')).map((f) => `techniques/${f.replace(/\.atex$/, '')}`)];

  it.each(texFiles)('%s.gp imports to the same song as %s.atex', (name) => {
    const tex = load(`${name}.atex`);
    const gp = load(`gp/${name}.gp`);
    expect(musicalContent(gp)).toEqual(musicalContent(tex));
  });
});

describe('alphaTab import: track listing', () => {
  const expected = [
    { name: 'Bass', strings: 4, playable: false, unsupportedReason: 'bass' },
    { name: 'Lead', strings: 6, playable: true, noteCount: 4 },
    { name: 'Seven', strings: 7, playable: false, unsupportedReason: 'string-count' },
    { name: 'Drums', playable: false, unsupportedReason: 'drums' },
    { name: 'Rhythm', strings: 6, playable: false, unsupportedReason: 'no-notes' },
    { name: 'Piano', playable: false, unsupportedReason: 'not-guitar' },
  ];

  it.each(['tracks.atex', 'gp/tracks.gp'])('marks bass, drums, 7-string and others unsupported (%s)', (rel) => {
    const tracks = alphaTabTracks(loadAlphaTabScore(fixture(rel)));
    expect(tracks).toHaveLength(expected.length);
    tracks.forEach((t, i) => {
      expect(t.index).toBe(i);
      expect(t).toMatchObject(expected[i] ?? {});
    });
  });

  it('defaults to the first playable track and lists every track in meta', () => {
    const song = load('tracks.atex');
    expect(song.arrangement).toBe(1);
    expect(song.meta.tracks).toHaveLength(6);
    expect(song.notes.map((n) => n.midi)).toEqual([64, 67, 69, 67]);
  });

  it('alphaTabToSong refuses an unplayable track', () => {
    const score = loadAlphaTabScore(fixture('tracks.atex'));
    expect(() => alphaTabToSong(score, 0, fixture('tracks.atex'))).toThrowError(expect.objectContaining({ code: 'bad-arrangement' }));
  });
});

describe('alphaTab import: MusicXML', () => {
  it.each(['tab-dropd.musicxml', 'tab-dropd.mxl'])('reads tab data, Drop D, repeats, rehearsal sections and tempo (%s)', async (rel) => {
    const song = load(rel);
    expect(song.meta.title).toBe('Drop D Tab');
    expect(song.meta.artist).toBe('Riffway'); // alphaTab maps the MusicXML composer credit to the artist
    expect(describeTuning(song.meta.tuning).id).toBe('drop-d');
    expect(song.timing.bars.map((b) => b.sourceIndex)).toEqual([0, 1, 0, 1, 2]);
    expect(barTimesMs(song)).toEqual([0, 2000, 4000, 6000, 8000]);
    expect(song.sections.map((s) => s.name)).toEqual(['Riff', 'Riff', 'Outro']);
    expect(song.notes[1]?.tech).toEqual({ hammerOn: true });
    expect(song.notes[2]?.tech).toEqual({ legatoDest: true });
    expect(song.notes.at(-1)).toMatchObject({ string: 3, fret: 2, midi: 57 });
    expect(song.diagnostics).toBeUndefined();
    expect(validateSong(song)).toEqual([]);
    await expect(JSON.stringify(summarize(song), null, 2)).toMatchFileSnapshot('../fixtures/import/golden/tab-dropd.json');
  });

  it('assigns strings and frets when the part has no tab data (span rule holds)', async () => {
    const song = load('melody-notab.musicxml');
    expect(song.meta.tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(song.meta.tracks[0]).toMatchObject({ playable: true, strings: 6 });
    expect(song.diagnostics?.map((d) => d.code)).toEqual(['fret-assigned']);
    // Pitches are preserved: E3 G3 A3 B3 | D4 E4 G4 A4 | C5 D5 E5 G5 | E major chord.
    expect(song.notes.slice(0, 12).map((n) => n.midi)).toEqual([52, 55, 57, 59, 62, 64, 67, 69, 72, 74, 76, 79]);
    for (const g of onsetGroups(song)) {
      const fretted = g.notes.map((n) => n.fret).filter((f) => f > 0);
      if (fretted.length === 0) continue;
      const lo = Math.min(...fretted);
      expect(Math.max(...fretted) - lo).toBeLessThanOrEqual(lo >= 7 ? 4 : 3);
      expect(new Set(g.notes.map((n) => n.string)).size).toBe(g.notes.length);
    }
    expect(song.notes.every((n) => n.fret <= 15)).toBe(true);
    expect(validateSong(song)).toEqual([]);
    await expect(JSON.stringify(summarize(song), null, 2)).toMatchFileSnapshot('../fixtures/import/golden/melody-notab.json');
  });
});

describe('alphaTab import: loader', () => {
  it('returns the alphaTab score and settings for reuse by the guide synth', () => {
    const loaded = loadAlphaTabScore(fixture('riff.atex'));
    expect(loaded.settings).toBeInstanceOf(Settings);
    expect(loaded.score.tracks).toHaveLength(1);
    expect(loaded.diagnostics).toBeUndefined();
  });

  it('surfaces alphaTex warnings (code, line, column) on a successful load and in Song.diagnostics', () => {
    const bundle = { fileName: 'w.atex', data: new TextEncoder().encode('\\title "W"\n\\ts 3 4\n:4 3.3 r r') };
    const warning = { severity: 'warning', code: 'AT301', line: 2, column: 5 };
    expect(loadAlphaTabScore(bundle).diagnostics).toEqual([expect.objectContaining(warning)]);
    expect(loadSong(bundle).diagnostics).toEqual([expect.objectContaining(warning)]);
  });

  it('rejects a corrupt binary as unsupported', () => {
    expect(() => loadAlphaTabScore({ fileName: 'x.gp5', data: new Uint8Array([1, 2, 3]) })).toThrowError(expect.objectContaining({ code: 'unsupported' }));
  });

  it('parses the same score as ScoreLoader.loadAlphaTex', () => {
    const viaLoader = importer.ScoreLoader.loadAlphaTex(new TextDecoder().decode(fixture('riff.atex').data), new Settings());
    expect(loadAlphaTabScore(fixture('riff.atex')).score.masterBars.length).toBe(viaLoader.masterBars.length);
  });
});
