/**
 * The pass-aware clock mapping the judge prefers (docs/game-mechanics.md § Driving the judge,
 * docs/timing.md § Passes). The engine's `SongClock` implements it; a plain `SongClockMapping`
 * (e.g. a test clock) still works for single-pass use.
 * @module
 */
import type { SongClockMapping } from '@shared/clock';

/**
 * A {@link SongClockMapping} that can also answer "when is song time `t` played **in pass `p`**",
 * which a loop needs: right after a short loop wraps, the nearest occurrence of a note can be the
 * previous pass's.
 */
export interface PassClockMapping extends SongClockMapping {
  /**
   * Context time at which `songTime` is played in pass `pass` (the transport's `ClockChange.pass`):
   * finite when that pass played it or will play it as scheduled now; `-Infinity` when that pass
   * never plays it (the pass is over, or it lies before the pass's start or in a count-in); `NaN`
   * while not known (the pass is paused or stopped before it, or has not started).
   */
  ctxTimeInPass(songTime: number, pass: number): number;
}
