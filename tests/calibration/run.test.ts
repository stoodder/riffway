/**
 * A calibration run on a fake clock: clicks scheduled per the plan, events collected, live
 * provisional estimates, the end wait (timers firing early), abort and single use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalibrationAbortedError, CalibrationRun, type CalibrationProgress } from '../../src/audio/calibration';
import { simulate } from './helpers';

class FakeHost {
  time = 100;
  scheduled: { when: number; accent: boolean; cancelled: boolean }[] = [];
  listeners = new Set<(t: number) => void>();
  now = (): number => this.time;
  clicks = {
    schedule: (when: number, accent: boolean) => {
      const c = { when, accent, cancelled: false };
      this.scheduled.push(c);
      return { cancel: () => void (c.cancelled = true) };
    },
  };
  listen = (cb: (t: number) => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  emit(t: number): void {
    for (const cb of this.listeners) cb(t);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Advance fake timers and the fake context clock together. */
async function advance(host: FakeHost, sec: number): Promise<void> {
  const steps = Math.ceil(sec / 0.05);
  for (let i = 0; i < steps; i++) {
    host.time += sec / steps;
    await vi.advanceTimersByTimeAsync((sec / steps) * 1000);
  }
}

describe('CalibrationRun', () => {
  it('schedules count-in + 16 clicks, collects events and resolves with the estimate', async () => {
    const host = new FakeHost();
    const run = new CalibrationRun(host);
    const progress: CalibrationProgress[] = [];
    run.onProgress((p) => progress.push(p));
    const done = run.start();
    expect(run.running).toBe(true);
    expect(host.scheduled).toHaveLength(20);
    expect(host.scheduled[0]!.when).toBeCloseTo(100.3, 9);
    expect(host.scheduled.filter((c) => c.accent)).toHaveLength(5);
    expect(host.listeners.size).toBe(1);

    const measured = run.plan.filter((c) => c.measured).map((c) => c.ctxTime);
    const events = simulate(measured, { offsetMs: 48, jitterMs: 2, seed: 7 });
    let i = 0;
    while (run.running) {
      while (i < events.length && events[i]! <= host.time) host.emit(events[i++]!);
      await advance(host, 0.05);
    }
    const r = await done;
    expect(r.ok).toBe(true);
    expect(Math.abs(r.offsetMs! - 48)).toBeLessThan(2);
    expect(host.time).toBeGreaterThanOrEqual(run.endsAt);
    expect(host.listeners.size).toBe(0);
    // Live estimates grow with the clicks played so far.
    expect(progress).toHaveLength(16);
    expect(progress[0]!.estimate.pairs).toHaveLength(1);
    expect(progress[15]!.estimate.kept).toBe(14);
  });

  it('waits on the context clock even when timers fire early', async () => {
    const host = new FakeHost();
    const run = new CalibrationRun(host, { plan: { clicks: 2, countInBeats: 0 }, estimator: { minPairs: 1, settlePairs: 0 } });
    const done = run.start();
    // Timers run but the context clock has not moved: still waiting.
    await vi.advanceTimersByTimeAsync(5000);
    expect(run.running).toBe(true);
    host.time = run.endsAt + 0.01;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toMatchObject({ failure: 'no-events' });
  });

  it('abort cancels the clicks, unsubscribes and rejects', async () => {
    const host = new FakeHost();
    const run = new CalibrationRun(host);
    const done = run.start();
    run.abort('stopped by test');
    await expect(done).rejects.toBeInstanceOf(CalibrationAbortedError);
    await expect(done).rejects.toThrow('stopped by test');
    expect(host.scheduled.every((c) => c.cancelled)).toBe(true);
    expect(host.listeners.size).toBe(0);
    expect(run.running).toBe(false);
    run.abort(); // no-op
    await expect(run.start()).rejects.toThrow(/only be started once/);
  });

  it('ignores events after the run and non-finite times', async () => {
    const host = new FakeHost();
    const run = new CalibrationRun(host, { plan: { clicks: 1, countInBeats: 0 } });
    const seen: number[] = [];
    run.onProgress((p) => seen.push(p.events));
    const done = run.start();
    host.emit(Number.NaN);
    host.emit(run.plan[0]!.ctxTime + 0.03);
    await advance(host, 1);
    await done;
    host.emit(run.plan[0]!.ctxTime + 0.04);
    expect(seen).toEqual([1]);
  });
});
