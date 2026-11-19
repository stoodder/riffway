import { describe, expect, it, vi } from 'vitest';
import type { ClockChange } from '@shared/clock';
import { segCtxLimit } from '../../src/audio/engine/clock';
import { diffs, makeRig, makeTimeline, RecordingSource } from './helpers';

const LEAD = 0.05;
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('TransportCore: metronome from the beat grid', () => {
  it('clicks every beat with accented downbeats, exactly on the ctx mapping', () => {
    const { clock, core, run, played } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 4 }]));
    clock.t = 1;
    core.play({ from: 0 });
    run(5);
    const clicks = played();
    expect(clicks).toHaveLength(8); // 4 s of song from ctx 1.05 → beats 0..3.5 by ctx 5
    clicks.forEach((c, k) => {
      expect(c.when).toBeCloseTo(1 + LEAD + k * 0.5, 9);
      expect(c.accent).toBe(k % 4 === 0);
      expect(c.scheduledAt).toBeLessThanOrEqual(c.when); // never scheduled late
      expect(c.when - c.scheduledAt).toBeLessThanOrEqual(0.12 + 1e-9);
    });
  });

  it('follows tempo and meter changes at speed 0.8', () => {
    const { clock, core, run, played } = makeRig({ countInBars: 0 });
    const tl = makeTimeline([
      { bpm: 120, num: 4, bars: 2 },
      { bpm: 90, num: 3, bars: 2 },
      { bpm: 160, num: 6, den: 8, bars: 1 },
    ]);
    core.load(tl);
    core.setSpeed(0.8);
    clock.t = 0.5;
    core.play({ from: 0 });
    run(20);
    const expected = tl.bars.flatMap((b) => b.beats.map((t, j) => ({ when: 0.55 + t / 0.8, accent: j === 0 })));
    const got = played();
    expect(got.map((c) => c.accent)).toEqual(expected.map((e) => e.accent));
    got.forEach((c, i) => expect(c.when).toBeCloseTo(expected[i]!.when, 9));
  });

  it('stops at the song end, fires onEnded and holds at the duration', () => {
    const { clock, core, run } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 1 }]));
    const ended = vi.fn();
    core.onEnded(ended);
    const src = new RecordingSource();
    core.addSource(src);
    core.play({ from: 0 });
    run(1);
    expect(ended).not.toHaveBeenCalled();
    run(3);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(core.state).toBe('stopped');
    expect(core.songTimeAt(clock.t)).toBe(2);
    expect(src.calls.at(-1)).toEqual({ type: 'stop', when: LEAD + 2 });
    expect(src.schedules()[0]).toMatchObject({ ctxStart: LEAD, songStart: 0, songEnd: 2, ctxEnd: LEAD + 2, speed: 1, pass: 0 });
  });

  it('setMetronome(false) cancels future grid clicks; turning it on resumes without duplicates', () => {
    const { core, run, sink, played } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    core.play({ from: 0 });
    run(1.01);
    core.setMetronome(false);
    run(3.01);
    core.setMetronome(true);
    run(6);
    const whens = played().map((c) => c.when);
    expect(new Set(whens.map((w) => w.toFixed(9))).size).toBe(whens.length);
    expect(whens.filter((w) => w > 1.1 && w < 3)).toEqual([]);
    expect(whens.filter((w) => w >= 3.1).length).toBeGreaterThan(4);
    expect(sink.all.some((c) => c.cancelled)).toBe(true);
  });
});

describe('TransportCore: count-in', () => {
  it('plays bars × beats count-in clicks before `from`, accenting each count-in bar', () => {
    const { clock, core, run, played } = makeRig({ metronome: false });
    core.load(makeTimeline([{ bpm: 100, num: 3, bars: 4 }]));
    const changes: ClockChange[] = [];
    core.onChange((c) => changes.push(c));
    clock.t = 2;
    core.play({ from: 1.8, countInBars: 2 });
    expect(core.state).toBe('count-in');
    run(10);
    const clicks = played();
    expect(clicks).toHaveLength(6);
    expect(clicks.map((c) => c.accent)).toEqual([true, false, false, true, false, false]);
    expect(clicks[0]!.when).toBeCloseTo(2 + LEAD, 9);
    diffs(clicks.map((c) => c.when)).forEach((d) => expect(d).toBeCloseTo(0.6, 9));
    expect(core.state).toBe('playing');
    expect(changes.map((c) => c.reason)).toEqual(['play', 'count-in-end']);
    // Song time `from` is reached one beat after the last count-in click.
    expect(core.ctxTimeAt(1.8)).toBeCloseTo(clicks[5]!.when + 0.6, 9);
  });

  it('listeners run after the change completes (re-entrant tick sees the count-in)', () => {
    const { core, run, played } = makeRig({ countInBars: 1 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 4 }]));
    const states: string[] = [];
    core.onChange((c) => {
      states.push(c.state);
      core.tick(); // what the engine's loop start does
    });
    core.play({ from: 0 });
    run(3);
    const whens = played().map((c) => c.when);
    whens.forEach((w, k) => expect(w).toBeCloseTo(LEAD + 0.5 * k, 9));
    expect(whens).toHaveLength(6);
    expect(states).toEqual(['count-in', 'playing']);
  });

  it('uses settings default bars; pausing during count-in rewinds to `from`', () => {
    const { clock, core, run } = makeRig({ countInBars: 1 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 4 }]));
    core.play({ from: 2 });
    expect(core.segments.at(-1)!.songStart).toBeCloseTo(0, 9);
    run(0.5);
    core.pause();
    run(1);
    expect(core.state).toBe('paused');
    expect(core.songTimeAt(clock.t)).toBe(2);
  });
});

describe('TransportCore: loops', () => {
  it('wraps seamlessly: constant click spacing, no gap or duplicate, pre-roll clicks', () => {
    const { core, run, played } = makeRig({ countInBars: 0, metronome: false });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    core.setSpeed(0.8);
    core.setLoop({ start: 4, end: 6, preroll: 2 });
    const changes: ClockChange[] = [];
    core.onChange((c) => changes.push(c));
    core.play({ from: 2 });
    run(16);
    // A pass plays song 2..6 (5 s of ctx time at 80%). Metronome off: only the pre-roll
    // (song 2..4) of passes ≥ 1 clicks.
    const wraps = changes.filter((c) => c.reason === 'loop-wrap');
    expect(wraps.map((c) => c.pass)).toEqual([1, 2, 3]);
    wraps.forEach((c, i) => expect(c.anchor.anchorCtxTime).toBeCloseTo(LEAD + 5 * (i + 1), 9));
    const expected = [1, 2, 3].flatMap((k) => [0, 0.625, 1.25, 1.875].map((d) => LEAD + 5 * k + d)).filter((w) => w < 16);
    const got = played();
    expect(got).toHaveLength(expected.length);
    got.forEach((c, i) => expect(c.when).toBeCloseTo(expected[i]!, 9));
    expect(got.map((c) => c.accent)).toEqual(expected.map((_, i) => i % 4 === 0));
  });

  it('metronome on: every beat across many wraps, exactly periodic', () => {
    const { core, run, played } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    core.setSpeed(0.8);
    core.setLoop({ start: 4, end: 6, preroll: 2 });
    core.play({ from: 2 });
    run(30);
    const whens = played().map((c) => c.when);
    expect(whens.length).toBeGreaterThan(40);
    whens.forEach((w, k) => expect(w).toBeCloseTo(LEAD + k * 0.625, 9));
    expect(played().map((c) => c.accent)).toEqual(whens.map((_, k) => k % 4 === 0));
  });

  it('maps song times to the nearest pass around a wrap', () => {
    const { clock, core, run } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    core.setLoop({ start: 4, end: 6, preroll: 2 });
    core.play({ from: 2 }); // pass 0 plays song 2..6 at ctx 0.05..4.05
    run(3.95);
    expect(core.ctxTimeAt(5.9)).toBeCloseTo(LEAD + 3.9, 9); // this pass
    expect(core.ctxTimeAt(2.1)).toBeCloseTo(LEAD + 4.1, 9); // the coming pass (already anchored)
    run(4.15);
    expect(core.ctxTimeAt(5.95)).toBeCloseTo(LEAD + 3.95, 9); // previous pass, just ended
    expect(core.ctxTimeAt(2.2)).toBeCloseTo(LEAD + 4.2, 9);
    expect(core.songTimeAt(clock.t)).toBeCloseTo(2.1, 9);
  });

  it('setLoop while past B jumps to the pre-roll; clearing the loop plays on', () => {
    const { clock, core, run } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    core.play({ from: 10 });
    run(1);
    core.setLoop({ start: 2, end: 4, preroll: 2 });
    run(1.2);
    expect(core.songTimeAt(clock.t)).toBeCloseTo(0.15, 9);
    core.setLoop(null);
    run(6);
    expect(core.songTimeAt(clock.t)).toBeCloseTo(4.95, 9);
  });
});

describe('TransportCore: speed changes', () => {
  it('applies at the next bar line once ready, with continuous clicks', async () => {
    const { clock, core, run, played } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    core.play({ from: 0 });
    run(0.6);
    let ready!: () => void;
    const changes: ClockChange[] = [];
    core.onChange((c) => changes.push(c));
    core.setSpeed(0.5, { ready: new Promise<void>((r) => (ready = r)) });
    expect(core.speed).toBe(0.5);
    run(2.9); // still 100%: song 2.85
    expect(core.songTimeAt(clock.t)).toBeCloseTo(2.85, 9);
    ready();
    await Promise.resolve();
    // Next bar line after song 2.9 (= now + lead) is 4, reached at ctx 4.05.
    expect(changes.at(-1)).toMatchObject({ reason: 'speed', anchor: { anchorCtxTime: 4.05, anchorSongTime: 4, speed: 0.5 } });
    run(12);
    const whens = played().map((c) => c.when);
    const expected = [...Array.from({ length: 8 }, (_, k) => LEAD + 0.5 * k), ...Array.from({ length: 8 }, (_, k) => 4.05 + k)];
    expect(whens).toHaveLength(expected.length);
    whens.forEach((w, i) => expect(w).toBeCloseTo(expected[i]!, 9));
    expect(core.songTimeAt(5.05)).toBeCloseTo(4.5, 9);
  });

  it('a change landing on loop B is carried by the wrap', () => {
    const { core, run, played } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    core.setLoop({ start: 2, end: 4, preroll: 0 });
    core.play({ from: 2 });
    run(1.9); // wrap at ctx 2.05 is already anchored at 100%
    expect(core.segments.at(-1)!.reason).toBe('loop-wrap');
    core.setSpeed(0.5);
    run(8);
    const whens = played().map((c) => c.when);
    const expected = [0, 0.5, 1, 1.5].map((x) => LEAD + x).concat([0, 1, 2, 3, 4, 5].map((x) => 2.05 + x));
    whens.slice(0, expected.length).forEach((w, i) => expect(w).toBeCloseTo(expected[i]!, 9));
    expect(core.segments.at(-1)!.speed).toBe(0.5);
  });

  it('a loop change in the bar before a pending bar-aligned speed change keeps that change (R2-I-02)', () => {
    const { clock, core, run } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    core.play({ from: 0 });
    run(0.6);
    core.setSpeed(0.5); // lands on the bar line at song 2 (ctx 2.05)
    run(1);
    core.setLoop({ start: 4, end: 8, preroll: 2 });
    run(3);
    expect(core.speedAt(clock.t)).toBe(0.5);
    expect(core.songTimeAt(3.05)).toBeCloseTo(2.5, 9);
  });

  it('clearing the loop before a pending speed change (bar line or loop B) keeps that change (R2-I-02)', () => {
    for (const viaWrap of [false, true]) {
      const { clock, core, run } = makeRig({ countInBars: 0 });
      core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
      // A one-bar loop: the change waits for loop B, carried by the wrap.
      core.setLoop(viaWrap ? { start: 2, end: 4, preroll: 0 } : { start: 2, end: 8, preroll: 0 });
      core.play({ from: 2 });
      run(0.6);
      core.setSpeed(0.6);
      run(0.9);
      core.setLoop(null);
      run(6);
      expect(core.speedAt(clock.t)).toBe(0.6);
      expect(core.songTimeAt(3.05)).toBeCloseTo(4.6, 9);
    }
  });

  it('applies immediately while paused and clamps to 40–110%', () => {
    const { core } = makeRig();
    core.setSpeed(0.2);
    expect(core.speed).toBe(0.4);
    core.setSpeed(2);
    expect(core.speed).toBe(1.1);
    expect(() => core.setSpeed(Number.NaN)).toThrow(RangeError);
  });

  it('a superseded or failed render does not apply', async () => {
    const { core, run } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    core.play({ from: 0 });
    run(0.3);
    let resolveFirst!: () => void;
    core.setSpeed(0.5, { ready: new Promise<void>((r) => (resolveFirst = r)) });
    core.setSpeed(0.7, { ready: Promise.reject(new Error('render failed')) });
    resolveFirst();
    await new Promise((r) => setTimeout(r, 0));
    run(6);
    expect(core.segments.every((s) => s.speed === 1 || s.speed === 0)).toBe(true);
    expect(core.speed).toBe(1);
  });
});

describe('TransportCore: seek, pause, sources', () => {
  it('seek re-anchors one lead ahead and cancels superseded clicks', () => {
    const { clock, core, run, played } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    core.play({ from: 0 });
    run(1.0);
    clock.t = 1.01;
    core.seek(6.25);
    run(2.5);
    const whens = played().map((c) => c.when);
    // Before the seek point (ctx 1.06): beats 0 and 0.5; beat 1.0 (ctx 1.05) still plays.
    expect(whens.filter((w) => w < 1.06)).toEqual([LEAD, LEAD + 0.5, LEAD + 1]);
    // After: song 6.5 at ctx 1.06 + 0.25, then every 0.5 s.
    const after = whens.filter((w) => w >= 1.06);
    after.forEach((w, k) => expect(w).toBeCloseTo(1.31 + 0.5 * k, 9));
    expect(after).toHaveLength(3);
    expect(core.songTimeAt(clock.t)).toBeCloseTo(6.25 + 1.44, 9);
  });

  it('pause stops sources one lead ahead and holds; play resumes from there', () => {
    const { clock, core, run } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    const src = new RecordingSource();
    core.addSource(src);
    core.play({ from: 0 });
    run(1);
    core.pause();
    const stop = src.calls.at(-1);
    expect(stop?.type === 'stop' && stop.when).toBeCloseTo(1 + LEAD, 9);
    run(3);
    expect(core.songTimeAt(clock.t)).toBeCloseTo(1, 9);
    core.play();
    const resumed = src.schedules().at(-1)!;
    expect(resumed.ctxStart).toBeCloseTo(3 + LEAD, 9);
    expect(resumed.songStart).toBeCloseTo(1, 9);
    run(4);
    expect(core.songTimeAt(clock.t)).toBeCloseTo(1 + 1 - LEAD, 9);
  });

  it('re-issues sources on play, seek, speed change and loop wrap; late registration starts now + lead', () => {
    const { core, run, clock } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    const early = new RecordingSource();
    core.addSource(early);
    core.setLoop({ start: 4, end: 8, preroll: 2 });
    core.play({ from: 0 });
    run(1);
    const late = new RecordingSource();
    core.addSource(late);
    const first = late.schedules()[0]!;
    expect(first.ctxStart).toBeCloseTo(1 + LEAD, 9);
    expect(first.songStart).toBeCloseTo(1, 9);
    expect(first.songEnd).toBe(8);
    core.seek(5);
    run(1.5);
    core.setSpeed(0.5, { atNextBar: false });
    run(12);
    const segs = early.schedules();
    const shape = segs.map((s) => [Number(s.songStart.toFixed(9)), s.speed, s.pass]);
    expect(shape).toEqual([
      [0, 1, 0],
      [5, 1, 1], // a seek starts a new pass
      [5.5, 0.5, 1],
      [2, 0.5, 2],
    ]);
    // Bounded at loop B; the wrap starts exactly where the previous segment ends.
    expect(segs.every((s) => s.songEnd === 8)).toBe(true);
    expect(segs[3]!.ctxStart).toBeCloseTo(segs[2]!.ctxEnd!, 12);
    expect(segs[3]!.ctxEnd).toBeCloseTo(segs[3]!.ctxStart + 12, 9);
    expect(segs[3]!.ctxStart).toBeLessThan(clock.t);
  });

  it('a throwing listener or source does not break the transport', async () => {
    const { core, run } = makeRig({ countInBars: 0 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 2 }]));
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onError);
    core.onChange(() => {
      throw new Error('listener');
    });
    core.addSource({ name: 'bad', schedule: () => { throw new Error('source'); }, stop: () => undefined });
    core.play({ from: 0 });
    run(1);
    await new Promise((r) => setTimeout(r, 0));
    process.off('uncaughtException', onError);
    expect(core.state).toBe('playing');
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('TransportCore: clock round trip', () => {
  it('songTimeAt(ctxTimeAt(t)) = t within 1 µs across speed changes and loop wraps', () => {
    const { clock, core, run } = makeRig({ countInBars: 1, historySec: 1e9 });
    core.load(makeTimeline([{ bpm: 137, num: 4, bars: 12 }, { bpm: 91, num: 7, den: 8, bars: 6 }]));
    core.setLoop({ start: 3.1, end: 5.7, preroll: 0.6 });
    core.play({ from: 1.7 });
    const speeds = [0.73, 1.1, 0.4, 0.95, 0.61];
    let worst = 0;
    for (let step = 0; step < 120; step++) {
      run(clock.t + 0.37);
      if (step % 7 === 3) core.setSpeed(speeds[step % speeds.length]!, { atNextBar: step % 2 === 0 });
      for (const seg of core.segments) {
        if (seg.speed <= 0) continue;
        const end = Math.min(segCtxLimit(seg), seg.ctxStart + 1);
        for (let i = 0; i < 8; i++) {
          const ctx = seg.ctxStart + ((end - seg.ctxStart) * i) / 8;
          const song = core.songTimeAt(ctx);
          worst = Math.max(worst, Math.abs(core.songTimeAt(core.ctxTimeAt(song)) - song));
        }
      }
    }
    expect(core.segments.filter((s) => s.reason === 'loop-wrap').length).toBeGreaterThan(3);
    expect(new Set(core.segments.map((s) => s.speed)).size).toBeGreaterThan(3);
    expect(worst).toBeLessThanOrEqual(1e-6);
  });

  it('is continuous at every re-anchor (no jumps except seeks and wraps)', () => {
    const { core, run, clock } = makeRig({ countInBars: 0, historySec: 1e9 });
    core.load(makeTimeline([{ bpm: 120, num: 4, bars: 16 }]));
    core.play({ from: 0 });
    for (let i = 0; i < 10; i++) {
      run(clock.t + 0.83);
      core.setSpeed([0.5, 0.9, 0.7][i % 3]!, { atNextBar: i % 2 === 1 });
    }
    run(clock.t + 3);
    const segs = core.segments.filter((s) => s.speed > 0);
    for (let i = 1; i < segs.length; i++) {
      const prev = segs[i - 1]!;
      expect(near(prev.songEnd!, segs[i]!.songStart)).toBe(true);
      expect(near(prev.songStart + (segs[i]!.ctxStart - prev.ctxStart) * prev.speed, segs[i]!.songStart, 1e-9)).toBe(true);
    }
  });
});

describe('TransportCore: passes and the pass-aware mapping (R1-C-01…05)', () => {
  /** 8 bars at 120 BPM, a 1-bar loop A = 4, B = 6 with a 1-bar pre-roll (the most common practice loop). */
  const loopRig = (opts: { horizon?: number } = {}) => {
    const rig = makeRig({ countInBars: 0 });
    rig.core.load(makeTimeline([{ bpm: 120, num: 4, bars: 8 }]));
    rig.core.setLoop({ start: 4, end: 6, preroll: 2 });
    const changes: ClockChange[] = [];
    rig.core.onChange((c) => changes.push(c));
    const run = (until: number) => rig.run(until, opts.horizon === undefined ? 0.025 : 1, opts.horizon ?? 0.12);
    return { ...rig, run, changes };
  };

  it('announces loop-wrap once the wrap has taken effect, not when it is scheduled', () => {
    for (const horizon of [undefined, 1.5]) {
      const { core, clock, run, changes } = loopRig({ horizon });
      const seen: { pass: number; at: number; anchor: number }[] = [];
      core.onChange((c) => {
        if (c.reason === 'loop-wrap') seen.push({ pass: c.pass, at: clock.t, anchor: c.anchor.anchorCtxTime });
      });
      core.play({ from: 2 }); // pass 0: song 2 → 6 from ctx 0.05; wraps at ctx 4.05, 8.05, 12.05
      run(13);
      expect(seen.map((s) => s.pass)).toEqual([1, 2, 3]);
      seen.forEach((s, i) => {
        expect(s.anchor).toBeCloseTo(LEAD + 4 * (i + 1), 9);
        expect(s.at).toBeGreaterThanOrEqual(s.anchor); // never before the new pass has begun
        expect(s.at - s.anchor).toBeLessThanOrEqual(horizon === undefined ? 0.025 + 1e-9 : 1 + 1e-9);
      });
      expect(changes.filter((c) => c.reason === 'loop-wrap')).toHaveLength(3);
    }
  });

  it('a re-anchor that drops a scheduled wrap never yields a phantom or duplicate loop-wrap (R1-C-04)', () => {
    for (const poke of ['none', 'setLoop', 'setSpeed', 'setLoop(null)'] as const) {
      const { core, clock, run, changes } = loopRig();
      core.play({ from: 2 });
      run(LEAD + 4 - 0.2); // the wrap at ctx 4.05 is already scheduled (two horizons ahead)
      expect(core.segments.some((s) => s.reason === 'loop-wrap')).toBe(true);
      if (poke === 'setLoop') core.setLoop({ start: 4, end: 6, preroll: 2 });
      if (poke === 'setSpeed') core.setSpeed(0.8);
      if (poke === 'setLoop(null)') core.setLoop(null);
      run(clock.t + 1);
      const wraps = changes.filter((c) => c.reason === 'loop-wrap').map((c) => c.pass);
      expect(wraps, poke).toEqual(poke === 'setLoop(null)' ? [] : [1]);
    }
  });

  it('numbers passes: pause/resume keeps the pass, seek and play({from}) start a new one, play after stop is 0', () => {
    const { core, run, changes } = loopRig();
    core.setLoop(null);
    const pass = () => changes.at(-1)!.pass;
    core.play({ from: 0 });
    expect(pass()).toBe(0);
    run(1);
    core.pause();
    expect(pass()).toBe(0);
    run(2);
    core.play();
    expect([pass(), core.pass]).toEqual([0, 0]);
    run(3);
    core.seek(6);
    expect(pass()).toBe(1);
    run(4);
    expect(core.pass).toBe(1);
    core.pause();
    core.seek(3);
    expect(pass()).toBe(2);
    core.play();
    expect(pass()).toBe(2);
    run(5);
    core.play({ from: 1 });
    expect(pass()).toBe(3);
    run(6);
    core.stop();
    core.play();
    expect(pass()).toBe(0);
  });

  it('ctxTimeInPass maps each pass to its own occurrence where nearest-to-now picks the wrong one (R1-C-01)', () => {
    const { core, run } = loopRig();
    core.play({ from: 2 }); // pass 0 plays song 2 → 6 at ctx 0.05 → 4.05; pass 1 from 4.05
    run(LEAD + 4 - 0.1); // pass 1 is scheduled; note A = 4 of pass 1 is 2 s ahead
    expect(core.ctxTimeInPass(4, 0)).toBeCloseTo(LEAD + 2, 9);
    expect(core.ctxTimeInPass(4, 1)).toBeCloseTo(LEAD + 6, 9);
    expect(core.ctxTimeAt(4)).toBeCloseTo(LEAD + 2, 9); // nearest-to-now: the past occurrence
    expect(core.ctxTimeInPass(5.9, 0)).toBeCloseTo(LEAD + 3.9, 9);
    expect(core.ctxTimeInPass(2.5, 1)).toBeCloseTo(LEAD + 4.5, 9);
    expect(core.ctxTimeInPass(4, 2)).toBeNaN(); // not scheduled yet
    run(LEAD + 4.5);
    expect(core.ctxTimeInPass(5.9, 0)).toBeCloseTo(LEAD + 3.9, 9); // the pass that just ended
    expect(core.ctxTimeInPass(6.5, 0)).toBe(-Infinity); // pass 0 is over and never played 6.5
    expect(core.ctxTimeInPass(1, 1)).toBe(-Infinity); // before the pass's start
  });

  it('ctxTimeInPass is NaN while paused for times not yet played, exact for times already played (R1-C-03)', () => {
    const { core, clock, run } = loopRig();
    core.setLoop(null);
    core.play({ from: 0 });
    run(1.91 - LEAD);
    core.pause(); // takes effect at ctx 1.91 = song 1.86
    run(3);
    expect(core.ctxTimeInPass(1.5, 0)).toBeCloseTo(LEAD + 1.5, 9);
    expect(core.ctxTimeInPass(1.9, 0)).toBeNaN();
    expect(core.ctxTimeInPass(2, 0)).toBeNaN();
    expect(Number.isFinite(core.ctxTimeAt(2))).toBe(true); // the plain mapping still extrapolates
    run(10);
    expect(core.ctxTimeInPass(1.5, 0)).toBeNaN(); // no longer retained (2 s of history)
    core.play(); // resumes pass 0 at ctx 10.05
    expect(core.ctxTimeInPass(2, 0)).toBeCloseTo(clock.t + LEAD + 0.14, 9);
    expect(core.ctxTimeInPass(1.5, 0)).toBe(-Infinity); // before the resumed stretch: already played
  });

  it('ctxTimeInPass after a seek: skipped and abandoned times are -Infinity; count-in times are never covered', () => {
    const { core, run } = loopRig();
    core.setLoop(null);
    core.play({ from: 0 });
    run(1);
    core.seek(8); // pass 1 from ctx 1.05
    expect(core.ctxTimeInPass(0.5, 0)).toBeCloseTo(LEAD + 0.5, 9);
    expect(core.ctxTimeInPass(4, 0)).toBe(-Infinity); // skipped by the seek
    expect(core.ctxTimeInPass(4, 1)).toBe(-Infinity); // before the new pass's start
    expect(core.ctxTimeInPass(8.5, 1)).toBeCloseTo(1 + LEAD + 0.5, 9);
    run(2);
    core.pause();
    core.seek(12); // pass 2 (a hold)
    core.play({ countInBars: 1 }); // count-in plays song 10 → 12 first
    expect(core.ctxTimeInPass(11, 2)).toBe(-Infinity);
    expect(core.ctxTimeInPass(12, 2)).toBeCloseTo(2 + LEAD + 2, 9);
  });
});
