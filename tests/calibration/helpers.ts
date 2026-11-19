/**
 * Calibration test helpers: simulated players (onsets around clicks with jitter, outliers, missed
 * plucks and double triggers) and an in-memory settings store. Pure TS (Node and browser tests).
 */
import { type DeepPartial, type Settings, type SettingsStore, defaultSettings } from '@shared/settings';
import { mergeSettings } from '../../src/storage';

/** Deterministic PRNG (mulberry32) in [0, 1). */
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

/** Standard normal sample (Box–Muller). */
export function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** How a simulated player responds to clicks. */
export interface PlayerSim {
  /** True offset (ms). */
  offsetMs: number;
  /** Gaussian jitter σ (ms). */
  jitterMs?: number;
  /** Click indices with no pluck. */
  missed?: readonly number[];
  /** Click index → extra deviation (ms) on top of the jitter (outliers). */
  outliers?: Readonly<Record<number, number>>;
  /** Click indices followed by a detector double trigger (+30 ms). */
  doubles?: readonly number[];
  /** Stray events at these absolute times (s). */
  strays?: readonly number[];
  seed?: number;
}

/** Event times a simulated player produces for `clicks`. */
export function simulate(clicks: readonly number[], p: PlayerSim): number[] {
  const rand = rng(p.seed ?? 1);
  const out: number[] = [];
  clicks.forEach((c, i) => {
    const jitter = gauss(rand) * (p.jitterMs ?? 0);
    if (p.missed?.includes(i)) return;
    const t = c + (p.offsetMs + jitter + (p.outliers?.[i] ?? 0)) / 1000;
    out.push(t);
    if (p.doubles?.includes(i)) out.push(t + 0.03);
  });
  out.push(...(p.strays ?? []));
  return out;
}

/** In-memory settings store using the real deep-merge (unknown fields survive, like IndexedDB). */
export function memorySettings(initial: DeepPartial<Settings> = {}): SettingsStore & { updates: number } {
  let current = mergeSettings(defaultSettings(), initial);
  const subs = new Set<(s: Settings) => void>();
  const store = {
    updates: 0,
    get: () => current,
    async update(patch: DeepPartial<Settings>) {
      store.updates++;
      current = mergeSettings(current, patch);
      for (const cb of [...subs]) cb(current);
      return current;
    },
    async replace(next: Settings) {
      current = mergeSettings(defaultSettings(), next);
      for (const cb of [...subs]) cb(current);
    },
    subscribe(cb: (s: Settings) => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
  };
  return store;
}
