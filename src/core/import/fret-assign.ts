/**
 * Fret assignment for MusicXML without tab data (T-011): dynamic programming over candidate
 * (string, fret) positions minimising hand-position shifts and span (window rule from
 * docs/game-mechanics.md), frets ≤ 15 preferred, open strings allowed. Signature frozen by T-010.
 * @module
 */
import type { StringNumber } from '@shared/song';
import { notImplemented } from '@shared/errors';

/** A pitched event to place on the fretboard. */
export interface FretAssignInput {
  time: number;
  midi: number;
  /** Notes sharing a chord id must land on distinct strings. */
  chordId?: number;
}

/** Assigned position, same order as the input. */
export interface FretPosition {
  string: StringNumber;
  fret: number;
}

/** Assign strings/frets for `notes` given a tuning (high → low) and capo. */
export function assignFrets(notes: readonly FretAssignInput[], tuning: readonly number[], capo = 0): FretPosition[] {
  return notImplemented('assignFrets', 'T-011');
}
