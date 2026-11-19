/**
 * Shared test helpers for ASCII/ClassTab imports: fixture loading and the song-model invariants
 * from docs/song-formats.md (checked locally so these tests do not depend on other tasks' code).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { Song } from '@shared/song';

export const CLASSTAB_DIR = join(import.meta.dirname, '..', 'fixtures', 'classtab-synthetic');
export const ASCII_DIR = join(import.meta.dirname, '..', 'fixtures', 'ascii');

/** Bytes of a synthetic ClassTab fixture. */
export function classtab(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(CLASSTAB_DIR, name)));
}

/** Bytes of an ASCII fixture. */
export function asciiFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ASCII_DIR, name)));
}

/** UTF-8 bytes of a string. */
export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Distinct onset times of a song, ascending. */
export const onsets = (song: Song): number[] => [...new Set(song.notes.map((n) => n.time))];

/** Assert the song-model invariants (times, MIDI pitches, collisions, bars, sections, chords). */
export function expectValidSong(song: Song): void {
  const { notes, timing, sections, chords, meta } = song;
  expect(notes.length).toBeGreaterThan(0);
  notes.forEach((n, i) => {
    expect(n.id).toBe(i);
    expect(n.time).toBeGreaterThanOrEqual(0);
    expect(n.dur).toBeGreaterThanOrEqual(0);
    if (i > 0) {
      const p = notes[i - 1];
      expect(n.time > p.time || (n.time === p.time && n.string > p.string)).toBe(true);
    }
    if (!n.tech.harmonic) expect(n.midi).toBe(meta.tuning[n.string - 1] + meta.capo + n.fret);
    const bar = timing.bars[n.bar];
    expect(n.time).toBeGreaterThanOrEqual(bar.time - 1e-6);
    expect(n.time).toBeLessThan(bar.time + bar.dur + 1e-6);
  });
  timing.bars.forEach((b, i) => {
    expect(b.index).toBe(i);
    expect(b.beats[0]).toBeCloseTo(b.time, 9);
    if (i > 0) expect(b.time).toBeCloseTo(timing.bars[i - 1].time + timing.bars[i - 1].dur, 6);
  });
  const end = timing.bars[timing.bars.length - 1].time + timing.bars[timing.bars.length - 1].dur;
  expect(meta.durationSec).toBeCloseTo(end, 6);
  expect(sections[0].startBar).toBe(0);
  expect(sections[sections.length - 1].endBar).toBe(timing.bars.length);
  sections.forEach((s, i) => {
    if (i > 0) expect(s.startBar).toBe(sections[i - 1].endBar);
    expect(s.start).toBeCloseTo(timing.bars[s.startBar].time, 9);
  });
  for (const c of chords) {
    expect(c.noteIds.length).toBeGreaterThan(1);
    for (const id of c.noteIds) {
      expect(notes[id].chordId).toBe(c.id);
      expect(notes[id].time).toBe(c.time);
    }
  }
}
