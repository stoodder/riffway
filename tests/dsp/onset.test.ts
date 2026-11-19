import { describe, expect, it } from 'vitest';
import { createOnsetDetector, type OnsetDetectorOptions } from '@core/dsp';
import {
  addPickTransient,
  applyPluckEnvelope,
  dbToAmp,
  fadeOut,
  GUITAR_PARTIALS,
  harmonicTone,
  karplusStrong,
  midiToHz,
  noise,
  pluckedTone,
  renderTimeline,
  rng,
  sawPartials,
  sine,
  type TimelineNote,
} from '../helpers/signals';

const HOP = 128;
const RATES = [44100, 48000] as const;

interface Detected {
  frame: number;
  /** Frame just after the hop whose `process()` returned the onset. */
  detectedAt: number;
}

function detect(signal: Float32Array, sampleRate: number, startFrame = 0, opts: Partial<OnsetDetectorOptions> = {}): Detected[] {
  const det = createOnsetDetector({ sampleRate, ...opts });
  const out: Detected[] = [];
  for (let i = 0; i + HOP <= signal.length; i += HOP) {
    const f = det.process(signal.subarray(i, i + HOP), startFrame + i);
    if (f >= 0) out.push({ frame: f - startFrame, detectedAt: i + HOP });
  }
  return out;
}

type Timbre = 'pluck' | 'tone' | 'sine';

/** One plucked note: Karplus–Strong, or a string-like additive tone or a sine, each with a pick transient. */
function note(timbre: Timbre, midi: number, durSec: number, sampleRate: number, db: number, seed: number): Float32Array {
  const amp = dbToAmp(db);
  const f = midiToHz(midi);
  if (timbre === 'pluck') return karplusStrong(f, durSec, sampleRate, { amp, seed });
  const body =
    timbre === 'tone'
      ? pluckedTone(f, durSec, sampleRate, { amp, decaySec: 0.6 })
      : applyPluckEnvelope(sine(f, durSec, sampleRate, amp), sampleRate, 1, 0.5);
  return addPickTransient(body, sampleRate, amp, 1, seed);
}

interface Score {
  missed: number;
  extra: number;
  /** Largest |detected − true| onset frame, ms. */
  worstErrorMs: number;
  /** Largest (report time − true onset), ms. */
  worstLatencyMs: number;
}

function score(found: Detected[], truth: number[], sampleRate: number): Score {
  const match = 0.03 * sampleRate;
  const s: Score = { missed: 0, extra: 0, worstErrorMs: 0, worstLatencyMs: 0 };
  for (const t of truth) {
    const m = found.find((d) => Math.abs(d.frame - t) <= match);
    if (!m) {
      s.missed++;
      continue;
    }
    s.worstErrorMs = Math.max(s.worstErrorMs, (Math.abs(m.frame - t) / sampleRate) * 1000);
    s.worstLatencyMs = Math.max(s.worstLatencyMs, ((m.detectedAt - t) / sampleRate) * 1000);
  }
  s.extra = found.filter((d) => !truth.some((t) => Math.abs(d.frame - t) <= match)).length;
  return s;
}

/**
 * A random line of `count` notes over E2–E6. `ring` lets notes overlap (1.5 s each) with level steps
 * of ±6 dB; otherwise each note is muted by the next and levels are uniform in `minDb`…−6 dBFS.
 */
function line(
  sampleRate: number,
  seed: number,
  count: number,
  ring: boolean,
  timbres: readonly Timbre[] = ['pluck', 'tone', 'sine'],
  minDb = -18,
): { signal: Float32Array; truth: number[] } {
  const r = rng(seed);
  const notes: TimelineNote[] = [];
  const truth: number[] = [];
  let t = 0.2;
  let db = -12;
  for (let i = 0; i < count; i++) {
    const midi = 40 + Math.floor(r() * 49);
    db = ring ? Math.max(-18, Math.min(-6, db - 6 + r() * 12)) : -6 + r() * (minDb + 6);
    const gap = 0.1 + r() * 0.3;
    const at = Math.round(t * sampleRate);
    const sig = note(timbres[i % timbres.length], midi, ring ? 1.5 : gap, sampleRate, db, i + 1);
    notes.push({ atSec: at / sampleRate, signal: fadeOut(sig, sampleRate) });
    truth.push(at);
    t += gap;
  }
  return { signal: renderTimeline(notes, t + 0.5, sampleRate, -70), truth };
}

describe('onset detector: timing on generated lines', () => {
  for (const sampleRate of RATES) {
    it(`${sampleRate} Hz monophonic lines (3 × 80 notes, E2–E6, mixed timbres, −24…−6 dBFS): all found within ±5 ms, ≤ 6 ms latency, no extras`, () => {
      for (const seed of [1, 2, 3]) {
        const { signal, truth } = line(sampleRate, seed, 80, false, ['pluck', 'tone', 'sine'], -24);
        const s = score(detect(signal, sampleRate, 7_654_321), truth, sampleRate);
        expect(s, `seed ${seed}`).toMatchObject({ missed: 0, extra: 0 });
        expect(s.worstErrorMs).toBeLessThanOrEqual(5);
        expect(s.worstLatencyMs).toBeLessThanOrEqual(6);
      }
    });

    it(`${sampleRate} Hz let-ring line (80 overlapping notes, ±6 dB steps): all found within ±5 ms, no extras`, () => {
      const { signal, truth } = line(sampleRate, 9, 80, true);
      const s = score(detect(signal, sampleRate), truth, sampleRate);
      expect(s).toMatchObject({ missed: 0, extra: 0 });
      expect(s.worstErrorMs).toBeLessThanOrEqual(5);
    });

    it(`${sampleRate} Hz notes from silence without a pick transient (sine, saw, guitar partials): ±5 ms`, () => {
      const notes: TimelineNote[] = [];
      const truth: number[] = [];
      let t = 0.1;
      for (let midi = 40; midi <= 88; midi += 4) {
        for (const partials of [[1], sawPartials(), GUITAR_PARTIALS]) {
          const sig = applyPluckEnvelope(harmonicTone(midiToHz(midi), 0.25, sampleRate, partials, dbToAmp(-12)), sampleRate, 2, 0.2);
          notes.push({ atSec: t, signal: fadeOut(sig, sampleRate, 10) });
          truth.push(Math.round(t * sampleRate));
          t += 0.4;
        }
      }
      const s = score(detect(renderTimeline(notes, t, sampleRate, -70), sampleRate), truth, sampleRate);
      expect(s).toMatchObject({ missed: 0, extra: 0 });
      expect(s.worstErrorMs).toBeLessThanOrEqual(5);
    });
  }

  it('catches fast repeated picking on one string (16ths at 180 BPM)', () => {
    const sampleRate = 48000;
    const step = 60 / 180 / 4;
    const notes: TimelineNote[] = [];
    const truth: number[] = [];
    for (let i = 0; i < 16; i++) {
      const at = Math.round((0.1 + i * step) * sampleRate);
      notes.push({ atSec: at / sampleRate, signal: fadeOut(karplusStrong(midiToHz(45), step, sampleRate, { amp: 0.3, seed: i + 1 }), sampleRate, 3) });
      truth.push(at);
    }
    const s = score(detect(renderTimeline(notes, 1.6, sampleRate, -70), sampleRate), truth, sampleRate);
    expect(s).toMatchObject({ missed: 0, extra: 0 });
    expect(s.worstErrorMs).toBeLessThanOrEqual(5);
  });
});

describe('onset detector: no false onsets', () => {
  for (const sampleRate of RATES) {
    it(`${sampleRate} Hz: exactly one onset over a 2 s decay, E2–E6, three timbres`, () => {
      for (const midi of [40, 45, 50, 55, 59, 64, 69, 76, 83, 88]) {
        const f = midiToHz(midi);
        const notes = [
          karplusStrong(f, 2, sampleRate, { feedback: 0.999, seed: midi }),
          applyPluckEnvelope(harmonicTone(f, 2, sampleRate, GUITAR_PARTIALS), sampleRate, 2, 1),
          applyPluckEnvelope(sine(f, 2, sampleRate), sampleRate, 2, 1),
        ];
        for (const n of notes) {
          const found = detect(renderTimeline([{ atSec: 0.1, signal: fadeOut(n, sampleRate, 20) }], 2.3, sampleRate, -65), sampleRate);
          expect(found.map((d) => d.frame), `midi ${midi}`).toHaveLength(1);
          expect(Math.abs(found[0].frame - 0.1 * sampleRate)).toBeLessThanOrEqual(0.005 * sampleRate);
        }
      }
    });
  }

  it('ignores steady noise, even well above the floor', () => {
    expect(detect(noise(3 * 48000, dbToAmp(-30), 4), 48000)).toEqual([]);
  });

  it('ignores plucks below the absolute floor (−50 dBFS) and honours a custom floor', () => {
    const quiet = renderTimeline([{ atSec: 0.1, signal: fadeOut(karplusStrong(110, 0.5, 48000, { amp: dbToAmp(-60) }), 48000) }], 0.7, 48000, -90);
    expect(detect(quiet, 48000)).toEqual([]);
    expect(detect(quiet, 48000, 0, { floorDb: -75 })).toHaveLength(1);
  });

  it('applies the refractory period (40 ms default)', () => {
    const sr = 48000;
    const two = (gapMs: number) =>
      renderTimeline(
        [
          { atSec: 0.1, signal: fadeOut(karplusStrong(220, gapMs / 1000, sr, { amp: 0.2 }), sr, 1) },
          { atSec: 0.1 + gapMs / 1000, signal: fadeOut(karplusStrong(330, 0.3, sr, { amp: 0.4, seed: 2 }), sr) },
        ],
        0.6,
        sr,
        -70,
      );
    expect(detect(two(20), sr)).toHaveLength(1);
    expect(detect(two(60), sr)).toHaveLength(2);
    expect(detect(two(60), sr, 0, { refractoryMs: 80 })).toHaveLength(1);
  });

  it('does not report a signal already playing when it starts or after reset()', () => {
    const sr = 48000;
    const sig = renderTimeline(
      [
        { atSec: 0, signal: fadeOut(karplusStrong(110, 1, sr, { amp: 0.4 }), sr) },
        { atSec: 0.6, signal: fadeOut(karplusStrong(165, 0.4, sr, { amp: 0.4, seed: 3 }), sr) },
      ],
      1,
      sr,
      -70,
    );
    const det = createOnsetDetector({ sampleRate: sr });
    const found: number[] = [];
    for (let i = 0; i + HOP <= sig.length; i += HOP) {
      if (i === 0.3 * sr - (0.3 * sr) % HOP) det.reset();
      const f = det.process(sig.subarray(i, i + HOP), i);
      if (f >= 0) found.push(f);
    }
    expect(found).toHaveLength(1);
    expect(Math.abs(found[0] - 0.6 * sr)).toBeLessThanOrEqual(0.005 * sr);
  });
});

describe('onset detector: API and budget', () => {
  it('validates the hop and options', () => {
    const det = createOnsetDetector({ sampleRate: 48000 });
    expect(() => det.process(new Float32Array(256), 0)).toThrow(RangeError);
    expect(() => createOnsetDetector({ sampleRate: 0 })).toThrow(RangeError);
    expect(() => createOnsetDetector({ sampleRate: 48000, hop: 100.5 })).toThrow(RangeError);
    const big = createOnsetDetector({ sampleRate: 48000, hop: 256 });
    expect(big.process(new Float32Array(256), 0)).toBe(-1);
  });

  it('processes a 128-sample hop in < 0.1 ms (Node)', () => {
    const sr = 48000;
    const sig = renderTimeline(
      Array.from({ length: 10 }, (_, i) => ({ atSec: i * 0.3, signal: karplusStrong(midiToHz(40 + i * 4), 0.3, sr, { seed: i + 1 }) })),
      3,
      sr,
      -70,
    );
    const hops = Array.from({ length: Math.floor(sig.length / HOP) }, (_, i) => sig.subarray(i * HOP, (i + 1) * HOP));
    const det = createOnsetDetector({ sampleRate: sr });
    const batches: number[] = [];
    for (let b = 0; b < 5; b++) {
      det.reset();
      const t0 = performance.now();
      for (let i = 0; i < hops.length; i++) det.process(hops[i], i * HOP);
      batches.push((performance.now() - t0) / hops.length);
    }
    batches.sort((x, y) => x - y);
    expect(batches[2]).toBeLessThan(0.1);
  });
});
