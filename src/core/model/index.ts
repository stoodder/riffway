/**
 * Song-model helpers (T-011). Pure, DOM-free; used by the judge, renderer, difficulty, transport
 * and UI. Signatures are frozen by T-010; T-011 implements the bodies.
 *
 * `onsetGroups` and `midiToName` are implemented in `./onset-groups.ts` / `./names.ts` by T-010 because
 * several wave-1 tasks need them at once.
 * @module
 */
import type { Section, Song, Timing } from '@shared/song';
import { notImplemented } from '@shared/errors';

export { onsetGroups, type OnsetGroup } from './onset-groups';
export { midiToName, NOTE_NAMES } from './names';

/** One validation problem found by {@link validateSong}. */
export interface ValidationIssue {
  code:
    | 'time-order'
    | 'midi-invariant'
    | 'string-collision'
    | 'bar-gap'
    | 'section-bars'
    | 'note-bar'
    | 'chord-ref'
    | 'tie-ref'
    | 'id-order';
  message: string;
  noteId?: number;
  bar?: number;
}

/**
 * Index range `[start, end)` of notes with `from ≤ time < to` (binary search over `song.notes`,
 * which is sorted by time). Allocation-free apart from the returned object.
 */
export function notesInRange(song: Song, from: number, to: number): { start: number; end: number } {
  return notImplemented('notesInRange', 'T-011');
}

/** Bar index containing `time` (clamped to `[0, bars.length - 1]`). */
export function barAt(song: Song, time: number): number {
  return notImplemented('barAt', 'T-011');
}

/** Section index containing `time`, or -1 when the song has no sections. */
export function sectionAt(song: Song, time: number): number {
  return notImplemented('sectionAt', 'T-011');
}

/** Every beat time in the song (flattened `timing.bars[].beats`), ascending. */
export function beatTimes(song: Song): number[] {
  return notImplemented('beatTimes', 'T-011');
}

/** Auto-sections of `barsPerSection` bars named "Part 1…n" (used when a source has none). */
export function autoSections(timing: Timing, barsPerSection = 8): Section[] {
  return notImplemented('autoSections', 'T-011');
}

/** Check the model invariants (docs/song-formats.md). Empty array = valid. */
export function validateSong(song: Song): ValidationIssue[] {
  return notImplemented('validateSong', 'T-011');
}

/**
 * Tuning slug + label for search filters and display, e.g. `{id:'drop-d', label:'Drop D'}`,
 * `{id:'standard', label:'Standard'}`, else `{id:'custom', label:'D A D G B E'}`.
 */
export function describeTuning(tuning: readonly number[]): { id: string; label: string } {
  return notImplemented('describeTuning', 'T-011');
}

/** Standard tuning, high → low (E4 B3 G3 D3 A2 E2). */
export const STANDARD_TUNING: readonly number[] = [64, 59, 55, 50, 45, 40];
