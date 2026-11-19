/**
 * Tuner display model (docs/audio-input.md § Tuner): turns a smoothed {@link TunerReading} into what
 * the tuner panel shows — the chromatic note and cents, the nearest string of the song's tuning
 * (Drop D etc.), how far that string is from its target, and which way to turn the peg. Pure.
 * @module
 */
import type { TunerReading } from '@core/dsp';
import { freqToMidiFloat } from '@core/dsp';
import { NOTE_NAMES } from '@core/model';

/**
 * DOM event the tuner panel dispatches (bubbling, from its root) the first time each string reads in
 * tune; `detail.string` is the string number. Audio setup counts tuning as done on it (R3-U-15).
 */
export const TUNER_IN_TUNE_EVENT = 'riffway:tuner-in-tune';

/** |cents| at or below this is in tune (the smoother also requires 0.5 s). */
export const IN_TUNE_CENTS = 3;
/** Allowed A4 reference range in the UI, Hz. */
export const A4_MIN = 415;
export const A4_MAX = 466;

/** One open string of the tuning. */
export interface StringTarget {
  /** String number, 1 = high e. */
  string: number;
  midi: number;
  /** Pitch class, e.g. `D`. */
  name: string;
  octave: number;
}

/** Open-string targets, in tuning order (string 1 first). */
export function stringTargets(tuning: readonly number[]): StringTarget[] {
  return tuning.map((midi, i) => ({ string: i + 1, midi, ...splitName(midi) }));
}

/** `40 → {name:'E', octave:2}` (MIDI 60 = C4, sharps). */
export function splitName(midi: number): { name: string; octave: number } {
  const m = Math.round(midi);
  return { name: NOTE_NAMES[((m % 12) + 12) % 12], octave: Math.floor(m / 12) - 1 };
}

/** Which way to turn the peg. */
export type TuneDirection = 'up' | 'down' | 'ok';

/** Everything the tuner panel renders for one reading. */
export interface TunerView {
  /** Chromatic note nearest to the pitch. */
  note: { name: string; octave: number; midi: number };
  /** Deviation from that note, cents (−50…+50). */
  cents: number;
  freq: number;
  /** Nearest open string of the tuning. */
  target: StringTarget;
  /** Deviation from the target string's pitch, cents (may exceed ±50 when a string is far off). */
  centsFromTarget: number;
  direction: TuneDirection;
  /** The target string is in tune (held ±3 cents for 0.5 s on the target note). */
  inTune: boolean;
  /** False while the display holds its last value (unclear signal). */
  live: boolean;
}

/** Index into `targets` of the open string nearest to `midiFloat` (ties go to the lower string). */
export function nearestString(midiFloat: number, targets: readonly StringTarget[]): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < targets.length; i++) {
    const d = Math.abs(midiFloat - targets[i].midi);
    if (d < bestDist || (d === bestDist && targets[i].midi < targets[best].midi)) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Build the view for a smoother reading. `a4` must be the reference the smoother used, so
 * `reading.midi`/`cents` and the string targets agree.
 */
export function tunerView(reading: TunerReading, targets: readonly StringTarget[], a4: number): TunerView | null {
  if (!(reading.freq > 0) || targets.length === 0) return null;
  const pitch = freqToMidiFloat(reading.freq, a4);
  const target = targets[nearestString(pitch, targets)];
  const centsFromTarget = (pitch - target.midi) * 100;
  const direction: TuneDirection =
    Math.abs(centsFromTarget) <= IN_TUNE_CENTS ? 'ok' : centsFromTarget < 0 ? 'up' : 'down';
  return {
    note: { ...splitName(reading.midi), midi: reading.midi },
    cents: reading.cents,
    freq: reading.freq,
    target,
    centsFromTarget,
    direction,
    inTune: reading.inTune && reading.live && reading.midi === target.midi,
    live: reading.live,
  };
}

/** Short instruction under the needle. */
export function instruction(view: TunerView): string {
  const t = `${view.target.name}${view.target.octave}`;
  if (view.direction === 'ok') return view.inTune ? `String ${view.target.string} in tune` : `Hold it… ${t}`;
  const semis = Math.round(Math.abs(view.centsFromTarget) / 100);
  const far = semis >= 1 ? ` (${semis} semitone${semis === 1 ? '' : 's'})` : '';
  return `Tune ${view.direction} to ${t}${far}`;
}

/** Cents as shown: `+3`, `−12`, `0` (typographic minus). */
export function formatCents(cents: number): string {
  const r = Math.round(cents);
  if (r === 0) return '0';
  return r > 0 ? `+${r}` : `−${-r}`;
}

/** Clamp an A4 reference to the UI range, whole Hz. */
export function clampA4(a4: number): number {
  return Math.min(A4_MAX, Math.max(A4_MIN, Math.round(a4)));
}
