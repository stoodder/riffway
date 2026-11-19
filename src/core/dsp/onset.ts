/**
 * Amplitude onset detector for a clean DI guitar signal, one hop (default 128 samples) at a time.
 *
 * **Detection function.** Two energies per hop — of the second difference x[n] − 2x[n−1] + x[n−2]
 * (a +12 dB/octave pre-emphasis that weights the broadband pick/finger transient over the ringing
 * partials, whose upper harmonics die out first) and of the plain signal (a new low or pure note
 * under a bright ringing one adds little high-frequency energy) — each turned into a novelty
 * value in dB against its loudest hop of the preceding 20 ms; the detection function is the larger
 * of the two. A hop *triggers* when that novelty exceeds an adaptive threshold — median + k × MAD
 * of the last 0.5 s of novelty, never below {@link MIN_NOVELTY_DB} — and its RMS is above the
 * absolute floor. The trigger is placed on the first sample of the rising edge, searched in the
 * triggering hop and the one before it (so a hit at a hop's end is still timed to the sample): the
 * first sample whose magnitude in the winning band (|second difference| or |x|) exceeds twice the
 * band's peak in the hops before, or, failing that, reaches half the peak of the two hops.
 *
 * **Attack confirmation** (recorded guitar, docs/audio-input.md § Audio-pipeline results). The pick
 * or fingertip touching the string makes a small transient 20–70 ms ahead of the pluck. A trigger
 * past the refractory period is reported at once unless it is *suspect*:
 * - **weak** — its attack (the hops within {@link ATTACK_MS} of it) stays {@link WEAK_DB} or more
 *   below the recent playing level (a peak follower of the hop energy that falls
 *   {@link RECENT_DECAY_DB_PER_SEC} and never reads below the floor + {@link RECENT_OVER_FLOOR_DB}),
 *   the signature of contact noise before a pluck; or
 * - **no new energy** — its plain energy never rises {@link RISE_DB} above the 20 ms before it: a
 *   pick touching a ringing string rather than plucking it.
 *
 * A suspect trigger is held and replaced by a later attack {@link REANCHOR_DB} louder than it (the
 * pluck after the contact noise), or — for a no-new-energy contact that then damped the string by
 * {@link DAMP_DB} — by the next trigger (the pluck after the pick stopped the old note). Otherwise
 * it is reported when its attack turns out loud after all; when a no-new-energy trigger has
 * sustained undamped for {@link SUSTAIN_MS} (a re-pick at the ringing level); when an unrelated
 * trigger arrives past the refractory period (the held onset is returned first, the new one on the
 * following hop); or after {@link CONFIRM_MS} at the latest. A suspect trigger is only held when the
 * last reported onset is at least {@link HOLD_GUARD_SEC} + 2560 samples old, so the analysis core
 * never measures a previous onset's pitch window (25 ms + up to 2048 + 512 samples) across an onset
 * the detector is still holding. Holding delays only the report, never the onset frame: the
 * worklet's onset message waits 25 ms + N for the pitch window anyway, so a hold adds at most
 * {@link CONFIRM_MS} − (25 ms + N) to it (docs/audio-input.md § Pitch and onset detection worklet).
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

/** Hops starting within this long after a trigger belong to its attack (peak level; merged triggers). */
export const ATTACK_MS = 10;
/** Longest hold of a suspect trigger, ms (covers contact noise up to ~70 ms before the pluck). */
export const CONFIRM_MS = 70;
/** A held trigger is replaced by an attack at least this much louder (plain or second-difference energy), dB. */
export const REANCHOR_DB = 12;
/** A trigger whose attack stays this far below the recent playing level is suspect, dB. */
export const WEAK_DB = 14;
/** Fall rate of the recent-level peak follower, dB/s. */
export const RECENT_DECAY_DB_PER_SEC = 10;
/**
 * The recent level never reads below the absolute floor + this, dB, so after silence (the first
 * note of a song) a trigger within {@link RECENT_OVER_FLOOR_DB} − {@link WEAK_DB} (6 dB) of the
 * floor is still suspect.
 */
export const RECENT_OVER_FLOOR_DB = 20;
/**
 * A held no-new-energy trigger (not weak) whose energy has not fallen {@link DAMP_DB} this long
 * after it is a note re-picked or played at the ringing level: it is reported then, ms. Below the
 * shortest pitch delay (25 ms + 1024 samples), so such holds never delay the onset message.
 */
export const SUSTAIN_MS = 40;
/** A trigger whose plain energy does not rise this much over the 20 ms before it adds no new energy, dB. */
export const RISE_DB = 3;
/** A no-new-energy contact that then damps the string by this much is not a note, dB. */
export const DAMP_DB = 10;
/**
 * Holding a suspect trigger needs the last reported onset to be this long + 2560 samples old: the
 * analysis core's pitch window for an onset ends 25 ms + 2048 samples (+ 512 for its one retry)
 * after it.
 */
export const HOLD_GUARD_SEC = 0.025;
/** Samples the hold guard adds to {@link HOLD_GUARD_SEC} (largest window + retry shift). */
const HOLD_GUARD_SAMPLES = 2048 + 512;

/**
 * Create an onset detector. `process(hop, startFrame)` takes exactly `opts.hop` samples whose first
 * sample is context frame `startFrame` and returns an onset frame or −1. Usually the frame falls in
 * the current or the previous hop; a held suspect trigger is returned up to {@link CONFIRM_MS} plus a
 * hop after its frame, and an onset that was due in the same hop as a released one a hop later
 * (see the module notes). Onsets are always returned in order.
 */
export function createOnsetDetector(opts: OnsetDetectorOptions): OnsetDetector {
  return new EnergyOnsetDetector(opts);
}

/** dB → power ratio. */
function powerRatio(db: number): number {
  return 10 ** (db / 10);
}
const REANCHOR_RATIO = powerRatio(REANCHOR_DB);
const WEAK_RATIO = powerRatio(WEAK_DB);
const RISE_RATIO = powerRatio(RISE_DB);
const DAMP_RATIO = powerRatio(DAMP_DB);

class EnergyOnsetDetector implements OnsetDetector {
  private readonly hop: number;
  private readonly k: number;
  private readonly floorMeanSquare: number;
  private readonly refractoryFrames: number;
  private readonly attackFrames: number;
  private readonly confirmFrames: number;
  private readonly sustainFrames: number;
  private readonly holdGuardFrames: number;
  /** Lowest value of the recent-level follower (mean square). */
  private readonly recentFloor: number;
  /** Per-hop decay factor of the recent-level follower (power). */
  private readonly recentDecay: number;
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
  /** Last reported onset frame. */
  private lastOnset = -Infinity;
  /** An onset to return on the next hop (two were due in one hop); −1 = none. */
  private queued = -1;
  /** The current hop's return value (−1 = none). */
  private out = -1;
  /** Peak follower of the plain hop energy (mean square), never below {@link recentFloor}. */
  private recentLevel: number;

  // Held (suspect) trigger; `held` false = none.
  private held = false;
  private heldFrame = 0;
  /** Recent level when the trigger fired (the weak test compares against it). */
  private heldRecent = 0;
  /** Plain energy reference (loudest hop of the 20 ms before the trigger). */
  private heldRef = 0;
  /** Attack peaks (hops within ATTACK_MS of the trigger). */
  private heldPeak = 0;
  private heldHfPeak = 0;
  /** Quietest plain hop energy after the attack. */
  private heldMin = Infinity;
  /** Latest trigger after the attack but within the refractory period (−1 = none): a re-anchor point. */
  private challenger = -1;

  constructor(opts: OnsetDetectorOptions) {
    const { sampleRate, hop = 128, k = 4, floorDb = -50, refractoryMs = 40 } = opts;
    if (!(sampleRate > 0)) throw new RangeError(`sample rate must be > 0, got ${sampleRate}`);
    if (!Number.isInteger(hop) || hop < 16) throw new RangeError(`hop must be an integer ≥ 16, got ${hop}`);
    this.hop = hop;
    this.k = k;
    this.floorMeanSquare = 10 ** (floorDb / 10);
    this.recentFloor = this.floorMeanSquare * powerRatio(RECENT_OVER_FLOOR_DB);
    this.recentLevel = this.recentFloor;
    this.refractoryFrames = Math.round((refractoryMs / 1000) * sampleRate);
    this.attackFrames = Math.round((ATTACK_MS / 1000) * sampleRate);
    this.confirmFrames = Math.round((CONFIRM_MS / 1000) * sampleRate);
    this.sustainFrames = Math.round((SUSTAIN_MS / 1000) * sampleRate);
    this.holdGuardFrames = Math.round(HOLD_GUARD_SEC * sampleRate) + HOLD_GUARD_SAMPLES;
    this.recentDecay = powerRatio((-RECENT_DECAY_DB_PER_SEC * hop) / sampleRate);
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
    const recentBefore = this.recentLevel;
    this.recentLevel = Math.max(energy, this.recentLevel * this.recentDecay, this.recentFloor);

    // The first hops after (re)start only fill the reference: a signal already playing is not an onset.
    const warm = this.historyCount > energies.length;
    const triggered = warm && novelty >= threshold && energy >= this.floorMeanSquare;
    const edge = triggered
      ? startFrame +
        (hfNovelty >= plainNovelty ? edgeOffset(this.dPrev, d, n, hfBackground) : edgeOffset(this.aPrev, a, n, background))
      : -1;
    this.dCur = this.dPrev;
    this.dPrev = d;
    this.aCur = this.aPrev;
    this.aPrev = a;

    this.out = this.queued;
    this.queued = -1;

    if (this.held) {
      if (startFrame < this.heldFrame + this.attackFrames) {
        // Still the held trigger's attack: its peaks grow; it is released once it proves loud.
        if (energy > this.heldPeak) this.heldPeak = energy;
        if (hfEnergy > this.heldHfPeak) this.heldHfPeak = hfEnergy;
        if (!this.heldSuspect()) this.release();
      } else {
        if (energy < this.heldMin) this.heldMin = energy;
        if (energy >= this.heldPeak * REANCHOR_RATIO || hfEnergy >= this.heldHfPeak * REANCHOR_RATIO) {
          // The pluck after the contact noise: re-anchor to its rising edge.
          const at = edge >= 0 ? edge : this.challenger >= 0 ? this.challenger : -1;
          if (at >= 0) {
            this.held = false;
            this.startTrigger(at, energy, hfEnergy, recentBefore, ref);
          }
        } else if (edge >= 0) {
          const damped = this.heldPeak < this.heldRef * RISE_RATIO && this.heldMin * DAMP_RATIO <= this.heldPeak;
          if (damped) {
            // The pick stopped the ringing string; this trigger is the pluck.
            this.held = false;
            this.startTrigger(edge, energy, hfEnergy, recentBefore, ref);
          } else if (edge - this.heldFrame < this.refractoryFrames) {
            this.challenger = edge;
          } else {
            this.release();
            this.startTrigger(edge, energy, hfEnergy, recentBefore, ref);
          }
        }
        if (this.held) {
          const end = startFrame + n;
          const weak = this.heldPeak * WEAK_RATIO <= this.heldRecent;
          const sustained = !weak && end >= this.heldFrame + this.sustainFrames && this.heldMin * DAMP_RATIO > this.heldPeak;
          if (sustained || end >= this.heldFrame + this.confirmFrames) this.release();
        }
      }
    } else if (edge >= 0 && edge - this.lastOnset >= this.refractoryFrames) {
      this.startTrigger(edge, energy, hfEnergy, recentBefore, ref);
    }
    return this.out;
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
    this.queued = -1;
    this.out = -1;
    this.recentLevel = this.recentFloor;
    this.held = false;
    this.challenger = -1;
  }

  /**
   * A new trigger at `frame`: report it, or hold it when it is suspect and the guard allows.
   * `energy`/`hfEnergy` are its hop's energies, `recent` the follower before this hop, `ref` the
   * plain reference of the 20 ms before it.
   */
  private startTrigger(frame: number, energy: number, hfEnergy: number, recent: number, ref: number): void {
    this.heldFrame = frame;
    this.heldRecent = recent;
    this.heldRef = ref;
    this.heldPeak = energy;
    this.heldHfPeak = hfEnergy;
    this.heldMin = Infinity;
    this.challenger = -1;
    if (this.heldSuspect() && frame - this.lastOnset >= this.holdGuardFrames) this.held = true;
    else this.report(frame);
  }

  /** Report the held trigger. */
  private release(): void {
    this.held = false;
    this.report(this.heldFrame);
  }

  /** Return `frame` from this hop's `process()`, or from the next one if this hop already reports one. */
  private report(frame: number): void {
    this.lastOnset = frame;
    if (this.out < 0) this.out = frame;
    else this.queued = frame;
  }

  /** The held (or just started) trigger is weak against the recent level, or added no new energy. */
  private heldSuspect(): boolean {
    const weak = this.heldPeak * WEAK_RATIO <= this.heldRecent;
    const noRise = this.heldPeak < this.heldRef * RISE_RATIO;
    return weak || noRise;
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
