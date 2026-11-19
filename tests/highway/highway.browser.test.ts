/**
 * Canvas highway in real Chromium (T-024): pixels land where docs/game-mechanics.md says, the
 * renderer only reads the clock, judgement feedback recolours / consumes gems, loop wraps reset them,
 * DPR sizing, the rAF loop and disposal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ClockChange, SongClock } from '@shared/clock';
import type { Judgement, Outcome } from '@shared/judge';
import type { Highway } from '@shared/services';
import type { Note, Song, StringNumber } from '@shared/song';
import { createHighway } from '../../src/game/highway';
import { PARTICLE_CAP } from '../../src/game/highway/fx';
import { computeLayout, timeToX } from '../../src/game/highway/layout';
import { HighwayRenderer } from '../../src/game/highway/renderer';
import { glyphFixtureSong } from '../../src/ui/screens/dev-highway/songs';

const W = 1000;
const H = 420;

/** A read-only test clock that records every property the renderer touches. */
function testClock(initial: { now: number; speed?: number }) {
  const state = { now: initial.now, speed: initial.speed ?? 1 };
  const listeners = new Set<(c: ClockChange) => void>();
  const touched = new Set<string>();
  const perfArgs: number[] = [];
  const impl: SongClock = {
    state: 'playing',
    speed: 1,
    anchor: { anchorCtxTime: 0, anchorSongTime: 0, speed: 1 },
    nowCtx: () => 0,
    nowSong: () => state.now,
    songTimeAt: (t) => t,
    ctxTimeAt: (t) => t,
    heardSongTime: (perfNow?: number) => {
      perfArgs.push(perfNow ?? Number.NaN);
      return state.now;
    },
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const clock = new Proxy(impl, {
    get(target, prop, receiver) {
      touched.add(String(prop));
      if (prop === 'speed') return state.speed;
      return Reflect.get(target, prop, receiver);
    },
  });
  const emit = (reason: ClockChange['reason'], pass: number, anchorSongTime = state.now): void => {
    for (const cb of listeners) cb({ reason, pass, state: 'playing', anchor: { anchorCtxTime: 0, anchorSongTime, speed: state.speed } });
  };
  return { clock, state, touched, perfArgs, listeners, emit };
}

/** Time of the tiny song's note on string `s` (staggered so they are not one chord). */
const tt = (s: number): number => 2 + (s - 1) * 0.05;

/** A tiny song: one note per string at t = 2 … 2.25 (see {@link tt}), plus a note on string 4 at t = 3. */
function tinySong(): Song {
  const base = glyphFixtureSong();
  const tuning = [64, 59, 55, 50, 45, 40];
  const notes: Note[] = [];
  for (let s = 1; s <= 6; s++) {
    notes.push({ id: notes.length, time: tt(s), dur: 0.1, string: s as StringNumber, fret: 5, midi: tuning[s - 1]! + 5, bar: 0, tech: {} });
  }
  notes.push({ id: notes.length, time: 3, dur: 0.1, string: 4, fret: 7, midi: 57, bar: 1, tech: {} });
  return { ...base, notes, chords: [], sections: [] };
}

function mountCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `display:block;width:${W}px;height:${H}px`;
  document.body.append(canvas);
  return canvas;
}

/** RGB at CSS pixel (x, y). */
function pixel(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number] {
  const dpr = canvas.width / W;
  const d = canvas.getContext('2d')!.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
}

/** A point inside a gem body (lower left, away from the fret number and highlight). */
function gemProbe(L: ReturnType<typeof computeLayout>, x: number, s: number): [number, number] {
  return [x - L.gemR * 0.72, L.laneY[s]! + L.gemR * 0.55];
}

function judgement(noteIds: number[], outcome: Outcome, extra: Partial<Judgement> = {}): Judgement {
  return {
    noteIds,
    outcome,
    deltaMs: outcome === 'Miss' ? null : 10,
    timing: null,
    expectedMidi: 60,
    chord: false,
    songTime: 2,
    ctxTime: 2,
    final: true,
    pass: 0,
    ...extra,
  };
}

const isGrey = ([r, g, b]: number[]): boolean => Math.max(r!, g!, b!) - Math.min(r!, g!, b!) < 28 && r! > 40;
const isDark = ([r, g, b]: number[]): boolean => r! < 40 && g! < 40 && b! < 40;

let highway: Highway | null = null;
afterEach(() => {
  highway?.dispose();
  highway = null;
  document.body.replaceChildren();
});

describe('createHighway', () => {
  it('sizes the backing store for the device pixel ratio', () => {
    const canvas = mountCanvas();
    const { clock } = testClock({ now: 0 });
    highway = createHighway(canvas, tinySong(), clock, { noteSpeed: 1, handCues: false });
    expect(canvas.width).toBe(Math.round(W * devicePixelRatio));
    expect(canvas.height).toBe(Math.round(H * devicePixelRatio));
  });

  it('draws gems on their lanes (high e on top) at x = hitX + Δt / speed × pxPerSec', () => {
    const canvas = mountCanvas();
    const { clock, state } = testClock({ now: 1.5, speed: 1 });
    highway = createHighway(canvas, tinySong(), clock, { noteSpeed: 1, handCues: false });
    highway.drawFrame(1000);
    const L = computeLayout(W, H, devicePixelRatio, 1);
    const x = (s: number): number => timeToX(L, tt(s), 1.5, 1);
    // String 1 (purple) on the top lane, string 6 (red) on the bottom lane.
    const [er, eg, eb] = pixel(canvas, ...gemProbe(L, x(1), 1));
    expect(eb).toBeGreaterThan(eg + 40);
    expect(er).toBeGreaterThan(eg + 20);
    const [lr, lg, lb] = pixel(canvas, ...gemProbe(L, x(6), 6));
    expect(lr).toBeGreaterThan(lg + 60);
    expect(lr).toBeGreaterThan(lb + 40);
    // String 4 is blue; nothing on string 4 between its two notes.
    const [dr, , db] = pixel(canvas, ...gemProbe(L, x(4), 4));
    expect(db).toBeGreaterThan(dr + 60);
    expect(isDark(pixel(canvas, (x(4) + timeToX(L, 3, 1.5, 1)) / 2, L.laneY[4]! - L.gemR * 0.6))).toBe(true);

    // At 50% speed the same song second is twice as far away (constant real-time velocity).
    state.speed = 0.5;
    highway.drawFrame(1016);
    const xSlow = timeToX(L, tt(6), 1.5, 0.5);
    expect(xSlow - L.hitX).toBeCloseTo(2 * (x(6) - L.hitX));
    const [sr, sg, sb] = pixel(canvas, ...gemProbe(L, xSlow, 6));
    expect(sr).toBeGreaterThan(sg + 60);
    expect(sr).toBeGreaterThan(sb + 40);
  });

  it('only reads heardSongTime (with the frame time), speed and onChange from the clock', () => {
    const canvas = mountCanvas();
    const { clock, touched, perfArgs } = testClock({ now: 1 });
    highway = createHighway(canvas, glyphFixtureSong(), clock, { noteSpeed: 1, handCues: true });
    highway.drawFrame(1234.5);
    highway.drawFrame(1251.2);
    expect(perfArgs).toEqual([1234.5, 1251.2]);
    expect([...touched].sort()).toEqual(['heardSongTime', 'onChange', 'speed']);
  });

  it('greys a missed gem, reddens a wrong one and consumes a hit one', () => {
    const canvas = mountCanvas();
    const { clock } = testClock({ now: 1.7 });
    highway = createHighway(canvas, tinySong(), clock, { noteSpeed: 1, handCues: false });
    const L = computeLayout(W, H, devicePixelRatio, 1);
    const x = (s: number): number => timeToX(L, tt(s), 1.7, 1);
    highway.feedback(judgement([5], 'Miss'));
    highway.feedback(judgement([0], 'WrongNote', { playedMidi: 70 }));
    highway.feedback(judgement([3], 'Perfect'));
    highway.drawFrame(2000);
    expect(isGrey(pixel(canvas, ...gemProbe(L, x(6), 6)))).toBe(true);
    const [wr, wg, wb] = pixel(canvas, ...gemProbe(L, x(1), 1));
    expect(wr).toBeGreaterThan(200);
    expect(wr).toBeGreaterThan(wg + 80);
    expect(wr).toBeGreaterThan(wb + 40);
    expect(isDark(pixel(canvas, ...gemProbe(L, x(4), 4)))).toBe(true);
    // Untouched string 2 stays green.
    const [gr, gg, gb] = pixel(canvas, ...gemProbe(L, x(2), 2));
    expect(gg).toBeGreaterThan(gr + 60);
    expect(gg).toBeGreaterThan(gb + 30);
  });

  it('forgets gem judgements on a loop wrap and on a rewind; stale passes do not colour gems', () => {
    const canvas = mountCanvas();
    const { clock, emit } = testClock({ now: 1.7 });
    highway = createHighway(canvas, tinySong(), clock, { noteSpeed: 1, handCues: false });
    const L = computeLayout(W, H, devicePixelRatio, 1);
    const probe = gemProbe(L, timeToX(L, tt(6), 1.7, 1), 6);
    const red = (): boolean => {
      const [r, g, b] = pixel(canvas, ...probe);
      return r > g + 60 && r > b + 40;
    };

    highway.feedback(judgement([5], 'Miss'));
    highway.drawFrame(10);
    expect(red()).toBe(false);
    emit('loop-wrap', 1);
    highway.drawFrame(20);
    expect(red()).toBe(true);

    // A late judgement from the previous pass no longer colours the gem.
    highway.feedback(judgement([5], 'Miss', { pass: 0 }));
    highway.drawFrame(30);
    expect(red()).toBe(true);

    highway.feedback(judgement([5], 'Miss', { pass: 1 }));
    highway.drawFrame(40);
    expect(red()).toBe(false);
    // Seeking backwards (anchor before the last drawn time) resets as well; a resume does not.
    emit('play', 1, 1.7);
    highway.drawFrame(50);
    expect(red()).toBe(false);
    emit('seek', 1, 0.5);
    highway.drawFrame(60);
    expect(red()).toBe(true);
  });

  it('runs and stops the rAF loop, and disposes cleanly', async () => {
    const canvas = mountCanvas();
    const { clock, perfArgs, listeners } = testClock({ now: 0 });
    highway = createHighway(canvas, tinySong(), clock, { noteSpeed: 1, handCues: false });
    expect(listeners.size).toBe(1);
    highway.start();
    await new Promise((r) => setTimeout(r, 120));
    const drawn = perfArgs.length;
    expect(drawn).toBeGreaterThan(0);
    highway.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(perfArgs.length).toBe(drawn);
    highway.dispose();
    expect(listeners.size).toBe(0);
    highway.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(perfArgs.length).toBe(drawn);
    highway = null;
  });

  it('follows option changes (note speed) and survives every feedback kind', () => {
    const canvas = mountCanvas();
    const song = glyphFixtureSong();
    const { clock } = testClock({ now: 25 });
    highway = createHighway(canvas, song, clock, { noteSpeed: 1, handCues: true });
    for (const o of ['Perfect', 'Great', 'Good', 'WrongNote', 'Miss'] as Outcome[]) {
      highway.feedback(judgement([40, 41], o, { timing: o === 'Good' ? 'late' : null, chord: true }));
    }
    highway.stray({ ctxTime: 25, songTime: 25, source: 'keyboard' });
    for (let c = 0; c <= 60; c++) highway.setCombo(c, Math.min(4, 1 + Math.floor(c / 10)));
    highway.setCombo(0, 1);
    highway.setOptions({ noteSpeed: 2, loop: { start: 24, end: 33.6, preroll: 2.4 } });
    highway.setOptions({ handCues: false });
    highway.resize();
    for (let f = 0; f < 30; f++) expect(highway.drawFrame(1000 + f * 16)).toBeGreaterThanOrEqual(0);
  });
});

describe('hand-position cues', () => {
  /** Two notes on string 4 with a supplied 1fr → 9fr shift whose raw `showAt` is only 0.1 s ahead. */
  function cueSong(): { song: Song; positions: NonNullable<Parameters<typeof createHighway>[3]['positions']> } {
    const song = { ...tinySong(), notes: [] as Note[] };
    song.notes = [
      { id: 0, time: 2, dur: 0.1, string: 4, fret: 1, midi: 51, bar: 0, tech: {} },
      { id: 1, time: 4, dur: 0.1, string: 4, fret: 9, midi: 59, bar: 1, tech: {} },
    ];
    return {
      song,
      positions: {
        positions: [
          { lo: 1, hi: 4, start: 2, end: 2.1, firstNoteId: 0, lastNoteId: 0 },
          { lo: 9, hi: 13, start: 4, end: 4.1, firstNoteId: 1, lastNoteId: 1 },
        ],
        cues: [{ showAt: 3.9, time: 4, fromLo: 1, lo: 9, hi: 13 }],
      },
    };
  }
  const isCueOrange = ([r, g, b]: number[]): boolean => r! > 180 && g! > 80 && g! < 180 && b! < 100;

  it('shows a cue from cueShowAt: at least 0.75 real seconds ahead, also above 100% speed (R1-C-10)', () => {
    const canvas = mountCanvas();
    const { song, positions } = cueSong();
    const { clock, state } = testClock({ now: 3.4, speed: 1.1 });
    highway = createHighway(canvas, song, clock, { noteSpeed: 1, handCues: true, positions });
    const L = computeLayout(W, H, canvas.width / W, 1);
    const probe = (): [number, number, number] => {
      const x = Math.round(timeToX(L, 4, state.now, state.speed) - L.gemR - 10);
      return pixel(canvas, x, (L.laneY[3]! + L.laneY[4]!) / 2);
    };
    // Raw showAt (3.9) would hide it; cueShowAt = 4 − 0.75 × 1.1 = 3.175, so at 3.4 it is drawn.
    highway.drawFrame(1000);
    expect(isCueOrange(probe())).toBe(true);
    // Before 3.175 it is not drawn yet.
    state.now = 3.1;
    highway.drawFrame(1016);
    expect(isCueOrange(probe())).toBe(false);
  });
});

describe('HighwayRenderer pools', () => {
  it('never grows the particle pool past its capacity', () => {
    const canvas = mountCanvas();
    const { clock } = testClock({ now: 2 });
    const r = new HighwayRenderer(canvas, tinySong(), clock, { noteSpeed: 1, handCues: false });
    r.resize(W, H, 1);
    for (let i = 0; i < 400; i++) r.feedback(judgement([0, 1, 2, 3, 4, 5], 'Perfect', { pass: 0 }));
    r.draw(5000);
    expect(r.fx.liveParticles(5000)).toBeLessThanOrEqual(PARTICLE_CAP);
    r.draw(9000);
    expect(r.fx.liveParticles(9000)).toBe(0);
  });

  it('shows feedback for a previous-pass judgement without colouring the new pass', () => {
    const canvas = mountCanvas();
    const { clock } = testClock({ now: 2 });
    const r = new HighwayRenderer(canvas, tinySong(), clock, { noteSpeed: 1, handCues: false });
    r.resize(W, H, 1);
    r.onClockChange('loop-wrap', 1, 1);
    r.feedback(judgement([2], 'Perfect', { pass: 0 }));
    r.draw(100);
    expect(r.stateOf(2)).toBe(0);
    expect(r.fx.liveParticles(100)).toBeGreaterThan(0);
    r.feedback(judgement([2], 'Great', { pass: 1 }));
    expect(r.stateOf(2)).toBe(2);
  });

  it('ignores note ids outside the song', () => {
    const canvas = mountCanvas();
    const { clock } = testClock({ now: 2 });
    const r = new HighwayRenderer(canvas, tinySong(), clock, { noteSpeed: 1, handCues: false });
    r.resize(W, H, 1);
    expect(() => r.feedback(judgement([-1, 999], 'Miss'))).not.toThrow();
    expect(r.stateOf(0)).toBe(0);
  });
});
