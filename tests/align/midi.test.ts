import { describe, expect, it } from 'vitest';
import {
  alignTabToMidi,
  enforceIncreasing,
  groupSimilarity,
  interpolate,
  readMidiRhythm,
  type MidiRhythm,
} from '@core/import/midi';
import { ImportError } from '@core/import/errors';
import { Midi } from '../fixtures/classtab-synthetic/midi-fixtures';
import { classtab } from '../ascii/song-checks';

/** A rhythm with one group per entry: `[time, ...pitches]`. */
const rhythm = (groups: number[][]): MidiRhythm => ({
  groups: groups.map(([time, ...pitches]) => ({ time, pitches })),
  tempos: [{ time: 0, bpm: 120 }],
  timeSignatures: [{ time: 0, num: 4, den: 4 }],
  ppq: 480,
  durationSec: groups.length ? groups[groups.length - 1][0] + 0.5 : 0,
});

describe('readMidiRhythm', () => {
  it('merges tracks into onset groups and reads tempo and time signatures in seconds', () => {
    const midi = new Midi();
    midi.header.setTempo(100);
    midi.header.timeSignatures.push({ ticks: 0, timeSignature: [3, 4] });
    const bar = midi.header.ppq * 3;
    midi.header.tempos.push({ ticks: bar, bpm: 50 });
    midi.header.timeSignatures.push({ ticks: bar, timeSignature: [6, 8] });
    midi.header.update();
    const a = midi.addTrack();
    const b = midi.addTrack();
    a.addNote({ midi: 64, time: 0, duration: 0.5 });
    b.addNote({ midi: 40, time: 0.005, duration: 1 });
    a.addNote({ midi: 64, time: 0.6, duration: 0.5 });
    const drums = midi.addTrack();
    drums.channel = 9;
    drums.addNote({ midi: 36, time: 0.3, duration: 0.1 });
    const r = readMidiRhythm(midi.toArray());
    expect(r.groups.map((g) => g.pitches)).toEqual([[40, 64], [64]]);
    expect(r.groups[1].time).toBeCloseTo(0.6, 3);
    expect(r.tempos).toHaveLength(2);
    expect(r.tempos[1].time).toBeCloseTo(1.8, 6);
    expect(r.tempos[1].bpm).toBeCloseTo(50, 6);
    expect(r.timeSignatures).toEqual([{ time: 0, num: 3, den: 4 }, { time: expect.closeTo(1.8, 6), num: 6, den: 8 }]);
    expect(r.ppq).toBe(midi.header.ppq);
  });

  it('defaults to 120 BPM and 4/4 when the file has no tempo or time signature', () => {
    const midi = new Midi();
    midi.addTrack().addNote({ midi: 60, time: 0, duration: 1 });
    const r = readMidiRhythm(midi.toArray());
    expect(r.tempos).toEqual([{ time: 0, bpm: 120 }]);
    expect(r.timeSignatures).toEqual([{ time: 0, num: 4, den: 4 }]);
  });

  it('reads the synthetic fixture: the ornament is its own group', () => {
    const r = readMidiRhythm(classtab('riffway_study_no1_in_e.mid'));
    expect(r.groups).toHaveLength(20);
    expect(r.groups[0]).toEqual({ time: 1.25, pitches: [55] });
    expect(r.timeSignatures[0]).toMatchObject({ num: 6, den: 8 });
  });

  it('throws ImportError for bytes that are not MIDI', () => {
    expect(() => readMidiRhythm(new TextEncoder().encode('MThd nonsense'))).toThrowError(ImportError);
  });
});

describe('groupSimilarity', () => {
  it('is the Jaccard index of the pitch sets', () => {
    expect(groupSimilarity([40, 55, 59], [40, 55, 59])).toBe(1);
    expect(groupSimilarity([40, 55, 59, 64], [40, 59])).toBe(0.5);
  });

  it('falls back to 0.5 × pitch-class Jaccard on octave errors', () => {
    expect(groupSimilarity([52], [64])).toBe(0.5);
    expect(groupSimilarity([52, 59], [64, 60])).toBeCloseTo(0.5 / 3, 9);
    expect(groupSimilarity([52], [65])).toBe(0);
    expect(groupSimilarity([], [65])).toBe(0);
  });
});

describe('alignTabToMidi', () => {
  const tab = (...sets: number[][]) => sets.map((pitches) => ({ pitches }));

  it('matches identical sequences one to one', () => {
    const a = alignTabToMidi(tab([40], [45], [50]), rhythm([[0, 40], [1, 45], [2, 50]]));
    expect(a).toEqual({ matched: 1, times: [0, 1, 2], pairs: [[0, 0], [1, 1], [2, 2]] });
  });

  it('skips extra MIDI groups (ornaments, intro, repeats) for free at the ends', () => {
    const midi = rhythm([[0, 30], [1, 31], [2, 40], [2.5, 47], [3, 45], [4, 50], [5, 40], [6, 45]]);
    const a = alignTabToMidi(tab([40], [45], [50]), midi);
    expect(a.pairs).toEqual([[0, 2], [1, 4], [2, 5]]);
    expect(a.times).toEqual([2, 3, 4]);
  });

  it('interpolates unmatched tab groups along their estimated times', () => {
    const groups = [{ pitches: [40], estTime: 0 }, { pitches: [99], estTime: 1 }, { pitches: [99], estTime: 3 }, { pitches: [50], estTime: 4 }];
    const a = alignTabToMidi(groups, rhythm([[10, 40], [18, 50]]));
    expect(a.matched).toBe(0.5);
    expect(a.times).toEqual([10, 12, 16, 18]);
  });

  it('extrapolates groups outside the matched range with the matched tempo', () => {
    const groups = [0, 1, 2, 3].map((estTime, i) => ({ pitches: i === 0 || i === 3 ? [99] : [40 + i], estTime }));
    const a = alignTabToMidi(groups, rhythm([[5, 41], [7, 42]]));
    expect(a.times).toEqual([3, 5, 7, 9]);
  });

  it('reports the matched fraction used by the 80% rule', () => {
    const tabGroups = tab([40], [41], [42], [43], [44]);
    expect(alignTabToMidi(tabGroups, rhythm([[0, 40], [1, 41], [2, 42], [3, 43], [4, 90]])).matched).toBe(0.8);
    expect(alignTabToMidi(tabGroups, rhythm([[0, 40], [1, 91], [2, 92], [3, 93], [4, 94]])).matched).toBeLessThan(0.8);
  });

  it('handles empty inputs', () => {
    expect(alignTabToMidi([], rhythm([[0, 40]]))).toEqual({ matched: 0, times: [], pairs: [] });
    const none = alignTabToMidi([{ pitches: [40], estTime: 2 }, { pitches: [41], estTime: 3 }], rhythm([]));
    expect(none.matched).toBe(0);
    expect(none.times).toEqual([0, 1]);
  });

  it('aligns 2,000 × 2,000 groups quickly', () => {
    const n = 2000;
    const groups = Array.from({ length: n }, (_, i) => ({ pitches: [40 + (i % 24), 64 - (i % 7)] }));
    const midi = rhythm(groups.map((g, i) => [i * 0.2, ...g.pitches]));
    const t0 = performance.now();
    const a = alignTabToMidi(groups, midi);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(a.matched).toBe(1);
  });
});

describe('interpolate / enforceIncreasing', () => {
  it('keeps anchors and fills between them', () => {
    expect(interpolate([0, 1, 2, 3], [[0, 0], [3, 6]])).toEqual([0, 2, 4, 6]);
  });

  it('never goes below zero and stays strictly increasing', () => {
    const t = interpolate([0, 1, 2], [[2, 0.5]]);
    expect(t[0]).toBe(0);
    expect(t[1]).toBeGreaterThan(t[0]);
    expect(t[2]).toBeGreaterThan(t[1]);
    expect(enforceIncreasing([1, 1, 0.5], 0.1)).toEqual([1, 1.1, 1.2000000000000002]);
  });
});
