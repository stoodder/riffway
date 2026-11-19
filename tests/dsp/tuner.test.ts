import { describe, expect, it } from 'vitest';
import { createPitchDetector, createTunerSmoother, type PitchEstimate } from '@core/dsp';
import { addNoise, karplusStrong, midiToHz } from '../helpers/signals';

/** ~21 Hz tuner frames (hop 1024 at 48 kHz) */
const DT = 1024 / 48000;

function est(freq: number, clarity = 0.97): PitchEstimate {
  return { freq, midi: 0, cents: 0, clarity };
}

describe('tuner smoother', () => {
  it('is null until the first confident frame, then shows the median of the last 5', () => {
    const tuner = createTunerSmoother();
    expect(tuner.push(null, 0)).toBeNull();
    expect(tuner.push(est(110, 0.85), DT)).toBeNull();
    const freqs = [110, 111, 300, 110.5, 109.5, 110.2];
    let r = null;
    freqs.forEach((f, i) => (r = tuner.push(est(f), (i + 2) * DT)));
    // Last five: 111, 300, 110.5, 109.5, 110.2 → median 110.5; the 300 Hz outlier never shows.
    expect(r).toMatchObject({ freq: 110.5, midi: 45, live: true });
  });

  it('holds the last value when clarity drops below 0.8 and stays live in [0.8, 0.9)', () => {
    const tuner = createTunerSmoother();
    for (let i = 0; i < 5; i++) tuner.push(est(146.83), i * DT);
    const held = tuner.push(est(400, 0.5), 5 * DT)!;
    expect(held).toMatchObject({ midi: 50, live: false, inTune: false });
    expect(held.freq).toBeCloseTo(146.83, 6);
    const live = tuner.push(est(400, 0.85), 6 * DT)!;
    expect(live.live).toBe(true);
    expect(live.freq).toBeCloseTo(146.83, 6);
    expect(tuner.push(null, 7 * DT)!.live).toBe(false);
  });

  it('reports cents against the A4 reference and flags in tune after 0.5 s within ±3 cents', () => {
    const tuner = createTunerSmoother({ a4: 440 });
    const flat = midiToHz(64) * 2 ** (-2 / 1200);
    let t = 0;
    let r = tuner.push(est(flat), t)!;
    expect(r.midi).toBe(64);
    expect(r.cents).toBeCloseTo(-2, 6);
    expect(r.inTune).toBe(false);
    while (t < 0.49) r = tuner.push(est(flat), (t += DT))!;
    expect(r.inTune).toBe(false);
    r = tuner.push(est(flat), (t += 2 * DT))!;
    expect(r.inTune).toBe(true);
    // Leaving the ±3 cent band restarts the timer.
    const sharp = midiToHz(64) * 2 ** (6 / 1200);
    for (let i = 0; i < 5; i++) r = tuner.push(est(sharp), (t += DT))!;
    expect(r.inTune).toBe(false);
    expect(r.cents).toBeCloseTo(6, 6);
  });

  it('starts a fresh median after a 0.3 s gap (new string) and on reset()', () => {
    const tuner = createTunerSmoother();
    for (let i = 0; i < 5; i++) tuner.push(est(82.41), i * DT);
    expect(tuner.push(est(110), 1)!.midi).toBe(45);
    tuner.reset();
    expect(tuner.push(null, 2)).toBeNull();
    expect(createTunerSmoother({ a4: 432 }).push(est(432), 0)!.midi).toBe(69);
    expect(() => createTunerSmoother({ a4: 0 })).toThrow(RangeError);
  });

  it('settles on a plucked low E within 1 cent with the 4096-sample window', () => {
    const sr = 48000;
    const f = midiToHz(40) * 2 ** (1.5 / 1200);
    const sig = addNoise(karplusStrong(f, 1.5, sr, { feedback: 0.999 }), -60);
    const det = createPitchDetector({ sampleRate: sr, size: 4096 });
    const tuner = createTunerSmoother();
    let r = null;
    for (let end = 4096 + 2400; end <= sig.length; end += 1024) r = tuner.push(det.detect(sig, end - 4096), end / sr);
    expect(r).toMatchObject({ midi: 40, live: true, inTune: true });
    expect(r!.cents).toBeCloseTo(1.5, 0);
  });
});
