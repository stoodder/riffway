/**
 * Hand-position segmentation and shift cues (T-013), per docs/game-mechanics.md § Hand-position cue:
 * window `[lo, lo+3]` (5 frets when `lo ≥ 7`), open strings never force a shift, cue when |Δlo| ≥ 2,
 * shown ≥ 1.5 beats and ≥ 0.75 s before the first note of the new position (`cueShowAt` keeps the
 * 0.75 s in real seconds at any speed). Signature frozen by T-010.
 *
 * Pure and allocation-light: one pass over the onset groups, with an amortised O(n) look-ahead
 * (a look-ahead run is never re-scanned, because every group in it fits the window it produces).
 * @module
 */
import type { HandPosition, HandPositionAnalysis, Note, PositionCue, Song } from '@shared/song';
import { onsetGroups } from '../model/onset-groups';

/** From this `lo` upwards a position spans 5 frets (`hi = lo + 4`); below it 4 frets (`hi = lo + 3`). */
export const WIDE_WINDOW_FROM_FRET = 7;
/** Cue threshold: a shift needs |Δlo| ≥ this to get a highway cue. */
export const CUE_MIN_SHIFT = 2;
/** Minimum cue lead in beats (the bar grid's metronome beat at the cue target). */
export const CUE_LEAD_BEATS = 1.5;
/** Minimum cue lead in seconds at 100% speed. */
export const CUE_LEAD_MIN_SEC = 0.75;
/** Beat length used when a song has neither a bar grid nor a tempo map (120 BPM). */
const FALLBACK_BEAT_SEC = 0.5;

/** Highest fret of the position window starting at `lo`. */
export function positionHi(lo: number): number {
  return lo + (lo >= WIDE_WINDOW_FROM_FRET ? 4 : 3);
}

/** True when a note needs the fretting hand in a position (fretted and not a dead note). */
export function isFretted(note: Note): boolean {
  return note.fret > 0 && note.tech.dead !== true;
}

/** Positions and cues for a song (feeds the highway, T-024, and difficulty shifts). */
export function computePositions(song: Song): HandPositionAnalysis {
  const groups = onsetGroups(song);
  const n = groups.length;
  // Fretted range per group; NaN marks a group of open strings / dead notes only.
  const fmin = new Float64Array(n);
  const fmax = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const note of groups[i]!.notes) {
      if (!isFretted(note)) continue;
      if (note.fret < lo) lo = note.fret;
      if (note.fret > hi) hi = note.fret;
    }
    fmin[i] = lo === Infinity ? NaN : lo;
    fmax[i] = hi === -Infinity ? NaN : hi;
  }

  /** `lo` of the longest run of fretted groups from `i` that fits one window (group `i` always counts). */
  const runLo = (i: number): number => {
    let mn = fmin[i]!;
    let mx = fmax[i]!;
    for (let j = i + 1; j < n; j++) {
      if (Number.isNaN(fmin[j]!)) continue;
      const a = Math.min(mn, fmin[j]!);
      const b = Math.max(mx, fmax[j]!);
      if (b > positionHi(a)) break;
      mn = a;
      mx = b;
    }
    return mn;
  };

  const positions: HandPosition[] = [];
  let current: HandPosition | null = null;
  for (let i = 0; i < n; i++) {
    const group = groups[i]!;
    const lastId = maxNoteId(group.notes);
    const open = Number.isNaN(fmin[i]!);
    if (open || (current !== null && fmin[i]! >= current.lo && fmax[i]! <= current.hi)) {
      // Open strings never move the hand; fretted notes inside the window stay in the position.
      if (current !== null) current.lastNoteId = Math.max(current.lastNoteId, lastId);
      continue;
    }
    const lo = runLo(i);
    if (current !== null && lo === current.lo) {
      // A chord stretching past the window re-triggers the same position: not a shift.
      current.lastNoteId = Math.max(current.lastNoteId, lastId);
      continue;
    }
    if (current !== null) current.end = group.time;
    current = { lo, hi: positionHi(lo), start: group.time, end: group.time, firstNoteId: minNoteId(group.notes), lastNoteId: lastId };
    positions.push(current);
  }
  if (current !== null) current.end = Math.max(current.end, songEnd(song));

  const cues: PositionCue[] = [];
  for (let k = 1; k < positions.length; k++) {
    const from = positions[k - 1]!;
    const to = positions[k]!;
    if (Math.abs(to.lo - from.lo) < CUE_MIN_SHIFT) continue;
    const lead = Math.max(CUE_LEAD_BEATS * beatLengthAt(song, to.start), CUE_LEAD_MIN_SEC);
    cues.push({ showAt: to.start - lead, time: to.start, fromLo: from.lo, lo: to.lo, hi: to.hi });
  }
  return { positions, cues };
}

/**
 * When to show `cue` at playback speed `speed` (song s): its `showAt`, moved earlier when needed so
 * the cue is on screen at least {@link CUE_LEAD_MIN_SEC} **real** seconds before its note
 * (`time − 0.75 × speed`; only above 100% speed does this move it). The beat lead scales with speed
 * by itself.
 */
export function cueShowAt(cue: Pick<PositionCue, 'showAt' | 'time'>, speed: number): number {
  return Math.min(cue.showAt, cue.time - CUE_LEAD_MIN_SEC * speed);
}

/**
 * Metronome beat length (s) at `time`: the containing bar's `dur / beats.length`, else `60 / bpm`
 * from the tempo map, else 0.5 s.
 */
export function beatLengthAt(song: Pick<Song, 'timing'>, time: number): number {
  const { bars, tempos } = song.timing;
  if (bars.length > 0) {
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid]!.time <= time) lo = mid;
      else hi = mid - 1;
    }
    const bar = bars[lo]!;
    const beats = bar.beats.length > 0 ? bar.beats.length : bar.num;
    if (bar.dur > 0 && beats > 0) return bar.dur / beats;
  }
  let bpm = 0;
  for (const t of tempos) {
    if (t.time > time && bpm > 0) break;
    bpm = t.bpm;
  }
  return bpm > 0 ? 60 / bpm : FALLBACK_BEAT_SEC;
}

/** Latest sounding end of any note (s). */
function songEnd(song: Song): number {
  let end = 0;
  for (const note of song.notes) end = Math.max(end, note.time + note.dur);
  return end;
}

function minNoteId(notes: readonly Note[]): number {
  let id = Infinity;
  for (const note of notes) id = Math.min(id, note.id);
  return id;
}

function maxNoteId(notes: readonly Note[]): number {
  let id = -Infinity;
  for (const note of notes) id = Math.max(id, note.id);
  return id;
}
