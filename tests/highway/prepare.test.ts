/**
 * Song → highway draw data (T-024): technique flags, connectors, chord boxes, palm-mute runs, beat
 * grid, culling indexes, labels; plus the dev fixture songs the renderer is screenshotted with.
 */
import { describe, expect, it } from 'vitest';
import type { Note, Song } from '@shared/song';
import { computePositions } from '@core/handpos';
import { validateSong } from '@core/model';
import {
  F_BEND_RELEASE,
  F_CHORD,
  F_DEAD,
  F_GHOST,
  F_HAMMER,
  F_HARMONIC,
  F_LET_RING,
  F_PALM_MUTE,
  F_PULL,
  F_TIED_DEST,
  F_VIBRATO,
  LONG_SUSTAIN_SEC,
  SLIDE_CODE,
  bendLabel,
  laneNames,
  lastAtOrBefore,
  longScanStart,
  lowerBound,
  noteScanStart,
  prepareSong,
} from '../../src/game/highway/prepare';
import { denseSong, glyphFixtureSong } from '../../src/ui/screens/dev-highway/songs';

const fixture = glyphFixtureSong();
const prep = prepareSong(fixture, computePositions(fixture));
const idx = (pred: (n: Note) => boolean): number => fixture.notes.findIndex(pred);

describe('bendLabel', () => {
  it('prints bends in tones like tab notation', () => {
    expect(bendLabel(0)).toBe('');
    expect(bendLabel(0.5)).toBe('¼');
    expect(bendLabel(1)).toBe('½');
    expect(bendLabel(1.5)).toBe('¾');
    expect(bendLabel(2)).toBe('full');
    expect(bendLabel(2.5)).toBe('1¼');
    expect(bendLabel(3)).toBe('1½');
    expect(bendLabel(4)).toBe('2');
  });
});

describe('binary search helpers', () => {
  const arr = Float64Array.from([0, 1, 1, 2, 5]);
  it('lowerBound / lastAtOrBefore', () => {
    expect(lowerBound(arr, 1)).toBe(1);
    expect(lowerBound(arr, 1.5)).toBe(3);
    expect(lowerBound(arr, 9)).toBe(5);
    expect(lowerBound(arr, -1)).toBe(0);
    expect(lowerBound(arr, 1, 3)).toBe(3);
    expect(lastAtOrBefore(arr, 1)).toBe(2);
    expect(lastAtOrBefore(arr, -1)).toBe(-1);
    expect(lastAtOrBefore(arr, 99)).toBe(4);
  });
});

describe('laneNames', () => {
  it('lower-cases the high e in standard tuning', () => {
    expect(laneNames([64, 59, 55, 50, 45, 40])).toEqual(['', 'e', 'B', 'G', 'D', 'A', 'E']);
  });
  it('always lower-cases string 1 (Drop D keeps its high e; R2-U-06)', () => {
    expect(laneNames([64, 59, 55, 50, 45, 38])).toEqual(['', 'e', 'B', 'G', 'D', 'A', 'D']);
    expect(laneNames([62, 57, 53, 48, 43, 38])).toEqual(['', 'd', 'A', 'F', 'C', 'G', 'D']);
    expect(laneNames([63, 58, 54, 49, 44, 39])[1]).toBe('d#');
  });
});

describe('dev songs', () => {
  it('the glyph fixture is a valid song covering every technique', () => {
    expect(validateSong(fixture)).toEqual([]);
    const has = (f: number): boolean => Array.from(prep.flags).some((v) => (v & f) !== 0);
    for (const f of [F_HAMMER, F_PULL, F_PALM_MUTE, F_LET_RING, F_VIBRATO, F_HARMONIC, F_DEAD, F_GHOST, F_TIED_DEST, F_BEND_RELEASE, F_CHORD]) {
      expect(has(f), `flag ${f}`).toBe(true);
    }
    for (const code of Object.values(SLIDE_CODE)) expect(Array.from(prep.slide)).toContain(code);
    expect(new Set(prep.bendLabel.filter(Boolean))).toEqual(new Set(['½', 'full', '1½']));
    expect(prep.hand?.cues.n).toBeGreaterThan(0);
  });

  it('the dense song has 20 min × 16 notes/s, sorted', () => {
    const song = denseSong();
    expect(song.notes.length).toBe(20 * 60 * 16);
    for (let i = 1; i < song.notes.length; i++) expect(song.notes[i]!.time).toBeGreaterThanOrEqual(song.notes[i - 1]!.time);
    expect(song.meta.durationSec).toBeGreaterThanOrEqual(20 * 60);
    expect(validateSong(song)).toEqual([]);
  });
});

describe('prepareSong', () => {
  it('flattens notes into typed arrays', () => {
    expect(prep.n).toBe(fixture.notes.length);
    fixture.notes.forEach((n, i) => {
      expect(prep.time[i]).toBe(n.time);
      expect(prep.end[i]).toBeCloseTo(n.time + n.dur);
      expect(prep.string[i]).toBe(n.string);
      expect(prep.fret[i]).toBe(n.fret);
    });
  });

  it('links each note to the next note on its string (h/p and slide connectors)', () => {
    const h = idx((n) => n.tech.hammerOn === true && n.string === 3);
    const next = prep.next[h]!;
    expect(next).toBeGreaterThan(h);
    expect(fixture.notes[next]!.string).toBe(3);
    expect(fixture.notes[next]!.tech.legatoDest).toBe(true);
    // Last note of each string has no successor.
    for (let s = 1; s <= 6; s++) {
      const last = fixture.notes.map((n) => n.string).lastIndexOf(s as Note['string']);
      expect(prep.next[last]).toBe(-1);
    }
  });

  it('builds chord boxes with names and string spans', () => {
    const g = fixture.chords.find((c) => c.name === 'G')!;
    const k = Array.from(prep.chords.time).findIndex((t) => Math.abs(t - g.time) < 1e-9);
    expect(prep.chords.name[k]).toBe('G');
    expect(prep.chords.minS[k]).toBe(1);
    expect(prep.chords.maxS[k]).toBe(6);
    const a5 = fixture.chords.find((c) => c.name === 'A5')!;
    const ka = Array.from(prep.chords.time).findIndex((t) => Math.abs(t - a5.time) < 1e-9);
    expect([prep.chords.minS[ka], prep.chords.maxS[ka]]).toEqual([3, 5]);
  });

  it('flattens the beat grid with bar labels and chord-name collisions', () => {
    expect(prep.beats.n).toBe(16 * 4);
    expect(prep.beats.down[0]).toBe(1);
    expect(prep.beats.down[1]).toBe(0);
    expect(prep.beats.label[4]).toBe('2');
    // Chorus bars start with chords that include string 1: their bar numbers yield to the name.
    const chorusBar = fixture.sections.find((s) => s.name === 'Chorus')!.startBar;
    expect(prep.beats.chordAt[chorusBar * 4]).toBeGreaterThanOrEqual(0);
    expect(prep.beats.chordAt[0]).toBe(-1);
  });

  it('merges palm-muted onsets into runs broken by unmuted notes', () => {
    // Verse bars 2–5: four PM eighths per bar, then dead notes / a chord break the run.
    expect(prep.palmMute.n).toBe(4);
    for (let i = 0; i < prep.palmMute.n; i++) {
      expect(prep.palmMute.end[i]!).toBeGreaterThan(prep.palmMute.start[i]!);
      if (i > 0) expect(prep.palmMute.start[i]!).toBeGreaterThan(prep.palmMute.end[i - 1]!);
    }
  });

  it('upper-cases section labels', () => {
    expect(prep.sections.label).toEqual(['INTRO', 'VERSE', 'CHORUS', 'SOLO', 'OUTRO']);
  });
});

describe('culling indexes', () => {
  /** A 30 s drone at t=0 plus a note every 0.25 s for 60 s. */
  function droneSong(): Song {
    const song = glyphFixtureSong();
    const notes: Note[] = [{ id: 0, time: 0, dur: 30, string: 6, fret: 0, midi: 40, bar: 0, tech: { letRing: true } }];
    for (let i = 1; i <= 240; i++) notes.push({ id: i, time: i * 0.25, dur: 0.2, string: 1, fret: 0, midi: 64, bar: 0, tech: {} });
    return { ...song, notes, chords: [] };
  }

  it('keeps the main scan bounded and finds long sustains through their own index', () => {
    const p = prepareSong(droneSong());
    expect(Array.from(p.longIdx)).toEqual([0]);
    const from = 20;
    const s0 = noteScanStart(p, from);
    // The scan starts LONG_SUSTAIN_SEC before the window, not at the drone.
    expect(p.time[s0]!).toBeGreaterThanOrEqual(from - LONG_SUSTAIN_SEC);
    expect(s0).toBeGreaterThan(0);
    // The drone's tail is still reachable.
    expect(longScanStart(p, from)).toBe(0);
    expect(longScanStart(p, 31)).toBe(1);
  });
});
