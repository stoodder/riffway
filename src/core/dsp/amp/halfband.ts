/**
 * 2× polyphase half-band FIR interpolator/decimator and the 4× oversampler built from two stages.
 *
 * A half-band low-pass (cutoff at a quarter of the high rate) has every second tap zero except the
 * centre (0.5), so each 2× stage costs one short FIR branch plus a pure delay. Taps are a
 * Kaiser-windowed sinc; each polyphase branch is normalised to unity DC gain. Lengths are `4K − 1`,
 * which puts the centre tap on an odd index and makes the delay branch an integer delay.
 *
 * Linear phase: the round trip is a pure delay (≈ 17.75 base-rate samples, 0.37 ms at 48 kHz); see
 * {@link oversamplerLatency}.
 * @module
 */

/** Zeroth-order modified Bessel function of the first kind (series; converges fast for β ≤ 20). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * Design half-band taps of length `taps` (`4K − 1`, ≥ 7) with a Kaiser window of shape `beta`.
 * Returns the full symmetric impulse response (centre tap 0.5).
 */
export function designHalfband(taps: number, beta: number): Float64Array {
  if (!Number.isInteger(taps) || taps < 7 || (taps + 1) % 4 !== 0) {
    throw new RangeError(`half-band length must be 4K − 1 and ≥ 7, got ${taps}`);
  }
  const h = new Float64Array(taps);
  const c = (taps - 1) / 2;
  const i0b = besselI0(beta);
  let oddSum = 0;
  for (let k = 0; k < taps; k++) {
    const m = k - c;
    if (m === 0) {
      h[k] = 0.5;
      continue;
    }
    if (m % 2 === 0) continue; // half-band zeros
    const sinc = Math.sin((Math.PI * m) / 2) / (Math.PI * m);
    const r = m / c;
    h[k] = sinc * (besselI0(beta * Math.sqrt(1 - r * r)) / i0b);
    oddSum += h[k];
  }
  // Normalise the FIR branch to 0.5 so both polyphase branches have DC gain exactly 0.5 (×2 = unity).
  for (let k = 0; k < taps; k++) if ((k - c) % 2 !== 0) h[k] *= 0.5 / oddSum;
  return h;
}

/** The non-zero, non-centre taps (the FIR polyphase branch), in order. */
function branchTaps(h: Float64Array): Float64Array {
  const c = (h.length - 1) / 2;
  const out = new Float64Array((h.length + 1) / 2);
  let j = 0;
  for (let k = 0; k < h.length; k++) if ((k - c) % 2 !== 0) out[j++] = h[k]!;
  return out;
}

/**
 * Circular delay line with a doubled buffer so the most recent `size` samples are always
 * contiguous (`buf[pos … pos + size)`, newest last) and FIR loops need no modulo.
 */
class History {
  readonly buf: Float64Array;
  pos = 0;
  constructor(readonly size: number) {
    this.buf = new Float64Array(size * 2);
  }
  /** Push one sample; afterwards `buf[pos + size − 1]` is the newest. */
  push(x: number): void {
    this.buf[this.pos] = x;
    this.buf[this.pos + this.size] = x;
    this.pos = this.pos + 1 === this.size ? 0 : this.pos + 1;
  }
  /** Sample `ago` steps back (0 = newest). */
  at(ago: number): number {
    return this.buf[this.pos + this.size - 1 - ago]!;
  }
  reset(): void {
    this.buf.fill(0);
    this.pos = 0;
  }
}

/** Dot product of branch taps with the history (taps[0] meets the newest sample). */
function fir(taps: Float64Array, hist: History): number {
  const { buf } = hist;
  const newest = hist.pos + hist.size - 1;
  let acc = 0;
  for (let j = 0; j < taps.length; j++) acc += taps[j]! * buf[newest - j]!;
  return acc;
}

/** One 2× half-band stage: interpolate (1 → 2 samples) and decimate (2 → 1 sample). */
export class HalfbandStage {
  /** Full impulse response (for tests and response plots). */
  readonly taps: Float64Array;
  /** Group delay in samples at this stage's high rate, per filter. */
  readonly delay: number;
  private readonly branch: Float64Array;
  /** Index of the centre tap within the branch's span, in low-rate samples. */
  private readonly centreLag: number;
  private readonly upHist: History;
  private readonly downEven: History;
  private readonly downOdd: History;

  constructor(taps: number, beta: number) {
    this.taps = designHalfband(taps, beta);
    this.branch = branchTaps(this.taps);
    this.delay = (taps - 1) / 2;
    this.centreLag = (this.delay - 1) / 2;
    this.upHist = new History(this.branch.length);
    this.downEven = new History(this.branch.length);
    this.downOdd = new History(this.centreLag + 1);
  }

  /** Interpolate one input sample into two output samples written at `out[at]`, `out[at + 1]`. */
  up(x: number, out: Float64Array, at: number): void {
    this.upHist.push(x);
    // Even output: FIR branch (×2 for interpolation gain); odd output: centre tap = pure delay.
    out[at] = 2 * fir(this.branch, this.upHist);
    out[at + 1] = this.upHist.at(this.centreLag);
  }

  /** Decimate two high-rate samples (`a` earlier, `b` later) into one. */
  down(a: number, b: number): number {
    // y = Σ branch·(samples on the FIR phase) + 0.5 · (sample on the centre phase).
    this.downEven.push(b);
    this.downOdd.push(a);
    return fir(this.branch, this.downEven) + 0.5 * this.downOdd.at(this.centreLag);
  }

  /** Clear all state. */
  reset(): void {
    this.upHist.reset();
    this.downEven.reset();
    this.downOdd.reset();
  }
}

/** Oversampler stage design: stage 1 runs at 2× and needs the steep filter; stage 2 at 4× is relaxed. */
export const OVERSAMPLER_DESIGN = {
  stage1: { taps: 31, beta: 8 },
  stage2: { taps: 15, beta: 7 },
} as const;

/**
 * Total round-trip (up + down) group delay of the 4× oversampler, in base-rate samples. A stage with
 * centre tap `c` delays its input stream by `c − ½` samples of that stream's rate: `c / 2` in the
 * interpolator plus `(c − 1) / 2` in the decimator, which reads each output on the later sample of
 * its pair. Stage 2's input stream runs at 2×.
 */
export function oversamplerLatency(): number {
  const c1 = (OVERSAMPLER_DESIGN.stage1.taps - 1) / 2;
  const c2 = (OVERSAMPLER_DESIGN.stage2.taps - 1) / 2;
  return c1 - 0.5 + (c2 - 0.5) / 2;
}

/**
 * 4× oversampler (two cascaded 2× half-band stages). Call {@link up} with one base-rate sample to get
 * four high-rate samples in {@link block}, process them in place, then {@link down} to get one
 * base-rate sample back.
 */
export class Oversampler4x {
  /** The four high-rate samples of the current base-rate sample. */
  readonly block = new Float64Array(4);
  private readonly s1 = new HalfbandStage(OVERSAMPLER_DESIGN.stage1.taps, OVERSAMPLER_DESIGN.stage1.beta);
  private readonly s2 = new HalfbandStage(OVERSAMPLER_DESIGN.stage2.taps, OVERSAMPLER_DESIGN.stage2.beta);
  private readonly mid = new Float64Array(2);

  /** Interpolate `x` into {@link block}. */
  up(x: number): void {
    this.s1.up(x, this.mid, 0);
    this.s2.up(this.mid[0]!, this.block, 0);
    this.s2.up(this.mid[1]!, this.block, 2);
  }

  /** Decimate {@link block} back to one base-rate sample. */
  down(): number {
    const b = this.block;
    const m0 = this.s2.down(b[0]!, b[1]!);
    const m1 = this.s2.down(b[2]!, b[3]!);
    return this.s1.down(m0, m1);
  }

  /** Clear all state. */
  reset(): void {
    this.s1.reset();
    this.s2.reset();
    this.block.fill(0);
  }
}
