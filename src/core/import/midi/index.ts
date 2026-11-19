/**
 * MIDI rhythm source for ASCII tabs (T-012): `@tonejs/midi` → onset groups, then Needleman–Wunsch
 * alignment of tab groups to MIDI groups (score = Jaccard of pitch sets, octave-insensitive 0.5,
 * gap −0.4; ≥ 80% matched → `rhythm: 'midi'`). Signatures frozen by T-010.
 * @module
 */
import type { TempoChange } from '@shared/song';
import { notImplemented } from '@shared/errors';

/** Notes starting together in the MIDI (all tracks merged). */
export interface MidiOnsetGroup {
  time: number;
  pitches: number[];
}

/** What the aligner needs from a MIDI file. */
export interface MidiRhythm {
  groups: MidiOnsetGroup[];
  tempos: TempoChange[];
  timeSignatures: { time: number; num: number; den: number }[];
  ppq: number;
  durationSec: number;
}

/** Alignment result. */
export interface MidiAlignment {
  /** Fraction of tab groups matched (0–1). */
  matched: number;
  /** One time per tab group (matched → MIDI time; unmatched → interpolated). */
  times: number[];
  /** `[tabGroupIndex, midiGroupIndex]` pairs. */
  pairs: [number, number][];
}

/** Parse MIDI bytes into onset groups + tempo/time-signature maps. */
export function readMidiRhythm(data: Uint8Array): MidiRhythm {
  return notImplemented('readMidiRhythm', 'T-012');
}

/** Align tab onset groups (pitch sets in order) to MIDI onset groups. */
export function alignTabToMidi(tabGroups: readonly { pitches: readonly number[] }[], midi: MidiRhythm): MidiAlignment {
  return notImplemented('alignTabToMidi', 'T-012');
}
