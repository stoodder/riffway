/**
 * Note-name helpers (shared; implemented by T-010). `midiToName(55) === 'G3'` (MIDI 60 = C4).
 * @module
 */

/** Sharp spellings, index = pitch class. */
export const NOTE_NAMES: readonly string[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Scientific pitch name, e.g. `40 → 'E2'`, `64 → 'E4'`. */
export function midiToName(midi: number): string {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  return `${NOTE_NAMES[pc]}${Math.floor(m / 12) - 1}`;
}
