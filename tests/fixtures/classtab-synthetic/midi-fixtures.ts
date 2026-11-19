/**
 * Generator for the synthetic ClassTab-style MIDI fixtures (D2: authored by us, nothing copied).
 * Each MIDI is built with `@tonejs/midi` from the note lists below, which mirror the synthetic tabs
 * in this folder. `tests/align/fixtures.test.ts` rebuilds every file and checks the committed bytes.
 *
 * Regenerate: `npx tsx tests/fixtures/classtab-synthetic/midi-fixtures.ts --write`
 * @module
 */
import * as tonejsMidi from '@tonejs/midi';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type MidiCtor = typeof tonejsMidi.Midi;
// CommonJS interop: Node's ESM loader exposes the exports object as `default`.
const interop = tonejsMidi as unknown as { Midi?: MidiCtor; default?: { Midi: MidiCtor } };
/** The `@tonejs/midi` constructor, whichever way the module system exposes it. */
export const Midi: MidiCtor = interop.Midi ?? (interop.default as { Midi: MidiCtor }).Midi;

/** Standard tuning high → low (string 1 first). */
const STANDARD = [64, 59, 55, 50, 45, 40];

/** `[string, fret, start, dur]` in `unit`s (fractions of a quarter note). */
type Ev = [number, number, number, number];

/** One fixture MIDI: tempo, time signature, note unit, tracks of tab-style events. */
export interface MidiSpec {
  bpm: number;
  timeSig: [number, number];
  /** Event unit in quarter notes (0.5 = eighths). */
  unit: number;
  tuning?: number[];
  tracks: { name: string; events: Ev[]; extra?: { pitch: number; start: number; dur: number }[] }[];
}

/** Note lists per MIDI file name (tabs: the `.txt` files next to this module). */
export const MIDI_SPECS: Readonly<Record<string, MidiSpec>> = {
  // riffway_study_no1_in_e.txt (6/8, pickup of one eighth after five eighths of rest).
  'riffway_study_no1_in_e.mid': {
    bpm: 120,
    timeSig: [6, 8],
    unit: 0.5,
    tracks: [
      {
        name: 'treble',
        events: [
          [3, 0, 5, 1],
          [1, 0, 6, 1], [2, 0, 7, 1], [3, 0, 8, 1], [1, 0, 9, 1], [2, 0, 10, 1], [3, 0, 11, 1],
          [2, 0, 12, 1], [3, 2, 13, 1], [2, 1, 15, 1], [3, 2, 16, 1], [3, 4, 17, 1],
          [1, 3, 18, 1], [2, 0, 19, 1], [3, 0, 20, 1], [1, 2, 21, 1], [2, 0, 22, 1], [3, 0, 23, 1],
          [1, 0, 24, 6], [2, 0, 24, 6], [3, 0, 24, 6], [4, 2, 24, 6],
        ],
        // An ornament the tab does not write: the aligner must skip it.
        extra: [{ pitch: 66, start: 20.5, dur: 0.25 }],
      },
      { name: 'bass', events: [[6, 0, 6, 6], [5, 2, 12, 6], [4, 0, 18, 3], [5, 2, 24, 6], [6, 0, 24, 6]] },
    ],
  },
  // A different piece: pairs with riffway_waltz_in_a.txt by suffix but must not be used for timing.
  'riffway_waltz_in_a_1.mid': {
    bpm: 90,
    timeSig: [3, 4],
    unit: 1,
    tracks: [{ name: 'other', events: [], extra: [{ pitch: 73, start: 0, dur: 1 }, { pitch: 78, start: 1, dur: 1 }, { pitch: 80, start: 2, dur: 1 }] }],
  },
  // riffway_march_in_c.txt (header URL names this file).
  'riffway_marche_elegante.mid': {
    bpm: 100,
    timeSig: [4, 4],
    unit: 0.5,
    tracks: [
      {
        name: 'guitar',
        events: [
          [2, 1, 0, 2], [5, 3, 0, 8], [3, 0, 1, 1], [2, 0, 2, 2], [3, 0, 3, 1], [2, 1, 4, 2], [3, 0, 5, 1], [4, 2, 6, 1], [3, 0, 7, 1],
          [1, 0, 8, 1], [2, 1, 9, 1], [3, 0, 10, 1], [4, 2, 11, 1], [1, 3, 12, 1], [2, 1, 13, 1], [3, 0, 14, 1], [4, 2, 15, 1],
          [1, 1, 16, 2], [4, 3, 16, 8], [1, 0, 18, 2], [2, 0, 20, 2], [5, 2, 22, 2],
          [1, 0, 24, 8], [2, 1, 24, 8], [3, 0, 24, 8], [4, 2, 24, 8], [5, 3, 24, 8],
        ],
      },
    ],
  },
  // riffway_two_preludes.txt, version 1 (2/4, Q=60).
  'riffway_two_preludes_01.mid': {
    bpm: 60,
    timeSig: [2, 4],
    unit: 0.5,
    tracks: [{ name: 'v1', events: [[5, 0, 0, 2], [3, 2, 1, 1], [2, 1, 2, 1], [1, 0, 3, 1], [5, 0, 4, 2], [3, 2, 5, 1], [2, 1, 6, 1], [3, 2, 7, 1]] }],
  },
  // riffway_two_preludes.txt, version 2 (2/4, Q=72).
  'riffway_two_preludes_02.mid': {
    bpm: 72,
    timeSig: [2, 4],
    unit: 0.5,
    tracks: [{ name: 'v2', events: [[6, 0, 0, 2], [3, 1, 1, 1], [2, 0, 2, 1], [1, 0, 3, 1], [6, 0, 4, 2], [3, 1, 5, 1], [2, 0, 6, 1], [1, 4, 7, 1]] }],
  },
  // A MIDI with no tab at all (an alternative edition): never paired.
  'riffway_orphan_am.mid': {
    bpm: 80,
    timeSig: [4, 4],
    unit: 1,
    tracks: [{ name: 'orphan', events: [[5, 0, 0, 4]] }],
  },
};

/** Build one MIDI from a spec (format 1, one track per spec track). */
export function buildMidi(spec: MidiSpec): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(spec.bpm);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [...spec.timeSig] });
  midi.header.update();
  const spq = 60 / spec.bpm;
  const tuning = spec.tuning ?? STANDARD;
  for (const t of spec.tracks) {
    const track = midi.addTrack();
    track.name = t.name;
    for (const [string, fret, start, dur] of t.events) {
      track.addNote({ midi: tuning[string - 1] + fret, time: start * spec.unit * spq, duration: dur * spec.unit * spq, velocity: 0.8 });
    }
    for (const e of t.extra ?? []) {
      track.addNote({ midi: e.pitch, time: e.start * spec.unit * spq, duration: e.dur * spec.unit * spq, velocity: 0.6 });
    }
  }
  return midi.toArray();
}

/** Folder holding the fixtures. */
export const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

if (process.argv.includes('--write') && process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, spec] of Object.entries(MIDI_SPECS)) writeFileSync(join(FIXTURE_DIR, name), buildMidi(spec));
}
