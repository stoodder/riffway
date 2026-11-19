/**
 * T-103: paired-MIDI fallbacks for tabs that fail the strict match (R1-P-03) for a fixable reason: the
 * tab's repeats are written out while the MIDI plays them once, or the MIDI holds more parts than the
 * tab (a duet's guitar 2) and only one of its tracks belongs to the tab.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asciiToSong } from '@core/import/ascii';
import { readMidiRhythm } from '@core/import/midi';
import type { SongBundle } from '@shared/song';
import { buildMidi } from '../fixtures/classtab-synthetic/midi-fixtures';
import { CLASSTAB_DIR, bytes, expectValidSong, onsets } from '../ascii/song-checks';

const staff = (rows: readonly string[]): string => ['e', 'B', 'G', 'D', 'A', 'E'].map((l, i) => `${l}${rows[i]}`).join('\n');
const rest = (body: string): string => body.replace(/[^|]/g, '-');
const codes = (song: { diagnostics?: { code: string }[] }): string[] => song.diagnostics?.map((d) => d.code) ?? [];
const messageOf = (song: { diagnostics?: { code: string; message: string }[] }, code: string): string =>
  song.diagnostics?.find((d) => d.code === code)?.message ?? '';

/** e-string melody of eight different notes, written with a repeat (`x2`). */
const REPEATED = ['time: 4/4', '', staff(['|-0-1-3-5-|-7-8-10-12-|', ...Array(5).fill(rest('|-0-1-3-5-|-7-8-10-12-|'))]), 'x2'].join('\n');
const MELODY_FRETS = [0, 1, 3, 5, 7, 8, 10, 12];

function tabBundle(text: string, midi: Uint8Array, fileName = 'riffway_rep.txt'): SongBundle {
  return { fileName, data: bytes(text), source: { source: 'classtab', path: fileName }, midi: { fileName: fileName.replace(/\.txt$/, '.mid'), data: midi } };
}

describe('MIDI fallback: the tab without its repeats', () => {
  const once = buildMidi({ bpm: 120, timeSig: [4, 4], unit: 1, tracks: [{ name: 'g', events: MELODY_FRETS.map((f, k) => [1, f, k, 1]) }] });

  it('aligns the written order when the MIDI plays the repeated passage once', () => {
    const song = asciiToSong(tabBundle(REPEATED, once));
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('midi');
    expect(messageOf(song, 'midi-aligned')).toMatch(/100% .*without the tab's repeats/);
    expect(song.notes.map((n) => n.fret)).toEqual(MELODY_FRETS);
    onsets(song).forEach((t, i) => expect(t).toBeCloseTo(i * 0.5, 3));
  });

  it('keeps the repeats when the MIDI plays them', () => {
    const twice = buildMidi({ bpm: 120, timeSig: [4, 4], unit: 1, tracks: [{ name: 'g', events: [...MELODY_FRETS, ...MELODY_FRETS].map((f, k) => [1, f, k, 1]) }] });
    const song = asciiToSong(tabBundle(REPEATED, twice));
    expect(song.meta.rhythm).toBe('midi');
    expect(messageOf(song, 'midi-aligned')).not.toMatch(/repeats/);
    expect(song.notes).toHaveLength(16);
  });
});

describe('MIDI fallback: one track of a multi-track MIDI', () => {
  // The duet fixture's guitar 1 (16 eighths at Q=60) plus a guitar 2 track on the off-beats.
  const guitar1: [number, number, number, number][] = [0, 0, 0, 0, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3, 3, 3].map((f, k) => [1, f, k, 1]);
  const guitar2: [number, number, number, number][] = Array.from({ length: 16 }, (_, k) => [3, 2, k + 0.5, 0.5]);
  const duo = new Uint8Array(readFileSync(join(CLASSTAB_DIR, 'recall', 'riffway_duo_rondino.txt')));
  const bundleWith = (midi: Uint8Array): SongBundle => ({
    fileName: 'riffway_duo_rondino.txt',
    data: duo,
    source: { source: 'classtab', path: 'riffway_duo_rondino.txt' },
    midi: { fileName: 'riffway_duo_rondino.mid', data: midi },
  });

  it('readMidiRhythm lists each track\'s onset groups when there are several', () => {
    const both = readMidiRhythm(buildMidi({ bpm: 60, timeSig: [2, 4], unit: 0.5, tracks: [{ name: 'g1', events: guitar1 }, { name: 'g2', events: guitar2 }] }));
    expect(both.groups).toHaveLength(32);
    expect(both.tracks?.map((t) => t.length)).toEqual([16, 16]);
    expect(readMidiRhythm(buildMidi({ bpm: 60, timeSig: [2, 4], unit: 0.5, tracks: [{ name: 'g1', events: guitar1 }] })).tracks).toBeUndefined();
  });

  it('aligns guitar 1 of a duet to its own track when the merged tracks do not match', () => {
    const midi = buildMidi({ bpm: 60, timeSig: [2, 4], unit: 0.5, tracks: [{ name: 'g2', events: guitar2 }, { name: 'g1', events: guitar1 }] });
    const song = asciiToSong(bundleWith(midi));
    expectValidSong(song);
    expect(song.meta.rhythm).toBe('midi');
    expect(messageOf(song, 'midi-aligned')).toMatch(/against MIDI track 2 alone/);
    onsets(song).forEach((t, i) => expect(t).toBeCloseTo(i * 0.5, 3));
  });

  it('still rejects an unrelated MIDI, reporting the best match it found', () => {
    const other = buildMidi({ bpm: 60, timeSig: [2, 4], unit: 0.5, tracks: [{ name: 'x', events: guitar2 }, { name: 'y', events: guitar2.map(([s, , t, d]) => [s, 7, t, d]) }] });
    const song = asciiToSong(bundleWith(other));
    expect(song.meta.rhythm).toBe('ruler');
    expect(codes(song)).toContain('midi-low-match');
    expect(messageOf(song, 'midi-low-match')).toMatch(/matched only \d+% .*needs 80%/);
  });
});
