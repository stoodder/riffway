import { describe, expect, it } from 'vitest';
import { createPitchChangeDetector, planPitchWindow, type PitchEstimate } from '@core/dsp';
import { addPickTransient, dbToAmp, fadeOut, karplusStrong, legatoTone, midiToHz, renderTimeline } from '../helpers/signals';
import { analyse } from './pipeline';

const SR = 48000;
/** Pitch frames every 256 samples (5.3 ms), as in the pipeline. */
const STEP = 256;

function est(pitch: number, clarity = 0.95): PitchEstimate {
  const midi = Math.round(pitch);
  return { freq: midiToHz(pitch), midi, cents: (pitch - midi) * 100, clarity };
}

/** Feed `pitches` (null = no estimate) at STEP spacing from `start`; returns [frameIndex, midi] for each change. */
function feed(det: ReturnType<typeof createPitchChangeDetector>, pitches: (number | null)[], start = 0): [number, number][] {
  const out: [number, number][] = [];
  pitches.forEach((p, i) => {
    const m = det.push(p === null ? null : est(p), start + i * STEP);
    if (m >= 0) out.push([i, m]);
  });
  return out;
}

const hold = (pitch: number | null, frames: number): (number | null)[] => Array<number | null>(frames).fill(pitch);
/** Frames needed to span 25 ms (first and last frame inclusive). */
const HOLD_FRAMES = Math.ceil((0.025 * SR) / STEP) + 1;

describe('pitch-change detector (unit)', () => {
  it('reports a ≥ 0.8 semitone move held for 25 ms once, from its first frame', () => {
    const det = createPitchChangeDetector({ sampleRate: SR });
    const changes = feed(det, [...hold(52, 20), ...hold(54, 30)]);
    expect(changes).toEqual([[20 + HOLD_FRAMES - 1, 54]]);
    expect(det.changeFrame).toBe(20 * STEP);
  });

  it('ignores moves that are too small or too short', () => {
    const det = createPitchChangeDetector({ sampleRate: SR });
    const vibrato = Array.from({ length: 80 }, (_, i) => 52 + 0.4 * Math.sin(i / 3));
    expect(feed(det, [...hold(52, 10), ...vibrato, ...hold(52.7, 20), ...hold(54, HOLD_FRAMES - 1), ...hold(52, 10)])).toEqual([]);
    expect(feed(det, hold(52.9, HOLD_FRAMES), 200 * STEP)).toEqual([[HOLD_FRAMES - 1, 53]]);
  });

  it('reports the end of a slide and chains changes', () => {
    const det = createPitchChangeDetector({ sampleRate: SR });
    const slide = Array.from({ length: 12 }, (_, i) => 50 + (5 * (i + 1)) / 12);
    const changes = feed(det, [...hold(50, 10), ...slide, ...hold(55, 20), ...hold(53, 20)]);
    expect(changes.map(([, m]) => m)).toEqual([55, 53]);
  });

  it('ignores frames below clarity 0.8 and inside the 25 ms after an onset', () => {
    const det = createPitchChangeDetector({ sampleRate: SR });
    expect(det.push(est(52), 0)).toBe(-1);
    for (let i = 1; i < 20; i++) expect(det.push(est(57, 0.7), i * STEP)).toBe(-1);
    det.onset(20 * STEP);
    // Attack frames (any pitch) are skipped; the first frame after 25 ms is the new reference.
    expect(feed(det, [...hold(64, 4), ...hold(57, 30)], 20 * STEP)).toEqual([]);
  });

  it('bridges short unclear stretches but starts a fresh reference after 150 ms without pitch, and after reset()', () => {
    const det = createPitchChangeDetector({ sampleRate: SR });
    expect(feed(det, [...hold(52, 10), ...hold(null, 12), ...hold(55, 20)])).toEqual([[22 + HOLD_FRAMES - 1, 55]]);
    expect(feed(det, [...hold(null, 30), ...hold(60, 20)], 100 * STEP)).toEqual([]);
    det.reset();
    expect(det.changeFrame).toBe(-1);
    expect(feed(det, [...hold(45, 10), ...hold(47, 20)])).toEqual([[10 + HOLD_FRAMES - 1, 47]]);
    expect(() => createPitchChangeDetector({ sampleRate: 0 })).toThrow(RangeError);
  });
});

describe('pitch-change detector in the analysis chain (generated audio)', () => {
  for (const sampleRate of [44100, 48000]) {
    it(`${sampleRate} Hz hammer-ons and pull-offs: one onset, then exactly one pitch-change`, () => {
      for (const [from, to] of [[40, 42], [45, 47], [52, 55], [57, 55], [64, 65], [69, 67], [76, 78], [83, 81]]) {
        const tone = legatoTone([{ atSec: 0, midi: from }, { atSec: 0.4, midi: to }], 1, sampleRate, { amp: dbToAmp(-12) });
        addPickTransient(fadeOut(tone, sampleRate, 20), sampleRate, dbToAmp(-12));
        const signal = renderTimeline([{ atSec: 0.1, signal: tone }], 1.2, sampleRate, -70);
        const { onsets, pitchChanges } = analyse(signal, sampleRate, planPitchWindow({ minMidi: Math.min(from, to), maxMidi: Math.max(from, to) }));
        const label = `${from}→${to}`;
        expect(onsets.map((o) => o.midi), label).toEqual([from]);
        expect(Math.abs(onsets[0].frame - 0.1 * sampleRate), label).toBeLessThanOrEqual(0.005 * sampleRate);
        expect(pitchChanges.map((p) => p.midi), label).toEqual([to]);
        const changeSec = pitchChanges[0].frame / sampleRate;
        expect(changeSec, label).toBeGreaterThanOrEqual(0.5);
        expect(changeSec, label).toBeLessThanOrEqual(0.53);
        // Confirmed within ~2 windows' worth of the change (window centre + 25 ms hold).
        expect(pitchChanges[0].detectedAt / sampleRate - 0.5, label).toBeLessThanOrEqual(0.08);
      }
    });
  }

  it('slides end on the target note without an amplitude onset', () => {
    for (const [from, to] of [[45, 50], [60, 55], [64, 71]]) {
      const tone = legatoTone([{ atSec: 0, midi: from }, { atSec: 0.3, midi: to }], 0.9, SR, { amp: dbToAmp(-12), glideMs: 80 });
      addPickTransient(fadeOut(tone, SR, 20), SR, dbToAmp(-12));
      const signal = renderTimeline([{ atSec: 0.1, signal: tone }], 1.1, SR, -70);
      const { onsets, pitchChanges } = analyse(signal, SR);
      expect(onsets).toHaveLength(1);
      expect(pitchChanges.length).toBeGreaterThanOrEqual(1);
      expect(pitchChanges.at(-1)!.midi).toBe(to);
    }
  });

  it('a new pluck while the previous note rings is an onset, not a pitch-change; sustained notes give none', () => {
    const notes = [
      { atSec: 0.1, signal: fadeOut(karplusStrong(midiToHz(45), 1.2, SR, { amp: 0.3, feedback: 0.999 }), SR, 20) },
      { atSec: 0.7, signal: fadeOut(karplusStrong(midiToHz(52), 0.8, SR, { amp: 0.4, seed: 2, feedback: 0.999 }), SR, 20) },
    ];
    const { onsets, pitchChanges } = analyse(renderTimeline(notes, 1.6, SR, -70), SR);
    expect(onsets.map((o) => o.midi)).toEqual([45, 52]);
    expect(pitchChanges).toEqual([]);
  });
});
