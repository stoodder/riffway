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
export type { PassClockMapping } from './pass-clock';

/**
 * Create a judge for one run (one song/arrangement, from one fresh `play()` to its end or quit).
 *
 * Driving it (docs/game-mechanics.md § Driving the judge):
 * - `config.clock`: the engine's `SongClock` (a {@link PassClockMapping}), so each loop pass, pause
 *   and seek maps exactly. Create the judge right before the run's `play()`.
 * - `push()` every calibrated input event (see `analysisToInputEvent` / `keyboardEventCtx`).
 * - `advance(inputHorizon(...))` every frame (also while paused): closes windows (Miss / final
 *   WrongNote) only once all input that could land in them has arrived.
 * - `startPass({pass: change.pass})` whenever a transport `ClockChange` carries a pass the judge is
 *   not on (`loop-wrap`, `seek`, `play({from})`); the previous pass still finishes its own notes.
 * - `finish()` at song end / quit for the `RunSummary`.
 */
export const createJudge: CreateJudge = (song: Song, config: JudgeConfig): Judge => new JudgeImpl(song, config);
