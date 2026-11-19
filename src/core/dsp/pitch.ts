/**
 * McLeod Pitch Method (MPM): normalised square difference function (NSDF) computed through a
 * radix-2 FFT autocorrelation, key-maximum peak picking and parabolic interpolation
 * (McLeod & Wyvill 2005), plus three guards for recorded guitar (docs/audio-input.md):
 * - **octave check** — the period twice as long wins when it is clearly more self-similar (weak
 *   fundamentals);
 * - **sub-harmonic guard** — a period 2 or 3 times as long as a clear shorter one (from the octave
 *   check or the key-maximum threshold) must also explain most of that one's imperfection
 *   ({@link SUBHARMONIC_RESIDUAL_RATIO}); a body thump, hum or sympathetically ringing lower string
 *   under noise does not;
 * - **glide check** — an estimate between two semitones is re-measured on the second half of the
 *   window, where a bend or slide has settled ({@link GLIDE_AMBIGUOUS_SEMITONES}).
 *
 * All buffers are allocated by {@link createPitchDetector}; `detect()` allocates nothing and reuses
 * its result object.
 * @module
 */
import { RealFft } from './fft';
import type { PitchDetector, PitchDetectorOptions, PitchEstimate, PitchWindowSize } from './index';

/** Lowest note of standard tuning (E2, 82.4 Hz). */
export const E2_MIDI = 40;
/** Default upper search bound (E6, 1318.5 Hz; 24th fret on the high e string). */
export const E6_MIDI = 88;

/** The lag search extends this many semitones past the requested range so out-of-tune edge notes are found. */
const RANGE_MARGIN_SEMITONES = 1;
/** McLeod's k: the first key maximum ≥ k × the highest key maximum is the period. */
const KEY_MAX_THRESHOLD = 0.9;
/**
 * Octave check: switch to the key maximum at twice the chosen period when its NSDF is at least this
 * much higher. A periodic signal has (almost) equal peaks at τ and 2τ; a tone with a weak
 * fundamental and strong even harmonics has a clearly lower peak at τ = T/2. Smaller margins let
 * interpolation error on the sharp peaks of bright high notes cause octave-down errors.
 */
const OCTAVE_MARGIN = 0.03;
/**
 * Sub-harmonic guard (octave check and key-maximum choice): a period m times longer (m = 2, 3) than
 * a clear shorter one is only taken when it explains most of the shorter period's imperfection —
 * its residual 1 − NSDF must be at most this fraction of the shorter period's 1 − NSDF. For a tone
 * whose own odd (or non-multiple-of-3) harmonics make τ = T/m imperfect, the longer period is
 * (nearly) perfect; when noise, an inharmonic attack thump or a sympathetically ringing lower string
 * lifts the longer period by a little, both stay similarly imperfect (recorded guitar,
 * docs/audio-input.md § Audio-pipeline results).
 */
export const SUBHARMONIC_RESIDUAL_RATIO = 0.4;
/** A key maximum at least this clear is a candidate for the sub-harmonic guard. */
const SUBHARMONIC_MIN_CLARITY = 0.5;
/**
 * Glide check: an estimate more than this far from the nearest semitone is re-measured on the
 * window's second half (a bend or slide moving through the window reads in between).
 */
export const GLIDE_AMBIGUOUS_SEMITONES = 0.3;
/** The second-half period is searched within ± this many semitones of the full window's. */
const GLIDE_RANGE_SEMITONES = 2;
/** The second half's NSDF peak must be at least this clear to replace the estimate. */
const TAIL_MIN_CLARITY = 0.8;
/** Allowed mismatch, as a fraction of 2τ, when looking for the key maximum at twice the period. */
const OCTAVE_TOLERANCE = 0.03;
/** Windows whose mean square is below this (−100 dBFS) are silence: no estimate. */
const SILENCE_MEAN_SQUARE = 1e-10;
/** Expected-note hint widening (docs/audio-input.md: expected ±7 semitones). */
const EXPECT_WIDEN_SEMITONES = 7;
/** Expected notes below this use the long window (two E2 periods need ~1165 samples at 48 kHz). */
const LONG_WINDOW_BELOW_HZ = 160;

/**
 * Whether a longer period with NSDF `longer` explains the imperfection of a shorter one with NSDF
 * `shorter` well enough to be the note's period ({@link SUBHARMONIC_RESIDUAL_RATIO}).
 */
function explainsSubharmonic(longer: number, shorter: number): boolean {
  return 1 - longer <= SUBHARMONIC_RESIDUAL_RATIO * (1 - shorter);
}

/** MIDI note → frequency in Hz (A4 = `a4`). */
export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * 2 ** ((midi - 69) / 12);
}

/** Fractional MIDI pitch of `freq` (A4 = `a4`); 69.5 is a quarter tone above A4. */
export function freqToMidiFloat(freq: number, a4 = 440): number {
  if (!(freq > 0) || !Number.isFinite(freq)) throw new RangeError(`frequency must be > 0, got ${freq}`);
  return 69 + 12 * Math.log2(freq / a4);
}

/**
 * Hz → nearest MIDI note + cents (A4 = `a4`, default 440). Allocates its result: not for the audio
 * hot path (detectors fill their own estimate). Throws `RangeError` for freq ≤ 0.
 */
export function freqToMidi(freq: number, a4 = 440): { midi: number; cents: number } {
  const pitch = freqToMidiFloat(freq, a4);
  const midi = Math.round(pitch);
  return { midi, cents: (pitch - midi) * 100 };
}

/** Window size and search range for an expected-note hint; see {@link planPitchWindow}. */
export interface PitchWindowPlan {
  size: PitchWindowSize;
  /** Search range for {@link PitchDetector.setRange}; `null` = E2–E6. */
  range: { minMidi: number; maxMidi: number } | null;
}

/** The sample rate the base window sizes (1024 / 2048 / tuner 4096) are designed for. */
const BASE_RATE = 44100;
/** Largest {@link pitchWindowScale} (192 kHz); the windows then reach the detector's 16384 limit. */
const MAX_WINDOW_SCALE = 4;

/**
 * Factor applied to every sample-counted analysis length (pitch windows, tuner window and hop,
 * legato step, retry shift, the onset hold guard) so they keep the same duration at any rate
 * (R3-C-03): the largest power of two ≤ `sampleRate / 44100`, clamped to 1–4. 44.1 and 48 kHz → 1
 * (N = 2048 is 46.4 / 42.7 ms), 88.2 and 96 kHz → 2, 176.4 and 192 kHz → 4. The windows therefore
 * never last longer than at 44.1 kHz (the judge's `GUITAR_ANALYSIS_DELAY_SEC` budget), and two
 * periods of Drop D's D2 always fit the long one. Rates below 44.1 kHz are not supported.
 */
export function pitchWindowScale(sampleRate: number): 1 | 2 | 4 {
  if (!(sampleRate > 0)) throw new RangeError(`sample rate must be > 0, got ${sampleRate}`);
  const scale = 2 ** Math.floor(Math.log2(sampleRate / BASE_RATE) + 1e-9);
  return Math.min(MAX_WINDOW_SCALE, Math.max(1, scale)) as 1 | 2 | 4;
}

/**
 * Choose the analysis window and search range from the main thread's `expect` hint
 * (docs/audio-input.md): N = 2048 when the lowest expected note is below ~160 Hz or there is no
 * hint, else 1024, both × {@link pitchWindowScale} of `sampleRate` (default 48 kHz); search the
 * expected range widened by ±7 semitones, or E2–E6 without a hint.
 */
export function planPitchWindow(expect: { minMidi: number; maxMidi: number } | null, sampleRate = 48000): PitchWindowPlan {
  const scale = pitchWindowScale(sampleRate);
  const long = (2048 * scale) as PitchWindowSize;
  if (!expect) return { size: long, range: null };
  return {
    size: midiToFreq(expect.minMidi) < LONG_WINDOW_BELOW_HZ ? long : ((1024 * scale) as PitchWindowSize),
    range: { minMidi: expect.minMidi - EXPECT_WIDEN_SEMITONES, maxMidi: expect.maxMidi + EXPECT_WIDEN_SEMITONES },
  };
}

/** Window sizes {@link createPitchDetector} accepts. */
const PITCH_WINDOW_SIZES: readonly number[] = [1024, 2048, 4096, 8192, 16384];

/**
 * Create an MPM pitch detector for windows of `opts.size` samples. The search range defaults to
 * E2–E6; lags are capped at `size / 2` so at least two periods fit the window (at 48 kHz a
 * 1024 window reaches down to ~94 Hz, 2048 to E2 and below; at higher rates scale the size with
 * {@link pitchWindowScale}). `detect()` returns the same
 * {@link PitchEstimate} object on every call.
 */
export function createPitchDetector(opts: PitchDetectorOptions): PitchDetector {
  return new MpmDetector(opts);
}

class MpmDetector implements PitchDetector {
  readonly size: number;
  private readonly sampleRate: number;
  private readonly a4: number;
  private readonly fft: RealFft;
  /** Zero-padded window (2N), then the autocorrelation r(τ). */
  private readonly buf: Float64Array;
  /** Half spectrum (N + 1 bins). */
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  /** DC-free copy of the window (for the NSDF normaliser). */
  private readonly x: Float64Array;
  private readonly nsdf: Float64Array;
  /** Lags of the key maxima found by the last `detect()`. */
  private readonly keyLags: Int32Array;
  private readonly result: PitchEstimate = { freq: 0, midi: 0, cents: 0, clarity: 0 };
  private minLag = 0;
  private maxLag = 0;
  /** Interpolated NSDF peak value from the last {@link interpolate} call. */
  private peakValue = 0;

  constructor(opts: PitchDetectorOptions) {
    const { size, sampleRate } = opts;
    if (!PITCH_WINDOW_SIZES.includes(size)) throw new RangeError(`unsupported window size ${String(size)}`);
    if (!(sampleRate > 0)) throw new RangeError(`sample rate must be > 0, got ${sampleRate}`);
    this.size = size;
    this.sampleRate = sampleRate;
    this.a4 = opts.a4 ?? 440;
    // Zero-padding to 2N makes the circular autocorrelation linear for every lag < N.
    this.fft = new RealFft(2 * size);
    this.buf = new Float64Array(2 * size);
    this.re = new Float64Array(size + 1);
    this.im = new Float64Array(size + 1);
    this.x = new Float64Array(size);
    this.nsdf = new Float64Array(size / 2 + 2);
    this.keyLags = new Int32Array(size / 4 + 1);
    this.setRange(null);
  }

  setRange(range: { minMidi: number; maxMidi: number } | null): void {
    const lo = range ? range.minMidi : E2_MIDI;
    const hi = range ? range.maxMidi : E6_MIDI;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
      throw new RangeError(`invalid MIDI range ${lo}..${hi}`);
    }
    const fMin = midiToFreq(lo - RANGE_MARGIN_SEMITONES, this.a4);
    const fMax = midiToFreq(hi + RANGE_MARGIN_SEMITONES, this.a4);
    const minLag = Math.max(2, Math.floor(this.sampleRate / fMax));
    const maxLag = Math.min(this.size / 2, Math.ceil(this.sampleRate / fMin));
    if (maxLag - minLag < 2) {
      throw new RangeError(`MIDI range ${lo}..${hi} cannot be resolved with a ${this.size}-sample window`);
    }
    this.minLag = minLag;
    this.maxLag = maxLag;
  }

  detect(buffer: Float32Array, offset = 0): PitchEstimate | null {
    const n = this.size;
    if (offset < 0 || offset + n > buffer.length) {
      throw new RangeError(`window [${offset}, ${offset + n}) exceeds buffer of ${buffer.length}`);
    }
    const { buf, re, im, x, nsdf } = this;

    let mean = 0;
    for (let i = 0; i < n; i++) mean += buffer[offset + i];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = buffer[offset + i] - mean;
      x[i] = v;
      buf[i] = v;
      energy += v * v;
    }
    if (energy / n < SILENCE_MEAN_SQUARE) return null;
    buf.fill(0, n);

    // Autocorrelation r(τ) = IFFT(|FFT(x)|²).
    this.fft.forward(buf, re, im);
    for (let k = 0; k <= n; k++) {
      re[k] = re[k] * re[k] + im[k] * im[k];
      im[k] = 0;
    }
    this.fft.inverse(re, im, buf);

    // NSDF n(τ) = 2 r(τ) / m'(τ), m'(τ) = Σ_{j<N−τ} x_j² + x_{j+τ}², updated incrementally.
    const end = this.maxLag + 1;
    let m = 2 * buf[0];
    nsdf[0] = 1;
    for (let tau = 1; tau <= end; tau++) {
      const a = x[tau - 1];
      const b = x[n - tau];
      m -= a * a + b * b;
      nsdf[tau] = m > 0 ? (2 * buf[tau]) / m : 0;
    }

    // Key maxima: the highest point of each positive lobe after the first negative-going zero crossing.
    const { minLag, maxLag, keyLags } = this;
    let keyCount = 0;
    let lobeLag = -1;
    let seenNegative = false;
    for (let tau = 1; tau <= maxLag; tau++) {
      const v = nsdf[tau];
      if (v <= 0) {
        seenNegative = true;
        if (lobeLag >= 0) {
          keyCount = this.pushKey(lobeLag, keyCount);
          lobeLag = -1;
        }
      } else if (seenNegative && tau >= minLag && (lobeLag < 0 || v > nsdf[lobeLag])) {
        lobeLag = tau;
      }
    }
    // A lobe still rising at maxLag belongs to a note below the range.
    if (lobeLag >= 0 && nsdf[lobeLag] >= nsdf[lobeLag + 1]) keyCount = this.pushKey(lobeLag, keyCount);
    if (keyCount === 0) return null;

    let best = 0;
    for (let i = 0; i < keyCount; i++) best = Math.max(best, nsdf[keyLags[i]]);
    const threshold = KEY_MAX_THRESHOLD * best;
    let chosen = 0;
    while (nsdf[keyLags[chosen]] < threshold) chosen++;
    chosen = this.guardSubharmonic(chosen);

    let lag = this.interpolate(keyLags[chosen]);
    let clarity = this.peakValue;
    // Octave check: prefer the period twice as long when it is clearly more self-similar.
    for (let i = chosen + 1; i < keyCount; i++) {
      const cand = keyLags[i];
      if (Math.abs(cand - 2 * lag) > OCTAVE_TOLERANCE * 2 * lag + 1) continue;
      const candLag = this.interpolate(cand);
      const doubled = this.peakValue;
      if (doubled >= clarity + OCTAVE_MARGIN && explainsSubharmonic(doubled, clarity)) {
        lag = candLag;
        clarity = doubled;
      }
      break;
    }

    let pitch = freqToMidiFloat(this.sampleRate / lag, this.a4);
    // Between two notes: a bend, slide or pick glide is moving through the window. The note is
    // where it settles, so re-measure the second half of the window around this period.
    if (Math.abs(pitch - Math.round(pitch)) > GLIDE_AMBIGUOUS_SEMITONES && lag <= n / 4) {
      const settled = this.tailPeriod(lag);
      if (settled > 0) {
        lag = settled;
        pitch = freqToMidiFloat(this.sampleRate / lag, this.a4);
      }
    }
    const freq = this.sampleRate / lag;
    const midi = Math.round(pitch);
    const out = this.result;
    out.freq = freq;
    out.midi = midi;
    out.cents = (pitch - midi) * 100;
    out.clarity = Math.min(1, Math.max(0, clarity));
    return out;
  }

  /**
   * Period of the window's second half near `lag` (± {@link GLIDE_RANGE_SEMITONES}), from its own
   * NSDF; −1 when that half has no clear peak there ({@link TAIL_MIN_CLARITY}). Reuses the FFT
   * buffers and the NSDF array (the full window's are no longer needed).
   */
  private tailPeriod(lag: number): number {
    const n = this.size;
    const h = n / 2;
    const { buf, re, im, x, nsdf } = this;
    for (let i = 0; i < h; i++) buf[i] = x[h + i];
    buf.fill(0, h);
    this.fft.forward(buf, re, im);
    for (let k = 0; k <= n; k++) {
      re[k] = re[k] * re[k] + im[k] * im[k];
      im[k] = 0;
    }
    this.fft.inverse(re, im, buf);
    const span = 2 ** (GLIDE_RANGE_SEMITONES / 12);
    const lo = Math.max(2, Math.floor(lag / span));
    const hi = Math.min(h / 2, Math.ceil(lag * span));
    let m = 2 * buf[0];
    let best = -1;
    for (let tau = 1; tau <= hi + 1; tau++) {
      const a = x[h + tau - 1];
      const b = x[n - tau];
      m -= a * a + b * b;
      nsdf[tau] = m > 0 ? (2 * buf[tau]) / m : 0;
      if (tau >= lo && tau <= hi && (best < 0 || nsdf[tau] > nsdf[best])) best = tau;
    }
    if (best <= lo || best >= hi || nsdf[best] < TAIL_MIN_CLARITY) return -1;
    return this.interpolate(best);
  }

  /**
   * The threshold rule picked key maximum `chosen`; when it lies at m × the lag of an earlier clear
   * key maximum (m = 2, 3) without explaining that one's imperfection
   * ({@link SUBHARMONIC_RESIDUAL_RATIO}), the earlier (higher) pitch is the note instead.
   */
  private guardSubharmonic(chosen: number): number {
    const { keyLags, nsdf } = this;
    const lag = keyLags[chosen];
    const value = nsdf[lag];
    for (let i = 0; i < chosen; i++) {
      const tau = keyLags[i];
      if (nsdf[tau] < SUBHARMONIC_MIN_CLARITY) continue;
      const m = Math.round(lag / tau);
      if ((m === 2 || m === 3) && Math.abs(lag - m * tau) <= OCTAVE_TOLERANCE * lag + 1 && !explainsSubharmonic(value, nsdf[tau])) {
        return i;
      }
    }
    return chosen;
  }

  /** Record a lobe maximum, unless it is the clipped edge of a lobe that peaked below `minLag`. */
  private pushKey(lag: number, count: number): number {
    if (this.nsdf[lag - 1] <= this.nsdf[lag] && count < this.keyLags.length) this.keyLags[count++] = lag;
    return count;
  }

  /** Parabolic interpolation around integer lag `tau`; returns the fractional lag, sets {@link peakValue}. */
  private interpolate(tau: number): number {
    const a = this.nsdf[tau - 1];
    const b = this.nsdf[tau];
    const c = this.nsdf[tau + 1];
    const denom = a - 2 * b + c;
    if (denom >= 0) {
      this.peakValue = b;
      return tau;
    }
    const delta = (0.5 * (a - c)) / denom;
    this.peakValue = b - 0.25 * (a - c) * delta;
    return tau + delta;
  }
}
