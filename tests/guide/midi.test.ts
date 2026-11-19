/**
 * Guide MIDI recipes (T-021): alphaTab generator filtered to the arrangement, the DEC-21 recipe
 * built from `Song` notes, and tempo scaling by speed.
 */
import { describe, expect, it } from 'vitest';
import { midi } from '@coderline/alphatab';
import type { Note, Song } from '@shared/song';
import { loadAlphaTabScore } from '@core/import/alphatab';
import { loadSong } from '@core/import/load-song';
import {
  buildMidiFile,
  recipeFromAlphaTab,
  recipeFromSong,
  SONG_MIDI_TICKS_PER_SEC,
  type MidiCall,
  type MidiRecipe,
} from '../../src/audio/guide/midi';
import { ISOLATED_TEX, TWO_TRACK_TEX, texBundle } from './fixtures';

type NoteCall = Extract<MidiCall, { op: 'note' }>;

function notes(recipe: MidiRecipe): NoteCall[] {
  return recipe.calls.filter((c): c is NoteCall => c.op === 'note');
}

function alphaTabRecipe(tex: string, arrangement: number): { song: Song; recipe: MidiRecipe } {
  const bundle = texBundle(tex);
  const song = loadSong(bundle, { arrangement });
  const { score, settings } = loadAlphaTabScore(bundle);
  return { song, recipe: recipeFromAlphaTab(score, settings, arrangement) };
}

/** A minimal hand-built song (one 4/4 bar per 2 s at 120 BPM). */
function makeSong(raw: Partial<Note>[], opts: { style?: ('pick' | 'fingerstyle')[]; bars?: number } = {}): Song {
  const bars = Array.from({ length: opts.bars ?? 2 }, (_, i) => ({
    index: i,
    time: i * 2,
    dur: 2,
    num: 4,
    den: 4,
    beats: [0, 0.5, 1, 1.5].map((b) => i * 2 + b),
  }));
  const notes: Note[] = raw.map((n, id) => ({ id, time: 0, dur: 0.5, string: 1, fret: 0, midi: 64, bar: 0, tech: {}, ...n }));
  const durationSec = bars.length * 2;
  return {
    schema: 1,
    id: 'local:test',
    arrangement: 0,
    meta: {
      title: 'T',
      source: { source: 'local' },
      tags: { style: opts.style ?? ['pick'], genre: [], skills: [] },
      tuning: [64, 59, 55, 50, 45, 40],
      capo: 0,
      durationSec,
      rhythm: 'aligned',
      tracks: [],
    },
    timing: { tempos: [{ time: 0, bpm: 120 }], bars },
    sections: [],
    notes,
    chords: [],
  };
}

describe('recipeFromAlphaTab', () => {
  it('keeps only the arrangement track and the global tempo/meter events', () => {
    const { recipe } = alphaTabRecipe(TWO_TRACK_TEX, 0);
    const n = notes(recipe);
    expect(n.map((c) => c.key)).toEqual([40, 43, 45, 47]);
    expect(n.every((c) => c.track === 0)).toBe(true);
    expect(recipe.calls.filter((c) => c.op === 'tempo')).toEqual([{ op: 'tempo', tick: 0, bpm: 120 }]);
    expect(recipe.calls.some((c) => c.op === 'timeSignature')).toBe(true);
    expect(recipe.calls.every((c) => !('track' in c) || c.track === 0 || c.op === 'finish')).toBe(true);
  });

  it('has one bar tick per played bar plus the end, matching the song bar times', () => {
    const { song, recipe } = alphaTabRecipe(ISOLATED_TEX, 0);
    expect(recipe.barTicks).toHaveLength(song.timing.bars.length + 1);
    // 90 BPM for two bars, then 140 BPM: tick → seconds through the tempo changes.
    const tempos = recipe.calls.filter((c): c is Extract<MidiCall, { op: 'tempo' }> => c.op === 'tempo');
    const secAt = (tick: number): number => {
      let sec = 0;
      let prev = 0;
      let bpm = tempos[0]?.bpm ?? 120;
      for (const t of tempos) {
        if (t.tick > tick) break;
        sec += ((t.tick - prev) * 60) / (bpm * recipe.division);
        prev = t.tick;
        bpm = t.bpm;
      }
      return sec + ((tick - prev) * 60) / (bpm * recipe.division);
    };
    song.timing.bars.forEach((bar, i) => expect(secAt(recipe.barTicks[i] as number)).toBeCloseTo(bar.time, 9));
    expect(secAt(recipe.barTicks[song.timing.bars.length] as number)).toBeCloseTo(song.meta.durationSec, 9);
  });

  it('renders the second track when it is the arrangement', () => {
    const bundle = texBundle(TWO_TRACK_TEX);
    const { score, settings } = loadAlphaTabScore(bundle);
    const n = notes(recipeFromAlphaTab(score, settings, 1));
    expect(n.map((c) => c.key)).toEqual([28, 28, 28, 28]);
  });
});

describe('recipeFromSong (DEC-21)', () => {
  it('maps note times to ticks on a 1920 ticks/s grid with the note pitches', () => {
    const song = makeSong([
      { time: 0, dur: 0.5, midi: 40 },
      { time: 0.75, dur: 0.25, midi: 52 },
      { time: 1.3337, dur: 0.4, midi: 64 },
    ]);
    const recipe = recipeFromSong(song);
    expect(notes(recipe).map((c) => [c.tick, c.length, c.key, c.channel])).toEqual([
      [0, 960, 40, 0],
      [1440, 480, 52, 0],
      [Math.round(1.3337 * SONG_MIDI_TICKS_PER_SEC), Math.round(1.7337 * 1920) - Math.round(1.3337 * 1920), 64, 0],
    ]);
    expect(recipe.barTicks).toEqual([0, 3840, 7680]);
    expect(recipe.calls.filter((c) => c.op === 'tempo')).toEqual([{ op: 'tempo', tick: 0, bpm: 120 }]);
  });

  it('merges tied notes into their origin', () => {
    const song = makeSong([
      { time: 0, dur: 1, midi: 50 },
      { time: 1, dur: 1, midi: 50, tiedFrom: 0 },
      { time: 2, dur: 1, midi: 50, tiedFrom: 1 },
    ]);
    expect(notes(recipeFromSong(song)).map((c) => [c.tick, c.length])).toEqual([[0, 3 * 1920]]);
  });

  it('shortens and softens dead, palm-muted and ghost notes', () => {
    const song = makeSong([
      { time: 0, dur: 1, tech: {} },
      { time: 1, dur: 1, tech: { dead: true } },
      { time: 2, dur: 1, tech: { palmMute: true } },
      { time: 3, dur: 1, tech: { ghost: true } },
    ]);
    const [plain, dead, pm, ghost] = notes(recipeFromSong(song));
    expect(plain?.length).toBe(1920);
    expect(dead?.length).toBeLessThanOrEqual(0.05 * 1920);
    expect(pm?.length).toBeLessThanOrEqual(0.2 * 1920 + 1);
    expect(ghost?.length).toBe(1920);
    expect(new Set([plain?.velocity, dead?.velocity, pm?.velocity, ghost?.velocity]).size).toBe(4);
    expect(ghost!.velocity).toBeLessThan(plain!.velocity);
  });

  it('turns a released bend into an up and a down per-note pitch-bend ramp', () => {
    const song = makeSong([{ time: 0, dur: 0.9, midi: 59, tech: { bend: { semitones: 2, release: true } } }]);
    const bends = recipeFromSong(song).calls.filter((c): c is Extract<MidiCall, { op: 'noteBend' }> => c.op === 'noteBend');
    expect(bends[0]).toMatchObject({ tick: 0, key: 59, value: 8192 });
    const peak = Math.max(...bends.map((b) => b.value));
    // Range ±12 semitones: +2 semitones = 8192 + 8192/6.
    expect(peak).toBe(Math.round(8192 + 8192 / 6));
    expect(bends[bends.length - 1]?.value).toBe(8192);
    expect(bends.every((b, i) => i === 0 || b.tick >= bends[i - 1]!.tick)).toBe(true);
  });

  it('uses a nylon guitar for fingerstyle songs and a clean electric otherwise', () => {
    const program = (s: Song) => recipeFromSong(s).calls.find((c) => c.op === 'program');
    expect(program(makeSong([{}], { style: ['fingerstyle'] }))).toMatchObject({ program: 24 });
    expect(program(makeSong([{}], { style: ['pick'] }))).toMatchObject({ program: 27 });
  });
});

describe('buildMidiFile', () => {
  it('scales every tempo by the speed and keeps the ticks', () => {
    const { recipe } = alphaTabRecipe(ISOLATED_TEX, 0);
    for (const speed of [1, 0.5, 0.7]) {
      const file = buildMidiFile(recipe, speed);
      const tempos = file.events.filter((e): e is midi.TempoChangeEvent => e.type === midi.MidiEventType.TempoChange);
      expect(tempos.map((t) => [t.tick, t.beatsPerMinute])).toEqual([
        [0, 90 * speed],
        [recipe.barTicks[2], 140 * speed],
      ]);
      const ons = file.events.filter((e): e is midi.NoteOnEvent => e.type === midi.MidiEventType.NoteOn);
      expect(ons.map((e) => e.tick)).toEqual(notes(recipe).map((c) => c.tick));
    }
  });

  it('rejects a non-positive speed', () => {
    const { recipe } = alphaTabRecipe(ISOLATED_TEX, 0);
    expect(() => buildMidiFile(recipe, 0)).toThrow(RangeError);
  });
});
