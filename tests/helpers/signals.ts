/**
 * Deterministic test-signal generators (T-015): sines, band-limited harmonic tones, Karplus–Strong
 * plucks, noise, envelopes and a phase-continuous legato tone. Everything is mono `Float32Array`
 * at an explicit sample rate; randomness comes from a seeded PRNG so tests are reproducible.
 * Other test areas may import these.
 */

/** MIDI note → Hz (A4 = 440 unless given). */
export function midiToHz(midi: number, a4 = 440): number {
  return a4 * 2 ** ((midi - 69) / 12);
}

/** Signed distance from `freq` to `refFreq`, in cents. */
export function centsBetween(freq: number, refFreq: number): number {
  return 1200 * Math.log2(freq / refFreq);
}

/** dBFS → linear amplitude. */
export function dbToAmp(db: number): number {
  return 10 ** (db / 20);
}

/** Seeded uniform PRNG in [0, 1) (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Number of samples in `sec` seconds. */
export function samples(sec: number, sampleRate: number): number {
  return Math.round(sec * sampleRate);
}

/** Sine of `freq` Hz at peak amplitude `amp`. */
export function sine(freq: number, durSec: number, sampleRate: number, amp = 0.5, phase = 0): Float32Array {
  const out = new Float32Array(samples(durSec, sampleRate));
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin(w * i + phase);
  return out;
}

/**
 * Additive harmonic tone: `partials[k]` is the relative amplitude of harmonic k + 1. Partials at or
 * above Nyquist are dropped (band-limited). The result is scaled so its peak is `amp`.
 */
export function harmonicTone(
  freq: number,
  durSec: number,
  sampleRate: number,
  partials: readonly number[],
  amp = 0.5,
): Float32Array {
  const out = new Float32Array(samples(durSec, sampleRate));
  for (let k = 0; k < partials.length; k++) {
    const f = freq * (k + 1);
    if (f >= sampleRate / 2 || partials[k] === 0) continue;
    const w = (2 * Math.PI * f) / sampleRate;
    // Stagger phases so the waveform is not artificially peaky.
    const ph = k * 0.7;
    for (let i = 0; i < out.length; i++) out[i] += partials[k] * Math.sin(w * i + ph);
  }
  return normalize(out, amp);
}

/** Band-limited sawtooth partials (1/k) up to `count` harmonics. */
export function sawPartials(count = 60): number[] {
  return Array.from({ length: count }, (_, k) => 1 / (k + 1));
}

/**
 * Guitar-like spectrum: weaker fundamental than the 2nd harmonic, slow 1/k-ish roll-off; typical of
 * a DI low string (the case MPM must not report an octave up).
 */
export const GUITAR_PARTIALS: readonly number[] = [0.45, 1, 0.7, 0.5, 0.42, 0.3, 0.25, 0.18, 0.14, 0.1, 0.08, 0.06];

/** "Missing fundamental"-ish: fundamental at 10% of the strong 2nd harmonic, odd harmonics weak (plain MPM, e.g. pitchy, reports the octave above). */
export const WEAK_FUNDAMENTAL_PARTIALS: readonly number[] = [0.1, 1, 0.2, 0.6, 0.1, 0.3, 0.05, 0.2];

/**
 * Pluck envelope in place: linear attack of `attackMs`, then exponential decay with time constant
 * `decaySec` (amplitude × e^(−t/decay)). Returns `signal`.
 */
export function applyPluckEnvelope(signal: Float32Array, sampleRate: number, attackMs = 2, decaySec = 0.8): Float32Array {
  const attack = Math.max(1, samples(attackMs / 1000, sampleRate));
  for (let i = 0; i < signal.length; i++) {
    const a = i < attack ? i / attack : 1;
    signal[i] *= a * Math.exp(-i / sampleRate / decaySec);
  }
  return signal;
}

/** Options for {@link pluckedTone}. */
export interface PluckedToneOptions {
  partials?: readonly number[];
  /** Peak amplitude (default 0.5). */
  amp?: number;
  /** Decay time constant of the fundamental, seconds (default 0.8). */
  decaySec?: number;
  /** Partial k decays (1 + f_k / dampingHz) times faster than a 0 Hz partial (default 1000). */
  dampingHz?: number;
  attackMs?: number;
}

/**
 * Additive plucked tone whose upper partials die out faster than the fundamental, as on a real
 * string (a single envelope keeps the brightness of the attack forever).
 */
export function pluckedTone(freq: number, durSec: number, sampleRate: number, opts: PluckedToneOptions = {}): Float32Array {
  const { partials = GUITAR_PARTIALS, amp = 0.5, decaySec = 0.8, dampingHz = 1000, attackMs = 2 } = opts;
  const out = new Float32Array(samples(durSec, sampleRate));
  for (let k = 0; k < partials.length; k++) {
    const f = freq * (k + 1);
    if (f >= sampleRate / 2 || partials[k] === 0) continue;
    const w = (2 * Math.PI * f) / sampleRate;
    const rate = (1 + f / dampingHz) / decaySec / sampleRate;
    for (let i = 0; i < out.length; i++) out[i] += partials[k] * Math.exp(-i * rate) * Math.sin(w * i + k * 0.7);
  }
  normalize(out, amp);
  return applyPluckEnvelope(out, sampleRate, attackMs, Number.POSITIVE_INFINITY);
}

/**
 * Add a pick/finger transient in place: a seeded noise burst of peak `amp` decaying with a
 * `ms` time constant from sample 0 (real attacks are broadband; additive tones alone are not).
 * Returns `signal`.
 */
export function addPickTransient(signal: Float32Array, sampleRate: number, amp: number, ms = 1, seed = 3): Float32Array {
  const r = rng(seed);
  const tau = (ms / 1000) * sampleRate;
  const len = Math.min(signal.length, Math.ceil(tau * 6));
  for (let i = 0; i < len; i++) signal[i] += amp * (r() * 2 - 1) * Math.exp(-i / tau);
  return signal;
}

/** Options for {@link karplusStrong}. */
export interface PluckOptions {
  /** Peak amplitude of the result (default 0.5). */
  amp?: number;
  /** Seed for the excitation noise. */
  seed?: number;
  /** Loop gain per period, < 1 (default 0.996): lower decays faster. */
  feedback?: number;
  /**
   * Excitation brightness 0–1 (default 0.6): the noise burst is low-passed by a one-pole filter with
   * this coefficient blend; 1 = white.
   */
  brightness?: number;
}

/**
 * Karplus–Strong plucked string with Jaffe–Smith all-pass tuning, so the fundamental is within a
 * cent of `freq`. The excitation is a seeded noise burst one period long.
 */
export function karplusStrong(freq: number, durSec: number, sampleRate: number, opts: PluckOptions = {}): Float32Array {
  const { amp = 0.5, seed = 1, feedback = 0.996, brightness = 0.6 } = opts;
  const out = new Float32Array(samples(durSec, sampleRate));
  // Loop delay = N (integer) + 0.5 (two-point average) + Δ (all-pass), Δ in [0.5, 1.5).
  const total = sampleRate / freq;
  const n = Math.floor(total - 1);
  const delta = total - 0.5 - n;
  const c = (1 - delta) / (1 + delta);
  const line = new Float64Array(n);
  const r = rng(seed);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const white = r() * 2 - 1;
    lp = brightness * white + (1 - brightness) * lp;
    line[i] = lp;
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += line[i];
  mean /= n;
  for (let i = 0; i < n; i++) line[i] -= mean;
  let idx = 0;
  let prev = 0;
  let apX = 0;
  let apY = 0;
  for (let i = 0; i < out.length; i++) {
    const cur = line[idx];
    out[i] = cur;
    const avg = feedback * 0.5 * (cur + prev);
    prev = cur;
    // First-order all-pass: y = c·x + x[−1] − c·y[−1].
    const y = c * avg + apX - c * apY;
    apX = avg;
    apY = y;
    line[idx] = y;
    idx = idx + 1 === n ? 0 : idx + 1;
  }
  return normalize(out, amp);
}

/** Options for {@link legatoTone}. */
export interface LegatoOptions {
  amp?: number;
  partials?: readonly number[];
  decaySec?: number;
  attackMs?: number;
  /** Glide duration between pitches in ms (0 = instant hammer-on/pull-off; > 0 = slide). */
  glideMs?: number;
}

/**
 * One plucked note whose pitch changes without a new attack (hammer-on, pull-off, slide): an
 * additive tone with continuous phase and a single pluck envelope. `steps` are
 * `{atSec, midi}` pitch targets; the first must be at 0.
 */
export function legatoTone(
  steps: readonly { atSec: number; midi: number }[],
  durSec: number,
  sampleRate: number,
  opts: LegatoOptions = {},
): Float32Array {
  const { amp = 0.5, partials = GUITAR_PARTIALS, decaySec = 1.2, attackMs = 2, glideMs = 0 } = opts;
  const out = new Float32Array(samples(durSec, sampleRate));
  const glide = samples(glideMs / 1000, sampleRate);
  const phases = new Float64Array(partials.length);
  let step = 0;
  for (let i = 0; i < out.length; i++) {
    while (step + 1 < steps.length && i >= samples(steps[step + 1].atSec, sampleRate)) step++;
    let midi = steps[step].midi;
    if (glide > 0 && step > 0) {
      const since = i - samples(steps[step].atSec, sampleRate);
      if (since < glide) midi = steps[step - 1].midi + ((steps[step].midi - steps[step - 1].midi) * since) / glide;
    }
    const f0 = midiToHz(midi);
    let v = 0;
    for (let k = 0; k < partials.length; k++) {
      const f = f0 * (k + 1);
      phases[k] += (2 * Math.PI * f) / sampleRate;
      if (f < sampleRate / 2) v += partials[k] * Math.sin(phases[k] + k * 0.7);
    }
    out[i] = v;
  }
  normalize(out, 1);
  applyPluckEnvelope(out, sampleRate, attackMs, decaySec);
  for (let i = 0; i < out.length; i++) out[i] *= amp;
  return out;
}

/** Gaussian-ish white noise (sum of 4 uniforms) with RMS `rms`. */
export function noise(length: number, rms: number, seed = 7): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(length);
  // Σ of 4 U(0,1) − 2 has variance 4/12.
  const scale = rms / Math.sqrt(1 / 3);
  for (let i = 0; i < length; i++) out[i] = (r() + r() + r() + r() - 2) * scale;
  return out;
}

/** Add `src` into `dst` starting at sample `at` (clipped to `dst`). Returns `dst`. */
export function mixInto(dst: Float32Array, src: Float32Array, at = 0, gain = 1): Float32Array {
  const end = Math.min(dst.length, at + src.length);
  for (let i = Math.max(0, at); i < end; i++) dst[i] += gain * src[i - at];
  return dst;
}

/** Add white noise at `noiseDb` dBFS RMS to `signal` in place. Returns `signal`. */
export function addNoise(signal: Float32Array, noiseDb: number, seed = 11): Float32Array {
  return mixInto(signal, noise(signal.length, dbToAmp(noiseDb), seed));
}

/**
 * Fade the last `ms` of `signal` linearly to zero in place (a mute: an abrupt end is a click that
 * onset detectors rightly report). Returns `signal`.
 */
export function fadeOut(signal: Float32Array, sampleRate: number, ms = 5): Float32Array {
  const n = Math.min(signal.length, samples(ms / 1000, sampleRate));
  for (let k = 0; k < n; k++) signal[signal.length - 1 - k] *= k / n;
  return signal;
}

/** Scale `signal` in place so its absolute peak is `peak`. Returns `signal`. */
export function normalize(signal: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (const v of signal) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < signal.length; i++) signal[i] *= peak / max;
  return signal;
}

/** A note placed on a timeline by {@link renderTimeline}. */
export interface TimelineNote {
  atSec: number;
  signal: Float32Array;
}

/** Mix notes into a buffer of `durSec` seconds (optionally over a noise floor at `noiseDb` dBFS RMS). */
export function renderTimeline(
  notes: readonly TimelineNote[],
  durSec: number,
  sampleRate: number,
  noiseDb?: number,
): Float32Array {
  const out = new Float32Array(samples(durSec, sampleRate));
  for (const n of notes) mixInto(out, n.signal, samples(n.atSec, sampleRate));
  if (noiseDb !== undefined) addNoise(out, noiseDb);
  return out;
}
