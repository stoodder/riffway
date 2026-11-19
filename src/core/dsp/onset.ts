/**
 * Amplitude onset detector for a clean DI guitar signal, one hop (default 128 samples) at a time.
 *
 * Detection function: two energies per hop — of the second difference x[n] − 2x[n−1] + x[n−2]
 * (a +12 dB/octave pre-emphasis that weights the broadband pick/finger transient over the ringing
 * partials, whose upper harmonics die out first) and of the plain signal (a new low or pure note
 * under a bright ringing one adds little high-frequency energy) — each turned into a novelty
 * value in dB against its loudest hop of the preceding 20 ms; the detection function is the larger
 * of the two. A hop is an onset when that novelty exceeds an
 * adaptive threshold — median + k × MAD of the last 0.5 s of novelty, never below
 * {@link MIN_NOVELTY_DB} — its RMS is above the absolute floor, and the refractory period has
 * passed. The onset is then placed on the first sample of the rising edge, searched in the
 * triggering hop and the one before it (so a hit at a hop's end is still timed to the sample): the
 * first sample whose magnitude in the winning band (|second difference| or |x|) exceeds twice the
 * band's peak in the hops before, or, failing that, reaches half the peak of the two hops.
 *
 * Allocation-free after construction.
 * @module
 */
import type { OnsetDetector, OnsetDetectorOptions } from './index';

/** Novelty must exceed this (dB rise of a hop's energy) whatever the adaptive threshold says. */
export const MIN_NOVELTY_DB = 6;
/** Length of the adaptive-threshold history, seconds. */
const HISTORY_SEC = 0.5;
/**
 * The novelty reference is the highest hop energy over this span before the current hop. It must
 * cover a full period of the lowest string (E2: 12.1 ms; D2: 13.6 ms) because a hop is shorter than
 * that period and its energy swings with the waveform's phase.
 */
const REF_SPAN_MS = 20;
/** Regulariser for the energy ratios (−100 dB per-sample power), so silence reads 0 dB. */
const ENERGY_EPS = 1e-10;
/** Onset placement: first sample above this multiple of the background peak (6 dB)… */
const EDGE_OVER_BACKGROUND = 2;
/** …else the first sample reaching this fraction of the edge's own peak. */
const EDGE_FRACTION = 0.5;

/**
 * Create an onset detector. `process(hop, startFrame)` takes exactly `opts.hop` samples whose first
 * sample is context frame `startFrame` and returns the onset frame (it may fall in the previous
 * hop) or −1.
 */
export function createOnsetDetector(opts: OnsetDetectorOptions): OnsetDetector {
  return new EnergyOnsetDetector(opts);
}

class EnergyOnsetDetector implements OnsetDetector {
  private readonly hop: number;
  private readonly k: number;
  private readonly floorMeanSquare: number;
  private readonly refractoryFrames: number;
  /** |second difference| of the previous and the current hop. */
  private dPrev: Float64Array;
  private dCur: Float64Array;
  /** |x| of the previous and the current hop. */
  private aPrev: Float64Array;
  private aCur: Float64Array;
  /** Second-difference and plain energies and peaks of the hops in the reference span (rings). */
  private readonly hfEnergies: Float64Array;
  private readonly energies: Float64Array;
  private readonly hfPeaks: Float64Array;
  private readonly peaks: Float64Array;
  private energyPos = 0;
  /** Novelty history for the adaptive threshold (ring). */
  private readonly history: Float64Array;
  private readonly scratch: Float64Array;
  private historyPos = 0;
  private historyCount = 0;
  private lastSample = 0;
  private lastSample2 = 0;
  private lastOnset = -Infinity;

  constructor(opts: OnsetDetectorOptions) {
    const { sampleRate, hop = 128, k = 4, floorDb = -50, refractoryMs = 40 } = opts;
    if (!(sampleRate > 0)) throw new RangeError(`sample rate must be > 0, got ${sampleRate}`);
    if (!Number.isInteger(hop) || hop < 16) throw new RangeError(`hop must be an integer ≥ 16, got ${hop}`);
    this.hop = hop;
    this.k = k;
    this.floorMeanSquare = 10 ** (floorDb / 10);
    this.refractoryFrames = Math.round((refractoryMs / 1000) * sampleRate);
    const refHops = Math.max(1, Math.ceil(((REF_SPAN_MS / 1000) * sampleRate) / hop));
    this.hfEnergies = new Float64Array(refHops);
    this.energies = new Float64Array(refHops);
    this.hfPeaks = new Float64Array(refHops);
    this.peaks = new Float64Array(refHops);
    this.dPrev = new Float64Array(hop);
    this.dCur = new Float64Array(hop);
    this.aPrev = new Float64Array(hop);
    this.aCur = new Float64Array(hop);
    const histLen = Math.max(8, Math.round((HISTORY_SEC * sampleRate) / hop));
    this.history = new Float64Array(histLen);
    this.scratch = new Float64Array(histLen);
  }

  process(hop: Float32Array, startFrame: number): number {
    const n = this.hop;
    if (hop.length !== n) throw new RangeError(`expected a hop of ${n} samples, got ${hop.length}`);
    const d = this.dCur;
    const a = this.aCur;
    let prev = this.lastSample;
    let prev2 = this.lastSample2;
    let hfEnergy = 0;
    let energy = 0;
    let hfPeak = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const v = hop[i];
      const diff = v - 2 * prev + prev2;
      const ad = Math.abs(diff);
      const av = Math.abs(v);
      d[i] = ad;
      a[i] = av;
      if (ad > hfPeak) hfPeak = ad;
      if (av > peak) peak = av;
      hfEnergy += diff * diff;
      energy += v * v;
      prev2 = prev;
      prev = v;
    }
    this.lastSample = prev;
    this.lastSample2 = prev2;
    hfEnergy /= n;
    energy /= n;

    const { hfEnergies, energies, hfPeaks, peaks } = this;
    const latest = (this.energyPos + energies.length - 1) % energies.length;
    let hfRef = 0;
    let ref = 0;
    let hfBackground = 0;
    let background = 0;
    for (let i = 0; i < energies.length; i++) {
      if (hfEnergies[i] > hfRef) hfRef = hfEnergies[i];
      if (energies[i] > ref) ref = energies[i];
      // Background for edge placement: the hops before the previous one.
      if (i !== latest) {
        if (hfPeaks[i] > hfBackground) hfBackground = hfPeaks[i];
        if (peaks[i] > background) background = peaks[i];
      }
    }
    const hfNovelty = 10 * Math.log10((hfEnergy + ENERGY_EPS) / (hfRef + ENERGY_EPS));
    const plainNovelty = 10 * Math.log10((energy + ENERGY_EPS) / (ref + ENERGY_EPS));
    const novelty = Math.max(hfNovelty, plainNovelty);
    const threshold = Math.max(MIN_NOVELTY_DB, this.adaptiveThreshold());

    hfEnergies[this.energyPos] = hfEnergy;
    energies[this.energyPos] = energy;
    hfPeaks[this.energyPos] = hfPeak;
    peaks[this.energyPos] = peak;
    this.energyPos = (this.energyPos + 1) % energies.length;
    this.history[this.historyPos] = novelty;
    this.historyPos = (this.historyPos + 1) % this.history.length;
    if (this.historyCount < this.history.length) this.historyCount++;

    let onset = -1;
    // The first hops after (re)start only fill the reference: a signal already playing is not an onset.
    const warm = this.historyCount > energies.length;
    if (warm && novelty >= threshold && energy >= this.floorMeanSquare) {
      const frame =
        startFrame +
        (hfNovelty >= plainNovelty
          ? edgeOffset(this.dPrev, d, n, hfBackground)
          : edgeOffset(this.aPrev, a, n, background));
      if (frame - this.lastOnset >= this.refractoryFrames) {
        this.lastOnset = frame;
        onset = frame;
      }
    }
    this.dCur = this.dPrev;
    this.dPrev = d;
    this.aCur = this.aPrev;
    this.aPrev = a;
    return onset;
  }

  reset(): void {
    this.dPrev.fill(0);
    this.dCur.fill(0);
    this.aPrev.fill(0);
    this.aCur.fill(0);
    this.hfEnergies.fill(0);
    this.energies.fill(0);
    this.hfPeaks.fill(0);
    this.peaks.fill(0);
    this.energyPos = 0;
    this.history.fill(0);
    this.historyPos = 0;
    this.historyCount = 0;
    this.lastSample = 0;
    this.lastSample2 = 0;
    this.lastOnset = -Infinity;
  }

  /** median + k × MAD of the novelty history (−∞ while empty). */
  private adaptiveThreshold(): number {
    const count = this.historyCount;
    if (count === 0) return -Infinity;
    const s = this.scratch;
    for (let i = 0; i < count; i++) s[i] = this.history[i];
    const median = medianInPlace(s, count);
    for (let i = 0; i < count; i++) s[i] = Math.abs(this.history[i] - median);
    return median + this.k * medianInPlace(s, count);
  }
}

/**
 * Rising-edge offset relative to the current hop (≤ 0 reaches into the previous one): the first
 * sample above {@link EDGE_OVER_BACKGROUND} × `background`, else the first reaching
 * {@link EDGE_FRACTION} of the peak over both hops.
 */
function edgeOffset(prev: Float64Array, cur: Float64Array, n: number, background: number): number {
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, prev[i], cur[i]);
  const level = Math.min(EDGE_OVER_BACKGROUND * background, EDGE_FRACTION * peak) || EDGE_FRACTION * peak;
  for (let i = 0; i < n; i++) if (prev[i] > level) return i - n;
  for (let i = 0; i < n; i++) if (cur[i] > level) return i;
  return 0;
}

/** Median of `a[0…count)` by quickselect; reorders that prefix. */
function medianInPlace(a: Float64Array, count: number): number {
  const mid = count >> 1;
  const upper = select(a, count, mid);
  if (count & 1) return upper;
  let lower = -Infinity;
  for (let i = 0; i < mid; i++) lower = Math.max(lower, a[i]);
  return 0.5 * (lower + upper);
}

/** Hoare quickselect: returns the `k`-th smallest of `a[0…count)`, leaving smaller values before it. */
function select(a: Float64Array, count: number, k: number): number {
  let lo = 0;
  let hi = count - 1;
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}
