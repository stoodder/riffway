/**
 * Song-model invariant checks (docs/song-formats.md § Internal model). Every importer's output is
 * expected to pass {@link validateSong}; the import golden tests assert it.
 * @module
 */
import type { Song } from '@shared/song';
import { GROUP_WINDOW_SEC } from './onset-groups';

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

/** Tolerance for comparing times computed along different float paths (seconds). */
const EPS = 1e-6;

/**
 * Check the model invariants (docs/song-formats.md). Empty array = valid.
 *
 * - `id-order`: `notes[i].id === i`.
 * - `time-order`: notes sorted by time, then string; times and durations finite and ≥ 0.
 * - `midi-invariant`: `midi = tuning[string-1] + capo + fret` except harmonics; string within the tuning.
 * - `string-collision`: no two non-tied notes on one string at one time.
 * - `bar-gap`: bars indexed in order, start at 0 s, contiguous, positive duration, beats inside the bar.
 * - `section-bars`: sections cover whole, existing bars, in order without overlap; start/end match the bars.
 * - `note-bar`: `note.bar` exists and contains the note's onset.
 * - `chord-ref`: chord ids unique; chord ↔ note references agree; chord notes start together.
 * - `tie-ref`: `tiedFrom` names an earlier note on the same string.
 */
export function validateSong(song: Song): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateBars(song, issues);
  validateSections(song, issues);
  validateNotes(song, issues);
  validateChords(song, issues);
  return issues;
}

function validateBars(song: Song, issues: ValidationIssue[]): void {
  const { bars } = song.timing;
  let expected = 0;
  bars.forEach((bar, i) => {
    if (bar.index !== i) issues.push({ code: 'bar-gap', bar: i, message: `bar ${i} has index ${bar.index}` });
    if (Math.abs(bar.time - expected) > EPS) {
      issues.push({ code: 'bar-gap', bar: i, message: `bar ${i} starts at ${bar.time}s, expected ${expected}s` });
    }
    if (!(bar.dur > 0)) issues.push({ code: 'bar-gap', bar: i, message: `bar ${i} has non-positive duration ${bar.dur}` });
    const end = bar.time + bar.dur;
    if (bar.beats.length === 0 || Math.abs((bar.beats[0] ?? NaN) - bar.time) > EPS) {
      issues.push({ code: 'bar-gap', bar: i, message: `bar ${i} beats must start on the downbeat` });
    }
    for (let b = 1; b < bar.beats.length; b++) {
      const t = bar.beats[b] ?? NaN;
      if (!(t > (bar.beats[b - 1] ?? NaN)) || t >= end - EPS) {
        issues.push({ code: 'bar-gap', bar: i, message: `bar ${i} beat ${b} at ${t}s is out of order or outside the bar` });
      }
    }
    expected = end;
  });
}

function validateSections(song: Song, issues: ValidationIssue[]): void {
  const { bars } = song.timing;
  let prevEnd = 0;
  song.sections.forEach((s, i) => {
    const first = bars[s.startBar];
    const last = bars[s.endBar - 1];
    if (!Number.isInteger(s.startBar) || !Number.isInteger(s.endBar) || s.startBar >= s.endBar || !first || !last) {
      issues.push({ code: 'section-bars', message: `section ${i} "${s.name}" has invalid bars [${s.startBar}, ${s.endBar})` });
      return;
    }
    if (s.startBar < prevEnd) {
      issues.push({ code: 'section-bars', bar: s.startBar, message: `section ${i} "${s.name}" overlaps the previous section` });
    }
    if (Math.abs(s.start - first.time) > EPS || Math.abs(s.end - (last.time + last.dur)) > EPS) {
      issues.push({ code: 'section-bars', bar: s.startBar, message: `section ${i} "${s.name}" start/end do not match its bars` });
    }
    prevEnd = s.endBar;
  });
}

function validateNotes(song: Song, issues: ValidationIssue[]): void {
  const { notes } = song;
  const { tuning, capo } = song.meta;
  const { bars } = song.timing;
  // Strings used by non-tied notes at the current onset time (notes are sorted by time).
  let runTime = Number.NEGATIVE_INFINITY;
  const runStrings = new Set<number>();

  notes.forEach((n, i) => {
    if (n.id !== i) issues.push({ code: 'id-order', noteId: n.id, message: `note at index ${i} has id ${n.id}` });

    const prev = i > 0 ? notes[i - 1] : undefined;
    if (!Number.isFinite(n.time) || n.time < 0 || !Number.isFinite(n.dur) || n.dur < 0) {
      issues.push({ code: 'time-order', noteId: n.id, message: `note ${n.id} has invalid time ${n.time}s / dur ${n.dur}s` });
    } else if (prev && (n.time < prev.time - EPS || (Math.abs(n.time - prev.time) <= EPS && n.string < prev.string))) {
      issues.push({ code: 'time-order', noteId: n.id, message: `note ${n.id} is not sorted by time, then string` });
    }

    const open = tuning[n.string - 1];
    if (open === undefined) {
      issues.push({ code: 'midi-invariant', noteId: n.id, message: `note ${n.id} is on string ${n.string} of a ${tuning.length}-string tuning` });
    } else if (n.tech.harmonic === undefined && n.midi !== open + capo + n.fret) {
      issues.push({
        code: 'midi-invariant',
        noteId: n.id,
        message: `note ${n.id}: midi ${n.midi} ≠ ${open} + capo ${capo} + fret ${n.fret}`,
      });
    }

    if (Math.abs(n.time - runTime) > EPS) {
      runTime = n.time;
      runStrings.clear();
    }
    if (n.tiedFrom === undefined) {
      if (runStrings.has(n.string)) {
        issues.push({ code: 'string-collision', noteId: n.id, message: `two notes on string ${n.string} at ${n.time}s` });
      }
      runStrings.add(n.string);
    }

    const bar = bars[n.bar];
    if (!bar || n.time < bar.time - EPS || n.time >= bar.time + bar.dur + EPS) {
      issues.push({ code: 'note-bar', noteId: n.id, bar: n.bar, message: `note ${n.id} at ${n.time}s is not inside bar ${n.bar}` });
    }

    if (n.tiedFrom !== undefined) {
      const origin = notes[n.tiedFrom];
      if (!origin || n.tiedFrom >= n.id || origin.string !== n.string || origin.time > n.time + EPS) {
        issues.push({ code: 'tie-ref', noteId: n.id, message: `note ${n.id} is tied from ${n.tiedFrom}, which is not an earlier note on its string` });
      }
    }
  });
}

function validateChords(song: Song, issues: ValidationIssue[]): void {
  const { notes } = song;
  const seen = new Map<number, Set<number>>();
  for (const chord of song.chords) {
    if (seen.has(chord.id)) {
      issues.push({ code: 'chord-ref', message: `duplicate chord id ${chord.id}` });
      continue;
    }
    seen.set(chord.id, new Set(chord.noteIds));
    for (const id of chord.noteIds) {
      const n = notes[id];
      if (!n || n.chordId !== chord.id) {
        issues.push({ code: 'chord-ref', noteId: id, message: `chord ${chord.id} lists note ${id}, which does not point back to it` });
      } else if (Math.abs(n.time - chord.time) > GROUP_WINDOW_SEC) {
        issues.push({ code: 'chord-ref', noteId: id, message: `note ${id} starts ${n.time}s, away from chord ${chord.id} at ${chord.time}s` });
      }
    }
  }
  for (const n of notes) {
    if (n.chordId !== undefined && !seen.get(n.chordId)?.has(n.id)) {
      issues.push({ code: 'chord-ref', noteId: n.id, message: `note ${n.id} names chord ${n.chordId}, which does not list it` });
    }
  }
}
