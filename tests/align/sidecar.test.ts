import { describe, expect, it } from 'vitest';
import { applySidecar, mapTapsToOnsets } from '@core/import/align';
import { asciiToSong, parseAsciiTab, decodeText } from '@core/import/ascii';
import type { RhythmSidecar } from '@shared/song';
import { asciiFixture, bytes, expectValidSong, onsets } from '../ascii/song-checks';

const sidecar = (onsetTimes: number[], extra: Partial<RhythmSidecar> = {}): RhythmSidecar => ({
  schema: 1,
  bpm: 120,
  timeSig: [4, 4],
  grid: 8,
  onsets: onsetTimes,
  method: 'tap',
  savedAt: 1_700_000_000_000,
  ...extra,
});

describe('applySidecar', () => {
  const text = decodeText(asciiFixture('ug-style-riff.txt'));
  const song = asciiToSong({ fileName: 'ug-style-riff.txt', data: bytes(text) });
  const groups = parseAsciiTab(text).groups;

  it('retimes every onset group, rebuilds bars and keeps named sections', () => {
    const taps = groups.map((_, i) => i * 0.25);
    const aligned = applySidecar(song, sidecar(mapTapsToOnsets(taps, groups)));
    expectValidSong(aligned);
    expect(aligned.meta.rhythm).toBe('aligned');
    expect(onsets(aligned)).toEqual(taps);
    expect(aligned.timing).toMatchObject({ tempos: [{ time: 0, bpm: 120 }] });
    expect(aligned.timing.bars.every((b) => b.dur === 2 && b.beats.length === 4)).toBe(true);
    expect(aligned.sections.map((s) => s.name)).toEqual(['Intro', 'Verse 1', 'Solo', 'Outro']);
    // Intro groups 0–15 at 0.25 s → bars 0–1; the verse starts at group 16 = 4 s = bar 2.
    expect(aligned.sections[1].startBar).toBe(2);
    expect(aligned.chords.every((c) => c.time === aligned.notes[c.noteIds[0]].time)).toBe(true);
    // Input untouched.
    expect(song.meta.rhythm).toBe('needs-alignment');
  });

  it('scales durations with the local tempo and never rings into the next note on the string', () => {
    const slow = applySidecar(song, sidecar(groups.map((_, i) => i * 2), { bpm: 30 }));
    expectValidSong(slow);
    const byString = new Map<number, number>();
    for (const n of [...slow.notes].reverse()) {
      const next = byString.get(n.string);
      if (next !== undefined) expect(n.time + n.dur).toBeLessThanOrEqual(next + 1e-9);
      byString.set(n.string, n.time);
    }
    expect(slow.notes[0].dur).toBeGreaterThan(song.notes[0].dur);
  });

  it('rebuilds auto-sections for songs without named sections', () => {
    const tab = ['e|-0-0-0-0-|', 'B|---------|', 'G|---------|', 'D|---------|', 'A|---------|', 'E|---------|'].join('\n');
    const plain = asciiToSong({ fileName: 'p.txt', data: bytes(tab) });
    const aligned = applySidecar(plain, sidecar([0, 10, 20, 30]));
    expect(aligned.sections.slice(0, 2).map((s) => [s.name, s.startBar, s.endBar])).toEqual([['Part 1', 0, 8], ['Part 2', 8, 16]]);
    expect(aligned.sections.every((s) => /^Part \d+$/.test(s.name))).toBe(true);
    expectValidSong(aligned);
  });

  it('returns the song unchanged with a warning when the onset count differs', () => {
    const out = applySidecar(song, sidecar([0, 1, 2]));
    expect(out.meta.rhythm).toBe('needs-alignment');
    expect(out.notes).toBe(song.notes);
    expect(out.diagnostics?.at(-1)).toMatchObject({ severity: 'warning', code: 'sidecar-mismatch' });
  });

  it('repairs non-increasing or non-finite onsets', () => {
    const bad = groups.map((_, i) => (i === 3 ? Number.NaN : i === 5 ? 0 : i * 0.5));
    const aligned = applySidecar(song, sidecar(bad));
    expectValidSong(aligned);
  });
});
