/**
 * Pitch `expect` hints for the analysis worklet (docs/audio-input.md): the session tells the input
 * service which pitch range the upcoming notes cover, so the pitch detector can search below its
 * default E2 floor (Drop D, D#2 and lower get no pitch without a hint) and reject implausible
 * octaves. Pure: the session calls {@link expectedRange} on a timer and forwards changes.
 * @module
 */
import type { Note, Song } from '@shared/song';

/** How far ahead (song seconds) the hint looks. */
export const EXPECT_LOOKAHEAD_SEC = 3;
/** How far back (song seconds): a note just played may still be ringing / arriving. */
export const EXPECT_LOOKBACK_SEC = 0.25;

/** A pitch range in MIDI note numbers (inclusive). */
export interface MidiRange {
  minMidi: number;
  maxMidi: number;
}

/** Highest pitch a note can reach (bent notes reach their bend target). */
function topMidi(n: Note): number {
  const bend = n.tech.bend?.semitones ?? 0;
  return n.midi + Math.max(0, Math.ceil(bend));
}

/**
 * Pitch range of the notes sounding in `[from, to]` (song seconds), dead notes excluded (they have
 * no pitch). `notes` must be sorted by time (as `Song.notes` is). Null when no pitched note is in range.
 */
export function expectedRange(notes: readonly Note[], from: number, to: number): MidiRange | null {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((notes[mid] as Note).time < from) lo = mid + 1;
    else hi = mid;
  }
  let minMidi = Infinity;
  let maxMidi = -Infinity;
  for (let i = lo; i < notes.length; i++) {
    const n = notes[i] as Note;
    if (n.time > to) break;
    if (n.tech.dead) continue;
    minMidi = Math.min(minMidi, n.midi);
    maxMidi = Math.max(maxMidi, topMidi(n));
  }
  return Number.isFinite(minMidi) ? { minMidi, maxMidi } : null;
}

/** Range for the window around `songTime` (lookback / lookahead scaled to song seconds). */
export function expectedRangeAt(song: Pick<Song, 'notes'>, songTime: number): MidiRange | null {
  return expectedRange(song.notes, songTime - EXPECT_LOOKBACK_SEC, songTime + EXPECT_LOOKAHEAD_SEC);
}

/** True when two hints are the same (null-safe). */
export function sameRange(a: MidiRange | null, b: MidiRange | null): boolean {
  if (a === null || b === null) return a === b;
  return a.minMidi === b.minMidi && a.maxMidi === b.maxMidi;
}
