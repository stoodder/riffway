/**
 * Song → flat, typed-array draw data for the highway (pure, DOM-free; built once per song).
 *
 * The draw loop never touches `Song` objects: it binary-searches these sorted arrays for the visible
 * window and reads numbers out of them, so a frame allocates nothing. Long sustains are indexed
 * separately so the main note scan stays bounded however long a single note rings.
 * @module
 */
import type { HandPositionAnalysis, SlideType, Song } from '@shared/song';
import { midiToName, onsetGroups } from '@core/model';

/** Per-note technique / role flags (`PreparedSong.flags`). */
export const F_HAMMER = 1 << 0;
export const F_PULL = 1 << 1;
export const F_LEGATO_DEST = 1 << 2;
export const F_PALM_MUTE = 1 << 3;
export const F_LET_RING = 1 << 4;
export const F_VIBRATO = 1 << 5;
export const F_HARMONIC = 1 << 6;
export const F_DEAD = 1 << 7;
export const F_GHOST = 1 << 8;
/** Tied destination: drawn as a tail continuing its origin, never as a gem. */
export const F_TIED_DEST = 1 << 9;
export const F_BEND_RELEASE = 1 << 10;
/** Member of a chord (onset group of ≥ 2 notes). */
export const F_CHORD = 1 << 11;

/** Slide codes (`PreparedSong.slide`). 0 = none. */
export const SLIDE_CODE: Readonly<Record<SlideType, number>> = {
  'in-below': 1,
  'in-above': 2,
  'out-up': 3,
  'out-down': 4,
  shift: 5,
  legato: 6,
};

/** Notes longer than this (s at 100%) are "long sustains", culled through their own index. */
export const LONG_SUSTAIN_SEC = 4;

/** Highest fret with a pre-rendered number sprite; higher frets fall back to text. */
export const MAX_SPRITE_FRET = 30;

/** Palm-mute runs merge across gaps up to this long (s at 100%) when no unmuted note intervenes. */
const PM_RUN_GAP_SEC = 0.75;

/** Flattened chord boxes (one per onset group of ≥ 2 notes). */
export interface PreparedChords {
  n: number;
  time: Float64Array;
  /** Topmost / bottommost string of the chord. */
  minS: Uint8Array;
  maxS: Uint8Array;
  /** Index of the chord's first note (state lookup). */
  firstNote: Int32Array;
  /** Chord name from the source, or `''`. */
  name: string[];
}

/** Flattened beat grid. */
export interface PreparedBeats {
  n: number;
  time: Float64Array;
  /** 1 on a downbeat (bar line). */
  down: Uint8Array;
  /** Bar number label on downbeats (`'1'`, `'2'`, …; written-score numbering), else `''`. */
  label: string[];
  /**
   * Index of the named chord whose label shares the top strip with this downbeat's number (a chord
   * on the bar line that includes string 1), else -1. The renderer nudges the number past the name.
   */
  chordAt: Int32Array;
}

/** Sections (labels upper-cased). */
export interface PreparedSections {
  n: number;
  start: Float64Array;
  end: Float64Array;
  label: string[];
  /** Index of a top-strip chord name at the section start (the label moves past it), else -1. */
  chordAt: Int32Array;
}

/** Palm-mute runs (`PM ----|` brackets). */
export interface PreparedRuns {
  n: number;
  start: Float64Array;
  end: Float64Array;
}

/** Hand-position cues and positions (from `computePositions`). */
export interface PreparedHandPositions {
  cues: {
    n: number;
    showAt: Float64Array;
    time: Float64Array;
    /** 1 when moving up the neck (higher frets). */
    up: Uint8Array;
    /** `'7fr'`. */
    label: string[];
  };
  positions: {
    n: number;
    start: Float64Array;
    label: string[];
  };
}

/** Everything the draw loop reads about a song. */
export interface PreparedSong {
  /** Note count. Arrays below are indexed by note index (= `Note.id`). */
  n: number;
  time: Float64Array;
  /** `time + dur`. */
  end: Float64Array;
  string: Uint8Array;
  fret: Int16Array;
  flags: Uint16Array;
  slide: Uint8Array;
  /** Bend amount in semitones (0 = none). */
  bend: Float32Array;
  /** Next note index on the same string (connector target), -1 if none. */
  next: Int32Array;
  /** Bend label per note (`'½'`, `'full'`, …), `''` when not bent. */
  bendLabel: string[];
  /** Indices of long sustains (dur > {@link LONG_SUSTAIN_SEC}) in time order, with a running max of their ends. */
  longIdx: Int32Array;
  longMaxEnd: Float64Array;
  chords: PreparedChords;
  beats: PreparedBeats;
  sections: PreparedSections;
  palmMute: PreparedRuns;
  /** `null` until hand positions are supplied. */
  hand: PreparedHandPositions | null;
  /** Song end (s). */
  duration: number;
}

/** First index in `arr[lo, hi)` whose value is `≥ v` (`hi` if none). Allocation-free. */
export function lowerBound(arr: Float64Array, v: number, lo = 0, hi = arr.length): number {
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = (a + b) >>> 1;
    if (arr[mid]! < v) a = mid + 1;
    else b = mid;
  }
  return a;
}

/** Last index in `arr` whose value is `≤ v` (-1 if none). */
export function lastAtOrBefore(arr: Float64Array, v: number): number {
  let a = 0;
  let b = arr.length;
  while (a < b) {
    const mid = (a + b) >>> 1;
    if (arr[mid]! <= v) a = mid + 1;
    else b = mid;
  }
  return a - 1;
}

/**
 * Bend label in tones, as in tab notation: 1 semitone = `½`, 2 = `full`, 3 = `1½`; quarter tones
 * get `¼` / `¾`. Other amounts print as a decimal number of tones.
 */
export function bendLabel(semitones: number): string {
  const quarters = Math.round(semitones * 2);
  if (quarters <= 0) return '';
  const whole = Math.floor(quarters / 4);
  const frac = quarters % 4;
  if (frac === 0) return whole === 1 ? 'full' : String(whole);
  const fracGlyph = frac === 1 ? '¼' : frac === 2 ? '½' : '¾';
  return whole === 0 ? fracGlyph : `${whole}${fracGlyph}`;
}

/** Index of the first note whose tail can still be visible at `from` (excluding long sustains). */
export function noteScanStart(p: PreparedSong, from: number): number {
  return lowerBound(p.time, from - LONG_SUSTAIN_SEC);
}

/** Index into `longIdx` of the first long sustain whose tail may reach `from`. */
export function longScanStart(p: PreparedSong, from: number): number {
  return lowerBound(p.longMaxEnd, from);
}

/** Build hand-position draw data from a `computePositions` result. */
export function prepareHandPositions(a: HandPositionAnalysis): PreparedHandPositions {
  const cues = [...a.cues].sort((x, y) => x.time - y.time);
  const positions = [...a.positions].sort((x, y) => x.start - y.start);
  return {
    cues: {
      n: cues.length,
      showAt: Float64Array.from(cues, (c) => c.showAt),
      time: Float64Array.from(cues, (c) => c.time),
      up: Uint8Array.from(cues, (c) => (c.lo > c.fromLo ? 1 : 0)),
      label: cues.map((c) => `${c.lo}fr`),
    },
    positions: {
      n: positions.length,
      start: Float64Array.from(positions, (p) => p.start),
      label: positions.map((p) => `${p.lo}fr`),
    },
  };
}

/** Flatten a song for drawing. `hand` is optional (hand cues off, or not yet computed). */
export function prepareSong(song: Song, hand?: HandPositionAnalysis | null): PreparedSong {
  const notes = song.notes;
  const n = notes.length;
  const time = new Float64Array(n);
  const end = new Float64Array(n);
  const string = new Uint8Array(n);
  const fret = new Int16Array(n);
  const flags = new Uint16Array(n);
  const slide = new Uint8Array(n);
  const bend = new Float32Array(n);
  const next = new Int32Array(n).fill(-1);
  const bendLabels: string[] = new Array<string>(n).fill('');
  const lastOnString = new Int32Array(7).fill(-1);
  const long: number[] = [];

  for (let i = 0; i < n; i++) {
    const note = notes[i]!;
    const t = note.tech;
    time[i] = note.time;
    end[i] = note.time + Math.max(0, note.dur);
    string[i] = note.string;
    fret[i] = note.fret;
    let f = 0;
    if (t.hammerOn) f |= F_HAMMER;
    if (t.pullOff) f |= F_PULL;
    if (t.legatoDest) f |= F_LEGATO_DEST;
    if (t.palmMute) f |= F_PALM_MUTE;
    if (t.letRing) f |= F_LET_RING;
    if (t.vibrato) f |= F_VIBRATO;
    if (t.harmonic) f |= F_HARMONIC;
    if (t.dead) f |= F_DEAD;
    if (t.ghost) f |= F_GHOST;
    if (note.tiedFrom !== undefined) f |= F_TIED_DEST;
    if (t.bend && t.bend.semitones > 0) {
      bend[i] = t.bend.semitones;
      bendLabels[i] = bendLabel(t.bend.semitones);
      if (t.bend.release) f |= F_BEND_RELEASE;
    }
    flags[i] = f;
    if (t.slide) slide[i] = SLIDE_CODE[t.slide];
    const prev = lastOnString[note.string]!;
    if (prev >= 0) next[prev] = i;
    lastOnString[note.string] = i;
    if (note.dur > LONG_SUSTAIN_SEC) long.push(i);
  }

  const longIdx = Int32Array.from(long);
  const longMaxEnd = new Float64Array(long.length);
  let runMax = -Infinity;
  for (let k = 0; k < long.length; k++) {
    runMax = Math.max(runMax, end[long[k]!]!);
    longMaxEnd[k] = runMax;
  }

  // Chord boxes: onset groups of ≥ 2 notes (chord ids and onsets within 10 ms, like the judge).
  const chordNames = new Map<number, string>();
  for (const c of song.chords) if (c.name) chordNames.set(c.id, c.name);
  const chordGroups = onsetGroups(song).filter((g) => g.chord);
  const chords: PreparedChords = {
    n: chordGroups.length,
    time: new Float64Array(chordGroups.length),
    minS: new Uint8Array(chordGroups.length),
    maxS: new Uint8Array(chordGroups.length),
    firstNote: new Int32Array(chordGroups.length),
    name: [],
  };
  chordGroups.forEach((g, k) => {
    chords.time[k] = g.time;
    chords.minS[k] = g.notes[0]!.string;
    chords.maxS[k] = g.notes[g.notes.length - 1]!.string;
    chords.firstNote[k] = g.notes[0]!.id;
    const named = g.notes.find((nt) => nt.chordId !== undefined && chordNames.has(nt.chordId));
    chords.name.push(named ? chordNames.get(named.chordId!)! : '');
    for (const nt of g.notes) flags[nt.id]! |= F_CHORD;
  });

  // Beat grid.
  const beatTimes: number[] = [];
  const beatDown: number[] = [];
  const beatLabel: string[] = [];
  for (const bar of song.timing.bars) {
    bar.beats.forEach((bt, k) => {
      beatTimes.push(bt);
      beatDown.push(k === 0 ? 1 : 0);
      beatLabel.push(k === 0 ? String((bar.sourceIndex ?? bar.index) + 1) : '');
    });
  }

  // Palm-mute runs: consecutive palm-muted onsets, broken by any unmuted onset or a long gap.
  const pmStart: number[] = [];
  const pmEnd: number[] = [];
  let runOpen = false;
  let runLastOnset = -Infinity;
  for (let i = 0; i < n; i++) {
    if (flags[i]! & F_TIED_DEST) continue;
    const pm = (flags[i]! & F_PALM_MUTE) !== 0;
    if (pm) {
      if (runOpen && time[i]! - pmEnd[pmEnd.length - 1]! <= PM_RUN_GAP_SEC) {
        pmEnd[pmEnd.length - 1] = Math.max(pmEnd[pmEnd.length - 1]!, end[i]!, time[i]!);
      } else {
        pmStart.push(time[i]!);
        pmEnd.push(Math.max(end[i]!, time[i]!));
        runOpen = true;
      }
      runLastOnset = time[i]!;
    } else if (runOpen && time[i]! - runLastOnset > 0.01) {
      runOpen = false;
    }
  }

  const beatTimeArr = Float64Array.from(beatTimes);
  // Downbeats whose bar number would collide with a top-strip chord name.
  const chordAt = new Int32Array(beatTimes.length).fill(-1);
  for (let k = 0; k < chords.n; k++) {
    if (chords.minS[k] !== 1 || !chords.name[k]) continue;
    const bi = lowerBound(beatTimeArr, chords.time[k]! - 0.02);
    if (bi < beatTimes.length && beatDown[bi] === 1 && Math.abs(beatTimes[bi]! - chords.time[k]!) <= 0.02) chordAt[bi] = k;
  }

  const sections = [...song.sections].sort((a, b) => a.start - b.start);
  const sectionChord = new Int32Array(sections.length).fill(-1);
  sections.forEach((sec, i) => {
    const k = lowerBound(chords.time, sec.start - 0.02);
    if (k < chords.n && Math.abs(chords.time[k]! - sec.start) <= 0.02 && chords.minS[k] === 1 && chords.name[k]) sectionChord[i] = k;
  });
  let lastNoteEnd = 0;
  for (let i = 0; i < n; i++) if (end[i]! > lastNoteEnd) lastNoteEnd = end[i]!;

  return {
    n,
    time,
    end,
    string,
    fret,
    flags,
    slide,
    bend,
    next,
    bendLabel: bendLabels,
    longIdx,
    longMaxEnd,
    chords,
    beats: { n: beatTimes.length, time: beatTimeArr, down: Uint8Array.from(beatDown), label: beatLabel, chordAt },
    sections: {
      n: sections.length,
      start: Float64Array.from(sections, (s) => s.start),
      end: Float64Array.from(sections, (s) => s.end),
      label: sections.map((s) => s.name.toUpperCase()),
      chordAt: sectionChord,
    },
    palmMute: { n: pmStart.length, start: Float64Array.from(pmStart), end: Float64Array.from(pmEnd) },
    hand: hand ? prepareHandPositions(hand) : null,
    duration: Math.max(song.meta.durationSec, lastNoteEnd),
  };
}

/**
 * Lane letters from the tuning (index = string number; index 0 unused): `['', 'e', 'B', 'G', 'D', 'A', 'E']`
 * for standard. String 1 is lower-cased when it shares its letter name with string 6 (tab convention).
 */
export function laneNames(tuning: readonly number[]): string[] {
  const out = [''];
  for (let s = 1; s <= 6; s++) {
    const midi = tuning[s - 1];
    out.push(midi === undefined ? '' : midiToName(midi).replace(/-?\d+$/, ''));
  }
  if (out[1] && out[1] === out[6]) out[1] = out[1].toLowerCase();
  return out;
}
