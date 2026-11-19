/**
 * Runaway (acoustic feedback) detector for the monitor path (docs/monitoring.md § Headphones and
 * feedback guard). Runs on the amp worklet's input, so it reacts on the audio thread without waiting
 * for the main thread.
 *
 * Every {@link GUARD.hopSize} samples it measures the RMS of the DC-blocked input (a DC offset is
 * not sound and must not look like a loud pure tone). It trips when either
 * - **feedback:** the RMS has stayed above −10 dBFS for ≥ 300 ms, rose by > 12 dB within the last
 *   1 s, and the spectrum is dominated by one partial (the strongest FFT bin plus its two neighbours,
 *   i.e. the main lobe of a Hann-windowed sinusoid, carries ≥ 70 % of the power); or
 * - **runaway level:** the RMS has stayed above −3 dBFS for ≥ 500 ms, whatever the spectrum (an
 *   input pinned near full scale is never useful to monitor).
 * Allocation-free after construction.
 * @module
 */
import { RealFft } from '../fft';
import { DcBlocker } from './filters';

/** Detector parameters. */
export const GUARD = {
  /** RMS hop (samples at 48 kHz ≈ 10.7 ms; scaled to the sample rate). */
  hopSize: 512,
  /** FFT size for the tonality check. */
  fftSize: 2048,
  /** Feedback: level floor (dBFS RMS) that must hold for {@link GUARD.sustainSec}. */
  levelDb: -10,
  sustainSec: 0.3,
  /** Feedback: required rise (dB) within {@link GUARD.riseWindowSec}. */
  riseDb: 12,
  riseWindowSec: 1,
  /**
   * Feedback: main-lobe power / total power. A sustained guitar note measures 0.5–0.6 (its harmonics
   * carry the rest) and a chord 0.2–0.5; a feedback howl is a near-sine (≥ 0.9, ≈ 0.8 even when
   * squared off by heavy drive), so 0.7 separates them.
   */
  tonality: 0.7,
  /** Runaway level: dBFS RMS that must hold for {@link GUARD.runawaySec}. */
  runawayDb: -3,
  runawaySec: 0.5,
} as const;

/** Why the guard tripped. */
export type GuardTrip = 'feedback' | 'runaway-level';

/** Very low level used for silence (dB). */
const FLOOR_DB = -120;

/** Hop size scaled to the sample rate (a power of two near 10.7 ms). */
function hopFor(sampleRate: number): number {
  return sampleRate > 64000 ? GUARD.hopSize * 2 : GUARD.hopSize;
}

/** Feedback/runaway detector. Feed it every input block; it reports a trip once until {@link reset}. */
export class RunawayGuard {
  /** Samples per RMS measurement. */
  readonly hop: number;
  private readonly hopSec: number;
  private readonly ring: Float64Array;
  private ringPos = 0;
  private readonly dc: DcBlocker;
  private readonly fft: RealFft;
  private readonly win: Float64Array;
  private readonly frame: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  /** Last ~1 s of hop RMS values (dB), circular. */
  private readonly history: Float64Array;
  private histPos = 0;
  private hopAcc = 0;
  private hopCount = 0;
  private aboveSec = 0;
  private runawaySec = 0;
  private tripped = false;

  constructor(sampleRate: number) {
    this.hop = hopFor(sampleRate);
    this.hopSec = this.hop / sampleRate;
    this.ring = new Float64Array(GUARD.fftSize);
    this.dc = new DcBlocker(sampleRate, 20);
    this.fft = new RealFft(GUARD.fftSize);
    this.win = new Float64Array(GUARD.fftSize);
    for (let i = 0; i < GUARD.fftSize; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GUARD.fftSize);
    this.frame = new Float64Array(GUARD.fftSize);
    this.re = new Float64Array(GUARD.fftSize / 2 + 1);
    this.im = new Float64Array(GUARD.fftSize / 2 + 1);
    this.history = new Float64Array(Math.max(1, Math.round(GUARD.riseWindowSec / this.hopSec))).fill(FLOOR_DB);
  }

  /** True after a trip, until {@link reset}. */
  get isTripped(): boolean {
    return this.tripped;
  }

  /**
   * Analyse `n` samples of `block`. Returns the trip reason the first time the guard trips, else null.
   */
  process(block: Float32Array, n = block.length): GuardTrip | null {
    let result: GuardTrip | null = null;
    for (let i = 0; i < n; i++) {
      const x = block[i]!;
      const v = this.dc.tick(Number.isFinite(x) ? x : 0);
      this.ring[this.ringPos] = v;
      this.ringPos = (this.ringPos + 1) % GUARD.fftSize;
      this.hopAcc += v * v;
      if (++this.hopCount === this.hop) {
        const trip = this.endHop();
        if (trip && !result) result = trip;
      }
    }
    return result;
  }

  /** Forget everything (after the user re-enables monitoring). */
  reset(): void {
    this.history.fill(FLOOR_DB);
    this.ring.fill(0);
    this.dc.reset();
    this.ringPos = 0;
    this.histPos = 0;
    this.hopAcc = 0;
    this.hopCount = 0;
    this.aboveSec = 0;
    this.runawaySec = 0;
    this.tripped = false;
  }

  /** Spectral main-lobe power ratio of the latest {@link GUARD.fftSize} samples (0–1). */
  tonality(): number {
    const N = GUARD.fftSize;
    for (let i = 0; i < N; i++) this.frame[i] = this.ring[(this.ringPos + i) % N]! * this.win[i]!;
    this.fft.forward(this.frame, this.re, this.im);
    let total = 0;
    let peak = 0;
    let peakBin = 1;
    const bins = N / 2;
    // Skip DC; power per bin.
    for (let k = 1; k <= bins; k++) {
      const p = this.re[k]! * this.re[k]! + this.im[k]! * this.im[k]!;
      this.re[k] = p;
      total += p;
      if (p > peak) {
        peak = p;
        peakBin = k;
      }
    }
    if (total <= 0) return 0;
    let lobe = peak;
    if (peakBin > 1) lobe += this.re[peakBin - 1]!;
    if (peakBin < bins) lobe += this.re[peakBin + 1]!;
    return lobe / total;
  }

  private endHop(): GuardTrip | null {
    const rms = Math.sqrt(this.hopAcc / this.hop);
    this.hopAcc = 0;
    this.hopCount = 0;
    const db = rms > 1e-6 ? 20 * Math.log10(rms) : FLOOR_DB;
    // Minimum over the last ~1 s, before recording this hop.
    let min = Infinity;
    for (let i = 0; i < this.history.length; i++) if (this.history[i]! < min) min = this.history[i]!;
    this.history[this.histPos] = db;
    this.histPos = (this.histPos + 1) % this.history.length;
    this.aboveSec = db > GUARD.levelDb ? this.aboveSec + this.hopSec : 0;
    this.runawaySec = db > GUARD.runawayDb ? this.runawaySec + this.hopSec : 0;
    if (this.tripped) return null;
    // Tolerance of half a hop so the hop grid doesn't decide the threshold.
    const tol = this.hopSec / 2;
    if (this.runawaySec + tol >= GUARD.runawaySec) {
      this.tripped = true;
      return 'runaway-level';
    }
    if (this.aboveSec + tol >= GUARD.sustainSec && db - min > GUARD.riseDb && this.tonality() >= GUARD.tonality) {
      this.tripped = true;
      return 'feedback';
    }
    return null;
  }
}
