/**
 * Peak/RMS level meter (docs/audio-input.md § Level meter). Accumulates blocks until `read()`.
 * Allocation-free: `read()` returns the same object each time.
 * @module
 */
import type { LevelMeter } from './index';

/** Level reported for silence (and for an empty interval), dBFS. Finite so UIs can do arithmetic. */
export const SILENCE_DB = -120;

/** Linear amplitude → dBFS, clamped to {@link SILENCE_DB}. */
export function ampToDb(amp: number): number {
  return amp > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(amp)) : SILENCE_DB;
}

/** Create a level meter. `read()` reuses its result object; copy the numbers if you keep them. */
export function createLevelMeter(): LevelMeter {
  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  const reading = { peakDb: SILENCE_DB, rmsDb: SILENCE_DB };
  return {
    process(block: Float32Array): void {
      for (let i = 0; i < block.length; i++) {
        const v = block[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sumSquares += v * v;
      }
      count += block.length;
    },
    read(): { peakDb: number; rmsDb: number } {
      reading.peakDb = ampToDb(peak);
      reading.rmsDb = count > 0 ? ampToDb(Math.sqrt(sumSquares / count)) : SILENCE_DB;
      peak = 0;
      sumSquares = 0;
      count = 0;
      return reading;
    },
  };
}
