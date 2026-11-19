/**
 * The judge (T-014): every step of the algorithm in docs/game-mechanics.md (onset groups,
 * candidates, pitch match ±50 cents with octave tolerance, greedy assignment, provisional upgrade,
 * legato, retrigger guard, strays, misses) plus scoring. Pure and deterministic.
 * Signatures frozen by T-010; constants in `./constants.ts`.
 * @module
 */
import type { CreateJudge, Judge, JudgeConfig, Stars } from '@shared/judge';
import type { Song } from '@shared/song';
import { notImplemented } from '@shared/errors';

/** Create a judge for one song/arrangement. */
export const createJudge: CreateJudge = (song: Song, config: JudgeConfig): Judge => {
  return notImplemented('createJudge', 'T-014');
};

/** Combo → multiplier (0–9 ×1, 10–19 ×2, 20–29 ×3, 30+ ×4). */
export function multiplierFor(combo: number): 1 | 2 | 3 | 4 {
  return notImplemented('multiplierFor', 'T-014');
}

/** Accuracy % → stars (≥ 50/70/80/90/97). */
export function starsFor(accuracy: number): Stars {
  return notImplemented('starsFor', 'T-014');
}
