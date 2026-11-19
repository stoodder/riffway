/**
 * Difficulty analysis (T-013) exactly per docs/difficulty.md. Pure; runs on the server indexer and
 * in the browser. Constants in `./constants.ts` (calibrated by T-029). Signatures frozen by T-010.
 * @module
 */
import type { DifficultyReport, HandPositionAnalysis, Song, Tier, TierName } from '@shared/song';
import { notImplemented } from '@shared/errors';

/** Analyse a song at 100% speed. Pass `positions` to reuse a `computePositions` result. */
export function analyzeDifficulty(song: Song, opts: { positions?: HandPositionAnalysis } = {}): DifficultyReport {
  return notImplemented('analyzeDifficulty', 'T-013');
}

/** `clamp(round(rating), 1, 10)`. */
export function tierOf(rating: number): Tier {
  return notImplemented('tierOf', 'T-013');
}

/** Band name for a tier (1–2 Beginner … 9–10 Expert). */
export function tierName(tier: Tier): TierName {
  return notImplemented('tierName', 'T-013');
}
