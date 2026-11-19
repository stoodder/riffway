import { describe, expect, it } from 'vitest';
import { LookaheadLoop, type LoopTimer } from '../../src/audio/engine/scheduler';
import { makeRig, makeTimeline } from './helpers';

/** A timer whose firing the test controls. */
class ManualTimer implements LoopTimer {
  fn: (() => void) | null = null;
  ms = 0;
  setInterval(fn: () => void, ms: number) {
    this.fn = fn;
    this.ms = ms;
    return 1;
  }
  clearInterval() {
    this.fn = null;
  }
}

describe('LookaheadLoop', () => {
  it('ticks with the 120 ms horizon every 25 ms and stops when idle', () => {
    let now = 0;
    const horizons: number[] = [];
    let busy = true;
    const timer = new ManualTimer();
    const loop = new LookaheadLoop({ now: () => now, timer, tick: (h) => (horizons.push(h), busy) });
    loop.start();
    expect(timer.ms).toBe(25);
    for (let i = 0; i < 3; i++) {
      now += 0.025;
      timer.fn!();
    }
    expect(horizons).toEqual([0.12, 0.12, 0.12, 0.12]);
    busy = false;
    timer.fn!();
    expect(loop.running).toBe(false);
  });

  it('widens the horizon after a throttled wake-up and while hidden', () => {
    let now = 0;
    let hidden = false;
    const timer = new ManualTimer();
    const loop = new LookaheadLoop({ now: () => now, timer, hidden: () => hidden, tick: () => true });
    loop.start();
    now = 1.0;
    timer.fn!();
    expect(loop.horizon).toBeCloseTo(1.05, 12);
    now = 1.025;
    timer.fn!();
    expect(loop.horizon).toBe(0.12);
    hidden = true;
    now = 1.05;
    timer.fn!();
    expect(loop.horizon).toBe(1.5);
    now = 9;
    timer.fn!();
    expect(loop.horizon).toBe(3);
  });
});

describe('scheduling under tab throttling (fake clock + loop)', () => {
  const setup = (hidden: () => boolean) => {
    const rig = makeRig({ countInBars: 0 });
    rig.core.load(makeTimeline([{ bpm: 120, num: 4, bars: 30 }]));
    const timer = new ManualTimer();
    const loop = new LookaheadLoop({
      now: () => rig.clock.t,
      timer,
      hidden,
      tick: (h) => {
        rig.core.tick(h);
        return rig.core.running;
      },
    });
    rig.core.play({ from: 0 });
    loop.start();
    /** Fire the timer at the given ctx times. */
    const wakeAt = (times: number[]) => {
      for (const t of times) {
        rig.clock.t = t;
        timer.fn?.();
      }
    };
    return { ...rig, wakeAt };
  };

  it('hidden tab with ~1 s wake-ups: every click is scheduled ahead and on the grid', () => {
    const { wakeAt, sink, clock } = setup(() => true);
    wakeAt(Array.from({ length: 20 }, (_, i) => 0.9 + i * 1.0 + (i % 3) * 0.07)); // jittery 1 Hz
    const live = sink.live().filter((c) => c.when < clock.t);
    expect(live).toHaveLength(Math.floor((clock.t - 0.05) / 0.5) + 1);
    live.forEach((c, k) => {
      expect(c.when).toBeCloseTo(0.05 + 0.5 * k, 9);
      expect(c.scheduledAt).toBeLessThanOrEqual(c.when);
    });
  });

  it('unexpected throttling skips clicks already in the past (never plays them late), then adapts', () => {
    const { wakeAt, sink, clock } = setup(() => false);
    // Normal ticking to 1 s, then a 1 s stall, then 1 s wake-ups.
    wakeAt(Array.from({ length: 40 }, (_, i) => 0.025 * (i + 1)));
    wakeAt([2.0, 3.0, 4.0, 5.0]);
    const live = sink.live().filter((c) => c.when < clock.t);
    for (const c of live) {
      expect(c.scheduledAt).toBeLessThanOrEqual(c.when);
      expect((c.when - 0.05) / 0.5).toBeCloseTo(Math.round((c.when - 0.05) / 0.5), 9); // on the grid
    }
    const whens = live.map((c) => c.when);
    // Beats at 1.55 (and ≥ 1.12 horizon) were missed during the stall; from the stall on, nothing is missing.
    expect(whens.some((w) => w > 1.2 && w < 2.0)).toBe(false);
    const after = whens.filter((w) => w >= 2.0);
    after.forEach((w, k) => expect(w).toBeCloseTo(2.05 + 0.5 * k, 9));
    expect(after.length).toBe(6);
  });
});
