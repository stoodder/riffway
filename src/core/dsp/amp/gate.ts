/**
 * Noise gate for the amp input (before the drive, where hiss and hum are quietest relative to the
 * playing). Peak envelope detector with hysteresis and hold; the gain opens quickly (no look-ahead,
 * so no added latency) and closes with a smooth release. Closed = silence (gain flushed to 0).
 * @module
 */
import { DENORMAL_FLOOR } from './filters';

/** Gate timing and hysteresis. */
export const GATE_TIMING = {
  /** Envelope release (s): how fast the detector forgets a peak. */
  detectorReleaseSec: 0.015,
  /** Gain attack (s) once the gate opens. */
  attackSec: 0.0005,
  /** Stay open this long after the level falls below the close threshold (s). */
  holdSec: 0.05,
  /** Gain release (s, time constant) when closing. */
  releaseSec: 0.06,
  /** The gate closes this many dB below its open threshold. */
  hysteresisDb: 6,
} as const;

/** Gain below this is treated as fully closed (−80 dB). */
const CLOSED_GAIN = 1e-4;

/** A noise gate; `thresholdDb === null` disables it (unity gain). */
export class NoiseGate {
  private readonly envRelease: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly holdSamples: number;
  private openThr = 0;
  private closeThr = 0;
  private enabled = false;
  private env = 0;
  private gain = 1;
  private open = true;
  private hold = 0;

  constructor(sampleRate: number) {
    this.envRelease = Math.exp(-1 / (GATE_TIMING.detectorReleaseSec * sampleRate));
    this.attack = 1 - Math.exp(-1 / (GATE_TIMING.attackSec * sampleRate));
    this.release = Math.exp(-1 / (GATE_TIMING.releaseSec * sampleRate));
    this.holdSamples = Math.round(GATE_TIMING.holdSec * sampleRate);
  }

  /** Set the open threshold (dBFS of the input peak envelope), or `null` to bypass the gate. */
  setThreshold(thresholdDb: number | null): void {
    this.enabled = thresholdDb !== null;
    if (thresholdDb === null) {
      this.open = true;
      this.gain = 1;
      return;
    }
    this.openThr = 10 ** (thresholdDb / 20);
    this.closeThr = 10 ** ((thresholdDb - GATE_TIMING.hysteresisDb) / 20);
  }

  /** True while the gate is open (or disabled). */
  get isOpen(): boolean {
    return this.open;
  }

  /** Current gain (0–1). */
  get currentGain(): number {
    return this.gain;
  }

  /** Gate one sample. */
  tick(x: number): number {
    if (!this.enabled) return x;
    const a = x < 0 ? -x : x;
    this.env = a > this.env ? a : this.env * this.envRelease;
    if (this.env < DENORMAL_FLOOR) this.env = 0;
    if (this.env >= this.openThr) {
      this.open = true;
      this.hold = this.holdSamples;
    } else if (this.open && this.env < this.closeThr) {
      if (this.hold > 0) this.hold--;
      else this.open = false;
    } else if (this.open) {
      this.hold = this.holdSamples;
    }
    if (this.open) {
      this.gain += (1 - this.gain) * this.attack;
      if (this.gain > 1 - CLOSED_GAIN) this.gain = 1;
    } else {
      this.gain *= this.release;
      if (this.gain < CLOSED_GAIN) this.gain = 0;
    }
    return x * this.gain;
  }

  /** Clear the state (gate closed, envelope empty); a disabled gate stays at unity. */
  reset(): void {
    this.env = 0;
    this.hold = 0;
    this.open = !this.enabled;
    this.gain = this.enabled ? 0 : 1;
  }
}
