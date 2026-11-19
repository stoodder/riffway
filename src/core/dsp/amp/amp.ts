/**
 * The amp DSP (docs/monitoring.md § Amp worklet), pure TS so it runs in the amp worklet and in Node
 * tests. Per sample:
 *
 * 1. DC blocker, noise gate (preset threshold), drive (smoothed);
 * 2. 4× oversampling (two half-band stages) around an asymmetric ADAA soft clipper;
 * 3. DC blocker (the bias adds DC), 3-band tone stack (low shelf 120 Hz, peak 700 Hz, high shelf
 *    3 kHz), output level (smoothed);
 * 4. guard duck gain (feedback guard, −30 dB over 50 ms), denormal flush.
 *
 * Bypass (DI) crossfades to the dry input over ~10 ms. Non-finite input samples are treated as 0,
 * and the output is always finite. Added latency is {@link AMP_LATENCY_SAMPLES} at the base rate.
 * @module
 */
import { AdaaClipper } from './clipper';
import { Biquad, DcBlocker, biquadCoefficients } from './filters';
import { NoiseGate } from './gate';
import { Oversampler4x, oversamplerLatency } from './halfband';
import { TONE_BANDS, TONE_MID_Q, type AmpConfig } from './config';

/**
 * Group delay of the amp path in base-rate samples: the oversampler round trip plus half a 4×
 * sample for the ADAA clipper. The DI (bypass) path adds none.
 */
export const AMP_LATENCY_SAMPLES = oversamplerLatency() + 0.5 / 4;

/** Feedback-guard duck: depth (dB) and ramp time (s). */
export const DUCK = { depthDb: -30, rampSec: 0.05 } as const;

/** Smoothing time constant for drive, level and the bypass crossfade (s). */
const SMOOTH_SEC = 0.01;

/** Output magnitudes below this are written as exactly 0 (no float32 subnormals). */
const OUTPUT_FLOOR = 1e-30;

const dbToGain = (db: number): number => 10 ** (db / 20);

/** One amp instance (mono). */
export class AmpEngine {
  readonly sampleRate: number;
  private readonly inDc: DcBlocker;
  private readonly outDc: DcBlocker;
  private readonly gate: NoiseGate;
  private readonly os = new Oversampler4x();
  private readonly clipper = new AdaaClipper();
  private readonly low = new Biquad();
  private readonly mid = new Biquad();
  private readonly high = new Biquad();
  private readonly smooth: number;
  private readonly duckStep: number;
  private readonly duckFloor = dbToGain(DUCK.depthDb);
  private config: AmpConfig;
  private drive = 1;
  private driveTarget = 1;
  private level = 1;
  private levelTarget = 1;
  /** 1 = amp path, 0 = dry (bypass). */
  private wet = 1;
  private wetTarget = 1;
  private duckGain = 1;
  private duckTarget = 1;
  /** Amp state was cleared while fully bypassed. */
  private idle = false;

  constructor(sampleRate: number, config: AmpConfig) {
    this.sampleRate = sampleRate;
    this.inDc = new DcBlocker(sampleRate, 10);
    this.outDc = new DcBlocker(sampleRate, 10);
    this.gate = new NoiseGate(sampleRate);
    this.smooth = 1 - Math.exp(-1 / (SMOOTH_SEC * sampleRate));
    // Linear-in-dB duck ramp: multiply per sample.
    this.duckStep = dbToGain(DUCK.depthDb / (DUCK.rampSec * sampleRate));
    this.config = config;
    this.configure(config, true);
  }

  /** The config in effect. */
  get current(): Readonly<AmpConfig> {
    return this.config;
  }

  /** True while the guard duck is engaged (or still ramping down). */
  get ducked(): boolean {
    return this.duckTarget < 1;
  }

  /**
   * Apply a new config. Drive, level and bypass glide (~10 ms); tone coefficients switch at once
   * (state kept). `immediate` jumps the smoothed values (construction, tests).
   */
  configure(config: AmpConfig, immediate = false): void {
    const sr = this.sampleRate;
    this.config = { ...config };
    this.driveTarget = finiteOr(config.drive, 1);
    this.levelTarget = dbToGain(finiteOr(config.level, 0));
    this.wetTarget = config.bypass ? 0 : 1;
    this.gate.setThreshold(config.gateDb);
    this.clipper.setBias(finiteOr(config.bias, 0));
    this.low.set(biquadCoefficients({ type: 'lowshelf', frequency: TONE_BANDS.low, q: 1, gain: finiteOr(config.low, 0) }, sr));
    this.mid.set(biquadCoefficients({ type: 'peaking', frequency: TONE_BANDS.mid, q: TONE_MID_Q, gain: finiteOr(config.mid, 0) }, sr));
    this.high.set(biquadCoefficients({ type: 'highshelf', frequency: TONE_BANDS.high, q: 1, gain: finiteOr(config.high, 0) }, sr));
    if (immediate) {
      this.drive = this.driveTarget;
      this.level = this.levelTarget;
      this.wet = this.wetTarget;
    }
  }

  /** Engage (`true`) or release the feedback-guard duck (−30 dB over 50 ms; release ramps back up). */
  setDucked(on: boolean): void {
    this.duckTarget = on ? this.duckFloor : 1;
  }

  /** Process `n` samples from `input` into `output` (may be the same array). */
  process(input: Float32Array, output: Float32Array, n = input.length): void {
    const s = this.smooth;
    const { os, clipper, gate, low, mid, high, inDc, outDc } = this;
    const hi = os.block;
    for (let i = 0; i < n; i++) {
      const raw = input[i]!;
      const x = Number.isFinite(raw) ? raw : 0;
      this.drive += (this.driveTarget - this.drive) * s;
      this.level += (this.levelTarget - this.level) * s;
      this.wet += (this.wetTarget - this.wet) * s;
      if (this.wet < 1e-4 && this.wetTarget === 0) this.wet = 0;
      else if (this.wet > 1 - 1e-4 && this.wetTarget === 1) this.wet = 1;
      this.stepDuck();

      let y = x;
      if (this.wet > 0) {
        this.idle = false;
        const g = gate.tick(inDc.tick(x)) * this.drive;
        os.up(g);
        hi[0] = clipper.tick(hi[0]!);
        hi[1] = clipper.tick(hi[1]!);
        hi[2] = clipper.tick(hi[2]!);
        hi[3] = clipper.tick(hi[3]!);
        let a = outDc.tick(os.down());
        a = high.tick(mid.tick(low.tick(a))) * this.level;
        y = this.wet === 1 ? a : this.wet * a + (1 - this.wet) * x;
      } else if (!this.idle) {
        this.resetAmpState();
        this.idle = true;
      }
      y *= this.duckGain;
      if (!(y > OUTPUT_FLOOR || y < -OUTPUT_FLOOR)) y = 0; // also maps NaN → 0
      output[i] = y;
    }
  }

  /** Clear all filter state (e.g. after the input changes). */
  reset(): void {
    this.resetAmpState();
    this.duckGain = this.duckTarget;
  }

  private stepDuck(): void {
    if (this.duckGain > this.duckTarget) {
      this.duckGain *= this.duckStep;
      if (this.duckGain < this.duckTarget) this.duckGain = this.duckTarget;
    } else if (this.duckGain < this.duckTarget) {
      this.duckGain /= this.duckStep;
      if (this.duckGain > this.duckTarget) this.duckGain = this.duckTarget;
    }
  }

  private resetAmpState(): void {
    this.inDc.reset();
    this.outDc.reset();
    this.gate.reset();
    this.os.reset();
    this.clipper.reset();
    this.low.reset();
    this.mid.reset();
    this.high.reset();
  }
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}
