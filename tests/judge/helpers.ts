/**
 * Test helpers for the judge: minimal songs, a mutable linear clock and event builders.
 */
import type { SongClockMapping } from '@shared/clock';
import type { InputEvent, Judgement } from '@shared/judge';
import type { Bar, Note, Section, Song, StringNumber, Tech } from '@shared/song';

export interface NoteSpec {
  time: number;
  midi: number;
  string?: StringNumber;
  chordId?: number;
  tiedFrom?: number;
  tech?: Tech;
}

/** A 4/4 song at 120 BPM (2 s bars) with the given notes and sections `[name, startBar, endBar]`. */
export function makeSong(specs: NoteSpec[], opts: { bars?: number; sections?: [string, number, number][] } = {}): Song {
  const sorted = [...specs].sort((a, b) => a.time - b.time || (a.string ?? 1) - (b.string ?? 1));
  const lastTime = sorted.length > 0 ? (sorted[sorted.length - 1] as NoteSpec).time : 0;
  const barCount = opts.bars ?? Math.max(1, Math.floor(lastTime / 2) + 1);
  const bars: Bar[] = Array.from({ length: barCount }, (_, i) => ({
    index: i,
    time: i * 2,
    dur: 2,
    num: 4,
    den: 4,
    beats: [0, 0.5, 1, 1.5].map((b) => i * 2 + b),
  }));
  const notes: Note[] = sorted.map((s, id) => {
    const n: Note = {
      id,
      time: s.time,
      dur: 0.1,
      string: s.string ?? 1,
      fret: 0,
      midi: s.midi,
      bar: Math.min(barCount - 1, Math.floor(s.time / 2)),
      tech: s.tech ?? {},
    };
    if (s.chordId !== undefined) n.chordId = s.chordId;
    if (s.tiedFrom !== undefined) n.tiedFrom = s.tiedFrom;
    return n;
  });
  const sections: Section[] = (opts.sections ?? []).map(([name, startBar, endBar]) => ({
    name,
    startBar,
    endBar,
    start: startBar * 2,
    end: endBar * 2,
  }));
  return {
    schema: 1,
    id: 'test:song',
    arrangement: 0,
    meta: {
      title: 'Test',
      source: { source: 'local' },
      tags: { style: [], genre: [], skills: [] },
      tuning: [64, 59, 55, 50, 45, 40],
      capo: 0,
      durationSec: barCount * 2,
      rhythm: 'exact',
      tracks: [],
    },
    timing: { tempos: [{ time: 0, bpm: 120 }], bars },
    sections,
    notes,
    chords: [],
  };
}

/** A mutable D5 clock: `songTime = (ctx − anchorCtx) × speed + anchorSong`; speed 0 = paused. */
export class TestClock implements SongClockMapping {
  constructor(
    public anchorCtx = 0,
    public anchorSong = 0,
    public speed = 1,
  ) {}

  songTimeAt(ctxTime: number): number {
    return (ctxTime - this.anchorCtx) * this.speed + this.anchorSong;
  }

  ctxTimeAt(songTime: number): number {
    return this.anchorCtx + (songTime - this.anchorSong) / this.speed;
  }

  /** Re-anchor at `ctx` keeping continuity, with a new speed. */
  reanchor(ctx: number, speed: number): void {
    const song = this.speed === 0 ? this.anchorSong : this.songTimeAt(ctx);
    this.anchorCtx = ctx;
    this.anchorSong = song;
    this.speed = speed;
  }
}

/** A pitched onset. */
export const onset = (ctxTime: number, midi: number, extra: Partial<InputEvent> = {}): InputEvent => ({
  ctxTime,
  kind: 'onset',
  midi,
  cents: 0,
  clarity: 0.9,
  source: 'test',
  ...extra,
});

/** An unpitched onset (low clarity). */
export const unpitched = (ctxTime: number): InputEvent => ({ ctxTime, kind: 'onset', clarity: 0.2, source: 'test' });

/** A legato pitch change. */
export const pitchChange = (ctxTime: number, midi: number): InputEvent => ({
  ctxTime,
  kind: 'pitch-change',
  midi,
  cents: 0,
  clarity: 0.9,
  source: 'test',
});

/** Final judgements only, keyed by the first note id. */
export function finals(js: readonly Judgement[]): Map<number, Judgement> {
  const m = new Map<number, Judgement>();
  for (const j of js) if (j.final) m.set(j.noteIds[0] as number, j);
  return m;
}
