/**
 * Analysis DSP (T-015), pure TS, allocation-free after construction, so it runs in the analysis
 * worklet (T-022) and in Node tests (docs/audio-input.md). Interfaces and factory signatures frozen
 * by T-010; the amp DSP lives in `./amp/` (T-023).
 * @module
 */
import { notImplemented } from '@shared/errors';

/** A pitch estimate. Detectors may reuse the returned object; copy it if you keep it. */
export interface PitchEstimate {
  /** Hz; 0 when none. */
  freq: number;
  /** Nearest MIDI note (A4 reference applied). */
  midi: number;
  /** Deviation from `midi`, cents. */
  cents: number;
  /** NSDF peak (0–1). */
  clarity: number;
}

/** MPM/NSDF pitch detector over a fixed window (radix-2 FFT, preallocated). */
export interface PitchDetector {
  readonly size: number;
  /** Estimate pitch of `size` samples starting at `offset`. Null when no clear peak in range. */
  detect(buffer: Float32Array, offset?: number): PitchEstimate | null;
  /** Restrict the search to a MIDI range (expected notes ±7 semitones); null = E2–E6. */
  setRange(range: { minMidi: number; maxMidi: number } | null): void;
}

/** Options for {@link createPitchDetector}. */
export interface PitchDetectorOptions {
  sampleRate: number;
  /** Window: 1024, 2048 or 4096 (tuner). */
  size: 1024 | 2048 | 4096;
  a4?: number;
}

/** Amplitude onset detector, one 128-sample hop at a time. */
export interface OnsetDetector {
  /** Process one hop; returns the onset frame (sample-accurate) or -1. */
  process(hop: Float32Array, startFrame: number): number;
  reset(): void;
}

/** Options for {@link createOnsetDetector}. */
export interface OnsetDetectorOptions {
  sampleRate: number;
  /** Hop size (default 128). */
  hop?: number;
  /** Threshold = median + k × MAD over 0.5 s (default 4). */
  k?: number;
  /** Absolute floor, dBFS (default −50). */
  floorDb?: number;
  /** Refractory period, ms (default 40). */
  refractoryMs?: number;
}

/** Legato detector: pitch moved ≥ 0.8 semitone and held ≥ 25 ms without an amplitude onset. */
export interface PitchChangeDetector {
  /** Feed a pitch frame; returns the new MIDI note on a change, else -1. */
  push(estimate: PitchEstimate | null, frame: number): number;
  /** Notify an amplitude onset (resets the reference pitch). */
  onset(frame: number): void;
  reset(): void;
}

/** Peak/RMS meter per block. */
export interface LevelMeter {
  process(block: Float32Array): void;
  /** Levels since the last read, dBFS; resets the accumulators. */
  read(): { peakDb: number; rmsDb: number };
}

/** Tuner display state. */
export interface TunerReading {
  freq: number;
  midi: number;
  cents: number;
  /** |cents| ≤ 3 for 0.5 s. */
  inTune: boolean;
  /** False when holding the last value (clarity < 0.8). */
  live: boolean;
}

/** Median-of-5 tuner smoother with hold below clarity 0.8. */
export interface TunerSmoother {
  push(estimate: PitchEstimate | null, timeSec: number): TunerReading | null;
  reset(): void;
}

export function createPitchDetector(opts: PitchDetectorOptions): PitchDetector {
  return notImplemented('createPitchDetector', 'T-015');
}

export function createOnsetDetector(opts: OnsetDetectorOptions): OnsetDetector {
  return notImplemented('createOnsetDetector', 'T-015');
}

export function createPitchChangeDetector(opts: { sampleRate: number }): PitchChangeDetector {
  return notImplemented('createPitchChangeDetector', 'T-015');
}

export function createLevelMeter(): LevelMeter {
  return notImplemented('createLevelMeter', 'T-015');
}

export function createTunerSmoother(opts?: { a4?: number }): TunerSmoother {
  return notImplemented('createTunerSmoother', 'T-015');
}

/** Hz → nearest MIDI + cents (A4 = `a4`, default 440). */
export function freqToMidi(freq: number, a4 = 440): { midi: number; cents: number } {
  return notImplemented('freqToMidi', 'T-015');
}
