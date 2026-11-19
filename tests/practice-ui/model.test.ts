/**
 * Practice panel model (T-032): speed steps/range, overspeed gating, A/B editing (snap to sections
 * then bars, min 1 bar), strip geometry, trainer ladder and message classification.
 */
import { describe, expect, it } from 'vitest';
import {
  SPEED,
  adjacentSectionLoop,
  barIndexAt,
  barTickEvery,
  clampSpeed,
  cleanRunsToGoal,
  describeLoop,
  formatSpeed,
  fractionToTime,
  isCleanRunMessage,
  loopToBars,
  maxSpeed,
  messageTone,
  nudgeLoop,
  overspeedAllowed,
  prerollText,
  sectionIndexAtBar,
  sectionIndexOfLoop,
  sectionLoop,
  setLoopEnd,
  setLoopStart,
  speedPresets,
  stepSpeed,
  timeToFraction,
  trainerLadder,
  trainerProgress,
} from '../../src/ui/panels/practice/model';
import { toTransportLoop } from '@core/practice';
import { makeSong, mastered } from './helpers';

const song = makeSong(); // 16 bars × 2 s; Intro 0–4, Verse 4–8, Chorus 8–12, Outro 12–16

describe('speed', () => {
  it('uses the contract range 40–100% (110% overspeed) in 5% steps', () => {
    expect(SPEED).toEqual({ min: 0.4, max: 1, overspeedMax: 1.1, step: 0.05 });
    expect(maxSpeed(false)).toBe(1);
    expect(maxSpeed(true)).toBe(1.1);
  });

  it('steps on the 5% grid without float drift and clamps', () => {
    expect(stepSpeed(0.7, 1)).toBe(0.75);
    expect(stepSpeed(0.75, -1)).toBe(0.7);
    expect(stepSpeed(0.72, 1)).toBe(0.75);
    expect(stepSpeed(0.72, -1)).toBe(0.7);
    expect(stepSpeed(0.8 + 0.05, 1)).toBe(0.9);
    expect(stepSpeed(1, 1)).toBe(1);
    expect(stepSpeed(1, 1, 1.1)).toBe(1.05);
    expect(stepSpeed(0.4, -1)).toBe(0.4);
    let s = 0.4;
    for (let i = 0; i < 12; i++) s = stepSpeed(s, 1);
    expect(s).toBe(1);
  });

  it('clamps and formats', () => {
    expect(clampSpeed(0.25)).toBe(0.4);
    expect(clampSpeed(1.5)).toBe(1);
    expect(clampSpeed(1.5, 1.1)).toBe(1.1);
    expect(formatSpeed(0.85)).toBe('85%');
    expect(speedPresets(1)).toEqual([0.5, 0.6, 0.7, 0.85, 1]);
    expect(speedPresets(1.1)).toContain(1.1);
  });

  it('offers 110% only with the opt-in and every in-scope section mastered', () => {
    const all = [0, 1, 2, 3].map(mastered);
    expect(overspeedAllowed(false, song, all, null)).toBe(false);
    expect(overspeedAllowed(true, song, all, null)).toBe(true);
    expect(overspeedAllowed(true, song, [mastered(1)], null)).toBe(false);
    expect(overspeedAllowed(true, song, [mastered(1)], { startBar: 4, endBar: 8 })).toBe(true);
    expect(overspeedAllowed(true, song, [mastered(1)], { startBar: 4, endBar: 9 })).toBe(false);
    const noSections = makeSong(8, []);
    expect(overspeedAllowed(true, noSections, [mastered(0)], null)).toBe(true);
  });
});

describe('bars and sections', () => {
  it('finds bars and sections', () => {
    expect(barIndexAt(song.timing.bars, -1)).toBe(0);
    expect(barIndexAt(song.timing.bars, 4)).toBe(2);
    expect(barIndexAt(song.timing.bars, 5.9)).toBe(2);
    expect(barIndexAt(song.timing.bars, 99)).toBe(15);
    expect(sectionIndexAtBar(song.sections, 5)).toBe(1);
    expect(sectionIndexOfLoop(song.sections, { startBar: 8, endBar: 12 })).toBe(2);
    expect(sectionIndexOfLoop(song.sections, { startBar: 8, endBar: 11 })).toBe(-1);
    expect(sectionLoop(song, 3)).toEqual({ startBar: 12, endBar: 16 });
    expect(sectionLoop(makeSong(8, []), -1, 3)).toEqual({ startBar: 3, endBar: 4 });
  });

  it('round-trips transport loops (with pre-roll) to bar loops', () => {
    for (const speed of [0.5, 1]) {
      const tl = toTransportLoop(song, { startBar: 5, endBar: 9 }, speed);
      expect(loopToBars(song, tl)).toEqual({ startBar: 5, endBar: 9 });
    }
    expect(loopToBars(song, null)).toBeNull();
  });

  it('describes loops and pre-roll', () => {
    expect(describeLoop({ startBar: 4, endBar: 8 })).toEqual({ bars: 4, label: 'bars 5–8' });
    expect(describeLoop({ startBar: 4, endBar: 5 }).label).toBe('bar 5');
    expect(prerollText(0.6)).toBe('1-bar pre-roll');
    expect(prerollText(0.55)).toBe('2-bar pre-roll (below 60%)');
  });
});

describe('A/B editing', () => {
  it('Set A without a loop leaves a pending A snapped to a section, then bars', () => {
    expect(setLoopStart(song, { loop: null, pendingA: null }, 8.6)).toEqual({ loop: null, pendingA: 4 }); // near Verse start
    expect(setLoopStart(song, { loop: null, pendingA: null }, 11.2)).toEqual({ loop: null, pendingA: 6 }); // 1.4 bars from any section → bar line
  });

  it('Set B closes the loop from the pending A (snapped, min 1 bar)', () => {
    expect(setLoopEnd(song, { loop: null, pendingA: 5 }, 15.1)).toEqual({ loop: { startBar: 5, endBar: 8 }, pendingA: null });
    expect(setLoopEnd(song, { loop: null, pendingA: 5 }, 10.2)).toEqual({ loop: { startBar: 5, endBar: 6 }, pendingA: null });
    // B before A: one bar at A
    expect(setLoopEnd(song, { loop: null, pendingA: 5 }, 3)).toEqual({ loop: { startBar: 5, endBar: 6 }, pendingA: null });
  });

  it('Set B without A starts at the current section', () => {
    expect(setLoopEnd(song, { loop: null, pendingA: null }, 13)).toEqual({ loop: { startBar: 4, endBar: 7 }, pendingA: null });
  });

  it('Set A / B move the edges of an existing loop', () => {
    const draft = { loop: { startBar: 4, endBar: 8 }, pendingA: null };
    expect(setLoopStart(song, draft, 10.1).loop).toEqual({ startBar: 5, endBar: 8 });
    expect(setLoopEnd(song, draft, 12.1).loop).toEqual({ startBar: 4, endBar: 6 });
    // A past B → pending A, loop kept
    expect(setLoopStart(song, draft, 20)).toEqual({ loop: draft.loop, pendingA: 10 });
  });

  it('nudges edges by one bar, keeping ≥ 1 bar inside the song', () => {
    const l = { startBar: 4, endBar: 5 };
    expect(nudgeLoop(song, l, 'start', 1)).toEqual(l);
    expect(nudgeLoop(song, l, 'end', -1)).toEqual(l);
    expect(nudgeLoop(song, l, 'start', -1)).toEqual({ startBar: 3, endBar: 5 });
    expect(nudgeLoop(song, { startBar: 0, endBar: 16 }, 'start', -1)).toEqual({ startBar: 0, endBar: 16 });
    expect(nudgeLoop(song, { startBar: 0, endBar: 16 }, 'end', 1)).toEqual({ startBar: 0, endBar: 16 });
  });

  it('steps to adjacent sections', () => {
    expect(adjacentSectionLoop(song, { startBar: 4, endBar: 8 }, 0, 1)).toEqual({ startBar: 8, endBar: 12 });
    expect(adjacentSectionLoop(song, { startBar: 4, endBar: 8 }, 0, -1)).toEqual({ startBar: 0, endBar: 4 });
    expect(adjacentSectionLoop(song, { startBar: 0, endBar: 4 }, 0, -1)).toEqual({ startBar: 0, endBar: 4 });
    expect(adjacentSectionLoop(song, null, 10, 1)).toEqual({ startBar: 8, endBar: 12 });
    expect(adjacentSectionLoop(song, null, 10, -1)).toEqual({ startBar: 0, endBar: 4 });
    expect(adjacentSectionLoop(song, { startBar: 5, endBar: 6 }, 0, 1)).toEqual({ startBar: 8, endBar: 12 });
    expect(adjacentSectionLoop(song, { startBar: 5, endBar: 6 }, 0, -1)).toEqual({ startBar: 4, endBar: 8 });
    expect(adjacentSectionLoop(makeSong(8, []), null, 0, 1)).toBeNull();
  });
});

describe('strip geometry', () => {
  it('maps time ↔ fraction over the bar grid', () => {
    expect(timeToFraction(song, 8)).toBe(0.25);
    expect(timeToFraction(song, -3)).toBe(0);
    expect(fractionToTime(song, 0.5)).toBe(16);
    expect(fractionToTime(song, 2)).toBe(32);
    expect(barTickEvery(16)).toBe(1);
    expect(barTickEvery(200)).toBe(4);
  });
});

describe('speed trainer view', () => {
  it('ladders from 70% to 100% with the current rung', () => {
    const l = trainerLadder(0.8);
    expect(l.map((r) => r.speed)).toEqual([0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1]);
    expect(l.map((r) => r.state)).toEqual(['done', 'done', 'current', 'todo', 'todo', 'todo', 'todo']);
    expect(trainerLadder(0.6)[0]).toEqual({ speed: 0.6, state: 'current' });
    expect(trainerLadder(0.72).find((r) => r.state === 'current')?.speed).toBe(0.7);
  });

  it('counts clean runs to the goal and progress', () => {
    expect(cleanRunsToGoal(0.7)).toBe(6);
    expect(cleanRunsToGoal(0.95)).toBe(1);
    expect(cleanRunsToGoal(1)).toBe(0);
    expect(cleanRunsToGoal(1.1)).toBe(0);
    expect(trainerProgress(0.7)).toBe(0);
    expect(trainerProgress(0.85)).toBeCloseTo(0.5);
    expect(trainerProgress(1)).toBe(1);
  });

  it('classifies trainer messages from @core/practice', () => {
    expect(messageTone({ kind: 'trainer', text: 'Clean run! +5% → 80%' })).toBe('up');
    expect(messageTone({ kind: 'trainer', text: 'Slow down a notch → 75%' })).toBe('down');
    expect(messageTone({ kind: 'trainer', text: 'Clean run at 100%!' })).toBe('hold');
    expect(messageTone({ kind: 'plateau', text: 'Good place to stop' })).toBe('info');
    expect(isCleanRunMessage({ kind: 'trainer', text: 'Clean run at 100%!' })).toBe(true);
    expect(isCleanRunMessage({ kind: 'trainer', text: 'Slow down a notch → 75%' })).toBe(false);
  });
});
