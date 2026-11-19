/**
 * Monitor test helpers: spectrum measurement, RMS, cross-correlation delay and an in-memory
 * settings store. Pure TS (used by Node and browser tests).
 */
import type { DeepPartial, Settings, SettingsStore } from '@shared/settings';
import { defaultSettings } from '@shared/settings';
import { RealFft } from '@core/dsp/fft';

/** RMS of `x[from, to)`. */
export function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Linear → dB. */
export const db = (v: number): number => 20 * Math.log10(v);

/** Bin-centred test frequency close to `freq` for an `n`-point FFT (no leakage). */
export function binFreq(freq: number, n: number, sampleRate: number): { freq: number; bin: number } {
  const bin = Math.round((freq * n) / sampleRate);
  return { freq: (bin * sampleRate) / n, bin };
}

/** Power spectrum (bins 0…n/2) of `x[from, from + n)` with a Blackman–Harris window. */
export function powerSpectrum(x: ArrayLike<number>, from: number, n: number): Float64Array {
  const frame = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const w = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
    frame[i] = x[from + i]! * w;
  }
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  new RealFft(n).forward(frame, re, im);
  const p = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) p[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  return p;
}

/** Power around bin `k` (±`spread` bins: the window's main lobe). */
export function binPower(p: Float64Array, k: number, spread = 4): number {
  let s = 0;
  for (let i = Math.max(0, k - spread); i <= Math.min(p.length - 1, k + spread); i++) s += p[i]!;
  return s;
}

/** Lag (samples) of the cross-correlation peak of `y` against `x`, searched over `0…maxLag`. */
export function xcorrLag(x: ArrayLike<number>, y: ArrayLike<number>, maxLag: number): number {
  let best = -Infinity;
  let lag = 0;
  for (let l = 0; l <= maxLag; l++) {
    let s = 0;
    for (let i = 0; i + l < y.length && i < x.length; i++) s += x[i]! * y[i + l]!;
    if (s > best) {
      best = s;
      lag = l;
    }
  }
  return lag;
}

/** Sub-sample peak lag: parabolic interpolation around {@link xcorrLag}. */
export function xcorrLagFine(x: ArrayLike<number>, y: ArrayLike<number>, maxLag: number): number {
  const corr = (l: number): number => {
    let s = 0;
    for (let i = 0; i + l < y.length && i < x.length; i++) s += x[i]! * y[i + l]!;
    return s;
  };
  const l = xcorrLag(x, y, maxLag);
  if (l === 0 || l === maxLag) return l;
  const a = corr(l - 1);
  const b = corr(l);
  const c = corr(l + 1);
  const den = a - 2 * b + c;
  return den === 0 ? l : l + (0.5 * (a - c)) / den;
}

/** True when every value is finite and either 0 or a normal float32 (no subnormals). */
export function allNormalOrZero(x: Float32Array): boolean {
  const MIN_NORMAL = 1.1754943508222875e-38;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (!Number.isFinite(v)) return false;
    if (v !== 0 && Math.abs(v) < MIN_NORMAL) return false;
  }
  return true;
}

/** Deep-merge `patch` into a copy of `base` (arrays and primitives replaced), like the real store. */
function merge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch) as T;
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = cur && typeof cur === 'object' && !Array.isArray(cur) ? merge(cur, v) : structuredClone(v);
  }
  return out as T;
}

/** In-memory {@link SettingsStore} (deep-merge semantics of the real store). */
export function memorySettings(initial: DeepPartial<Settings> = {}): SettingsStore & { updates: number } {
  let current = merge(defaultSettings(), initial);
  const subs = new Set<(s: Settings) => void>();
  const store = {
    updates: 0,
    get: () => current,
    async update(patch: DeepPartial<Settings>) {
      current = merge(current, patch);
      store.updates++;
      for (const cb of [...subs]) cb(current);
      return current;
    },
    async replace(next: Settings) {
      current = next;
      for (const cb of [...subs]) cb(current);
    },
    subscribe(cb: (s: Settings) => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
  return store;
}
