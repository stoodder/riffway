import { describe, expect, it } from 'vitest';
import type { Bar, Note, Song, StringNumber } from '@shared/song';
import { autoSections, barAt, beatTimes, describeTuning, notesInRange, sectionAt, STANDARD_TUNING, validateSong } from '@core/model';

/** 4/4 bars of 2 s (120 BPM), contiguous from 0. */
function bars(count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => ({ index: i, time: i * 2, dur: 2, num: 4, den: 4, beats: [0, 0.5, 1, 1.5].map((b) => i * 2 + b) }));
}

function note(id: number, time: number, string: StringNumber, fret: number, extra: Partial<Note> = {}): Note {
  return { id, time, dur: 0.25, string, fret, midi: (STANDARD_TUNING[string - 1] ?? 0) + fret, bar: Math.floor(time / 2), tech: {}, ...extra };
}

function song(notes: Note[], barCount = 4, extra: Partial<Song> = {}): Song {
  const timing = { tempos: [{ time: 0, bpm: 120 }], bars: bars(barCount) };
  return {
    schema: 1,
    id: 'test:1',
    arrangement: 0,
    meta: {
      title: 'T',
      source: { source: 'local' },
      tags: { style: [], genre: [], skills: [] },
      tuning: [...STANDARD_TUNING],
      capo: 0,
      durationSec: barCount * 2,
      rhythm: 'exact',
      tracks: [],
    },
    timing,
    sections: [
      { name: 'A', startBar: 0, endBar: 2, start: 0, end: 4 },
      { name: 'B', startBar: 2, endBar: barCount, start: 4, end: barCount * 2 },
    ],
    notes,
    chords: [],
    ...extra,
  };
}

const NOTES = [note(0, 0, 6, 0), note(1, 0.5, 6, 3), note(2, 1, 5, 2), note(3, 1, 4, 2), note(4, 2.5, 3, 0), note(5, 4, 2, 1), note(6, 7.5, 1, 0)];

describe('notesInRange', () => {
  const s = song(NOTES);
  it.each([
    [0, 1, 0, 2],
    [0, 1.0001, 0, 4],
    [1, 4, 2, 5],
    [4, 4, 5, 5],
    [5, 3, 6, 6], // inverted → empty at `from`
    [-10, 100, 0, 7],
    [8, 9, 7, 7],
  ])('[%s, %s) → [%s, %s)', (from, to, start, end) => {
    expect(notesInRange(s, from, to)).toEqual({ start, end });
  });

  it('handles an empty song', () => {
    expect(notesInRange(song([]), 0, 10)).toEqual({ start: 0, end: 0 });
  });
});

describe('barAt / sectionAt / beatTimes', () => {
  const s = song(NOTES);

  it.each([
    [-1, 0],
    [0, 0],
    [1.999, 0],
    [2, 1],
    [7.9, 3],
    [100, 3],
  ])('barAt(%s) = %s', (t, bar) => {
    expect(barAt(s, t)).toBe(bar);
  });

  it.each([
    [-1, 0],
    [3.99, 0],
    [4, 1],
    [100, 1],
  ])('sectionAt(%s) = %s', (t, section) => {
    expect(sectionAt(s, t)).toBe(section);
  });

  it('sectionAt is -1 without sections', () => {
    expect(sectionAt(song(NOTES, 4, { sections: [] }), 1)).toBe(-1);
  });

  it('beatTimes flattens the beat grid in order', () => {
    const beats = beatTimes(song([], 2));
    expect(beats).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
  });
});

describe('autoSections', () => {
  it('cuts 8-bar parts named Part 1…n, the last one shorter', () => {
    const timing = { tempos: [{ time: 0, bpm: 120 }], bars: bars(19) };
    expect(autoSections(timing)).toEqual([
      { name: 'Part 1', startBar: 0, endBar: 8, start: 0, end: 16 },
      { name: 'Part 2', startBar: 8, endBar: 16, start: 16, end: 32 },
      { name: 'Part 3', startBar: 16, endBar: 19, start: 32, end: 38 },
    ]);
    expect(autoSections(timing, 4)).toHaveLength(5);
  });

  it('returns [] without bars', () => {
    expect(autoSections({ tempos: [], bars: [] })).toEqual([]);
  });
});

describe('describeTuning', () => {
  it.each([
    [[64, 59, 55, 50, 45, 40], 'standard', 'Standard'],
    [[64, 59, 55, 50, 45, 38], 'drop-d', 'Drop D'],
    [[63, 58, 54, 49, 44, 39], 'eb-standard', 'Eb Standard'],
    [[62, 57, 53, 48, 43, 38], 'd-standard', 'D Standard'],
    [[62, 57, 53, 48, 43, 36], 'drop-c', 'Drop C'],
    [[62, 57, 55, 50, 45, 38], 'dadgad', 'DADGAD'],
    [[62, 59, 55, 50, 43, 38], 'open-g', 'Open G'],
    [[64, 59, 55, 50, 45, 39], 'custom', 'D# A D G B E'],
    [[64, 59, 55, 50, 45, 40, 35], 'custom', 'B E A D G B E'],
  ])('%j → %s', (tuning, id, label) => {
    expect(describeTuning(tuning)).toEqual({ id, label });
  });
});

describe('validateSong', () => {
  const codes = (s: Song): string[] => [...new Set(validateSong(s).map((i) => i.code))];

  it('accepts a valid song (incl. chords, ties and harmonics)', () => {
    const notes = [
      note(0, 0, 4, 2, { chordId: 0 }),
      note(1, 0, 5, 2, { chordId: 0 }),
      note(2, 1, 3, 12, { midi: 67, tech: { harmonic: 'natural' } }),
      note(3, 1, 4, 2, { tiedFrom: 0 }),
      note(4, 1.5, 3, 7, { midi: 74, tech: { harmonic: 'natural' } }),
    ];
    expect(validateSong(song(notes, 4, { chords: [{ id: 0, time: 0, noteIds: [0, 1] }] }))).toEqual([]);
  });

  it('flags id-order and time-order', () => {
    expect(codes(song([note(1, 0, 6, 0)]))).toEqual(['id-order']);
    expect(codes(song([note(0, 1, 6, 0), note(1, 0.5, 6, 0)]))).toEqual(['time-order']);
    expect(codes(song([note(0, 1, 3, 0), note(1, 1, 2, 0)]))).toEqual(['time-order']); // string order at one onset
    expect(codes(song([note(0, -1, 6, 0, { bar: 0 })]))).toContain('time-order');
  });

  it('flags the midi invariant (capo included) but not harmonics', () => {
    expect(codes(song([note(0, 0, 6, 3, { midi: 40 })]))).toEqual(['midi-invariant']);
    const capo = song([note(0, 0, 6, 3)]);
    capo.meta.capo = 2;
    expect(codes(capo)).toEqual(['midi-invariant']);
    capo.notes[0] = { ...(capo.notes[0] as Note), midi: 45 };
    expect(codes(capo)).toEqual([]);
    expect(codes(song([note(0, 0, 3, 12, { midi: 67, tech: { harmonic: 'natural' } })]))).toEqual([]);
  });

  it('flags string collisions of non-tied notes only', () => {
    expect(codes(song([note(0, 0, 6, 0), note(1, 0, 6, 3)]))).toEqual(['string-collision']);
    expect(codes(song([note(0, 0, 6, 0), note(1, 0, 6, 0, { tiedFrom: 0 })]))).toEqual([]);
  });

  it('flags bar gaps, bad beats and missing bars of notes', () => {
    const gap = song([]);
    (gap.timing.bars[2] as Bar).time = 4.5;
    expect(codes(gap)).toContain('bar-gap');
    const beats = song([]);
    (beats.timing.bars[1] as Bar).beats = [2.5, 3];
    expect(codes(beats)).toEqual(['bar-gap']);
    expect(codes(song([note(0, 0.5, 6, 0, { bar: 1 })]))).toEqual(['note-bar']);
    expect(codes(song([note(0, 0.5, 6, 0, { bar: 9 })]))).toEqual(['note-bar']);
  });

  it('flags sections that are not whole, ordered bars', () => {
    expect(codes(song([], 4, { sections: [{ name: 'X', startBar: 0, endBar: 0, start: 0, end: 0 }] }))).toEqual(['section-bars']);
    expect(codes(song([], 4, { sections: [{ name: 'X', startBar: 0, endBar: 2, start: 0, end: 3 }] }))).toEqual(['section-bars']);
    expect(
      codes(
        song([], 4, {
          sections: [
            { name: 'A', startBar: 0, endBar: 3, start: 0, end: 6 },
            { name: 'B', startBar: 2, endBar: 4, start: 4, end: 8 },
          ],
        }),
      ),
    ).toEqual(['section-bars']);
    expect(codes(song([], 4, { sections: [{ name: 'X', startBar: 3, endBar: 5, start: 6, end: 10 }] }))).toEqual(['section-bars']);
  });

  it('flags broken chord and tie references', () => {
    expect(codes(song([note(0, 0, 6, 0, { chordId: 0 })]))).toEqual(['chord-ref']);
    expect(codes(song([note(0, 0, 5, 0), note(1, 0, 6, 0)], 4, { chords: [{ id: 0, time: 0, noteIds: [0, 1] }] }))).toEqual(['chord-ref']);
    expect(codes(song([note(0, 0, 6, 0, { chordId: 0 }), note(1, 1, 5, 0, { chordId: 0 })], 4, { chords: [{ id: 0, time: 0, noteIds: [0, 1] }] }))).toEqual(['chord-ref']);
    expect(codes(song([note(0, 0, 6, 0, { tiedFrom: 0 })]))).toEqual(['tie-ref']);
    expect(codes(song([note(0, 0, 6, 0), note(1, 1, 5, 0, { tiedFrom: 0 })]))).toEqual(['tie-ref']);
  });
});
