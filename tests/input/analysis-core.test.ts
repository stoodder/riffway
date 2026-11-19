/**
 * The analysis worklet's logic (`AnalysisCore`, T-022) driven quantum by quantum in Node, the way the
 * worklet runs it: onsets + pitches on plucked melodies, level cadence, channel selection, tuner
 * frames (incl. Drop D's low D), `expect` hints, the cut-short window for fast notes, the follow-up
 * pitch for an unclear attack, legato and resets.
 */
import { describe, expect, it } from 'vitest';
import {
  AnalysisCore,
  LEVEL_INTERVAL_SEC,
  ONSET_PITCH_DELAY_SEC,
  QUANTUM,
  TUNER_HOP_FRAMES,
} from '../../src/audio/input/analysis-core';
import type { AnalysisEvent } from '@shared/audio-events';
import { centsBetween, fadeOut, legatoTone, midiToHz, mixInto, noise, pluckedTone } from '../helpers/signals';
import { SR, melody, ofType, runCore } from './helpers';

const TOL_FRAMES = Math.round(0.005 * SR);

describe('AnalysisCore onsets and pitch', () => {
  const notes = [40, 45, 50, 55, 59, 64, 69, 76, 84].map((midi, i) => ({ atSec: 0.3 + i * 0.4, midi }));
  const events = runCore([melody(notes, 4.2)]);
  const onsets = ofType(events, 'onset');

  it('finds every pluck from E2 to C6 within ±5 ms with the right MIDI pitch', () => {
    expect(onsets).toHaveLength(notes.length);
    onsets.forEach((o, i) => {
      expect(Math.abs(o.frame - notes[i].atSec * SR)).toBeLessThanOrEqual(TOL_FRAMES);
      expect(o.midi).toBe(notes[i].midi);
      expect(Math.abs(o.cents)).toBeLessThan(10);
      expect(o.clarity).toBeGreaterThanOrEqual(0.9);
      expect(o.rmsDb).toBeGreaterThan(-40);
      expect(o.rmsDb).toBeLessThan(0);
    });
    expect(ofType(events, 'pitch')).toHaveLength(0);
    expect(ofType(events, 'pitch-change')).toHaveLength(0);
  });

  it('respects the start frame (context frames, not buffer offsets)', () => {
    const shifted = ofType(runCore([melody(notes.slice(0, 2), 1.2)], { startFrame: 480_000 }), 'onset');
    expect(shifted.map((o) => o.frame - 480_000)).toEqual(onsets.slice(0, 2).map((o) => o.frame));
  });

  it('reports the onset only after its pitch window (25 ms + N) is complete', () => {
    const core = new AnalysisCore({ sampleRate: SR, channel: 0, tuner: false }, (ev) => seen.push({ frame: end, ev }));
    const seen: { frame: number; ev: AnalysisEvent }[] = [];
    const signal = melody([{ atSec: 0.3, midi: 45 }], 0.8);
    let end = 0;
    for (let off = 0; off + QUANTUM <= signal.length; off += QUANTUM) {
      end = off + QUANTUM;
      core.process([signal.subarray(off, end)], off);
    }
    const onset = seen.find((s) => s.ev.type === 'onset');
    expect(onset).toBeDefined();
    const due = 0.3 * SR + Math.round(ONSET_PITCH_DELAY_SEC * SR) + 2048;
    expect(onset!.frame).toBeGreaterThanOrEqual(due);
    // Within one quantum of the window's end: the judge's guitar lag budget assumes 25 ms + N + 128.
    expect(onset!.frame - due).toBeLessThanOrEqual(QUANTUM);
  });

  it('never measures across the next pluck: fast notes get their own pitch or none', () => {
    for (const gap of [0.045, 0.06]) {
      const fast = [
        { atSec: 0.3, midi: 45, durSec: gap - 0.01 },
        { atSec: 0.3 + gap, midi: 47 },
      ];
      const got = ofType(runCore([melody(fast, 1)]), 'onset');
      expect(got).toHaveLength(2);
      expect([45, null]).toContain(got[0].midi);
      expect(got[1].midi).toBe(47);
    }
    // With a high `expect` hint the short window fits between notes 45 ms apart.
    const high = [
      { atSec: 0.3, midi: 64, durSec: 0.035 },
      { atSec: 0.345, midi: 67 },
    ];
    const hinted = ofType(
      runCore([melody(high, 1)], { commands: [{ frame: 0, cmd: { type: 'expect', range: { minMidi: 64, maxMidi: 67 } } }] }),
      'onset',
    );
    expect(hinted.map((o) => o.midi)).toEqual([64, 67]);
  });

  it('emits an unpitched onset and a follow-up pitch when the attack is unclear', () => {
    const sig = new Float32Array(SR * 1.2);
    mixInto(sig, noise(Math.round(0.036 * SR), 0.2, 5), Math.round(0.3 * SR));
    mixInto(sig, fadeOut(pluckedTone(midiToHz(57), 0.5, SR, { amp: 0.3 }), SR, 8), Math.round(0.3 * SR) + 10);
    const ev = runCore([sig]);
    const [onset] = ofType(ev, 'onset');
    expect(onset.midi).toBeNull();
    expect(onset.clarity).toBeLessThan(0.6);
    const pitches = ofType(ev, 'pitch');
    expect(pitches).toHaveLength(1);
    expect(pitches[0].onsetFrame).toBe(onset.frame);
    expect(pitches[0].midi).toBe(57);
    expect(pitches[0].clarity).toBeGreaterThanOrEqual(0.6);
    expect(pitches[0].frame).toBeGreaterThan(onset.frame);
  });

  it('detects a hammer-on as a pitch change without a second onset', () => {
    const sig = new Float32Array(SR * 1.5);
    mixInto(sig, fadeOut(legatoTone([{ atSec: 0, midi: 45 }, { atSec: 0.3, midi: 47 }], 0.8, SR), SR, 8), Math.round(0.3 * SR));
    const ev = runCore([sig]);
    expect(ofType(ev, 'onset')).toHaveLength(1);
    const changes = ofType(ev, 'pitch-change');
    expect(changes).toHaveLength(1);
    expect(changes[0].midi).toBe(47);
    expect(Math.abs(changes[0].frame - 0.6 * SR)).toBeLessThan(0.03 * SR);
  });

  it('treats a missing input as silence and recovers from frame gaps', () => {
    const core = new AnalysisCore({ sampleRate: SR, channel: 0, tuner: false }, (ev) => out.push(ev));
    const out: AnalysisEvent[] = [];
    for (let f = 0; f < SR * 0.2; f += QUANTUM) core.process([], f);
    const levels = ofType(out, 'level');
    expect(levels.length).toBeGreaterThan(2);
    expect(levels.every((l) => l.peakDb === -120 && l.rmsDb === -120)).toBe(true);
    // A jump in currentFrame (e.g. the node was paused) restarts the detectors instead of mixing history.
    const sig = melody([{ atSec: 0.3, midi: 52 }], 0.8);
    for (let off = 0; off + QUANTUM <= sig.length; off += QUANTUM) core.process([sig.subarray(off, off + QUANTUM)], 1_000_000 + off);
    const onsets = ofType(out, 'onset');
    expect(onsets).toHaveLength(1);
    expect(Math.abs(onsets[0].frame - (1_000_000 + 0.3 * SR))).toBeLessThanOrEqual(TOL_FRAMES);
    expect(onsets[0].midi).toBe(52);
  });

  it('reset drops a pending measurement', () => {
    const sig = melody([{ atSec: 0.3, midi: 52 }], 0.8);
    const resetAt = Math.round(0.31 * SR / QUANTUM) * QUANTUM;
    const ev = runCore([sig], { commands: [{ frame: resetAt, cmd: { type: 'reset' } }] });
    expect(ofType(ev, 'onset')).toHaveLength(0);
  });
});

describe('AnalysisCore level', () => {
  it('posts peak/RMS about every 50 ms', () => {
    const sec = 1;
    const sine = new Float32Array(SR * sec);
    for (let i = 0; i < sine.length; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
    const levels = ofType(runCore([sine]), 'level');
    expect(levels.length).toBe(Math.floor((SR * sec) / QUANTUM / Math.round((LEVEL_INTERVAL_SEC * SR) / QUANTUM)));
    const steps = levels.slice(1).map((l, i) => (l.frame - levels[i].frame) / SR);
    for (const s of steps) expect(s).toBeCloseTo(LEVEL_INTERVAL_SEC, 2);
    const last = levels[levels.length - 1];
    expect(last.peakDb).toBeCloseTo(20 * Math.log10(0.5), 1);
    expect(last.rmsDb).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 1);
  });
});

describe('AnalysisCore channel selection', () => {
  const sig = melody([{ atSec: 0.3, midi: 50 }], 0.9);
  const silent = new Float32Array(sig.length);

  it('analyses channel 1 when the guitar is on input 2', () => {
    expect(ofType(runCore([silent, sig], { channel: 1 }), 'onset').map((o) => o.midi)).toEqual([50]);
    expect(ofType(runCore([silent, sig], { channel: 0 }), 'onset')).toHaveLength(0);
  });

  it('mixes channels 1 + 2 (half level when only one carries signal)', () => {
    const one = ofType(runCore([sig, silent], { channel: 0 }), 'level');
    const mix = runCore([silent, sig], { channel: 'mix' });
    expect(ofType(mix, 'onset').map((o) => o.midi)).toEqual([50]);
    const peak = (ls: { peakDb: number }[]): number => Math.max(...ls.map((l) => l.peakDb));
    expect(peak(ofType(mix, 'level'))).toBeCloseTo(peak(one) - 20 * Math.log10(2), 1);
  });

  it('falls back to channel 0 on a mono input', () => {
    expect(ofType(runCore([sig], { channel: 1 }), 'onset').map((o) => o.midi)).toEqual([50]);
  });

  it('switches channel on a config command', () => {
    const ev = runCore([silent, sig], { channel: 0, commands: [{ frame: 0, cmd: { type: 'config', channel: 1, tuner: false } }] });
    expect(ofType(ev, 'onset')).toHaveLength(1);
  });
});

describe('AnalysisCore at the interface sample rate (R3-C-03)', () => {
  /** E2, F2, F♯2 (low E frets 0–2), A2, then E3, F3, F♯3. */
  const LOW = [40, 41, 42, 45, 52, 53, 54];
  const at = (midis: readonly number[]) => midis.map((midi, i) => ({ atSec: 0.3 + i * 0.4, midi }));

  for (const sr of [44100, 48000, 88200, 96000]) {
    describe(`${sr} Hz`, () => {
      const scale = sr >= 88200 ? 2 : 1;

      it('scales the pitch window with the rate', () => {
        const core = new AnalysisCore({ sampleRate: sr, channel: 0, tuner: false }, () => undefined);
        expect(core.windowSize).toBe(2048 * scale);
        core.command({ type: 'expect', range: { minMidi: 60, maxMidi: 72 } });
        expect(core.windowSize).toBe(1024 * scale);
      });

      it('pitches the low E string and E3–F♯3, hinted and unhinted', () => {
        const notes = at(LOW);
        const signal = melody(notes, 3.4, sr);
        for (const range of [null, { minMidi: 40, maxMidi: 64 }]) {
          const onsets = ofType(runCore([signal], { sampleRate: sr, commands: [{ frame: 0, cmd: { type: 'expect', range } }] }), 'onset');
          expect(onsets.map((o) => o.midi), JSON.stringify(range)).toEqual(LOW);
          onsets.forEach((o, i) => expect(Math.abs(o.frame - notes[i].atSec * sr)).toBeLessThanOrEqual(0.005 * sr));
        }
      });

      it("pitches Drop D's D2 with its hint", () => {
        const notes = at([38, 45, 50]);
        const onsets = ofType(
          runCore([melody(notes, 1.6, sr)], { sampleRate: sr, commands: [{ frame: 0, cmd: { type: 'expect', range: { minMidi: 38, maxMidi: 62 } } }] }),
          'onset',
        );
        expect(onsets.map((o) => o.midi)).toEqual([38, 45, 50]);
      });

      it('pitches E3–F♯3 on the short window (hint above 160 Hz)', () => {
        const notes = at([52, 53, 54, 57]);
        const onsets = ofType(
          runCore([melody(notes, 2, sr)], { sampleRate: sr, commands: [{ frame: 0, cmd: { type: 'expect', range: { minMidi: 52, maxMidi: 76 } } }] }),
          'onset',
        );
        expect(onsets.map((o) => o.midi)).toEqual([52, 53, 54, 57]);
      });

      it("tunes Drop D's low D2 with ~23 Hz frames", () => {
        const dropD = midiToHz(38) * 2 ** (-12 / 1200);
        const frames = ofType(runCore([pluckedTone(dropD, 1.5, sr, { decaySec: 3 })], { sampleRate: sr, tuner: true }), 'tuner');
        expect(frames.length).toBeGreaterThan(20);
        for (const f of frames.slice(1, -1)) expect(Math.abs(centsBetween(f.freq, dropD))).toBeLessThan(2);
        const gapSec = (frames[2].frame - frames[1].frame) / sr;
        expect(gapSec).toBeGreaterThan(0.04);
        expect(gapSec).toBeLessThan(0.05);
      });
    });
  }
});

describe('AnalysisCore tuner frames', () => {
  const dropD = midiToHz(38) * 2 ** (-12 / 1200);
  const tone = pluckedTone(dropD, 2.5, SR, { decaySec: 3 });

  it('streams ~23 Hz frames that resolve Drop D’s low D2 12 cents flat', () => {
    const frames = ofType(runCore([tone], { tuner: true }), 'tuner');
    const expected = Math.floor((tone.length - 4096) / TUNER_HOP_FRAMES) + 1;
    expect(frames.length).toBeGreaterThanOrEqual(expected - 1);
    expect(frames.length).toBeLessThanOrEqual(expected);
    for (const f of frames.slice(1, -1)) {
      expect(Math.abs(centsBetween(f.freq, dropD))).toBeLessThan(2);
      expect(f.clarity).toBeGreaterThanOrEqual(0.9);
    }
    const gaps = frames.slice(1).map((f, i) => f.frame - frames[i].frame);
    expect(new Set(gaps)).toEqual(new Set([TUNER_HOP_FRAMES]));
  });

  it('is off by default and toggles with config', () => {
    expect(ofType(runCore([tone]), 'tuner')).toHaveLength(0);
    const half = Math.round(tone.length / 2 / QUANTUM) * QUANTUM;
    const ev = runCore([tone], {
      commands: [
        { frame: 0, cmd: { type: 'config', channel: 0, tuner: true } },
        { frame: half, cmd: { type: 'config', channel: 0, tuner: false } },
      ],
    });
    const frames = ofType(ev, 'tuner');
    expect(frames.length).toBeGreaterThan(5);
    expect(frames.every((f) => f.frame < half)).toBe(true);
  });

  it('reports freq 0 on silence', () => {
    const frames = ofType(runCore([new Float32Array(SR)], { tuner: true }), 'tuner');
    expect(frames.length).toBeGreaterThan(5);
    expect(frames.every((f) => f.freq === 0 && f.clarity === 0)).toBe(true);
  });
});

describe('AnalysisCore expect hints', () => {
  it('picks the window from the hint and tolerates ranges the window cannot resolve', () => {
    const core = new AnalysisCore({ sampleRate: SR, channel: 0, tuner: false }, () => undefined);
    expect(core.windowSize).toBe(2048);
    core.command({ type: 'expect', range: { minMidi: 60, maxMidi: 72 } });
    expect(core.windowSize).toBe(1024);
    core.command({ type: 'expect', range: { minMidi: 40, maxMidi: 52 } });
    expect(core.windowSize).toBe(2048);
    expect(() => core.command({ type: 'expect', range: { minMidi: 10, maxMidi: 12 } })).not.toThrow();
    core.command({ type: 'expect', range: null });
    expect(core.windowSize).toBe(2048);
  });

  it('finds a hinted low note with the hint applied', () => {
    const notes = [{ atSec: 0.3, midi: 38 }];
    const ev = runCore([melody(notes, 1)], { commands: [{ frame: 0, cmd: { type: 'expect', range: { minMidi: 38, maxMidi: 50 } } }] });
    expect(ofType(ev, 'onset').map((o) => o.midi)).toEqual([38]);
  });

  it('works at 44.1 kHz', () => {
    const notes = [45, 57, 69].map((midi, i) => ({ atSec: 0.3 + i * 0.4, midi }));
    const sr = 44100;
    const ev = ofType(runCore([melody(notes, 1.6, sr)], { sampleRate: sr }), 'onset');
    expect(ev.map((o) => o.midi)).toEqual([45, 57, 69]);
    ev.forEach((o, i) => expect(Math.abs(o.frame - notes[i].atSec * sr)).toBeLessThanOrEqual(0.005 * sr));
  });
});
