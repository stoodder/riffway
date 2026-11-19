/**
 * Song-model helpers (T-011). Pure, DOM-free; used by the judge, renderer, difficulty, transport
 * and UI. Lookups are binary searches over the sorted arrays of a {@link Song}, so they are cheap
 * enough to call every frame.
 *
 * - Time lookups: {@link notesInRange}, {@link barAt}, {@link sectionAt}, {@link beatTimes}.
 * - Construction helpers: {@link autoSections}.
 * - Invariants: {@link validateSong} (`./validate.ts`).
 * - Tunings: {@link describeTuning}, {@link STANDARD_TUNING} (`./tuning.ts`).
 * - Grouping and names: {@link onsetGroups} (`./onset-groups.ts`), {@link midiToName} (`./names.ts`).
 * @module
 */
import type { Section, Song, Timing } from '@shared/song';

export { onsetGroups, type OnsetGroup } from './onset-groups';
export { midiToName, NOTE_NAMES } from './names';
export { validateSong, type ValidationIssue } from './validate';
export { describeTuning, STANDARD_TUNING } from './tuning';

/** Index of the first element of `arr` whose `key` is `≥ value` (`arr.length` if none). */
function lowerBound<T>(arr: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(arr[mid] as T) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the last element of `arr` whose `key` is `≤ value` (-1 if none). */
function lastAtOrBefore<T>(arr: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(arr[mid] as T) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

const noteTime = (n: { time: number }): number => n.time;

/**
 * Index range `[start, end)` of notes with `from ≤ time < to` (binary search over `song.notes`,
 * which is sorted by time). Allocation-free apart from the returned object. An empty or inverted
 * range yields `start === end`.
 */
export function notesInRange(song: Song, from: number, to: number): { start: number; end: number } {
  const start = lowerBound(song.notes, from, noteTime);
  const end = Math.max(start, lowerBound(song.notes, to, noteTime));
  return { start, end };
}

/** Bar index containing `time` (clamped to `[0, bars.length - 1]`; 0 for a song without bars). */
export function barAt(song: Song, time: number): number {
  return Math.max(0, lastAtOrBefore(song.timing.bars, time, noteTime));
}

/**
 * Section index containing `time`, or -1 when the song has no sections. Times before the first
 * section clamp to 0; times after the last section clamp to the last one.
 */
export function sectionAt(song: Song, time: number): number {
  if (song.sections.length === 0) return -1;
  return Math.max(0, lastAtOrBefore(song.sections, time, (s) => s.start));
}

/** Every beat time in the song (flattened `timing.bars[].beats`), ascending. */
export function beatTimes(song: Song): number[] {
  const out: number[] = [];
  for (const bar of song.timing.bars) for (const t of bar.beats) out.push(t);
  return out;
}

/**
 * Auto-sections of `barsPerSection` bars named "Part 1…n" (used when a source has none). The last
 * section takes the remaining bars. Returns `[]` when the timing has no bars.
 */
export function autoSections(timing: Timing, barsPerSection = 8): Section[] {
  const { bars } = timing;
  const size = Math.max(1, Math.floor(barsPerSection));
  const out: Section[] = [];
  for (let startBar = 0; startBar < bars.length; startBar += size) {
    const endBar = Math.min(bars.length, startBar + size);
    const first = bars[startBar];
    const last = bars[endBar - 1];
    if (!first || !last) break;
    out.push({ name: `Part ${out.length + 1}`, startBar, endBar, start: first.time, end: last.time + last.dur });
  }
  return out;
}
