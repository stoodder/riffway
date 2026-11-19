/**
 * Pure progress logic (T-020): section mastery, weekly streaks with freezes, comfort tier and
 * recommendations (docs/progress.md). Node-testable; persistence lives in `src/storage/`.
 * Signatures frozen by T-010.
 * @module
 */
import type { PracticeDay, Recommendation, RunRecord, SectionProgress, SessionGoal, StreakState } from '@shared/storage';
import type { SearchResult } from '@shared/sources';
import type { Tier } from '@shared/song';
import { notImplemented } from '@shared/errors';

/** A practice day needs at least this much active play (s). */
export const PRACTICE_DAY_SEC = 300;

/** Run facts needed to update one section's progress. */
export interface SectionRunInput {
  songId: string;
  arrangement: number;
  sectionIdx: number;
  /** Section accuracy %. */
  accuracy: number;
  clean: boolean;
  /** Speed fraction. */
  speed: number;
  at: number;
  /** Identifies the practice session (mastery needs 2 clean runs at 100% in one session). */
  sessionId: string;
  /** Section tier and the player's comfort tier (trainer start). */
  sectionTier: number;
  comfortTier: number;
}

/** Apply a run to a section's progress (trainer, mastery, next-day check, plateau counter). */
export function applySectionRun(prev: SectionProgress | null, run: SectionRunInput): SectionProgress {
  return notImplemented('applySectionRun', 'T-020');
}

/** Lazily evaluate the weekly streak up to `now` (freeze earn/apply, grace repair). */
export function evaluateStreak(prev: StreakState | null, days: readonly PracticeDay[], now: number, weekTarget: number): StreakState {
  return notImplemented('evaluateStreak', 'T-020');
}

/** Highest tier with ≥ 85% accuracy at 100% on ≥ 2 distinct songs (default 2). */
export function comfortTier(runs: readonly RunRecord[], tierOfSong: (songId: string) => Tier | null): Tier {
  return notImplemented('comfortTier', 'T-020');
}

/** Inputs for {@link recommend} and {@link sessionGoals}. */
export interface RecommendInput {
  candidates: readonly SearchResult[];
  comfortTier: Tier;
  recentRuns: readonly RunRecord[];
  dueChecks: readonly SectionProgress[];
  preferences: { style: 'pick' | 'fingerstyle'; fingerstyle: boolean; genres: readonly string[] };
  now: number;
}

/** 10 slots: 6 stretch, 3 comfort/review, 1 reach. Deterministic for equal input. */
export function recommend(input: RecommendInput): Recommendation[] {
  return notImplemented('recommend', 'T-020');
}

/** Up to 3 process goals (next-day checks, weakest section, new stretch song). */
export function sessionGoals(input: RecommendInput): SessionGoal[] {
  return notImplemented('sessionGoals', 'T-020');
}

/** Local calendar day `'YYYY-MM-DD'` for an epoch-ms timestamp. */
export function localDate(at: number): string {
  return notImplemented('localDate', 'T-020');
}

/** Speed fraction → bucket (rounded to 5%, integer percent; 100 = full speed). */
export function speedBucket(speed: number): number {
  return notImplemented('speedBucket', 'T-020');
}
