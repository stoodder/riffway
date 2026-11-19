import { describe, expect, it } from 'vitest';
import type { TrainerState } from '@shared/judge';
import type { Bar, Song } from '@shared/song';
import { TRAINER, initialTrainerState, prerollBars, snapLoop, toTransportLoop, trainerStep } from '@core/practice';
import { makeSong } from '../judge/helpers';

describe('speed trainer', () => {
  it.each([
    [3, 3, 0.7],
    [4, 3, 0.7],
    [5, 3, 0.6],
    [9, 3, 0.6],
    [1, 4, 0.7],
  ])('section tier %d, comfort %d → start %d', (section, comfort, speed) => {
    expect(initialTrainerState(section, comfort)).toEqual({ speed, failStreak: 0 });
  });

  it('clean runs ramp +5% without float drift and cap at 100%', () => {
    let state: TrainerState = initialTrainerState(3, 3);
    const speeds: number[] = [];
    for (let i = 0; i < 8; i++) {
      const step = trainerStep(state, 95, true);
      state = step.state;
      speeds.push(state.speed);
    }
    expect(speeds).toEqual([0.75, 0.8, 0.85, 0.9, 0.95, 1, 1, 1]);
    expect(trainerStep({ speed: 0.75, failStreak: 1 }, 92, true)).toEqual({
      state: { speed: 0.8, failStreak: 0 },
      delta: 0.05,
      message: 'Clean run! +5% → 80%',
    });
    expect(trainerStep({ speed: 1, failStreak: 0 }, 99, true)).toMatchObject({ delta: 0, message: 'Clean run at 100%!' });
  });

  it('two failed runs (< 70%) in a row step down 5% with "Slow down a notch"', () => {
    const first = trainerStep({ speed: 0.8, failStreak: 0 }, 69.9, false);
    expect(first).toEqual({ state: { speed: 0.8, failStreak: 1 }, delta: 0, message: null });
    const second = trainerStep(first.state, 50, false);
    expect(second).toEqual({ state: { speed: 0.75, failStreak: 0 }, delta: -0.05, message: 'Slow down a notch → 75%' });
  });

  it('a holding run (70–89%, or ≥ 90% but not clean) keeps the speed and breaks the fail streak', () => {
    expect(trainerStep({ speed: 0.8, failStreak: 1 }, 70, false)).toEqual({ state: { speed: 0.8, failStreak: 0 }, delta: 0, message: null });
    expect(trainerStep({ speed: 0.8, failStreak: 1 }, 95, false).state).toEqual({ speed: 0.8, failStreak: 0 });
  });

  it('never goes below the 40% floor', () => {
    const step = trainerStep({ speed: 0.4, failStreak: 1 }, 10, false);
    expect(step.state).toEqual({ speed: 0.4, failStreak: 0 });
    expect(step.delta).toBe(0);
    expect(step.message).toBe('Already at 40%: try a shorter loop');
    expect(trainerStep({ speed: 0.43, failStreak: 1 }, 10, false).state.speed).toBe(TRAINER.floor);
  });

  it('out-of-range stored speeds are clamped first', () => {
    expect(trainerStep({ speed: 1.2, failStreak: 0 }, 80, false).state.speed).toBe(1);
    expect(trainerStep({ speed: 0.1, failStreak: 0 }, 80, false).state.speed).toBe(0.4);
  });
});

describe('loops', () => {
  // 12 bars of 2 s; sections Intro 0–2, Verse 2–8, Chorus 8–12.
  const song: Song = makeSong([{ time: 0, midi: 64 }], {
    bars: 12,
    sections: [['Intro', 0, 2], ['Verse', 2, 8], ['Chorus', 8, 12]],
  });

  it.each([
    ['exact section edges', 4, 16, 2, 8],
    ['near section edges (< 1 bar) snap to them', 4.9, 15.2, 2, 8],
    ['inside a section → nearest bar lines', 6.9, 11.2, 3, 6],
    ['bar-exact edge one bar from a section stays on its bar', 6, 10, 3, 5],
    ['reversed range is swapped', 11.2, 6.9, 3, 6],
    ['tiny range → minimum 1 bar', 7.1, 7.3, 4, 5],
    ['zero-length range at a section edge → 1 bar', 16, 16, 8, 9],
    ['range at the very end → last bar', 23.9, 30, 11, 12],
    ['before the song start → first bar', -5, 0.5, 0, 1],
  ] as const)('snapLoop: %s', (_label, a, b, startBar, endBar) => {
    expect(snapLoop(song, a, b)).toEqual({ startBar, endBar });
  });

  it('without sections snaps to bars only', () => {
    const plain = makeSong([{ time: 0, midi: 64 }], { bars: 6 });
    expect(snapLoop(plain, 0.9, 7.2)).toEqual({ startBar: 0, endBar: 4 });
  });

  it.each([
    [1, 1], [0.6, 1], [0.65, 1], [0.59, 2], [0.4, 2],
  ])('prerollBars(%d) = %d', (speed, bars) => {
    expect(prerollBars(speed)).toBe(bars);
  });

  it('toTransportLoop converts bars to song seconds with 1 or 2 bars of pre-roll', () => {
    expect(toTransportLoop(song, { startBar: 2, endBar: 8 }, 0.8)).toEqual({ start: 4, end: 16, preroll: 2 });
    expect(toTransportLoop(song, { startBar: 2, endBar: 8 }, 0.5)).toEqual({ start: 4, end: 16, preroll: 4 });
    // Loop at the first bar: the pre-roll repeats the first bar's length (negative song time).
    expect(toTransportLoop(song, { startBar: 0, endBar: 2 }, 0.5)).toEqual({ start: 0, end: 4, preroll: 4 });
  });

  it('pre-roll follows the real lengths of the previous bars (meter / tempo changes)', () => {
    const bars: Bar[] = [
      { index: 0, time: 0, dur: 2, num: 4, den: 4, beats: [0, 0.5, 1, 1.5] },
      { index: 1, time: 2, dur: 1.5, num: 3, den: 4, beats: [2, 2.5, 3] },
      { index: 2, time: 3.5, dur: 1, num: 4, den: 4, beats: [3.5, 3.75, 4, 4.25] },
      { index: 3, time: 4.5, dur: 1, num: 4, den: 4, beats: [4.5, 4.75, 5, 5.25] },
    ];
    const odd: Song = { ...song, sections: [], timing: { tempos: [{ time: 0, bpm: 120 }], bars } };
    expect(toTransportLoop(odd, { startBar: 2, endBar: 4 }, 1)).toEqual({ start: 3.5, end: 5.5, preroll: 1.5 });
    expect(toTransportLoop(odd, { startBar: 2, endBar: 4 }, 0.45)).toEqual({ start: 3.5, end: 5.5, preroll: 3.5 });
    expect(snapLoop(odd, 3.4, 3.6)).toEqual({ startBar: 2, endBar: 3 });
  });

  it('out-of-range bar loops are clamped; a song without bars is rejected', () => {
    expect(toTransportLoop(song, { startBar: -3, endBar: 99 }, 1)).toEqual({ start: 0, end: 24, preroll: 2 });
    expect(toTransportLoop(song, { startBar: 5, endBar: 5 }, 1)).toEqual({ start: 10, end: 12, preroll: 2 });
    const empty: Song = { ...song, timing: { tempos: [], bars: [] } };
    expect(() => snapLoop(empty, 0, 1)).toThrow(RangeError);
    expect(() => toTransportLoop(empty, { startBar: 0, endBar: 1 }, 1)).toThrow(RangeError);
  });
});
