/**
 * Tuner smoother (docs/audio-input.md § Tuner): median of the last 5 confident pitch frames, a held
 * value when the signal is unclear, and an "in tune" flag after 0.5 s within ±3 cents.
 * Allocation-free: `push()` returns the same object each time.
 * @module
 */
import type { PitchEstimate, TunerReading, TunerSmoother } from './index';
import { freqToMidiFloat } from './pitch';

/** Frames at or above this clarity enter the median. */
export const TUNER_VALID_CLARITY = 0.9;
/** Below this clarity the display holds its last value (`live: false`). */
export const TUNER_HOLD_CLARITY = 0.8;
/** Median window, frames. */
const MEDIAN_FRAMES = 5;
/** |cents| at or below this counts as in tune… */
const IN_TUNE_CENTS = 3;
/** …once held this long, seconds. */
const IN_TUNE_SEC = 0.5;
/** A gap this long without confident frames starts a fresh median (new string or new pluck). */
const STALE_SEC = 0.3;

/**
 * Create a tuner smoother. Push every tuner pitch frame (or `null` for none) with its time in
 * seconds; the result is `null` until the first confident frame. Frames with clarity in
 * [0.8, 0.9) keep the display live without entering the median.
 */
export function createTunerSmoother(opts?: { a4?: number }): TunerSmoother {
  return new MedianTunerSmoother(opts?.a4 ?? 440);
}

class MedianTunerSmoother implements TunerSmoother {
  private readonly ring = new Float64Array(MEDIAN_FRAMES);
  private readonly sorted = new Float64Array(MEDIAN_FRAMES);
  private ringPos = 0;
  private ringCount = 0;
  private lastValidTime = -Infinity;
  private inTuneSince = NaN;
  private readonly reading: TunerReading = { freq: 0, midi: 0, cents: 0, inTune: false, live: false };
  private hasReading = false;

  constructor(private readonly a4: number) {
    if (!(a4 > 0)) throw new RangeError(`A4 must be > 0, got ${a4}`);
  }

  push(estimate: PitchEstimate | null, timeSec: number): TunerReading | null {
    const clarity = estimate && estimate.freq > 0 ? estimate.clarity : 0;
    const out = this.reading;
    if (clarity < TUNER_HOLD_CLARITY) {
      out.live = false;
      out.inTune = false;
      this.inTuneSince = NaN;
      return this.hasReading ? out : null;
    }
    if (clarity >= TUNER_VALID_CLARITY && estimate) {
      if (timeSec - this.lastValidTime > STALE_SEC) this.ringCount = 0;
      this.lastValidTime = timeSec;
      this.ring[this.ringPos] = estimate.freq;
      this.ringPos = (this.ringPos + 1) % MEDIAN_FRAMES;
      if (this.ringCount < MEDIAN_FRAMES) this.ringCount++;
      const freq = this.median();
      const pitch = freqToMidiFloat(freq, this.a4);
      out.freq = freq;
      out.midi = Math.round(pitch);
      out.cents = (pitch - out.midi) * 100;
      this.hasReading = true;
    }
    if (!this.hasReading) return null;
    out.live = true;
    if (Math.abs(out.cents) <= IN_TUNE_CENTS) {
      if (Number.isNaN(this.inTuneSince)) this.inTuneSince = timeSec;
      out.inTune = timeSec - this.inTuneSince >= IN_TUNE_SEC;
    } else {
      this.inTuneSince = NaN;
      out.inTune = false;
    }
    return out;
  }

  reset(): void {
    this.ringPos = 0;
    this.ringCount = 0;
    this.lastValidTime = -Infinity;
    this.inTuneSince = NaN;
    this.hasReading = false;
    const out = this.reading;
    out.freq = 0;
    out.midi = 0;
    out.cents = 0;
    out.inTune = false;
    out.live = false;
  }

  /** Median of the frequencies in the ring (insertion sort into scratch; ≤ 5 values). */
  private median(): number {
    const n = this.ringCount;
    const s = this.sorted;
    // The ring is filled from ringPos backwards in time; order does not matter for the median.
    for (let i = 0; i < n; i++) {
      const v = this.ring[(this.ringPos - 1 - i + MEDIAN_FRAMES) % MEDIAN_FRAMES];
      let j = i;
      while (j > 0 && s[j - 1] > v) {
        s[j] = s[j - 1];
        j--;
      }
      s[j] = v;
    }
    return n & 1 ? s[n >> 1] : 0.5 * (s[(n >> 1) - 1] + s[n >> 1]);
  }
}
