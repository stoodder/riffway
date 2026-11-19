import { describe, expect, it } from 'vitest';
import { Fft, RealFft } from '@core/dsp';
import { rng } from '../helpers/signals';

/** Naive O(n²) DFT reference. */
function dft(re: Float64Array, im: Float64Array): [Float64Array, Float64Array] {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      outRe[k] += re[t] * Math.cos(a) - im[t] * Math.sin(a);
      outIm[k] += re[t] * Math.sin(a) + im[t] * Math.cos(a);
    }
  }
  return [outRe, outIm];
}

function randomArray(n: number, seed: number): Float64Array {
  const r = rng(seed);
  return Float64Array.from({ length: n }, () => r() * 2 - 1);
}

function maxDiff(a: Float64Array, b: Float64Array, n = a.length): number {
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('Fft (radix-2 complex)', () => {
  it.each([2, 4, 8, 64, 256])('matches a naive DFT at n = %i', (n) => {
    const re = randomArray(n, n);
    const im = randomArray(n, n + 1);
    const [refRe, refIm] = dft(re, im);
    new Fft(n).forward(re, im);
    expect(maxDiff(re, refRe)).toBeLessThan(1e-9);
    expect(maxDiff(im, refIm)).toBeLessThan(1e-9);
  });

  it('inverse undoes forward', () => {
    const fft = new Fft(1024);
    const re = randomArray(1024, 1);
    const im = randomArray(1024, 2);
    const re0 = re.slice();
    const im0 = im.slice();
    fft.forward(re, im);
    fft.inverse(re, im);
    expect(maxDiff(re, re0)).toBeLessThan(1e-12);
    expect(maxDiff(im, im0)).toBeLessThan(1e-12);
  });

  it('rejects sizes that are not powers of two', () => {
    for (const n of [0, 1, 3, 100, 1.5]) expect(() => new Fft(n)).toThrow(RangeError);
  });
});

describe('RealFft (real input via half-size complex FFT)', () => {
  it.each([4, 8, 32, 512])('matches the complex FFT on bins 0…n/2 at n = %i', (n) => {
    const x = randomArray(n, 3 * n);
    const re = x.slice();
    const im = new Float64Array(n);
    new Fft(n).forward(re, im);
    const outRe = new Float64Array(n / 2 + 1);
    const outIm = new Float64Array(n / 2 + 1);
    new RealFft(n).forward(x, outRe, outIm);
    expect(maxDiff(outRe, re, n / 2 + 1)).toBeLessThan(1e-9);
    expect(maxDiff(outIm, im, n / 2 + 1)).toBeLessThan(1e-9);
  });

  it('inverse undoes forward', () => {
    const n = 4096;
    const rf = new RealFft(n);
    const x = randomArray(n, 9);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    const back = new Float64Array(n);
    rf.forward(x, re, im);
    rf.inverse(re, im, back);
    expect(maxDiff(back, x)).toBeLessThan(1e-12);
  });

  it('turns a power spectrum into the circular autocorrelation', () => {
    const n = 64;
    const x = randomArray(n, 5);
    const rf = new RealFft(n);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    rf.forward(x, re, im);
    for (let k = 0; k <= n / 2; k++) {
      re[k] = re[k] * re[k] + im[k] * im[k];
      im[k] = 0;
    }
    const r = new Float64Array(n);
    rf.inverse(re, im, r);
    for (const lag of [0, 1, 7, 31]) {
      let expected = 0;
      for (let j = 0; j < n; j++) expected += x[j] * x[(j + lag) % n];
      expect(r[lag]).toBeCloseTo(expected, 9);
    }
  });

  it('rejects sizes below 4 or not powers of two', () => {
    for (const n of [2, 6, 1000]) expect(() => new RealFft(n)).toThrow(RangeError);
  });
});
