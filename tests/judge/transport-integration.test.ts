/**
 * Judge ↔ real transport integration (R1-C-01…05, R1-C-07). The judge is driven exactly the way
 * docs/game-mechanics.md § Driving the judge describes: the engine's `SongClock` adapter over a real
 * `TransportCore` on a fake context clock, a scheduler tick every 25 ms (1 s with a 1.5 s horizon
 * while the tab is hidden), `advance(inputHorizon(…))` every frame, and `startPass({pass})` whenever a
 * clock change reports a pass the judge is not on.
 *
 * The simulated player listens to the transport, not to the mapping under test: a note is "heard"
 * at the context time the segment being played reaches it (the segments are what the guide audio is
 * scheduled from), the player plucks `lateSec` after that, and the guitar event reaches the judge
 * `lagSec` later. Time advances in 1 ms steps.
 */
import { describe, expect, it } from 'vitest';
import type { ClockChange, TransportLoop } from '@shared/clock';
import type { Judge, Judgement, Outcome, StrayEvent } from '@shared/judge';
import { createJudge, inputHorizon } from '@core/judge';
import { toTransportLoop } from '@core/practice';
import { createSongClock, segCtx, segCtxLimit, segSong } from '../../src/audio/engine/clock';
import { TransportCore } from '../../src/audio/engine/transport';
import { makeSong, onset } from './helpers';

const E4 = 64;
const STEP = 0.001;

interface RigOptions {
  /** Note times (song s); every note is E4. The song has `bars` 2-s bars (120 BPM 4/4). */
  notes: number[];
  bars: number;
  speed?: number;
  countInBars?: number;
  /** Hidden tab: ticks and judge frames every 1 s, scheduler horizon 1.5 s. */
  hidden?: boolean;
  /** How late the player plucks after hearing a note (s). */
  lateSec?: number;
  /** Delivery delay of a guitar event after its (calibrated) time (s); must stay ≤ INPUT_LAG_SEC.guitar. */
  lagSec?: number;
  /** The player only plays notes in `[from, to)` (default: all). */
  plays?: { from: number; to: number };
  region?: { start: number; end: number } | null;
}

/** A transport + judge + simulated player on one fake context clock. */
class Rig {
  readonly clock = { t: 10 };
  readonly core: TransportCore;
  readonly judge: Judge;
  readonly judgements: Judgement[] = [];
  readonly strays: StrayEvent[] = [];
  readonly changes: ClockChange[] = [];
  /** Context times of the plucks the player made (for assertions). */
  readonly plucks: number[] = [];
  private readonly notes: number[];
  private readonly tickEvery: number;
  private readonly horizon: number;
  private readonly frameEvery: number;
  private readonly lateSec: number;
  private readonly lagSec: number;
  private readonly plays: { from: number; to: number };
  private nextTick: number;
  private nextFrame: number;
  private judgePass = 0;
  private inbox: number[] = [];

  constructor(opts: RigOptions) {
    this.notes = [...opts.notes].sort((a, b) => a - b);
    const song = makeSong(
      this.notes.map((time) => ({ time, midi: E4 })),
      { bars: opts.bars },
    );
    this.core = new TransportCore(
      { now: () => this.clock.t, clicks: { schedule: () => ({ cancel: () => undefined }) } },
      { countInBars: opts.countInBars ?? 0 },
    );
    this.core.load({ durationSec: opts.bars * 2, bars: song.timing.bars });
    if (opts.speed !== undefined) this.core.setSpeed(opts.speed);
    const songClock = createSongClock(
      this.core,
      { now: () => this.clock.t, outputTimestamp: () => null, perfNow: () => this.clock.t * 1000, outputDelay: () => 0 },
      () => 0,
    );
    this.judge = createJudge(song, { clock: songClock, region: opts.region ?? null });
    this.core.onChange((c) => {
      this.changes.push(c);
      if (c.pass !== this.judgePass) {
        this.judgePass = c.pass;
        this.judge.startPass({ pass: c.pass });
      }
    });
    this.tickEvery = opts.hidden ? 1 : 0.025;
    this.horizon = opts.hidden ? 1.5 : 0.12;
    this.frameEvery = opts.hidden ? 1 : 1 / 60;
    this.lateSec = opts.lateSec ?? 0.02;
    this.lagSec = opts.lagSec ?? 0.07;
    this.plays = opts.plays ?? { from: -Infinity, to: Infinity };
    this.nextTick = this.clock.t;
    this.nextFrame = this.clock.t;
  }

  /** Advance the simulation to context time `until`. */
  run(until: number): void {
    while (this.clock.t < until - 1e-9) {
      const prevT = this.clock.t;
      this.clock.t = Math.round((prevT + STEP) * 1e6) / 1e6;
      const t = this.clock.t;
      if (t >= this.nextTick - 1e-9) {
        this.core.tick(this.horizon);
        this.nextTick += this.tickEvery;
      }
      this.listen(prevT, t);
      while (this.inbox.length > 0 && this.inbox[0]! + this.lagSec <= t + 1e-9) {
        this.take(this.judge.push({ ...onset(this.inbox.shift()!, E4), source: 'guitar' }));
      }
      if (t >= this.nextFrame - 1e-9) {
        this.take(this.judge.advance(inputHorizon(t, 'guitar', 0)));
        this.nextFrame += this.frameEvery;
      }
    }
  }

  /** Run until the transport's song time first reaches `song` (playing forward). */
  runToSong(song: number, limit = 120): void {
    const end = this.clock.t + limit;
    while (this.core.songTimeAt(this.clock.t) < song && this.clock.t < end) this.run(this.clock.t + STEP);
  }

  /** An extra onset at context time `ctx` (noodling), delivered `lagSec` later like the others. */
  pluckAt(ctx: number): void {
    this.inbox.push(ctx);
    this.inbox.sort((a, b) => a - b);
  }

  /** Final judgements as `[pass, songTime, outcome]`, in emission order. */
  finals(): [number, number, Outcome][] {
    return this.judgements.filter((j) => j.final).map((j) => [j.pass, j.songTime, j.outcome]);
  }

  /** Final outcomes per pass, keyed by song time; fails on a duplicate final for one note in one pass. */
  byPass(): Map<number, Map<number, Outcome>> {
    const out = new Map<number, Map<number, Outcome>>();
    for (const [pass, time, outcome] of this.finals()) {
      const m = out.get(pass) ?? new Map<number, Outcome>();
      expect(m.has(time), `note ${time} judged twice in pass ${pass}`).toBe(false);
      m.set(time, outcome);
      out.set(pass, m);
    }
    return out;
  }

  wrapPasses(): number[] {
    return this.changes.filter((c) => c.reason === 'loop-wrap').map((c) => c.pass);
  }

  /** Notes whose sound starts in `(prevT, t]`, read from the segments the transport is playing. */
  private listen(prevT: number, t: number): void {
    for (const seg of this.core.segments) {
      if (seg.speed <= 0) continue;
      const lo = Math.max(prevT, seg.ctxStart);
      const hi = Math.min(t, segCtxLimit(seg));
      if (hi < lo) continue;
      const sLo = segSong(seg, lo) - 1e-9;
      const sHi = segSong(seg, hi) + 1e-9;
      for (const n of this.notes) {
        if (n < sLo || n > sHi) continue;
        const at = segCtx(seg, n);
        if (at <= prevT || at > t || at < seg.ctxStart || at >= segCtxLimit(seg)) continue;
        if (n < this.plays.from - 1e-6 || n >= this.plays.to - 1e-6) continue;
        const pluck = at + this.lateSec;
        this.plucks.push(pluck);
        this.inbox.push(pluck);
      }
    }
    this.inbox.sort((a, b) => a - b);
  }

  private take(out: { judgements: Judgement[]; strays: StrayEvent[] }): void {
    this.judgements.push(...out.judgements);
    this.strays.push(...out.strays);
  }
}

/** Notes every `step` s over `bars` 2-s bars. */
function grid(bars: number, step: number): number[] {
  const out: number[] = [];
  for (let k = 0; k * step < bars * 2 - 1e-9; k++) out.push(Math.round(k * step * 1e6) / 1e6);
  return out;
}

const inRange = (notes: number[], from: number, to: number): number[] => notes.filter((n) => n >= from - 1e-9 && n < to - 1e-9);

/** Bars 2-s long, loop over bars [startBar, endBar) with the practice pre-roll for `speed`. */
function loopFor(startBar: number, endBar: number, speed: number): TransportLoop {
  return toTransportLoop(makeSong([], { bars: 8 }), { startBar, endBar }, speed);
}

/** Every pass in `passes` judged every note of `expected` exactly once, all Perfect. */
function expectPerfectPasses(rig: Rig, passes: number[], expected: number[]): void {
  const got = rig.byPass();
  for (const p of passes) {
    const m = got.get(p);
    expect(m, `pass ${p} judged`).toBeDefined();
    expect([...m!.keys()].sort((a, b) => a - b), `pass ${p} notes`).toEqual(expected);
    expect([...new Set(m!.values())], `pass ${p} outcomes`).toEqual(['Perfect']);
  }
}

describe('judge ↔ TransportCore: loops (R1-C-01, R1-C-02)', () => {
  const cases: [string, number, number, number][] = [
    // [label, loop bars, speed, note step]
    ['1-bar loop at 100%', 1, 1, 0.5],
    ['1-bar loop at 70%', 1, 0.7, 0.5],
    ['1-bar loop at 55% (2-bar pre-roll)', 1, 0.55, 0.25],
    ['1-bar loop at 40% (2-bar pre-roll)', 1, 0.4, 0.5],
    ['2-bar loop at 100% in 16ths', 2, 1, 0.125],
    ['2-bar loop at 55% (2-bar pre-roll)', 2, 0.55, 0.5],
    ['2-bar loop at 40% (2-bar pre-roll)', 2, 0.4, 0.125],
    ['4-bar loop in 16ths at 100%', 4, 1, 0.125],
  ];
  for (const [label, loopBars, speed, step] of cases) {
    it(`${label}: every pass judges every note in [A, B) exactly once, all Perfect`, () => {
      const notes = grid(8, step);
      const loop = loopFor(2, 2 + loopBars, speed);
      // The player plays the loop region only (a pre-roll 16th 125 ms before A would take A's window).
      const rig = new Rig({ notes, bars: 8, speed, plays: { from: loop.start, to: loop.end } });
      rig.core.setLoop(loop);
      const region = { start: loop.start, end: loop.end };
      rig.judge.startPass({ pass: 0, region });
      rig.core.play({ from: loop.start - loop.preroll });
      const passSec = (loop.end - loop.start + loop.preroll) / speed;
      rig.run(rig.clock.t + 4 * passSec + 0.6);
      expect(rig.wrapPasses()).toEqual([1, 2, 3, 4]);
      expectPerfectPasses(rig, [0, 1, 2, 3], inRange(notes, loop.start, loop.end));
      expect(rig.judge.state().counts.Miss).toBe(0);
    });
  }

  it('the player also plays the pre-roll: those onsets are strays, the region is still all Perfect', () => {
    const notes = grid(8, 0.5);
    const rig = new Rig({ notes, bars: 8 });
    const loop = loopFor(2, 3, 1);
    rig.core.setLoop(loop);
    rig.judge.startPass({ pass: 0, region: { start: loop.start, end: loop.end } });
    rig.core.play({ from: loop.start - loop.preroll });
    rig.run(rig.clock.t + 3 * 4 + 0.5);
    expectPerfectPasses(rig, [0, 1, 2], inRange(notes, loop.start, loop.end));
    expect(rig.strays.length).toBe(rig.plucks.length - rig.judge.state().judgedNotes);
  });

  it('hidden tab (1 s ticks, 1.5 s horizon): 4-bar loop in 8ths, every note of every pass judged', () => {
    const notes = grid(8, 0.25);
    const rig = new Rig({ notes, bars: 8, hidden: true });
    const loop = loopFor(2, 6, 1);
    rig.core.setLoop(loop);
    rig.judge.startPass({ pass: 0, region: { start: loop.start, end: loop.end } });
    rig.core.play({ from: loop.start - loop.preroll });
    rig.run(rig.clock.t + 3 * 10 + 1.5);
    expectPerfectPasses(rig, [0, 1, 2], inRange(notes, loop.start, loop.end));
  });

  it('hidden tab: 1-bar loop at 100% and 2-bar loop at 55%', () => {
    for (const [bars, speed] of [
      [1, 1],
      [2, 0.55],
    ] as const) {
      const notes = grid(8, 0.5);
      const rig = new Rig({ notes, bars: 8, speed, hidden: true });
      const loop = loopFor(2, 2 + bars, speed);
      rig.core.setLoop(loop);
      rig.judge.startPass({ pass: 0, region: { start: loop.start, end: loop.end } });
      rig.core.play({ from: loop.start - loop.preroll });
      const passSec = (loop.end - loop.start + loop.preroll) / speed;
      rig.run(rig.clock.t + 3 * passSec + 1.5);
      expectPerfectPasses(rig, [0, 1, 2], inRange(notes, loop.start, loop.end));
    }
  });

  it('a player 110 ms late (Good) is still judged on the last note before B', () => {
    const notes = grid(8, 0.25);
    const rig = new Rig({ notes, bars: 8, lateSec: 0.11, lagSec: 0.1 });
    const loop = loopFor(2, 3, 1);
    rig.core.setLoop(loop);
    rig.judge.startPass({ pass: 0, region: { start: loop.start, end: loop.end } });
    rig.core.play({ from: loop.start - loop.preroll });
    rig.run(rig.clock.t + 3 * 4 + 0.6);
    const got = rig.byPass();
    for (const p of [0, 1, 2]) {
      expect([...got.get(p)!.keys()]).toEqual(inRange(notes, loop.start, loop.end));
      expect([...new Set(got.get(p)!.values())]).toEqual(['Good']);
    }
  });
});

describe('judge ↔ TransportCore: speed and loop changes near B (multi-anchor, R1-C-04)', () => {
  it('bar-aligned speed changes mid-song keep a perfect player Perfect (multi-anchor)', () => {
    const notes = grid(8, 0.25);
    const rig = new Rig({ notes, bars: 8 });
    rig.core.play({ from: 0 });
    rig.runToSong(1.3);
    rig.core.setSpeed(0.6); // applies at bar 1 (song 2)
    rig.runToSong(5.1);
    rig.core.setSpeed(0.9); // applies at song 6
    rig.runToSong(9.7);
    rig.core.setSpeed(0.45); // applies at song 10
    rig.runToSong(15.99);
    rig.run(rig.clock.t + 1);
    expectPerfectPasses(rig, [0], notes);
  });

  for (const action of ['setSpeed', 'setLoop'] as const) {
    it(`${action} 0.2 s before B: one loop-wrap per pass, every note of every pass judged once`, () => {
      const notes = grid(8, 0.25);
      const rig = new Rig({ notes, bars: 8, speed: 0.8 });
      const loop = loopFor(2, 4, 0.8);
      rig.core.setLoop(loop);
      rig.judge.startPass({ pass: 0, region: { start: loop.start, end: loop.end } });
      rig.core.play({ from: loop.start - loop.preroll });
      for (let pass = 0; pass < 3; pass++) {
        rig.runToSong(loop.end - 0.2 * 0.8);
        if (action === 'setSpeed') rig.core.setSpeed(0.8); // lands on B: the wrap carries it
        else rig.core.setLoop({ ...loop });
        rig.run(rig.clock.t + 0.5); // past the wrap
      }
      rig.runToSong(loop.end - 0.01);
      rig.run(rig.clock.t + 0.5);
      expect(rig.wrapPasses()).toEqual([1, 2, 3, 4]);
      expectPerfectPasses(rig, [0, 1, 2], inRange(notes, loop.start, loop.end));
    });
  }

  it('a slower speed requested before B is carried by the wrap; the next pass stays Perfect', () => {
    const notes = grid(8, 0.5);
    const rig = new Rig({ notes, bars: 8 });
    const loop = loopFor(2, 3, 1);
    rig.core.setLoop(loop);
    rig.judge.startPass({ pass: 0, region: { start: loop.start, end: loop.end } });
    rig.core.play({ from: loop.start - loop.preroll });
    rig.runToSong(loop.end - 0.15);
    rig.core.setSpeed(0.5);
    rig.run(rig.clock.t + 2 * ((loop.end - loop.start + loop.preroll) / 0.5) + 0.5);
    expect(rig.wrapPasses()).toEqual([1, 2, 3]);
    expectPerfectPasses(rig, [0, 1, 2], inRange(notes, loop.start, loop.end));
  });
});

describe('judge ↔ TransportCore: changing the loop mid-pass', () => {
  it('extending B mid-pass: startPass on the same pass judges the new notes once, keeps the old ones', () => {
    const notes = grid(8, 0.5);
    const rig = new Rig({ notes, bars: 8, plays: { from: 4, to: 12 } });
    rig.core.setLoop({ start: 4, end: 8, preroll: 2 });
    rig.judge.startPass({ pass: 0, region: { start: 4, end: 8 } });
    rig.core.play({ from: 2 });
    rig.runToSong(5.2);
    rig.core.setLoop({ start: 4, end: 12, preroll: 2 }); // no pass change: the session updates the region
    rig.judge.startPass({ pass: 0, region: { start: 4, end: 12 } });
    rig.runToSong(11.99);
    rig.run(rig.clock.t + 1);
    expect(rig.wrapPasses()).toEqual([1]);
    expectPerfectPasses(rig, [0], inRange(notes, 4, 12));
  });
});

describe('judge ↔ TransportCore: pause, seek and finish (R1-C-03, R1-C-05, R1-C-07)', () => {
  it('onsets while paused never hit the upcoming note; it is judged normally after resume', () => {
    const notes = grid(8, 0.5);
    // Fast delivery (like keyboard input) and a pause 40 ms before a note: the worst case.
    const rig = new Rig({ notes, bars: 8, lagSec: 0.01 });
    rig.core.play({ from: 0 });
    rig.runToSong(1.96 - 0.05); // the pause takes effect one re-anchor lead later, at song 1.96
    rig.core.pause();
    rig.run(rig.clock.t + 0.3);
    const pausedAt = rig.clock.t;
    // Noodling during an 8 s pause, including right where an extrapolated mapping would put note 2.0.
    for (let k = 0; k < 16; k++) rig.pluckAt(pausedAt + 0.5 * k + 0.03);
    rig.run(pausedAt + 8);
    expect(rig.finals().filter(([, time]) => time >= 2)).toEqual([]);
    expect(rig.judgements.filter((j) => j.songTime >= 2)).toEqual([]);
    expect(rig.strays.length).toBe(16);
    rig.core.play(); // resume (same pass)
    rig.run(rig.clock.t + 3);
    expect(rig.changes.map((c) => c.pass)).not.toContain(1);
    const pass0 = rig.byPass().get(0)!;
    for (const n of inRange(notes, 0, 4)) expect(pass0.get(n), `note ${n}`).toBe('Perfect');
  });

  it('pause/resume with a 1-bar count-in: the count-in bar is not re-judged, play resumes Perfect', () => {
    const notes = grid(8, 0.5);
    const rig = new Rig({ notes, bars: 8, countInBars: 1 });
    rig.core.play({ from: 0 });
    rig.run(rig.clock.t + 2.2); // through the count-in
    rig.runToSong(3.3 - 0.05);
    rig.core.pause();
    rig.run(rig.clock.t + 2);
    rig.core.play(); // counts in from song 3.3 (replays song 1.3 … 3.3)
    rig.runToSong(6.2);
    rig.run(rig.clock.t + 0.2);
    expectPerfectPasses(rig, [0], inRange(notes, 0, 6.2));
  });

  it('seek forward: skipped notes stay unjudged (no Miss), notes after the target are judged', () => {
    const notes = grid(16, 0.5);
    const rig = new Rig({ notes, bars: 16 });
    rig.core.play({ from: 0 });
    rig.runToSong(1.2);
    rig.core.seek(8);
    rig.runToSong(12.2);
    rig.run(rig.clock.t + 0.2);
    expect(rig.judge.state().counts.Miss).toBe(0);
    const judged = rig.finals().map(([, time]) => time);
    expect(judged.filter((t) => t > 1.3 && t < 8)).toEqual([]);
    for (const n of inRange(notes, 8, 12)) expect(judged).toContain(n);
    for (const n of inRange(notes, 0, 1.2)) expect(judged).toContain(n);
  });

  it('seek backward: the replayed notes are judged again in a new pass, nothing is doubled', () => {
    const notes = grid(16, 0.5);
    const rig = new Rig({ notes, bars: 16 });
    rig.core.play({ from: 0 });
    rig.runToSong(6.2);
    rig.core.seek(2);
    const seekPass = rig.changes.at(-1)!.pass;
    expect(seekPass).not.toBe(0);
    rig.runToSong(9.2);
    rig.run(rig.clock.t + 0.2);
    expect(rig.judge.state().counts.Miss).toBe(0);
    const got = rig.byPass();
    expect([...got.get(0)!.keys()]).toEqual(inRange(notes, 0, 6.2));
    expect([...got.get(seekPass)!.keys()]).toEqual(inRange(notes, 2, 9.2));
    expect(rig.judge.state().counts.Perfect).toBe(inRange(notes, 0, 6.2).length + inRange(notes, 2, 9.2).length);
  });

  it('seek while paused, then resume with a count-in: the count-in bar is not judged', () => {
    const notes = grid(16, 0.5);
    const rig = new Rig({ notes, bars: 16, countInBars: 1 });
    rig.core.play({ from: 0, countInBars: 0 });
    rig.runToSong(3.2);
    rig.core.pause();
    rig.run(rig.clock.t + 1);
    rig.core.seek(10);
    rig.run(rig.clock.t + 1);
    rig.core.play(); // count-in from song 8 to 10
    rig.run(rig.clock.t + 2.5);
    rig.runToSong(12.2);
    rig.run(rig.clock.t + 0.2);
    expect(rig.judge.state().counts.Miss).toBe(0);
    const judged = rig.finals().map(([, time]) => time);
    expect(judged.filter((t) => t > 3.3 && t < 10)).toEqual([]);
    for (const n of inRange(notes, 10, 12.2)) expect(judged).toContain(n);
  });

  it('finish() on quit judges notes already reached and leaves upcoming ones unjudged', () => {
    const notes = grid(8, 0.5);
    const rig = new Rig({ notes, bars: 8, plays: { from: 0, to: 2 } });
    rig.core.play({ from: 0 });
    rig.runToSong(2.95); // notes 2.0 and 2.5 not played (Miss), 3.0 is 50 ms ahead (window open)
    const summary = rig.judge.finish(rig.clock.t);
    expect(summary.counts.Perfect).toBe(4);
    expect(summary.counts.Miss).toBe(2);
    expect(summary.judgedNotes).toBe(6);
  });

  it('finish() while paused leaves the notes after the pause point unjudged', () => {
    const notes = grid(8, 0.5);
    const rig = new Rig({ notes, bars: 8 });
    rig.core.play({ from: 0 });
    rig.runToSong(1.91 - 0.05);
    rig.core.pause();
    rig.run(rig.clock.t + 5);
    const summary = rig.judge.finish(rig.clock.t);
    expect(summary.judgedNotes).toBe(4);
    expect(summary.counts.Perfect).toBe(4);
  });
});
