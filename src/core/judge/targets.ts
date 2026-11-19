/**
 * Judge targets: onset groups enriched with what the judge needs (pitch sets, dead/legato flags,
 * section index), plus the pitch-match rule (±50 cents, octave tolerance DEC-18, dead notes, bends).
 * Pure.
 * @module
 */
import type { Song } from '@shared/song';
import { onsetGroups } from '../model/onset-groups';
import { PITCH_TOLERANCE_CENTS } from './constants';

/** One judge target (an onset group: a single note or a chord). */
export interface Target {
  /** Index in song order (onset-group index). */
  index: number;
  /** Song time of the group (earliest note). */
  time: number;
  noteIds: number[];
  /** Per note: MIDI pitches that note accepts (its pitch, plus up to the bend target for bends). */
  accepts: number[][];
  /** Per note MIDI (parallel to `noteIds`). */
  midis: number[];
  /** Lowest MIDI in the group (expected pitch shown for a chord Miss). */
  lowestMidi: number;
  chord: boolean;
  /** Some note is a dead note: any onset (pitched or not) matches. */
  anyPitch: boolean;
  /** Some note is a legato destination: a `pitch-change` event may satisfy the group. */
  legato: boolean;
  /** Index into `Song.sections`, or −1. */
  section: number;
}

/** How an event pitch matched a target. */
export interface PitchMatch {
  /** 0 = exact pitch or dead note, 1 = octave error (DEC-18). Lower is better. */
  rank: 0 | 1;
  /** The chord tone (or note) that matched; the dead note's MIDI for any-pitch matches. */
  expectedMidi: number;
}

/** Build the judge targets of a song (tied destinations are not targets). */
export function buildTargets(song: Pick<Song, 'notes' | 'sections'>): Target[] {
  return onsetGroups(song).map((g) => {
    const midis = g.notes.map((n) => n.midi);
    return {
      index: g.index,
      time: g.time,
      noteIds: g.notes.map((n) => n.id),
      accepts: g.notes.map((n) => acceptedPitches(n.midi, n.tech.bend?.semitones)),
      midis,
      lowestMidi: Math.min(...midis),
      chord: g.chord,
      anyPitch: g.notes.some((n) => n.tech.dead === true),
      legato: g.notes.some((n) => n.tech.legatoDest === true),
      section: sectionIndexAt(song.sections, g.time),
    };
  });
}

/** A bent note is heard anywhere from its fretted pitch up to the bend target. */
function acceptedPitches(midi: number, bendSemitones: number | undefined): number[] {
  const up = bendSemitones !== undefined && bendSemitones > 0 ? Math.round(bendSemitones) : 0;
  const out: number[] = [];
  for (let s = 0; s <= up; s++) out.push(midi + s);
  return out;
}

/** Section containing `time` (sections are sorted and cover `[start, end)`), or −1. */
export function sectionIndexAt(sections: Song['sections'], time: number): number {
  let lo = 0;
  let hi = sections.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const s = sections[mid];
    if (s === undefined) break;
    if (s.start <= time + 1e-9) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return -1;
  const s = sections[found];
  return s !== undefined && time < s.end - 1e-9 ? found : -1;
}

/**
 * Pitch match of an event against a target. `midi` + `cents` is the detected pitch; it matches a
 * note when within ±50 cents of an accepted pitch, or of that pitch ±12 unless `strictOctave`.
 * Dead notes match any pitch. Returns the best match or `null`.
 */
export function matchPitch(target: Target, midi: number, cents: number | undefined, strictOctave: boolean): PitchMatch | null {
  const exact = exactTone(target, midi, cents);
  if (exact !== null) return { rank: 0, expectedMidi: exact };
  if (target.anyPitch) return { rank: 0, expectedMidi: target.lowestMidi };
  if (strictOctave) return null;
  const up = exactTone(target, midi + 12, cents);
  if (up !== null) return { rank: 1, expectedMidi: up };
  const down = exactTone(target, midi - 12, cents);
  if (down !== null) return { rank: 1, expectedMidi: down };
  return null;
}

function exactTone(target: Target, midi: number, cents: number | undefined): number | null {
  const pitch = midi + (cents ?? 0) / 100;
  const tol = PITCH_TOLERANCE_CENTS / 100 + 1e-9;
  for (let i = 0; i < target.accepts.length; i++) {
    for (const p of target.accepts[i] ?? []) {
      if (Math.abs(pitch - p) <= tol) return target.midis[i] ?? p;
    }
  }
  return null;
}
