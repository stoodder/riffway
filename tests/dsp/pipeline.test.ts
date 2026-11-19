import { describe, expect, it } from 'vitest';
import { planPitchWindow } from '@core/dsp';
import { addNoise, centsBetween, fadeOut, karplusStrong, midiToHz, renderTimeline, type TimelineNote } from '../helpers/signals';
import { analyse } from './pipeline';

describe('analysis chain: onset + pitch 25 ms later (generated plucks)', () => {
  for (const sampleRate of [44100, 48000]) {
    it(`${sampleRate} Hz: every plucked note E2–E6 gets its onset (±5 ms) and pitch (±10 cents, clarity ≥ 0.9)`, () => {
      for (const hinted of [false, true]) {
        const notes: TimelineNote[] = [];
        const midis: number[] = [];
        let t = 0.1;
        for (let midi = 40; midi <= 88; midi++) {
          notes.push({ atSec: t, signal: fadeOut(karplusStrong(midiToHz(midi), 0.25, sampleRate, { amp: 0.3, seed: midi }), sampleRate) });
          midis.push(midi);
          t += 0.25;
        }
        const signal = addNoise(renderTimeline(notes, t + 0.2, sampleRate), -65);
        // Hinted: the `expect` range covers the whole line, widened ±7 semitones by planPitchWindow.
        const { onsets } = analyse(signal, sampleRate, hinted ? planPitchWindow({ minMidi: 40, maxMidi: 88 }) : {});
        expect(onsets).toHaveLength(midis.length);
        onsets.forEach((o, i) => {
          const label = `${hinted ? 'hint' : 'no hint'} midi ${midis[i]}`;
          expect(Math.abs(o.frame - Math.round(notes[i].atSec * sampleRate)), label).toBeLessThanOrEqual(0.005 * sampleRate);
          expect(o.midi, label).toBe(midis[i]);
          expect(o.clarity, label).toBeGreaterThanOrEqual(0.9);
          const freq = midiToHz(o.midi! + o.cents / 100);
          expect(Math.abs(centsBetween(freq, midiToHz(midis[i]))), label).toBeLessThanOrEqual(10);
        });
      }
    });
  }
});
