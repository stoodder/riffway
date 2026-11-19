/**
 * Section preparation for difficulty analysis: merging short sections and the effective tempo.
 * @module
 */
import type { Song, TempoChange } from '@shared/song';
import { DEFAULT_BPM, MERGE_SECTION_SEC } from './constants';

/** A (possibly merged) section as analysed. */
export interface RatedSpan {
  /** Index of the first merged `Song.sections` entry (0 for the whole-song fallback). */
  sectionIndex: number;
  name: string;
  start: number;
  end: number;
}

/** Name used when a song has no sections and is rated as one span. */
export const WHOLE_SONG_NAME = 'Whole song';

/**
 * Song sections with every section shorter than `MERGE_SECTION_SEC` merged into the next one (the
 * last one, if short, into the previous). Names of merged sections are joined with " + ". A song
 * without sections is one span from 0 to its end.
 */
export function mergeSections(song: Song): RatedSpan[] {
  if (song.sections.length === 0) {
    return [{ sectionIndex: 0, name: WHOLE_SONG_NAME, start: 0, end: songEnd(song) }];
  }
  const out: RatedSpan[] = [];
  let pending: RatedSpan | null = null;
  for (let i = 0; i < song.sections.length; i++) {
    const s = song.sections[i]!;
    const span: RatedSpan = pending
      ? { sectionIndex: pending.sectionIndex, name: `${pending.name} + ${s.name}`, start: pending.start, end: s.end }
      : { sectionIndex: i, name: s.name, start: s.start, end: s.end };
    pending = null;
    if (span.end - span.start < MERGE_SECTION_SEC && i < song.sections.length - 1) pending = span;
    else out.push(span);
  }
  const last = out[out.length - 1]!;
  if (out.length > 1 && last.end - last.start < MERGE_SECTION_SEC) {
    const prev = out[out.length - 2]!;
    out.splice(out.length - 2, 2, { ...prev, name: `${prev.name} + ${last.name}`, end: last.end });
  }
  return out;
}

/**
 * Duration-weighted mean BPM of the tempo map over `[start, end)`. Before the first change the first
 * tempo applies; with an empty map `DEFAULT_BPM`; for an empty interval the tempo at `start`.
 */
export function effectiveBpm(tempos: readonly TempoChange[], start: number, end: number): number {
  if (tempos.length === 0) return DEFAULT_BPM;
  if (end <= start) return bpmAt(tempos, start);
  let sum = 0;
  for (let i = 0; i < tempos.length; i++) {
    const from = i === 0 ? -Infinity : tempos[i]!.time;
    const to = i + 1 < tempos.length ? tempos[i + 1]!.time : Infinity;
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap > 0) sum += overlap * tempos[i]!.bpm;
  }
  return sum / (end - start);
}

function bpmAt(tempos: readonly TempoChange[], time: number): number {
  let bpm = tempos[0]!.bpm;
  for (const t of tempos) {
    if (t.time > time) break;
    bpm = t.bpm;
  }
  return bpm;
}

/** End of the song: the latest of `meta.durationSec`, the last bar's end and the last note's end. */
function songEnd(song: Song): number {
  let end = song.meta.durationSec;
  const bars = song.timing.bars;
  if (bars.length > 0) end = Math.max(end, bars[bars.length - 1]!.time + bars[bars.length - 1]!.dur);
  for (const note of song.notes) end = Math.max(end, note.time + note.dur);
  return end;
}
