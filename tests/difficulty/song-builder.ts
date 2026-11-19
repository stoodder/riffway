/**
 * Hand-built `Song` fixtures for difficulty and hand-position tests (independent of the importers).
 * Times are given in quarter-note beats at a constant tempo; bars are 4/4 unless `beatsPerBar` says
 * otherwise. String 1 = high e; standard tuning.
 */
import type { Chord, Note, RhythmStatus, Section, Song, StringNumber, Tech } from '@shared/song';

export const STANDARD: readonly number[] = [64, 59, 55, 50, 45, 40];

/** One note of an event: `[string, fret]` or `[string, fret, tech]`. */
export type NoteSpec = readonly [StringNumber, number] | readonly [StringNumber, number, Tech];

/** Notes struck together at `at` (quarter beats from the start), held for `len` beats (default 1). */
export interface EventSpec {
  at: number;
  notes: readonly NoteSpec[];
  len?: number;
}

export interface SongSpec {
  title?: string;
  bpm: number;
  events: readonly EventSpec[];
  /** Total bars (default: enough to hold every event). */
  bars?: number;
  beatsPerBar?: number;
  /** `[name, barCount]` per section (default: one section "All" over every bar; `[]` for none). */
  sections?: ReadonlyArray<readonly [string, number]>;
  rhythm?: RhythmStatus;
}

/** Build a valid `Song` from a compact spec. */
export function buildSong(spec: SongSpec): Song {
  const beatSec = 60 / spec.bpm;
  const beatsPerBar = spec.beatsPerBar ?? 4;
  const lastBeat = Math.max(0, ...spec.events.map((e) => e.at + (e.len ?? 1)));
  const barCount = spec.bars ?? Math.max(1, Math.ceil(lastBeat / beatsPerBar - 1e-9));
  const bars = Array.from({ length: barCount }, (_, i) => {
    const time = i * beatsPerBar * beatSec;
    return {
      index: i,
      time,
      dur: beatsPerBar * beatSec,
      num: beatsPerBar,
      den: 4,
      beats: Array.from({ length: beatsPerBar }, (_, b) => time + b * beatSec),
    };
  });

  const notes: Note[] = [];
  const chords: Chord[] = [];
  const sorted = [...spec.events].sort((a, b) => a.at - b.at);
  for (const ev of sorted) {
    const time = ev.at * beatSec;
    const chordId = ev.notes.length > 1 ? chords.length : undefined;
    const ids: number[] = [];
    for (const [string, fret, tech] of [...ev.notes].sort((a, b) => a[0] - b[0])) {
      const id = notes.length;
      ids.push(id);
      notes.push({
        id,
        time,
        dur: (ev.len ?? 1) * beatSec,
        string,
        fret,
        midi: STANDARD[string - 1]! + fret,
        bar: Math.min(barCount - 1, Math.floor(ev.at / beatsPerBar + 1e-9)),
        ...(chordId !== undefined ? { chordId } : {}),
        tech: { ...(tech ?? {}) },
      });
    }
    if (chordId !== undefined) chords.push({ id: chordId, time, noteIds: ids });
  }

  const sectionSpecs = spec.sections ?? [['All', barCount] as const];
  const sections: Section[] = [];
  let bar = 0;
  for (const [name, count] of sectionSpecs) {
    const endBar = bar + count;
    sections.push({ name, startBar: bar, endBar, start: bars[bar]!.time, end: bars[endBar - 1]!.time + bars[endBar - 1]!.dur });
    bar = endBar;
  }

  const durationSec = barCount * beatsPerBar * beatSec;
  return {
    schema: 1,
    id: `test:${spec.title ?? 'song'}`,
    arrangement: 0,
    meta: {
      title: spec.title ?? 'Test song',
      source: { source: 'local' },
      tags: { style: ['pick'], genre: [], skills: [] },
      tuning: [...STANDARD],
      capo: 0,
      durationSec,
      rhythm: spec.rhythm ?? 'exact',
      tracks: [{ index: 0, name: 'Guitar', strings: 6, tuning: [...STANDARD], capo: 0, playable: true, noteCount: notes.length }],
    },
    timing: { tempos: [{ time: 0, bpm: spec.bpm }], bars },
    sections,
    notes,
    chords,
  };
}

/** Single notes on consecutive beats of `len` beats each: `[string, fret]` per note. */
export function line(notes: readonly NoteSpec[], len = 1, start = 0): EventSpec[] {
  return notes.map((n, i) => ({ at: start + i * len, notes: [n], len }));
}

/** "Power Chord Drive" (docs/difficulty.md § Worked example): A5 → C5 → G5 → E5, palm-muted eighths. */
export function powerChordDrive(): Song {
  const pm: Tech = { palmMute: true };
  const shapes: Array<readonly NoteSpec[]> = [
    [[6, 5, pm], [5, 7, pm]], // A5
    [[6, 8, pm], [5, 10, pm]], // C5
    [[6, 3, pm], [5, 5, pm]], // G5
    [[5, 7, pm], [4, 9, pm]], // E5 (A-string root)
  ];
  const events: EventSpec[] = [];
  shapes.forEach((shape, bar) => {
    for (let k = 0; k < 8; k++) events.push({ at: bar * 4 + k * 0.5, notes: shape, len: 0.5 });
  });
  return buildSong({ title: 'Power Chord Drive', bpm: 120, events, bars: 4, sections: [['Riff', 4]] });
}

/** Ode-to-Joy-like melody on the top two strings, quarter notes at 100 BPM, 4 bars. */
export function odeToJoy(): Song {
  const E: NoteSpec = [1, 0];
  const F: NoteSpec = [1, 1];
  const G: NoteSpec = [1, 3];
  const D: NoteSpec = [2, 3];
  const C: NoteSpec = [2, 1];
  const events = [
    ...line([E, E, F, G, G, F, E, D, C, C, D, E]),
    { at: 12, notes: [E], len: 1.5 },
    { at: 13.5, notes: [D], len: 0.5 },
    { at: 14, notes: [D], len: 2 },
  ];
  return buildSong({ title: 'Ode', bpm: 100, events, bars: 4, sections: [['Theme', 4]] });
}

/** Deterministic PRNG (mulberry32) for property tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random riff spec: `sectionCount` sections of 8 bars, eighth/quarter onsets, single notes and
 * 2–3 note chords, frets 0–15, occasional techniques.
 */
export function randomSpec(seed: number, bpm: number, sectionCount = 3): SongSpec {
  const r = rng(seed);
  const bars = sectionCount * 8;
  const events: EventSpec[] = [];
  let at = 0;
  let base = 1 + Math.floor(r() * 10);
  while (at < bars * 4) {
    if (r() < 0.1) base = 1 + Math.floor(r() * 12);
    const len = r() < 0.5 ? 0.5 : 1;
    const tech: Tech = r() < 0.15 ? { slide: 'shift' } : r() < 0.1 ? { bend: { semitones: 1 } } : {};
    if (r() < 0.25) {
      const s = (4 + Math.floor(r() * 3)) as StringNumber;
      events.push({ at, notes: [[s, base, tech], [(s - 1) as StringNumber, base + 2], [(s - 2) as StringNumber, base + 2]], len });
    } else {
      const s = (1 + Math.floor(r() * 6)) as StringNumber;
      const fret = r() < 0.1 ? 0 : base + Math.floor(r() * 4);
      events.push({ at, notes: [[s, fret, tech]], len });
    }
    at += len;
  }
  return {
    bpm,
    events,
    bars,
    sections: Array.from({ length: sectionCount }, (_, i) => [`Part ${i + 1}`, 8] as const),
  };
}
