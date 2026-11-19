/**
 * Tuning names for search filters and display (`SongMeta.tuningId` / `tuningLabel`).
 * Tunings are MIDI note numbers ordered high → low (`tuning[0]` = string 1 = high e).
 * @module
 */
import { NOTE_NAMES } from './names';

/** Standard tuning, high → low (E4 B3 G3 D3 A2 E2). */
export const STANDARD_TUNING: readonly number[] = [64, 59, 55, 50, 45, 40];

/** Named 6-string tunings, high → low. Order matters only for readability. */
const NAMED_TUNINGS: readonly { id: string; label: string; midi: readonly number[] }[] = [
  { id: 'standard', label: 'Standard', midi: STANDARD_TUNING },
  { id: 'drop-d', label: 'Drop D', midi: [64, 59, 55, 50, 45, 38] },
  { id: 'eb-standard', label: 'Eb Standard', midi: [63, 58, 54, 49, 44, 39] },
  { id: 'd-standard', label: 'D Standard', midi: [62, 57, 53, 48, 43, 38] },
  { id: 'drop-c-sharp', label: 'Drop C#', midi: [63, 58, 54, 49, 44, 37] },
  { id: 'drop-c', label: 'Drop C', midi: [62, 57, 53, 48, 43, 36] },
  { id: 'double-drop-d', label: 'Double Drop D', midi: [62, 59, 55, 50, 45, 38] },
  { id: 'dadgad', label: 'DADGAD', midi: [62, 57, 55, 50, 45, 38] },
  { id: 'open-g', label: 'Open G', midi: [62, 59, 55, 50, 43, 38] },
  { id: 'open-d', label: 'Open D', midi: [62, 57, 54, 50, 45, 38] },
  { id: 'open-e', label: 'Open E', midi: [64, 59, 56, 52, 47, 40] },
];

/**
 * Tuning slug + label for search filters and display, e.g. `{id:'drop-d', label:'Drop D'}`,
 * `{id:'standard', label:'Standard'}`, else `{id:'custom', label:'D A D G B E'}` (pitch classes
 * low → high, the way guitarists write tunings).
 */
export function describeTuning(tuning: readonly number[]): { id: string; label: string } {
  const named = NAMED_TUNINGS.find((t) => t.midi.length === tuning.length && t.midi.every((m, i) => m === tuning[i]));
  if (named) return { id: named.id, label: named.label };
  const label = [...tuning]
    .reverse()
    .map((m) => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12])
    .join(' ');
  return { id: 'custom', label };
}
