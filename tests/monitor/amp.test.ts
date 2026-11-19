/**
 * Amp DSP in Node: half-band oversampler, ADAA clipper, tone stack, harmonic content, aliasing,
 * gain staging, latency, bypass, duck, and numerical hygiene (no NaN, no subnormals).
 */
import { describe, expect, it } from 'vitest';
import {
  AMP_LATENCY_SAMPLES,
  AMP_PRESETS,
  AdaaClipper,
  AmpEngine,
  Biquad,
  BYPASS_CONFIG,
  DUCK,
  HalfbandStage,
  OVERSAMPLER_DESIGN,
  Oversampler4x,
  TONE_BANDS,
  TONE_MID_Q,
  ampConfigFor,
  biquadCoefficients,
  cabStages,
  cascadeMagnitudeDb,
  clip,
  clipAntiderivative,
  designHalfband,
  driveCharacter,
  oversamplerLatency,
  type AmpConfig,
} from '@core/dsp/amp';
import { noise, pluckedTone, sine } from '../helpers/signals';
import { allNormalOrZero, binFreq, binPower, db, powerSpectrum, rms, xcorrLagFine } from './helpers';

const SR = 48000;

/** Process a whole signal through a fresh amp. */
function run(config: AmpConfig, x: Float32Array, sr = SR): Float32Array {
  const amp = new AmpEngine(sr, config);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 128) {
    const n = Math.min(128, x.length - i);
    amp.process(x.subarray(i, i + n), y.subarray(i, i + n), n);
  }
  return y;
}

/** Preset config without the gate (steady test tones) and with a flat tone stack if asked. */
function preset(id: keyof typeof AMP_PRESETS, flat = false): AmpConfig {
  const c: AmpConfig = { ...AMP_PRESETS[id].amp, gateDb: null };
  return flat ? { ...c, low: 0, mid: 0, high: 0 } : c;
}

/** Harmonic amplitudes (dB re fundamental) of `y` for a bin-centred tone. */
function harmonics(y: Float32Array, bin: number, n: number, count: number): number[] {
  const p = powerSpectrum(y, y.length - n, n);
  const f = binPower(p, bin);
  const out: number[] = [];
  for (let h = 2; h <= count; h++) out.push(10 * Math.log10(binPower(p, bin * h) / f));
  return out;
}

describe('half-band oversampler', () => {
  it('designs half-band taps: centre 0.5, alternate zeros, symmetric, unity DC per branch', () => {
    const h = designHalfband(31, 8);
    const c = 15;
    expect(h[c]).toBe(0.5);
    for (let k = 0; k < h.length; k++) {
      expect(h[k]).toBeCloseTo(h[h.length - 1 - k]!, 15);
      if (k !== c && (k - c) % 2 === 0) expect(h[k]).toBe(0);
    }
    let branch = 0;
    for (let k = 0; k < h.length; k++) if ((k - c) % 2 !== 0) branch += h[k]!;
    expect(branch).toBeCloseTo(0.5, 14);
    expect(() => designHalfband(30, 8)).toThrow(RangeError);
    expect(() => designHalfband(3, 8)).toThrow(RangeError);
  });

  it('stage 1 passes ≤ 16 kHz flat and rejects images ≥ 32 kHz (at 2 × 48 kHz) by > 70 dB', () => {
    const { taps } = new HalfbandStage(OVERSAMPLER_DESIGN.stage1.taps, OVERSAMPLER_DESIGN.stage1.beta);
    const mag = (f: number): number => {
      let re = 0;
      let im = 0;
      for (let k = 0; k < taps.length; k++) {
        re += taps[k]! * Math.cos((2 * Math.PI * f * k) / (2 * SR));
        im -= taps[k]! * Math.sin((2 * Math.PI * f * k) / (2 * SR));
      }
      return db(Math.hypot(re, im));
    };
    for (const f of [100, 1000, 5000, 10000, 16000]) expect(Math.abs(mag(f))).toBeLessThan(0.05);
    for (const f of [32000, 40000, 48000]) expect(mag(f)).toBeLessThan(-70);
  });

  it('up → down is a pure delay of oversamplerLatency() samples for band-limited input', () => {
    expect(oversamplerLatency()).toBe(17.75);
    const os = new Oversampler4x();
    // Broadband but inside the passband: noise low-passed by a 4-pole 8 kHz filter.
    const lp = cabStages(8000)
      .slice(4)
      .map((s) => {
        const f = new Biquad();
        f.set(biquadCoefficients(s, SR));
        return f;
      });
    const x = noise(9600, 0.2, 21).map((v) => lp[1]!.tick(lp[0]!.tick(v)));
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      os.up(x[i]!);
      y[i] = os.down();
    }
    expect(xcorrLagFine(x, y, 64)).toBeCloseTo(17.75, 1);
    // Unity gain through the round trip (passband ripple < 0.01 dB).
    expect(Math.abs(db(rms(y, 2000) / rms(x, 2000)))).toBeLessThan(0.01);
  });
});

describe('ADAA soft clipper', () => {
  it('has the documented asymmetric transfer curve', () => {
    expect(clip(0, 0)).toBe(0);
    expect(clip(0, 0.15)).toBe(0);
    expect(clip(10, 0)).toBeCloseTo(1, 6);
    expect(clip(-10, 0)).toBeCloseTo(-1, 6);
    expect(clip(0.5, 0)).toBeCloseTo(Math.tanh(0.5), 12);
    // Bias makes it asymmetric: the positive side saturates sooner.
    const b = 0.15;
    expect(clip(10, b)).toBeCloseTo(1 - Math.tanh(b), 6);
    expect(clip(-10, b)).toBeCloseTo(-1 - Math.tanh(b), 6);
    // Monotonic.
    for (let x = -5; x < 5; x += 0.01) expect(clip(x + 0.01, b)).toBeGreaterThan(clip(x, b));
  });

  it('antiderivative differentiates to the curve, and is overflow-safe', () => {
    for (const b of [0, 0.15]) {
      for (const x of [-3, -0.4, 0, 0.3, 2.5]) {
        const d = (clipAntiderivative(x + 1e-5, b) - clipAntiderivative(x - 1e-5, b)) / 2e-5;
        expect(d).toBeCloseTo(clip(x, b), 7);
      }
    }
    expect(Number.isFinite(clipAntiderivative(1e6, 0.15))).toBe(true);
    expect(Number.isFinite(clipAntiderivative(-1e6, 0.15))).toBe(true);
  });

  it('ADAA output equals the static curve on a constant input', () => {
    const c = new AdaaClipper();
    c.setBias(0.15);
    let y = 0;
    for (let i = 0; i < 4; i++) y = c.tick(0.8);
    expect(y).toBeCloseTo(clip(0.8, 0.15), 9);
  });
});

describe('tone stack', () => {
  const sr = SR;
  const stack = (low: number, mid: number, high: number) => [
    biquadCoefficients({ type: 'lowshelf', frequency: TONE_BANDS.low, q: 1, gain: low }, sr),
    biquadCoefficients({ type: 'peaking', frequency: TONE_BANDS.mid, q: TONE_MID_Q, gain: mid }, sr),
    biquadCoefficients({ type: 'highshelf', frequency: TONE_BANDS.high, q: 1, gain: high }, sr),
  ];

  it('each band hits its gain at the band centre (±0.5 dB) and leaves the others near flat', () => {
    for (const g of [-6, 3, 9]) {
      // Shelves reach half their gain (in dB) at the corner and the full gain well inside the shelf.
      expect(cascadeMagnitudeDb(stack(g, 0, 0), TONE_BANDS.low, sr)).toBeCloseTo(g / 2, 0);
      expect(Math.abs(cascadeMagnitudeDb(stack(g, 0, 0), 20, sr) - g)).toBeLessThan(0.5);
      expect(Math.abs(cascadeMagnitudeDb(stack(0, g, 0), TONE_BANDS.mid, sr) - g)).toBeLessThan(0.5);
      expect(cascadeMagnitudeDb(stack(0, 0, g), TONE_BANDS.high, sr)).toBeCloseTo(g / 2, 0);
      expect(Math.abs(cascadeMagnitudeDb(stack(0, 0, g), 18000, sr) - g)).toBeLessThan(0.5);
    }
    expect(Math.abs(cascadeMagnitudeDb(stack(0, 0, 0), 1000, sr))).toBeLessThan(1e-9);
  });

  it('the Overdrive preset tone (+2 / +3 / −1 dB) measures within ±0.5 dB at the band centres', () => {
    const s = stack(2, 3, -1);
    expect(Math.abs(cascadeMagnitudeDb(s, 30, sr) - 2)).toBeLessThan(0.5);
    expect(Math.abs(cascadeMagnitudeDb(s, TONE_BANDS.mid, sr) - 3)).toBeLessThan(0.5);
    expect(Math.abs(cascadeMagnitudeDb(s, 16000, sr) - -1)).toBeLessThan(0.5);
  });

  it('the processed amp matches the analytic tone response (DI-like drive, clean signal)', () => {
    const cfg: AmpConfig = { drive: 1, bias: 0, low: 0, mid: 6, high: 0, level: 0, bypass: false, gateDb: null };
    const n = 8192;
    const { freq, bin } = binFreq(TONE_BANDS.mid, n, SR);
    const amp = 0.01; // tanh is linear down here
    const x = sine(freq, 1, SR, amp);
    const y = run(cfg, x);
    const p = powerSpectrum(y, y.length - n, n);
    const px = powerSpectrum(x, x.length - n, n);
    expect(Math.abs(10 * Math.log10(binPower(p, bin) / binPower(px, bin)) - 6)).toBeLessThan(0.5);
  });
});

describe('cab', () => {
  it('shapes like a guitar speaker: low cut, presence, steep top roll-off', () => {
    const c = cabStages(5500).map((s) => biquadCoefficients(s, SR));
    const at = (f: number): number => cascadeMagnitudeDb(c, f, SR);
    expect(at(40)).toBeLessThan(at(120) - 10);
    expect(at(2500)).toBeGreaterThan(at(1000));
    expect(at(5500)).toBeLessThan(at(1000) - 3);
    expect(at(12000)).toBeLessThan(at(1000) - 25);
  });
});

describe('harmonic content', () => {
  const n = 16384;
  const { freq, bin } = binFreq(220, n, SR);

  it('Clean at a typical level stays clean (THD < 3 %)', () => {
    const y = run(preset('clean', true), sine(freq, 1, SR, 0.25));
    const h = harmonics(y, bin, n, 7);
    const thd = Math.sqrt(h.reduce((s, d) => s + 10 ** (d / 10), 0));
    expect(thd).toBeLessThan(0.03);
    expect(thd).toBeGreaterThan(0.001); // a little warmth, not a wire
  });

  it('Overdrive adds strong odd harmonics and, with bias, even harmonics', () => {
    const y = run(preset('overdrive', true), sine(freq, 1, SR, 0.25));
    const [h2, h3, , h5] = harmonics(y, bin, n, 7) as [number, number, number, number];
    expect(h3).toBeGreaterThan(-15);
    expect(h5).toBeGreaterThan(-25);
    expect(h2).toBeGreaterThan(-40); // asymmetric clipping

    const sym = run({ ...preset('overdrive', true), bias: 0 }, sine(freq, 1, SR, 0.25));
    const [s2] = harmonics(sym, bin, n, 3) as [number];
    expect(s2).toBeLessThan(-80); // symmetric clipper: no even harmonics
  });

  it('more drive means more distortion', () => {
    const thdAt = (drive: number): number => {
      const y = run({ ...preset('overdrive', true), drive, bias: 0 }, sine(freq, 1, SR, 0.25));
      return harmonics(y, bin, n, 9).reduce((s, d) => s + 10 ** (d / 10), 0);
    };
    expect(thdAt(2)).toBeLessThan(thdAt(6));
    expect(thdAt(6)).toBeLessThan(thdAt(20));
  });
});

describe('aliasing', () => {
  it('a 5 kHz sine at drive 12 has aliased components < −60 dB relative to the fundamental', () => {
    const n = 16384;
    const { freq, bin } = binFreq(5000, n, SR);
    for (const amp of [0.25, 1]) {
      const y = run({ ...preset('overdrive', true) }, sine(freq, 1, SR, amp));
      const p = powerSpectrum(y, y.length - n, n);
      const fund = binPower(p, bin);
      let worst = -Infinity;
      const limit = Math.floor((20000 / SR) * n);
      for (let k = 8; k < limit; k++) {
        if (Math.abs(k - Math.round(k / bin) * bin) <= 6) continue; // harmonics (and DC) are wanted
        worst = Math.max(worst, 10 * Math.log10(p[k]! / fund));
      }
      expect(worst).toBeLessThan(-60);
    }
  });
});

describe('gain staging', () => {
  /** Output RMS (dBFS) of a 2 s plucked G3 (decaying, with harmonics) peaking at `inDb`. */
  const outRmsDb = (id: keyof typeof AMP_PRESETS, inDb: number): number => {
    const x = pluckedTone(196, 2, SR, { amp: 10 ** (inDb / 20) });
    return db(rms(run(AMP_PRESETS[id].amp, x)));
  };

  it('Clean and Overdrive stay within 4 dB of the dry (DI) level at typical guitar levels', () => {
    for (const inDb of [-12, -6]) {
      const dry = outRmsDb('di', inDb);
      for (const id of ['clean', 'overdrive'] as const) expect(Math.abs(outRmsDb(id, inDb) - dry)).toBeLessThan(4);
    }
  });

  it('Overdrive compresses: a 12 dB quieter pick loses less than 10 dB (Clean loses ≈ 12)', () => {
    const drop = outRmsDb('overdrive', -12) - outRmsDb('overdrive', -24);
    expect(drop).toBeLessThan(10);
    expect(Math.abs(outRmsDb('clean', -12) - outRmsDb('clean', -24) - 12)).toBeLessThan(1);
  });

  it('DI is bit-transparent', () => {
    const x = noise(4800, 0.2, 5);
    const y = run(AMP_PRESETS.di.amp, x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it('a full-scale input never drives the output past 0 dBFS at the preset levels', () => {
    for (const id of ['clean', 'overdrive'] as const) {
      const y = run(preset(id), sine(110, 0.5, SR, 1));
      let peak = 0;
      for (const v of y) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeLessThan(1);
    }
  });

  it('ampConfigFor clamps knobs and keeps bias, gate and bypass from the preset', () => {
    const c = ampConfigFor('overdrive', { drive: 1000, tone: { low: 50, mid: -50, high: 0 }, level: 20 });
    expect(c).toMatchObject({ drive: 40, low: 12, mid: -12, high: 0, level: 6, bias: 0.15, bypass: false, gateDb: -60 });
    expect(ampConfigFor('di', { drive: 5, tone: { low: 1, mid: 1, high: 1 }, level: -3 })).toEqual(BYPASS_CONFIG);
  });

  it('describes drive in player terms', () => {
    expect(driveCharacter(AMP_PRESETS.clean.amp.drive)).toBe('clean');
    expect(driveCharacter(5)).toBe('crunch');
    expect(driveCharacter(AMP_PRESETS.overdrive.amp.drive)).toBe('overdrive');
    expect(driveCharacter(40)).toBe('saturated');
  });
});

describe('latency', () => {
  it('adds AMP_LATENCY_SAMPLES (< 0.5 ms at 48 kHz) and nothing in DI', () => {
    expect(AMP_LATENCY_SAMPLES).toBeCloseTo(17.875, 9);
    expect((AMP_LATENCY_SAMPLES / SR) * 1000).toBeLessThan(0.5);
    const x = noise(9600, 0.05, 9);
    const y = run({ ...preset('clean', true), drive: 1 }, x);
    // Broadband check: the correlation peak sits at the oversampler + ADAA delay.
    expect(Math.abs(xcorrLagFine(x, y, 100) - AMP_LATENCY_SAMPLES)).toBeLessThan(0.25);
    expect(xcorrLagFine(x, run(AMP_PRESETS.di.amp, x), 100)).toBe(0);
  });
});

describe('guard duck and bypass crossfade', () => {
  it('ducks by 30 dB within 50 ms and recovers when released', () => {
    const amp = new AmpEngine(SR, AMP_PRESETS.di.amp);
    const ones = new Float32Array(128).fill(0.5);
    const out = new Float32Array(128);
    amp.setDucked(true);
    expect(amp.ducked).toBe(true);
    const blocks = Math.ceil((DUCK.rampSec * SR) / 128) + 1;
    for (let b = 0; b < blocks; b++) amp.process(ones, out);
    expect(db(out[127]! / 0.5)).toBeCloseTo(DUCK.depthDb, 1);
    amp.setDucked(false);
    for (let b = 0; b < blocks; b++) amp.process(ones, out);
    expect(out[127]).toBeCloseTo(0.5, 9);
  });

  it('switching to DI crossfades without a jump larger than the signal', () => {
    const amp = new AmpEngine(SR, preset('clean'));
    const x = sine(220, 0.3, SR, 0.25);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 128) {
      if (i === 4864) amp.configure(AMP_PRESETS.di.amp);
      amp.process(x.subarray(i, i + 128), y.subarray(i, i + 128), Math.min(128, x.length - i));
    }
    let maxStep = 0;
    for (let i = 4865; i < 9600; i++) maxStep = Math.max(maxStep, Math.abs(y[i]! - y[i - 1]!));
    expect(maxStep).toBeLessThan(0.05);
    // After the fade it is exactly the dry input.
    expect(y[y.length - 1]).toBe(x[x.length - 1]);
  });
});

describe('numerical hygiene', () => {
  it('silence after a loud burst decays to exact zeros (no subnormals)', () => {
    for (const id of ['clean', 'overdrive'] as const) {
      const x = new Float32Array(SR * 6);
      x.set(noise(4800, 0.5, 2));
      const y = run(AMP_PRESETS[id].amp, x);
      expect(allNormalOrZero(y)).toBe(true);
      // Gate closed and filters flushed: the tail is exactly silent.
      expect(y.subarray(y.length - SR).every((v) => v === 0)).toBe(true);
    }
  });

  it('NaN and Infinity inputs never reach the output, and the amp recovers', () => {
    const x = sine(440, 0.1, SR, 0.3);
    x[100] = Number.NaN;
    x[200] = Number.POSITIVE_INFINITY;
    x[300] = Number.NEGATIVE_INFINITY;
    for (const id of ['clean', 'overdrive', 'di'] as const) {
      const y = run(AMP_PRESETS[id].amp, x);
      expect(allNormalOrZero(y)).toBe(true);
      expect(rms(y, 2400)).toBeGreaterThan(0.01);
    }
  });

  it('extreme and non-finite parameters stay finite', () => {
    const x = noise(4800, 0.9, 4);
    const configs: AmpConfig[] = [
      { ...preset('overdrive'), drive: 1e6, low: 24, mid: 24, high: 24, level: 12 },
      { ...preset('overdrive'), drive: 0, bias: 5 },
      { ...preset('overdrive'), drive: Number.NaN, bias: Number.NaN, low: Number.NaN, level: Number.POSITIVE_INFINITY },
    ];
    for (const c of configs) expect(allNormalOrZero(run(c, x))).toBe(true);
  });

  it('runs at 44.1 and 96 kHz too', () => {
    for (const sr of [44100, 96000]) {
      const y = run(preset('overdrive'), sine(330, 0.2, sr, 0.25), sr);
      expect(allNormalOrZero(y)).toBe(true);
      expect(rms(y, sr / 10)).toBeGreaterThan(0.02);
    }
  });
});
