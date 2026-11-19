/**
 * Songs for the highway dev screen and the renderer tests (T-024):
 * - {@link glyphFixtureSong}: a 16-bar, 100 BPM arrangement that exercises every highway glyph
 *   (h/p, all slide kinds, ½/full/1½ bends with release, palm-mute runs, let ring, vibrato,
 *   harmonics, dead and ghost notes, named chords, ties, sections and hand-position shifts).
 * - {@link denseSong}: a synthetic long, dense song for performance runs (default 20 min × 16 notes/s).
 * Both are deterministic.
 * @module
 */
import type { Bar, Chord, Note, Section, Song, StringNumber, Tech } from '@shared/song';

/** Standard tuning, string 1 (high e) first. */
const STANDARD: readonly number[] = [64, 59, 55, 50, 45, 40];

/** Seeded uniform PRNG in [0, 1) (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A note before ids are assigned. */
interface Draft {
  time: number;
  dur: number;
  string: StringNumber;
  fret: number;
  tech: Tech;
  chordKey?: number;
  tieKey?: number;
  tiedToKey?: number;
}

/** Bars of a constant-tempo grid. */
function makeBars(count: number, bpm: number, num: number): Bar[] {
  const beat = 60 / bpm;
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const time = i * num * beat;
    bars.push({ index: i, time, dur: num * beat, num, den: 4, beats: Array.from({ length: num }, (_, k) => time + k * beat) });
  }
  return bars;
}

/** Turn drafts into sorted notes with ids, chords and ties resolved. */
function finish(drafts: Draft[], bars: Bar[], chordNames: Map<number, string>): { notes: Note[]; chords: Chord[] } {
  const order = drafts
    .map((d, k) => ({ d, k }))
    .sort((a, b) => a.d.time - b.d.time || a.d.string - b.d.string || a.k - b.k);
  const tieId = new Map<number, number>();
  const notes: Note[] = [];
  const chordIdByKey = new Map<number, number>();
  const chords: Chord[] = [];
  const barStarts = bars.map((b) => b.time);
  order.forEach(({ d }, id) => {
    let bar = 0;
    while (bar + 1 < barStarts.length && barStarts[bar + 1]! <= d.time + 1e-9) bar++;
    const note: Note = { id, time: d.time, dur: d.dur, string: d.string, fret: d.fret, midi: STANDARD[d.string - 1]! + d.fret, bar, tech: d.tech };
    if (d.tech.harmonic && d.fret === 12) note.midi += 12;
    if (d.chordKey !== undefined) {
      let cid = chordIdByKey.get(d.chordKey);
      if (cid === undefined) {
        cid = chords.length;
        chordIdByKey.set(d.chordKey, cid);
        const name = chordNames.get(d.chordKey);
        chords.push({ id: cid, time: d.time, noteIds: [], ...(name ? { name } : {}) });
      }
      note.chordId = cid;
      chords[cid]!.noteIds.push(id);
    }
    if (d.tieKey !== undefined) tieId.set(d.tieKey, id);
    notes.push(note);
  });
  order.forEach(({ d }, id) => {
    if (d.tiedToKey !== undefined) notes[id]!.tiedFrom = tieId.get(d.tiedToKey)!;
  });
  return { notes, chords };
}

function sectionsFor(bars: Bar[], spec: ReadonlyArray<[string, number, number]>): Section[] {
  return spec.map(([name, startBar, endBar]) => ({
    name,
    startBar,
    endBar,
    start: bars[startBar]!.time,
    end: bars[endBar - 1]!.time + bars[endBar - 1]!.dur,
  }));
}

function songShell(id: string, title: string, bars: Bar[], bpm: number): Omit<Song, 'notes' | 'chords' | 'sections'> {
  const last = bars[bars.length - 1]!;
  return {
    schema: 1,
    id,
    arrangement: 0,
    meta: {
      title,
      artist: 'Riffway dev',
      source: { source: 'starter', path: `dev/${id}` },
      tags: { style: ['pick'], genre: ['rock'], skills: [] },
      tuning: [...STANDARD],
      capo: 0,
      durationSec: last.time + last.dur,
      rhythm: 'exact',
      tracks: [{ index: 0, name: 'Guitar', strings: 6, tuning: [...STANDARD], capo: 0, playable: true }],
    },
    timing: { tempos: [{ time: 0, bpm }], bars },
  };
}

/** Every highway glyph in 16 bars (100 BPM, 4/4). */
export function glyphFixtureSong(): Song {
  const bpm = 100;
  const beat = 60 / bpm;
  const bars = makeBars(16, bpm, 4);
  const drafts: Draft[] = [];
  const chordNames = new Map<number, string>();
  let chordKey = 0;
  const at = (bar: number, beatInBar: number): number => bars[bar]!.time + beatInBar * beat;
  const n = (bar: number, b: number, string: StringNumber, fret: number, durBeats: number, tech: Tech = {}, extra: Partial<Draft> = {}): void => {
    drafts.push({ time: at(bar, b), dur: durBeats * beat, string, fret, tech, ...extra });
  };
  const chord = (bar: number, b: number, name: string, shape: ReadonlyArray<[StringNumber, number]>, durBeats: number, tech: Tech = {}): void => {
    const key = chordKey++;
    if (name) chordNames.set(key, name);
    for (const [s, f] of shape) n(bar, b, s, f, durBeats, { ...tech }, { chordKey: key });
  };

  // Intro (bars 0–1): let-ring Em arpeggio, natural harmonics at the 12th.
  const arp: Array<[StringNumber, number]> = [[6, 0], [5, 2], [4, 2], [3, 0], [2, 0], [1, 0], [2, 0], [3, 0]];
  arp.forEach(([s, f], k) => n(0, k * 0.5, s, f, 4 - k * 0.5, { letRing: true }));
  n(1, 0, 4, 12, 1, { harmonic: 'natural' });
  n(1, 1, 3, 12, 1, { harmonic: 'natural' });
  n(1, 2, 2, 12, 2, { harmonic: 'natural', letRing: true });

  // Verse (bars 2–5): palm-muted chugs, power chords, dead-note rakes.
  const E5: Array<[StringNumber, number]> = [[6, 0], [5, 2], [4, 2]];
  const A5: Array<[StringNumber, number]> = [[5, 0], [4, 2], [3, 2]];
  const G5: Array<[StringNumber, number]> = [[6, 3], [5, 5], [4, 5]];
  for (let bar = 2; bar <= 5; bar++) {
    for (let k = 0; k < 4; k++) n(bar, k * 0.5, 6, 0, 0.5, { palmMute: true });
    n(bar, 2, 6, 0, 0.25, { dead: true });
    n(bar, 2.25, 5, 0, 0.25, { dead: true });
    const shape = bar === 3 ? A5 : bar === 4 ? G5 : E5;
    chord(bar, 2.5, bar === 3 ? 'A5' : bar === 4 ? 'G5' : 'E5', shape, 1.5, bar === 5 ? { vibrato: true } : {});
  }

  // Chorus (bars 6–9): open chords, strummed.
  const G: Array<[StringNumber, number]> = [[6, 3], [5, 2], [4, 0], [3, 0], [2, 0], [1, 3]];
  const C: Array<[StringNumber, number]> = [[5, 3], [4, 2], [3, 0], [2, 1], [1, 0]];
  const D: Array<[StringNumber, number]> = [[4, 0], [3, 2], [2, 3], [1, 2]];
  const Em: Array<[StringNumber, number]> = [[6, 0], [5, 2], [4, 2], [3, 0], [2, 0], [1, 0]];
  const prog: Array<[string, Array<[StringNumber, number]>]> = [['G', G], ['C', C], ['D', D], ['Em', Em]];
  prog.forEach(([name, shape], k) => {
    chord(6 + k, 0, name, shape, 1.5);
    chord(6 + k, 1.5, name, shape, 1);
    chord(6 + k, 2.5, name, shape, 1.5, k === 3 ? { letRing: true } : {});
  });

  // Solo (bars 10–13): position 5 → 12 → 3, legato, slides, bends, vibrato, ghost notes.
  n(10, 0, 3, 5, 0.5, { slide: 'in-below' });
  n(10, 0.5, 3, 7, 0.5, { hammerOn: true });
  n(10, 1, 3, 9, 0.5, { legatoDest: true, pullOff: true });
  n(10, 1.5, 3, 7, 0.5, { legatoDest: true });
  n(10, 2, 2, 5, 0.5);
  n(10, 2.5, 2, 6, 0.5, { ghost: true });
  n(10, 3, 2, 8, 1, { vibrato: true });
  n(11, 0, 2, 12, 0.5, { slide: 'shift' });
  n(11, 0.5, 2, 14, 0.5, { legatoDest: true });
  n(11, 1, 1, 12, 0.5, { hammerOn: true });
  n(11, 1.5, 1, 15, 0.5, { legatoDest: true, pullOff: true });
  n(11, 2, 1, 12, 0.5, { legatoDest: true });
  n(11, 2.5, 2, 15, 1.5, { bend: { semitones: 2 }, vibrato: true });
  n(12, 0, 3, 14, 2, { bend: { semitones: 1, release: true } });
  n(12, 2, 3, 12, 0.5, { slide: 'legato' });
  n(12, 2.5, 3, 14, 1.5, { legatoDest: true, bend: { semitones: 3 } });
  n(13, 0, 4, 5, 0.5, { slide: 'in-above' });
  n(13, 0.5, 4, 3, 0.5);
  n(13, 1, 5, 5, 0.5, { hammerOn: true });
  n(13, 1.5, 5, 6, 0.5, { legatoDest: true });
  n(13, 2, 4, 5, 2, { slide: 'out-down' });

  // Outro (bars 14–15): tied, vibrato E5 and a ringing harmonic; a slide out up the neck.
  chord(14, 0, 'E5', E5, 4, { vibrato: true });
  drafts.filter((d) => d.chordKey === chordKey - 1).forEach((d, k) => (d.tieKey = 100 + k));
  E5.forEach(([s, f], k) => n(15, 0, s, f, 2, { vibrato: true }, { tiedToKey: 100 + k }));
  n(15, 2, 3, 7, 1, { harmonic: 'natural' });
  n(15, 3, 1, 7, 1, { slide: 'out-up' });

  const { notes, chords } = finish(drafts, bars, chordNames);
  return {
    ...songShell('dev:glyph-fixture', 'Glyph fixture', bars, bpm),
    sections: sectionsFor(bars, [
      ['Intro', 0, 2],
      ['Verse', 2, 6],
      ['Chorus', 6, 10],
      ['Solo', 10, 14],
      ['Outro', 14, 16],
    ]),
    notes,
    chords,
  };
}

/**
 * A long, dense synthetic song for performance runs: `minutes` long at `notesPerSec` notes per second
 * (chords count each note), 120 BPM 4/4, with a mix of every technique and a position shift every two
 * bars. Deterministic for a given `seed`.
 */
export function denseSong(minutes = 20, notesPerSec = 16, seed = 7): Song {
  const bpm = 120;
  const rand = seededRandom(seed);
  const beat = 60 / bpm;
  const barDur = 4 * beat;
  const total = minutes * 60;
  const bars = makeBars(Math.ceil(total / barDur), bpm, 4);
  const notes: Note[] = [];
  const chords: Chord[] = [];
  const target = Math.round(total * notesPerSec);
  // Onsets: 3-note chords every 6th onset, single notes otherwise.
  const avgPerOnset = (5 * 1 + 3) / 6;
  const onsetGap = 1 / (notesPerSec / avgPerOnset);
  let t = 0;
  let onset = 0;
  while (notes.length < target && t < total) {
    const bar = Math.min(bars.length - 1, Math.floor(t / barDur));
    const lo = 1 + ((Math.floor(bar / 2) * 5) % 13);
    const isChord = onset % 6 === 5;
    const strings: StringNumber[] = isChord
      ? ([[4, 5, 6], [3, 4, 5], [2, 3, 4]] as StringNumber[][])[Math.floor(rand() * 3)]!
      : [(1 + Math.floor(rand() * 6)) as StringNumber];
    const chordId = isChord ? chords.length : undefined;
    if (isChord) chords.push({ id: chords.length, time: t, noteIds: [], name: rand() < 0.5 ? 'E5' : undefined });
    for (const s of strings) {
      if (notes.length >= target) break;
      const fret = lo + Math.floor(rand() * 4);
      const tech: Tech = {};
      const r = rand();
      if (r < 0.08) tech.hammerOn = true;
      else if (r < 0.14) tech.pullOff = true;
      else if (r < 0.18) tech.slide = 'shift';
      else if (r < 0.22) tech.bend = { semitones: rand() < 0.5 ? 1 : 2, release: rand() < 0.3 };
      else if (r < 0.3) tech.palmMute = true;
      else if (r < 0.34) tech.vibrato = true;
      else if (r < 0.36) tech.harmonic = 'natural';
      else if (r < 0.39) tech.dead = true;
      else if (r < 0.42) tech.letRing = true;
      else if (r < 0.44) tech.ghost = true;
      const dur = rand() < 0.15 ? beat * (1 + Math.floor(rand() * 3)) : onsetGap * 0.9;
      const id = notes.length;
      const note: Note = { id, time: t, dur, string: s, fret, midi: STANDARD[s - 1]! + fret, bar, tech };
      if (chordId !== undefined) {
        note.chordId = chordId;
        chords[chordId]!.noteIds.push(id);
      }
      notes.push(note);
    }
    onset++;
    t += onsetGap;
  }
  for (const c of chords) if (c.name === undefined) delete c.name;
  const sectionSpec: Array<[string, number, number]> = [];
  for (let b = 0; b < bars.length; b += 8) sectionSpec.push([`Part ${b / 8 + 1}`, b, Math.min(bars.length, b + 8)]);
  return {
    ...songShell('dev:dense', `Dense ${minutes} min × ${notesPerSec}/s`, bars, bpm),
    sections: sectionsFor(bars, sectionSpec),
    notes,
    chords,
  };
}
