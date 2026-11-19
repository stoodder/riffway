import { PitchDetector as Pitchy } from 'pitchy';
import { describe, expect, it } from 'vitest';
import {
  addPickTransient,
  centsBetween,
  dbToAmp,
  fadeOut,
  harmonicTone,
  karplusStrong,
  legatoTone,
  midiToHz,
  noise,
  pluckedTone,
  renderTimeline,
  rng,
  sawPartials,
  sine,
} from './signals';

/** Pitch of `n` samples from `offset`, by the pitchy oracle. */
function oracle(sig: Float32Array, sr: number, offset: number, n = 8192): number {
  return Pitchy.forFloat32Array(n).findPitch(sig.subarray(offset, offset + n), sr)[0];
}

const rms = (s: Float32Array) => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length);
const peak = (s: Float32Array) => s.reduce((a, v) => Math.max(a, Math.abs(v)), 0);

describe('test signal generators', () => {
  it('Karplus–Strong plucks are tuned within 1 cent from E2 to E6', () => {
    for (const sr of [44100, 48000]) {
      for (const midi of [40, 47, 52, 64, 76, 88]) {
        const f = midiToHz(midi);
        const sig = karplusStrong(f, 0.4, sr, { feedback: 0.999 });
        expect(Math.abs(centsBetween(oracle(sig, sr, 2048), f)), `${sr} ${midi}`).toBeLessThan(1);
        expect(peak(sig)).toBeCloseTo(0.5, 6);
      }
    }
  });

  it('additive tones are band-limited, peak-normalised and correctly pitched', () => {
    const sr = 48000;
    const saw = harmonicTone(1000, 0.2, sr, sawPartials(60), 0.8);
    expect(peak(saw)).toBeCloseTo(0.8, 6);
    expect(Math.abs(centsBetween(oracle(saw, sr, 0), 1000))).toBeLessThan(0.5);
    const tone = pluckedTone(220, 0.5, sr, { amp: 0.4 });
    expect(peak(tone)).toBeLessThanOrEqual(0.4 + 1e-6);
    expect(Math.abs(centsBetween(oracle(tone, sr, 2400), 220))).toBeLessThan(0.5);
  });

  it('legato tones change pitch at the requested time', () => {
    const sr = 48000;
    const sig = legatoTone([{ atSec: 0, midi: 52 }, { atSec: 0.3, midi: 55 }], 0.6, sr);
    expect(Math.abs(centsBetween(oracle(sig, sr, 2400, 4096), midiToHz(52)))).toBeLessThan(0.5);
    expect(Math.abs(centsBetween(oracle(sig, sr, 0.35 * sr, 4096), midiToHz(55)))).toBeLessThan(0.5);
  });

  it('noise has the requested RMS and is reproducible', () => {
    const a = noise(48000, dbToAmp(-20), 1);
    expect(20 * Math.log10(rms(a))).toBeCloseTo(-20, 1);
    expect(noise(16, 0.1, 1)).toEqual(noise(16, 0.1, 1));
    expect(rng(1)()).toBe(rng(1)());
  });

  it('timeline, fade-out and pick transient helpers place and shape samples', () => {
    const sr = 1000;
    const tl = renderTimeline([{ atSec: 0.1, signal: new Float32Array([1, 1]) }], 0.2, sr);
    expect(tl.length).toBe(200);
    expect([tl[99], tl[100], tl[101], tl[102]]).toEqual([0, 1, 1, 0]);
    const faded = fadeOut(new Float32Array(10).fill(1), sr, 4);
    expect(Array.from(faded.slice(6))).toEqual([0.75, 0.5, 0.25, 0]);
    const s = addPickTransient(sine(10, 1, sr, 0), sr, 0.5, 2);
    expect(peak(s)).toBeLessThanOrEqual(0.5);
    expect(peak(s.subarray(50))).toBe(0);
  });
});
