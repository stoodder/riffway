/**
 * Guide MIDI (T-021, DEC-21). DOM-free; runs in the song worker and in Node tests.
 *
 * A {@link MidiRecipe} is the guide track as a list of `IMidiFileHandler` calls plus the played-order
 * bar ticks. It is built once per song, either
 * - from alphaTab's `MidiFileGenerator` (GP/MusicXML/alphaTex: bends, slides, palm mutes, vibrato and
 *   dead notes come from alphaTab), keeping only the arrangement's track, or
 * - from the `Song` notes (ASCII tabs and ClassTab, which alphaTab cannot import), at a fixed
 *   120 BPM / 960 PPQ grid where 1 tick = 1/1920 s.
 *
 * {@link buildMidiFile} replays the recipe into an alphaTab `MidiFile` with **every tempo multiplied by
 * the speed**, so a render at speed `s` maps song time `t` to render time `t / s` with no pitch change.
 * @module
 */
import { midi, type model, type Settings } from '@coderline/alphatab';
import type { Note, Song } from '@shared/song';

/** One recorded `IMidiFileHandler` call (plain data, structured-clonable). */
export type MidiCall =
  | { op: 'tickShift'; tickShift: number }
  | { op: 'timeSignature'; tick: number; num: number; den: number }
  | { op: 'note'; track: number; tick: number; length: number; key: number; velocity: number; channel: number }
  | { op: 'control'; track: number; tick: number; channel: number; controller: number; value: number }
  | { op: 'program'; track: number; tick: number; channel: number; program: number }
  | { op: 'tempo'; tick: number; bpm: number }
  | { op: 'bend'; track: number; tick: number; channel: number; value: number }
  | { op: 'noteBend'; track: number; tick: number; channel: number; key: number; value: number }
  | { op: 'finish'; track: number; tick: number };

/** The guide track of one song, ready to be rendered at any speed. */
export interface MidiRecipe {
  /** Handler calls in generation order (ticks before `tickShift` is applied, as alphaTab passes them). */
  calls: MidiCall[];
  /** Ticks per quarter note. */
  division: number;
  /**
   * Absolute MIDI tick (tick shift applied) of every played bar start, plus the song end as the
   * last entry: `barTicks.length === song.timing.bars.length + 1`. `barTicks[k]` sounds at song
   * time `song.timing.bars[k].time`.
   */
  barTicks: number[];
  /** `MidiFileGenerator.transpositionPitches` as `[channel, semitones]` pairs. */
  transpositionPitches: [number, number][];
}

/** Ticks per quarter note of a Song-built recipe (alphaTab's default). */
export const SONG_MIDI_DIVISION = 960;
/** Tempo of a Song-built recipe: 120 BPM × 960 PPQ = 1920 ticks per second. */
export const SONG_MIDI_BPM = 120;
/** Ticks per second of a Song-built recipe. */
export const SONG_MIDI_TICKS_PER_SEC = (SONG_MIDI_BPM / 60) * SONG_MIDI_DIVISION;

/** Pitch-bend range set on the Song-built channel (RPN 0), semitones; same as alphaTab's generator. */
const BEND_RANGE_SEMITONES = 12;
/** 14-bit pitch-wheel centre. */
const WHEEL_CENTER = 8192;
/** Linear steps per bend ramp. */
const BEND_STEPS = 8;
/** General MIDI programs (0-based): nylon for fingerstyle/classical, clean electric otherwise. */
const PROGRAM_NYLON = 24;
const PROGRAM_CLEAN_ELECTRIC = 27;
/** MIDI controllers used for the Song-built channel setup. */
const CC = { volume: 7, pan: 10, expression: 11, dataEntry: 6, dataEntryFine: 38, rpnFine: 100, rpnCoarse: 101 } as const;

/** Shortest sounding note, seconds (dead notes are clipped to this). */
const DEAD_NOTE_SEC = 0.05;
/** Palm-muted notes ring at most this long, seconds. */
const PALM_MUTE_MAX_SEC = 0.2;

/** Velocities of the Song-built track. */
const VELOCITY = { normal: 100, palmMute: 85, ghost: 60, dead: 70 } as const;

/** `IMidiFileHandler` that records calls for one track (the guide arrangement) plus global events. */
class RecordingHandler implements midi.IMidiFileHandler {
  readonly calls: MidiCall[] = [];
  constructor(private readonly track: number) {}

  addTickShift(tickShift: number): void {
    this.calls.push({ op: 'tickShift', tickShift });
  }
  addTimeSignature(tick: number, num: number, den: number): void {
    this.calls.push({ op: 'timeSignature', tick, num, den });
  }
  addRest(): void {
    // Rests only feed alphaTab's cursor events; nothing to synthesise.
  }
  addMetronome(): void {
    // The guide never renders alphaSynth's metronome (the engine owns the click).
  }
  addNote(track: number, tick: number, length: number, key: number, velocity: number, channel: number): void {
    if (track === this.track) this.calls.push({ op: 'note', track, tick, length, key, velocity, channel });
  }
  addControlChange(track: number, tick: number, channel: number, controller: midi.ControllerType, value: number): void {
    if (track === this.track) this.calls.push({ op: 'control', track, tick, channel, controller, value });
  }
  addProgramChange(track: number, tick: number, channel: number, program: number): void {
    if (track === this.track) this.calls.push({ op: 'program', track, tick, channel, program });
  }
  addTempo(tick: number, bpm: number): void {
    this.calls.push({ op: 'tempo', tick, bpm });
  }
  addBend(track: number, tick: number, channel: number, value: number): void {
    if (track === this.track) this.calls.push({ op: 'bend', track, tick, channel, value });
  }
  addNoteBend(track: number, tick: number, channel: number, key: number, value: number): void {
    if (track === this.track) this.calls.push({ op: 'noteBend', track, tick, channel, key, value });
  }
  finishTrack(track: number, tick: number): void {
    this.calls.push({ op: 'finish', track, tick });
  }
}

/**
 * Recipe for one track of an alphaTab score (`MidiFileGenerator`, repeats expanded). Only the
 * arrangement's notes and channel events are kept; tempo and time-signature events are global.
 * Bar ticks follow `tickLookup.masterBars` (played order), matching `alphaTabToSong`.
 */
export function recipeFromAlphaTab(score: model.Score, settings: Settings, arrangement: number): MidiRecipe {
  const handler = new RecordingHandler(arrangement);
  const gen = new midi.MidiFileGenerator(score, settings, handler);
  gen.generate();
  const shift = handler.calls.reduce((s, c) => (c.op === 'tickShift' ? c.tickShift : s), 0);
  const played = gen.tickLookup.masterBars;
  const barTicks = played.map((m) => m.start + shift);
  const last = played[played.length - 1];
  barTicks.push((last ? last.end : 0) + shift);
  return {
    calls: handler.calls,
    // The generator writes ticks at the `MidiFile` default division (960 PPQ).
    division: new midi.MidiFile().division,
    barTicks,
    transpositionPitches: [...gen.transpositionPitches.entries()],
  };
}

function secToTick(sec: number): number {
  return Math.round(sec * SONG_MIDI_TICKS_PER_SEC);
}

/** Pitch-wheel value for a bend of `semitones` within the ±{@link BEND_RANGE_SEMITONES} range. */
function wheel(semitones: number): number {
  const v = WHEEL_CENTER + (semitones / BEND_RANGE_SEMITONES) * WHEEL_CENTER;
  return Math.max(0, Math.min(16383, Math.round(v)));
}

/** Linear per-note bend ramp from `from` to `to` semitones over `[t0, t1]` ticks. */
function bendRamp(calls: MidiCall[], key: number, t0: number, t1: number, from: number, to: number): void {
  for (let i = 1; i <= BEND_STEPS; i++) {
    const tick = Math.round(t0 + ((t1 - t0) * i) / BEND_STEPS);
    calls.push({ op: 'noteBend', track: 0, tick, channel: 0, key, value: wheel(from + ((to - from) * i) / BEND_STEPS) });
  }
}

/** Sounding length of a note in seconds, with tied continuations merged in. */
function soundingEnd(note: Note, tieEnd: ReadonlyMap<number, number>): number {
  let end = Math.max(note.time + note.dur, tieEnd.get(note.id) ?? 0);
  if (note.tech.dead) end = note.time + Math.min(DEAD_NOTE_SEC, end - note.time || DEAD_NOTE_SEC);
  else if (note.tech.palmMute) end = Math.min(end, note.time + PALM_MUTE_MAX_SEC);
  return Math.max(end, note.time + 1 / SONG_MIDI_TICKS_PER_SEC);
}

function velocityOf(note: Note): number {
  if (note.tech.dead) return VELOCITY.dead;
  if (note.tech.ghost) return VELOCITY.ghost;
  if (note.tech.palmMute) return VELOCITY.palmMute;
  return VELOCITY.normal;
}

/**
 * Recipe built from `Song` notes (DEC-21: ASCII tabs and ClassTab, which have no alphaTab score).
 * One track on channel 0 at 120 BPM, so ticks are seconds × 1920 and the song's own tempo map is
 * already folded into the note times. Tied destinations extend their origin; dead, ghost and
 * palm-muted notes are shorter and/or softer; bends become per-note pitch-bend ramps (up over the
 * first third, back down over the last third when released). Nylon guitar for fingerstyle or
 * classical songs, clean electric otherwise.
 */
export function recipeFromSong(song: Song): MidiRecipe {
  const calls: MidiCall[] = [];
  const firstBar = song.timing.bars[0];
  const nylon = song.meta.tags.style.includes('fingerstyle') || song.meta.tags.genre.includes('classical');
  calls.push({ op: 'tempo', tick: 0, bpm: SONG_MIDI_BPM });
  calls.push({ op: 'timeSignature', tick: 0, num: firstBar?.num ?? 4, den: firstBar?.den ?? 4 });
  const setup: [number, number][] = [
    [CC.volume, 110],
    [CC.pan, 64],
    [CC.expression, 127],
    [CC.rpnFine, 0],
    [CC.rpnCoarse, 0],
    [CC.dataEntryFine, 0],
    [CC.dataEntry, BEND_RANGE_SEMITONES],
  ];
  for (const [controller, value] of setup) calls.push({ op: 'control', track: 0, tick: 0, channel: 0, controller, value });
  calls.push({ op: 'program', track: 0, tick: 0, channel: 0, program: nylon ? PROGRAM_NYLON : PROGRAM_CLEAN_ELECTRIC });

  // Tied destinations are not struck again: their end extends the chain's origin.
  const tieEnd = new Map<number, number>();
  for (const n of song.notes) {
    if (n.tiedFrom === undefined) continue;
    let origin = song.notes[n.tiedFrom];
    while (origin?.tiedFrom !== undefined) origin = song.notes[origin.tiedFrom];
    if (origin) tieEnd.set(origin.id, Math.max(tieEnd.get(origin.id) ?? 0, n.time + n.dur));
  }

  for (const n of song.notes) {
    if (n.tiedFrom !== undefined) continue;
    const tick = secToTick(n.time);
    const end = Math.max(tick + 1, secToTick(soundingEnd(n, tieEnd)));
    calls.push({ op: 'note', track: 0, tick, length: end - tick, key: n.midi, velocity: velocityOf(n), channel: 0 });
    const bend = n.tech.bend;
    if (bend && bend.semitones !== 0) {
      const third = Math.max(1, Math.round((end - tick) / 3));
      calls.push({ op: 'noteBend', track: 0, tick, channel: 0, key: n.midi, value: wheel(0) });
      bendRamp(calls, n.midi, tick, tick + third, 0, bend.semitones);
      if (bend.release) bendRamp(calls, n.midi, end - third, end, bend.semitones, 0);
    }
  }

  const barTicks = song.timing.bars.map((b) => secToTick(b.time));
  const endTick = secToTick(song.meta.durationSec);
  barTicks.push(Math.max(endTick, (barTicks[barTicks.length - 1] ?? 0) + 1));
  calls.push({ op: 'finish', track: 0, tick: barTicks[barTicks.length - 1] as number });
  return { calls, division: SONG_MIDI_DIVISION, barTicks, transpositionPitches: [] };
}

/**
 * Replay a recipe into an alphaTab `MidiFile` with every tempo × `speed` (0.4–1.1 in practice).
 * Ticks are unchanged, so bar ticks stay valid and only the tick → time mapping is scaled.
 */
export function buildMidiFile(recipe: MidiRecipe, speed: number): midi.MidiFile {
  if (!(speed > 0)) throw new RangeError(`Guide speed must be positive, got ${speed}`);
  const file = new midi.MidiFile();
  file.division = recipe.division;
  const h = new midi.AlphaSynthMidiFileHandler(file);
  let maxFinish = 0;
  for (const c of recipe.calls) {
    switch (c.op) {
      case 'tickShift':
        h.addTickShift(c.tickShift);
        break;
      case 'timeSignature':
        h.addTimeSignature(c.tick, c.num, c.den);
        break;
      case 'note':
        h.addNote(c.track, c.tick, c.length, c.key, c.velocity, c.channel);
        break;
      case 'control':
        h.addControlChange(c.track, c.tick, c.channel, c.controller as midi.ControllerType, c.value);
        break;
      case 'program':
        h.addProgramChange(c.track, c.tick, c.channel, c.program);
        break;
      case 'tempo':
        h.addTempo(c.tick, c.bpm * speed);
        break;
      case 'bend':
        h.addBend(c.track, c.tick, c.channel, c.value);
        break;
      case 'noteBend':
        h.addNoteBend(c.track, c.tick, c.channel, c.key, c.value);
        break;
      case 'finish':
        maxFinish = Math.max(maxFinish, c.tick);
        break;
    }
  }
  h.finishTrack(0, maxFinish);
  return file;
}
