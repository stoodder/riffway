/**
 * Hand-position segmentation and shift cues (T-013), per docs/game-mechanics.md § Hand-position cue:
 * window `[lo, lo+3]` (5 frets when `lo ≥ 7`), open strings never force a shift, cue when |Δlo| ≥ 2,
 * shown ≥ 1.5 beats and ≥ 0.75 s before the first note of the new position. Signature frozen by T-010.
 * @module
 */
import type { HandPositionAnalysis, Song } from '@shared/song';
import { notImplemented } from '@shared/errors';

/** Positions and cues for a song (feeds the highway, T-024, and difficulty shifts). */
export function computePositions(song: Song): HandPositionAnalysis {
  return notImplemented('computePositions', 'T-013');
}
