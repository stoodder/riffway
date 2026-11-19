/**
 * Biquad filters for the amp's tone stack (RBJ Audio EQ Cookbook, the same formulas Chrome's
 * `BiquadFilterNode` uses), a one-pole DC blocker, and a magnitude-response helper for tests and
 * UI curves. Allocation-free while processing; filter state is flushed to zero below
 * {@link DENORMAL_FLOOR} so silence never decays into subnormal numbers.
 * @module
 */

/** Filter state magnitudes below this are set to exactly 0 (keeps the audio thread off subnormals). */
export const DENORMAL_FLOOR = 1e-20;

/** RBJ filter shapes used by the amp and the cab. */
export type BiquadShape = 'lowpass' | 'highpass' | 'peaking' | 'lowshelf' | 'highshelf';

/** One biquad stage: shape, corner/centre frequency (Hz), Q (linear; shelves use slope S = 1) and gain (dB). */
export interface BiquadSpec {
  type: BiquadShape;
  frequency: number;
  /** Linear Q (peaking bandwidth, low/high-pass resonance). Ignored by shelves (S = 1). */
  q: number;
  /** Gain in dB (peaking and shelves only). */
  gain: number;
}

/** Normalised biquad coefficients (a0 = 1). */
export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Compute normalised coefficients for `spec` at `sampleRate` (frequency clamped below Nyquist). */
export function biquadCoefficients(spec: BiquadSpec, sampleRate: number): BiquadCoefficients {
  const f = Math.min(Math.max(spec.frequency, 1), sampleRate * 0.499);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = 10 ** (spec.gain / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (spec.type) {
    case 'lowpass': {
      const alpha = sin / (2 * spec.q);
      b1 = 1 - cos;
      b0 = b1 / 2;
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'highpass': {
      const alpha = sin / (2 * spec.q);
      b1 = -(1 + cos);
      b0 = (1 + cos) / 2;
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    }
    case 'peaking': {
      const alpha = sin / (2 * spec.q);
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowshelf':
    case 'highshelf': {
      // Shelf slope S = 1: alpha = sin/2 · √2.
      const alpha = (sin / 2) * Math.SQRT2;
      const k = 2 * Math.sqrt(A) * alpha;
      if (spec.type === 'lowshelf') {
        b0 = A * (A + 1 - (A - 1) * cos + k);
        b1 = 2 * A * (A - 1 - (A + 1) * cos);
        b2 = A * (A + 1 - (A - 1) * cos - k);
        a0 = A + 1 + (A - 1) * cos + k;
        a1 = -2 * (A - 1 + (A + 1) * cos);
        a2 = A + 1 + (A - 1) * cos - k;
      } else {
        b0 = A * (A + 1 + (A - 1) * cos + k);
        b1 = -2 * A * (A - 1 + (A + 1) * cos);
        b2 = A * (A + 1 + (A - 1) * cos - k);
        a0 = A + 1 - (A - 1) * cos + k;
        a1 = 2 * (A - 1 - (A + 1) * cos);
        a2 = A + 1 - (A - 1) * cos - k;
      }
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Magnitude response of a cascade of biquads at `freq` Hz, in dB. */
export function cascadeMagnitudeDb(stages: readonly BiquadCoefficients[], freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  let db = 0;
  for (const { b0, b1, b2, a1, a2 } of stages) {
    // H(e^jw) = (b0 + b1 e^-jw + b2 e^-2jw) / (1 + a1 e^-jw + a2 e^-2jw)
    const nr = b0 + b1 * c1 + b2 * c2;
    const ni = -(b1 * s1 + b2 * s2);
    const dr = 1 + a1 * c1 + a2 * c2;
    const di = -(a1 * s1 + a2 * s2);
    db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return db;
}

/** A biquad section (transposed direct form II) whose coefficients can be swapped live. */
export class Biquad {
  private c: BiquadCoefficients = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  private z1 = 0;
  private z2 = 0;

  /** Current coefficients (read-only view). */
  get coefficients(): Readonly<BiquadCoefficients> {
    return this.c;
  }

  /** Replace the coefficients; state is kept so live tone changes don't click. */
  set(coefficients: BiquadCoefficients): void {
    this.c = coefficients;
  }

  /** Filter one sample. */
  tick(x: number): number {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + this.z1;
    this.z1 = b1 * x - a1 * y + this.z2;
    this.z2 = b2 * x - a2 * y;
    if (this.z1 < DENORMAL_FLOOR && this.z1 > -DENORMAL_FLOOR) this.z1 = 0;
    if (this.z2 < DENORMAL_FLOOR && this.z2 > -DENORMAL_FLOOR) this.z2 = 0;
    return y;
  }

  /** Clear the state. */
  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

/** One-pole DC blocker, `y[n] = x[n] − x[n−1] + R·y[n−1]` with a ≈ `cutoffHz` corner. */
export class DcBlocker {
  private readonly r: number;
  private x1 = 0;
  private y1 = 0;

  constructor(sampleRate: number, cutoffHz = 10) {
    this.r = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  }

  /** Filter one sample. */
  tick(x: number): number {
    let y = x - this.x1 + this.r * this.y1;
    if (y < DENORMAL_FLOOR && y > -DENORMAL_FLOOR) y = 0;
    this.x1 = x;
    this.y1 = y;
    return y;
  }

  /** Clear the state. */
  reset(): void {
    this.x1 = 0;
    this.y1 = 0;
  }
}
