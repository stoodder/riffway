import { PitchDetector as Pitchy } from 'pitchy';
import { describe, expect, it } from 'vitest';
import {
  createPitchDetector,
  E2_MIDI,
  E6_MIDI,
  freqToMidi,
  freqToMidiFloat,
  midiToFreq,
  planPitchWindow,
} from '@core/dsp';
import {
  addNoise,
  applyPluckEnvelope,
  centsBetween,
  GUITAR_PARTIALS,
  harmonicTone,
  karplusStrong,
  midiToHz,
  noise,
  sawPartials,
  sine,
  WEAK_FUNDAMENTAL_PARTIALS,
} from '../helpers/signals';

const RATES = [44100, 48000] as const;
const NOTES = Array.from({ length: E6_MIDI - E2_MIDI + 1 }, (_, i) => E2_MIDI + i);
/** Analysis starts 25 ms into the note, past the attack (docs/audio-input.md). */
const OFFSET_SEC = 0.025;
const NOISE_DB = -60;

/** Test timbres; all peak at −6 dBFS with a −60 dBFS noise floor. */
const TIMBRES: Record<string, (freq: number, sr: number, midi: number) => Float32Array> = {
  sine: (f, sr, m) => addNoise(sine(f, 0.2, sr), NOISE_DB, m),
  sawtooth: (f, sr, m) => addNoise(harmonicTone(f, 0.2, sr, sawPartials()), NOISE_DB, m),
  'guitar partials + pluck': (f, sr, m) =>
    addNoise(applyPluckEnvelope(harmonicTone(f, 0.2, sr, GUITAR_PARTIALS), sr), NOISE_DB, m),
  'Karplus-Strong': (f, sr, m) => addNoise(karplusStrong(f, 0.2, sr, { seed: m }), NOISE_DB, m),
  'weak fundamental + pluck': (f, sr, m) =>
    addNoise(applyPluckEnvelope(harmonicTone(f, 0.2, sr, WEAK_FUNDAMENTAL_PARTIALS), sr), NOISE_DB, m),
};

interface Sweep {
  /** Largest |cents error| among non-octave results. */
  worstCents: number;
  /** Results off by ≥ 6 semitones (octave errors). */
  octaveErrors: number;
  nulls: number;
  minClarity: number;
  /** Largest |ours − pitchy| where pitchy has no octave error. */
  worstPitchyGap: number;
  pitchyOctaveErrors: number;
}

function sweep(timbre: string, sampleRate: number, hinted: boolean): Sweep {
  const gen = TIMBRES[timbre];
  const res: Sweep = { worstCents: 0, octaveErrors: 0, nulls: 0, minClarity: 1, worstPitchyGap: 0, pitchyOctaveErrors: 0 };
  const detectors = { 1024: createPitchDetector({ sampleRate, size: 1024 }), 2048: createPitchDetector({ sampleRate, size: 2048 }) };
  const oracles = { 1024: Pitchy.forFloat32Array(1024), 2048: Pitchy.forFloat32Array(2048) };
  for (const midi of NOTES) {
    const freq = midiToHz(midi);
    const signal = gen(freq, sampleRate, midi);
    const plan = planPitchWindow(hinted ? { minMidi: midi, maxMidi: midi } : null);
    const det = detectors[plan.size];
    det.setRange(plan.range);
    const offset = Math.round(OFFSET_SEC * sampleRate);
    const est = det.detect(signal, offset);
    const [pitchyFreq] = oracles[plan.size].findPitch(signal.subarray(offset, offset + plan.size), sampleRate);
    const pitchyCents = centsBetween(pitchyFreq, freq);
    const pitchyOk = Math.abs(pitchyCents) < 600;
    if (!pitchyOk) res.pitchyOctaveErrors++;
    if (!est) {
      res.nulls++;
      continue;
    }
    const cents = centsBetween(est.freq, freq);
    if (Math.abs(cents) >= 600) {
      res.octaveErrors++;
      continue;
    }
    res.worstCents = Math.max(res.worstCents, Math.abs(cents));
    res.minClarity = Math.min(res.minClarity, est.clarity);
    if (pitchyOk) res.worstPitchyGap = Math.max(res.worstPitchyGap, Math.abs(cents - pitchyCents));
  }
  return res;
}

describe('MPM pitch detector: generated tones E2–E6', () => {
  for (const sampleRate of RATES) {
    for (const hinted of [false, true]) {
      describe(`${sampleRate} Hz, ${hinted ? 'expected-note hint (N 1024/2048, ±7 st)' : 'no hint (N 2048, E2–E6)'}`, () => {
        for (const timbre of Object.keys(TIMBRES)) {
          it(`${timbre}: ±10 cents, no octave errors, clarity ≥ 0.9, within 5 cents of pitchy`, () => {
            const r = sweep(timbre, sampleRate, hinted);
            expect(r.nulls).toBe(0);
            expect(r.octaveErrors).toBe(0);
            expect(r.worstCents).toBeLessThanOrEqual(10);
            expect(r.minClarity).toBeGreaterThanOrEqual(0.9);
            expect(r.worstPitchyGap).toBeLessThanOrEqual(5);
          });
        }
      });
    }
  }

  it('octave check fixes the weak-fundamental tones that plain MPM (pitchy) reports an octave up', () => {
    const r = sweep('weak fundamental + pluck', 48000, false);
    expect(r.octaveErrors).toBe(0);
    expect(r.pitchyOctaveErrors).toBeGreaterThan(NOTES.length / 2);
  });

  it('stays within ±10 cents at about 20 dB SNR', () => {
    const det = createPitchDetector({ sampleRate: 48000, size: 2048 });
    for (const midi of [40, 45, 50, 55, 59, 64, 76, 88]) {
      const f = midiToHz(midi);
      const sig = addNoise(applyPluckEnvelope(harmonicTone(f, 0.2, 48000, GUITAR_PARTIALS), 48000), -30, midi);
      const est = det.detect(sig, 1200);
      expect(est).not.toBeNull();
      expect(Math.abs(centsBetween(est!.freq, f))).toBeLessThanOrEqual(10);
    }
  });

  it('finds strings detuned by up to a semitone beyond E2–E6 (tuner use)', () => {
    const det = createPitchDetector({ sampleRate: 48000, size: 2048 });
    for (const [midi, detune, expected] of [[40, -90, 39], [40, -40, 40], [88, 40, 88], [88, 90, 89]] as const) {
      const f = midiToHz(midi) * 2 ** (detune / 1200);
      const est = det.detect(karplusStrong(f, 0.2, 48000), 1200);
      expect(est).not.toBeNull();
      expect(est!.midi).toBe(expected);
      expect(Math.abs(centsBetween(est!.freq, f))).toBeLessThanOrEqual(5);
    }
  });

  it('the 4096-sample tuner window resolves E2 to within 1 cent', () => {
    const det = createPitchDetector({ sampleRate: 48000, size: 4096 });
    const f = midiToHz(40);
    const est = det.detect(addNoise(karplusStrong(f, 0.3, 48000), NOISE_DB), 2400);
    expect(Math.abs(centsBetween(est!.freq, f))).toBeLessThan(1);
    expect(est!.clarity).toBeGreaterThan(0.95);
  });

  it('applies the A4 reference to midi/cents but not to freq', () => {
    const det = createPitchDetector({ sampleRate: 48000, size: 1024, a4: 432 });
    const est = det.detect(sine(432, 0.1, 48000), 0)!;
    expect(est.freq).toBeCloseTo(432, 0);
    expect(est.midi).toBe(69);
    expect(Math.abs(est.cents)).toBeLessThan(1);
  });

  it('ignores a DC offset', () => {
    const det = createPitchDetector({ sampleRate: 48000, size: 2048 });
    const sig = sine(110, 0.1, 48000).map((v) => v + 0.3);
    expect(Math.abs(centsBetween(det.detect(sig, 0)!.freq, 110))).toBeLessThan(1);
  });
});

describe('MPM pitch detector: API', () => {
  it('returns null for silence and reports low clarity for noise', () => {
    const det = createPitchDetector({ sampleRate: 48000, size: 2048 });
    expect(det.detect(new Float32Array(2048))).toBeNull();
    const est = det.detect(noise(2048, 0.1, 3));
    if (est) expect(est.clarity).toBeLessThan(0.6);
  });

  it('honours the search range: a note far outside it is not reported', () => {
    const det = createPitchDetector({ sampleRate: 48000, size: 2048 });
    const a2 = karplusStrong(110, 0.2, 48000);
    det.setRange({ minMidi: 60, maxMidi: 74 });
    const est = det.detect(a2, 1200);
    expect(est === null || est.midi !== 45).toBe(true);
    det.setRange(null);
    expect(det.detect(a2, 1200)!.midi).toBe(45);
  });

  it('reuses its result object and reads at an offset', () => {
    const det = createPitchDetector({ sampleRate: 44100, size: 1024 });
    const buf = new Float32Array(4096);
    buf.set(sine(440, 1024 / 44100, 44100), 3000);
    const a = det.detect(buf, 3000);
    const b = det.detect(sine(220, 0.05, 44100));
    expect(a).toBe(b);
    expect(b!.midi).toBe(57);
  });

  it('validates its inputs', () => {
    expect(() => createPitchDetector({ sampleRate: 48000, size: 512 as 1024 })).toThrow(RangeError);
    expect(() => createPitchDetector({ sampleRate: 0, size: 1024 })).toThrow(RangeError);
    const det = createPitchDetector({ sampleRate: 48000, size: 1024 });
    expect(() => det.detect(new Float32Array(1000))).toThrow(RangeError);
    expect(() => det.detect(new Float32Array(2048), 1025)).toThrow(RangeError);
    expect(() => det.setRange({ minMidi: 70, maxMidi: 60 })).toThrow(RangeError);
    // Two periods of E1 do not fit in 1024 samples.
    expect(() => det.setRange({ minMidi: 20, maxMidi: 24 })).toThrow(RangeError);
  });

  it('size and planPitchWindow follow docs/audio-input.md', () => {
    expect(createPitchDetector({ sampleRate: 48000, size: 4096 }).size).toBe(4096);
    expect(planPitchWindow(null)).toEqual({ size: 2048, range: null });
    expect(planPitchWindow({ minMidi: 45, maxMidi: 52 })).toEqual({ size: 2048, range: { minMidi: 38, maxMidi: 59 } });
    expect(planPitchWindow({ minMidi: 52, maxMidi: 64 })).toEqual({ size: 1024, range: { minMidi: 45, maxMidi: 71 } });
  });
});

describe('frequency ↔ MIDI helpers', () => {
  it('converts both ways with an A4 reference', () => {
    expect(midiToFreq(69)).toBe(440);
    expect(midiToFreq(40)).toBeCloseTo(82.407, 3);
    expect(freqToMidi(440)).toEqual({ midi: 69, cents: 0 });
    const q = freqToMidi(midiToFreq(64.3));
    expect(q.midi).toBe(64);
    expect(q.cents).toBeCloseTo(30, 6);
    expect(freqToMidi(midiToFreq(63.7)).cents).toBeCloseTo(-30, 6);
    expect(freqToMidi(432, 432).midi).toBe(69);
    expect(freqToMidiFloat(880)).toBeCloseTo(81, 9);
    expect(() => freqToMidi(0)).toThrow(RangeError);
    expect(() => freqToMidiFloat(Number.NaN)).toThrow(RangeError);
  });
});

describe('MPM pitch detector: budget', () => {
  it('N = 2048 runs in < 0.5 ms (Node)', () => {
    const det = createPitchDetector({ sampleRate: 48000, size: 2048 });
    const sig = karplusStrong(110, 0.5, 48000);
    const runs = 200;
    const batches: number[] = [];
    for (let b = 0; b < 7; b++) {
      const t0 = performance.now();
      for (let i = 0; i < runs; i++) det.detect(sig, (i * 37) % 4000);
      batches.push((performance.now() - t0) / runs);
    }
    batches.sort((x, y) => x - y);
    expect(batches[3]).toBeLessThan(0.5);
  });
});
