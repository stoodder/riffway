/**
 * Pitch helpers for ASCII tab: note-name parsing, tunings from note names, natural-harmonic pitches.
 * @module
 */
import type { StringNumber, Tech } from '@shared/song';

/** Standard tuning, high → low (E4 B3 G3 D3 A2 E2). */
export const STANDARD_TUNING: readonly number[] = [64, 59, 55, 50, 45, 40];

const LETTER_PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Pitch class (0–11) of a note name such as `E`, `e`, `F#`, `Bb`, `E♭`; null when not a note name.
 * Case-insensitive letter; `b`/`♭` = flat, `#`/`♯` = sharp.
 */
export function pitchClassOf(name: string): number | null {
  const m = /^([A-Ga-g])([#b♯♭]?)$/.exec(name.trim());
  if (!m) return null;
  const base = LETTER_PC[m[1].toUpperCase()];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return (base + acc + 12) % 12;
}

/** MIDI pitch with pitch class `pc` nearest to `reference` (ties resolve downward, e.g. drop tunings). */
export function nearestPitch(pc: number, reference: number): number {
  const refPc = ((reference % 12) + 12) % 12;
  let diff = pc - refPc;
  if (diff > 5) diff -= 12;
  if (diff < -6) diff += 12;
  return reference + diff;
}

/**
 * Tuning (high → low) from six pitch classes ordered string 1 → string 6, each placed in the octave
 * nearest to standard tuning for that string (`D` on string 6 → D2, i.e. Drop D).
 */
export function tuningFromPitchClasses(pcs: readonly number[]): number[] {
  return pcs.map((pc, i) => nearestPitch(pc, STANDARD_TUNING[i]));
}

/** Split a token such as `EADGBE`, `DADGAD`, `EbAbDbGbBbEb` or `E` into note names; null if it is not one. */
export function splitNoteNames(token: string): string[] | null {
  if (!/^(?:[A-Ga-g][#b♯♭]?)+$/.test(token)) return null;
  return token.match(/[A-Ga-g][#b♯♭]?/g);
}

/** Pitch offset above the open string for a natural harmonic at `fret` (12 → +12, 7 → +19, 5 → +24, …). */
const NATURAL_HARMONIC_OFFSET: Readonly<Record<number, number>> = {
  12: 12, 7: 19, 19: 19, 5: 24, 24: 24, 4: 28, 9: 28, 16: 28, 3: 31,
};

/**
 * Sounding MIDI pitch of a tab note: `tuning[string-1] + capo + fret`; natural harmonics sound at
 * their harmonic (`<12>` = open + 12). Dead notes use fret 0.
 */
export function notePitch(tuning: readonly number[], capo: number, string: StringNumber, fret: number, tech: Tech): number {
  const open = tuning[string - 1] + capo;
  if (tech.harmonic === 'natural') {
    const offset = NATURAL_HARMONIC_OFFSET[fret];
    if (offset !== undefined) return open + offset;
  }
  return open + fret;
}
