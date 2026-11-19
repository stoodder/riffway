/**
 * The judge (T-014): every step of the algorithm in docs/game-mechanics.md (onset groups,
 * candidates, pitch match ±50 cents with octave tolerance, greedy assignment, provisional upgrade,
 * legato, retrigger guard, strays, misses) plus scoring. Pure and deterministic.
 * Signatures frozen by T-010; constants in `./constants.ts`.
 * @module
 */
import type { CreateJudge, Judge, JudgeConfig } from '@shared/judge';
import type { Song } from '@shared/song';
import { JudgeImpl } from './judge';

export { multiplierFor, starsFor, gradeFor, timingLabelFor, passStats, isHit, type PassStats } from './scoring';
export { analysisToInputEvent, frameToEventCtx, inputHorizon, keyboardEventCtx } from './input';

/**
 * Create a judge for one song/arrangement.
 *
 * Driving it (docs/game-mechanics.md § Driving the judge):
 * - `push()` every calibrated input event (see `analysisToInputEvent` / `keyboardEventCtx`).
 * - `advance(inputHorizon(...))` every frame: closes windows (Miss / final WrongNote) only once all
 *   input that could land in them has arrived. Do not call it while paused unless the clock maps to
 *   non-finite times then.
 * - `startPass()` synchronously in the transport's `loop-wrap` handler, after the clock has switched
 *   to the new pass; open groups of the previous pass keep their target and finish normally.
 * - `finish()` at song end / quit for the `RunSummary`.
 */
export const createJudge: CreateJudge = (song: Song, config: JudgeConfig): Judge => new JudgeImpl(song, config);
