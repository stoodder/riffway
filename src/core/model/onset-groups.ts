/**
 * Onset grouping shared by the judge (T-014) and difficulty (T-013): a group is a single note or a
 * chord (same `chordId`, or onsets within 10 ms). Tied destinations are excluded.
 * Implemented by T-010 (shared helper); T-011 owns the folder afterwards.
 * @module
 */
import type { Note, Song } from '@shared/song';

/** Notes struck together. */
export interface OnsetGroup {
  /** Index in the returned array. */
  index: number;
  /** Earliest note time in the group. */
  time: number;
  /** Notes in the group (ascending string number). */
  notes: Note[];
  /** True when the group has ≥ 2 notes. */
  chord: boolean;
}

/** Group window: onsets within this many seconds form one group. */
export const GROUP_WINDOW_SEC = 0.01;

/** Build onset groups from `song.notes` (sorted by time). Tied destinations are skipped. */
export function onsetGroups(song: Pick<Song, 'notes'>, windowSec = GROUP_WINDOW_SEC): OnsetGroup[] {
  const groups: OnsetGroup[] = [];
  let current: OnsetGroup | null = null;
  for (const note of song.notes) {
    if (note.tiedFrom !== undefined) continue;
    const sameChord =
      current !== null &&
      note.chordId !== undefined &&
      current.notes.some((n) => n.chordId === note.chordId);
    if (current && (sameChord || note.time - current.time <= windowSec)) {
      current.notes.push(note);
      current.chord = true;
      continue;
    }
    current = { index: groups.length, time: note.time, notes: [note], chord: false };
    groups.push(current);
  }
  for (const g of groups) g.notes.sort((a, b) => a.string - b.string);
  return groups;
}
