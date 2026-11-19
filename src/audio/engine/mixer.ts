/**
 * Mixer (docs/monitoring.md § Graph): `monitor`, `backing`, `guide`, `metronome` bus `GainNode`s →
 * `master` → safety limiter → destination. Mute is gain 0; buses are never disconnected.
 *
 * **Safety limiter.** A `DynamicsCompressorNode` delays everything by a fixed 6 ms look-ahead in
 * Chrome (measured: 288 samples at 48 kHz) and changes levels below its threshold, which would add
 * latency to guitar monitoring and shift clicks. Instead the limiter is a zero-latency static
 * soft clipper (`WaveShaperNode`, no oversampling): exactly linear up to −1 dBFS, then a tanh knee
 * that never exceeds 0 dBFS, with +12 dB of input range before it hard-clips.
 * @module
 */
import type { MixerBus } from '@shared/services';
import type { MixerLevels } from '@shared/settings';

/** Bus names in signal order (`master` last). */
export const MIXER_BUSES: readonly MixerBus[] = ['monitor', 'backing', 'guide', 'metronome', 'master'];

/** Safety limiter shape. */
export const SAFETY_LIMITER = {
  /** Linear below this level (dBFS). */
  thresholdDb: -1,
  /** Input range covered by the soft knee before hard clipping (linear: +12 dB). */
  headroom: 4,
  /** Curve points (odd, so 0 maps exactly to 0). */
  points: 8193,
} as const;

/** Time constant for level changes (s): fast, but click-free. */
const LEVEL_SMOOTH_SEC = 0.01;

/** The limiter transfer function (input/output linear amplitude). */
export function limiterCurve(x: number): number {
  const k = 10 ** (SAFETY_LIMITER.thresholdDb / 20);
  const a = Math.abs(x);
  if (a <= k) return x;
  return Math.sign(x) * (k + (1 - k) * Math.tanh((a - k) / (1 - k)));
}

/** The mixer graph on one context. */
export interface Mixer {
  readonly buses: Readonly<Record<MixerBus, GainNode>>;
  /** Current levels (0–1). */
  levels(): MixerLevels;
  /** Set a bus level (clamped to 0–1), smoothed over ~10 ms. */
  setLevel(bus: MixerBus, level: number): void;
  /** Disconnect everything. */
  dispose(): void;
}

/** Validate and clamp a level to 0–1. */
export function clampLevel(level: number): number {
  if (Number.isNaN(level)) throw new RangeError('mixer level must be a number');
  return Math.min(1, Math.max(0, level));
}

/** Build the mixer on `ctx`, ending in `destination` (default `ctx.destination`). */
export function createMixer(ctx: BaseAudioContext, levels: MixerLevels, destination: AudioNode = ctx.destination): Mixer {
  const current: MixerLevels = { ...levels };
  const make = (bus: MixerBus): GainNode => {
    current[bus] = clampLevel(levels[bus]);
    return new GainNode(ctx, { gain: current[bus] });
  };
  const buses: Record<MixerBus, GainNode> = {
    monitor: make('monitor'),
    backing: make('backing'),
    guide: make('guide'),
    metronome: make('metronome'),
    master: make('master'),
  };
  // Scale into the shaper's [-1, 1] domain, then map back up in the curve: y(u) = limiterCurve(R·u).
  const pre = new GainNode(ctx, { gain: 1 / SAFETY_LIMITER.headroom });
  const curve = new Float32Array(SAFETY_LIMITER.points);
  for (let i = 0; i < curve.length; i++) {
    const u = (2 * i) / (curve.length - 1) - 1;
    curve[i] = limiterCurve(SAFETY_LIMITER.headroom * u);
  }
  const limiter = new WaveShaperNode(ctx, { curve, oversample: 'none' });
  for (const bus of MIXER_BUSES) if (bus !== 'master') buses[bus].connect(buses.master);
  buses.master.connect(pre).connect(limiter).connect(destination);

  return {
    buses,
    levels: () => ({ ...current }),
    setLevel(bus, level) {
      const v = clampLevel(level);
      current[bus] = v;
      const param = buses[bus].gain;
      param.cancelScheduledValues(ctx.currentTime);
      param.setTargetAtTime(v, ctx.currentTime, LEVEL_SMOOTH_SEC);
    },
    dispose() {
      for (const bus of MIXER_BUSES) buses[bus].disconnect();
      pre.disconnect();
      limiter.disconnect();
    },
  };
}
