/**
 * Radix-2 complex FFT with precomputed twiddle and bit-reversal tables. In-place on caller-owned
 * `Float64Array`s, so a transform allocates nothing (safe on the audio thread).
 * @module
 */

/** In-place iterative radix-2 Cooley–Tukey FFT of a fixed power-of-two size. */
export class Fft {
  /** Transform length (a power of two ≥ 2). */
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  /** @param size transform length; must be a power of two ≥ 2. */
  constructor(size: number) {
    if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
      throw new RangeError(`FFT size must be a power of two ≥ 2, got ${size}`);
    }
    this.size = size;
    const half = size >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const a = (-2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0, v = i; b < bits; b++, v >>= 1) r = (r << 1) | (v & 1);
      this.rev[i] = r;
    }
  }

  /** Forward transform, X[k] = Σ x[n]·e^(−2πikn/N), unscaled. Arrays must hold ≥ `size` values. */
  forward(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, 1);
  }

  /** Inverse transform, scaled by 1/N so `inverse(forward(x)) = x`. */
  inverse(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, -1);
    const n = this.size;
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }

  /** `sign` 1 = forward (e^−iθ twiddles), −1 = inverse (conjugate twiddles). */
  private transform(re: Float64Array, im: Float64Array, sign: 1 | -1): void {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    const cos = this.cos;
    const sin = this.sin;
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0, t = 0; k < halfLen; k++, t += step) {
          const wr = cos[t];
          const wi = sign * sin[t];
          const a = start + k;
          const b = a + halfLen;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/**
 * FFT of real signals of length `size` through one complex FFT of `size / 2` (even/odd packing),
 * about twice as fast as a complex transform of the full length. Spectra are the non-redundant
 * half, bins 0…size/2 (`size / 2 + 1` values); the rest follows from Hermitian symmetry.
 */
export class RealFft {
  /** Real signal length (a power of two ≥ 4). */
  readonly size: number;
  private readonly half: Fft;
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;
  /** e^(−2πik/size) for k < size/2. */
  private readonly wr: Float64Array;
  private readonly wi: Float64Array;

  /** @param size real signal length; must be a power of two ≥ 4. */
  constructor(size: number) {
    if (!Number.isInteger(size) || size < 4 || (size & (size - 1)) !== 0) {
      throw new RangeError(`real FFT size must be a power of two ≥ 4, got ${size}`);
    }
    this.size = size;
    const h = size >> 1;
    this.half = new Fft(h);
    this.zr = new Float64Array(h);
    this.zi = new Float64Array(h);
    this.wr = new Float64Array(h);
    this.wi = new Float64Array(h);
    for (let k = 0; k < h; k++) {
      const a = (-2 * Math.PI * k) / size;
      this.wr[k] = Math.cos(a);
      this.wi[k] = Math.sin(a);
    }
  }

  /**
   * Forward transform of `input[0…size)` into bins 0…size/2 of `outRe`/`outIm`
   * (each ≥ size/2 + 1 long). Unscaled, like {@link Fft.forward}.
   */
  forward(input: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
    const h = this.size >> 1;
    const { zr, zi, wr, wi } = this;
    for (let m = 0; m < h; m++) {
      zr[m] = input[2 * m];
      zi[m] = input[2 * m + 1];
    }
    this.half.forward(zr, zi);
    // E[k] = (Z[k] + conj Z[h−k]) / 2, O[k] = (Z[k] − conj Z[h−k]) / 2i, X[k] = E[k] + W^k O[k].
    for (let k = 0; k <= h; k++) {
      const a = k === h ? 0 : k;
      const b = k === 0 ? 0 : h - k;
      const er = 0.5 * (zr[a] + zr[b]);
      const ei = 0.5 * (zi[a] - zi[b]);
      const or = 0.5 * (zi[a] + zi[b]);
      const oi = -0.5 * (zr[a] - zr[b]);
      const c = k === h ? -1 : wr[k];
      const s = k === h ? 0 : wi[k];
      outRe[k] = er + c * or - s * oi;
      outIm[k] = ei + c * oi + s * or;
    }
  }

  /**
   * Inverse of {@link forward}: bins 0…size/2 of a Hermitian spectrum → `output[0…size)`, scaled by
   * 1/size so the round trip is the identity. The imaginary parts of bins 0 and size/2 are ignored.
   */
  inverse(inRe: Float64Array, inIm: Float64Array, output: Float64Array): void {
    const h = this.size >> 1;
    const { zr, zi, wr, wi } = this;
    // E[k] = (X[k] + conj X[h−k]) / 2, O[k] = (X[k] − conj X[h−k]) / (2 W^k), Z[k] = E[k] + i O[k].
    for (let k = 0; k < h; k++) {
      const j = h - k;
      const er = 0.5 * (inRe[k] + inRe[j]);
      const ei = 0.5 * (inIm[k] - inIm[j]);
      const dr = 0.5 * (inRe[k] - inRe[j]);
      const di = 0.5 * (inIm[k] + inIm[j]);
      // Divide by W^k = multiply by conj(W^k).
      const or = dr * wr[k] + di * wi[k];
      const oi = di * wr[k] - dr * wi[k];
      zr[k] = er - oi;
      zi[k] = ei + or;
    }
    // Z = FFT_h(even + i·odd), so the scaled half-length inverse yields the samples directly.
    this.half.inverse(zr, zi);
    for (let m = 0; m < h; m++) {
      output[2 * m] = zr[m];
      output[2 * m + 1] = zi[m];
    }
  }
}
