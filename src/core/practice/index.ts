/**
 * Practice logic (T-014): speed trainer state machine (D8) and loop math (snap to sections then bars,
 * min 1 bar, pre-roll 1 bar / 2 bars below 60%). Pure. Signatures frozen by T-010.
 * @module
 */
import type { TransportLoop } from '@shared/clock';
import type { BarLoop, TrainerState, TrainerStep } from '@shared/judge';
import type { Song } from '@shared/song';
import { notImplemented } from '@shared/errors';

/** Speed-trainer parameters (fractions). */
export const TRAINER = {
  start: 0.7,
  /** Start for sections ≥ 2 tiers above comfort. */
  hardStart: 0.6,
  floor: 0.4,
  cap: 1.0,
  step: 0.05,
  /** Clean-run accuracy %. */
  cleanAccuracy: 90,
  /** Failed-run accuracy % (below). */
  failAccuracy: 70,
  /** Failed runs in a row before stepping down. */
  failsToStepDown: 2,
  /** Restart speed after failing a next-day check. */
  recheckStart: 0.85,
} as const;

/** Initial trainer state for a section given its tier and the player's comfort tier. */
export function initialTrainerState(sectionTier: number, comfortTier: number): TrainerState {
  return notImplemented('initialTrainerState', 'T-014');
}

/** Advance the trainer after a run with `accuracy` % (`clean` per the clean-run rule). */
export function trainerStep(state: TrainerState, accuracy: number, clean: boolean): TrainerStep {
  return notImplemented('trainerStep', 'T-014');
}

/** Snap a time range to section markers, then bar lines (minimum 1 bar). */
export function snapLoop(song: Song, startTime: number, endTime: number): BarLoop {
  return notImplemented('snapLoop', 'T-014');
}

/** Pre-roll bars for a speed (1, or 2 below 60%). */
export function prerollBars(speed: number): number {
  return notImplemented('prerollBars', 'T-014');
}

/** Bar loop → transport loop in song seconds, with pre-roll for `speed`. */
export function toTransportLoop(song: Song, loop: BarLoop, speed: number): TransportLoop {
  return notImplemented('toTransportLoop', 'T-014');
}
