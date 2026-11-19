/**
 * Shared helpers for engine tests: a beat-grid builder and a fake-clock transport rig whose click
 * sink records when each click was scheduled and whether it was cancelled.
 */
import type { PlaybackSegment, ScheduledSource, TransportTimeline } from '@shared/clock';
import { type ClickSink, TransportCore, type TransportOptions } from '../../src/audio/engine/transport';

/** A run of identical bars. `bpm` is quarter notes per minute; beats are `den` notes. */
export interface BarRun {
  bpm: number;
  num: number;
  den?: number;
  bars: number;
}

/** Build a `TransportTimeline` from runs of bars (start at `start` song seconds). */
export function makeTimeline(runs: BarRun[], start = 0): TransportTimeline {
  const bars: TransportTimeline['bars'][number][] = [];
  let t = start;
  for (const run of runs) {
    const beatSec = (60 / run.bpm) * (4 / (run.den ?? 4));
    for (let b = 0; b < run.bars; b++) {
      const beats = Array.from({ length: run.num }, (_, j) => t + j * beatSec);
      bars.push({ time: t, dur: run.num * beatSec, beats });
      t += run.num * beatSec;
    }
  }
  return { durationSec: t, bars };
}

/** One recorded click. */
export interface RecordedClick {
  when: number;
  accent: boolean;
  scheduledAt: number;
  cancelled: boolean;
}

/** Click sink recording everything. */
export class RecordingSink implements ClickSink {
  readonly all: RecordedClick[] = [];
  constructor(private readonly now: () => number) {}
  schedule(when: number, accent: boolean) {
    const rec: RecordedClick = { when, accent, scheduledAt: this.now(), cancelled: false };
    this.all.push(rec);
    return {
      cancel: () => {
        rec.cancelled = true;
      },
    };
  }
  /** Clicks that were not cancelled, by time. */
  live(): RecordedClick[] {
    return this.all.filter((c) => !c.cancelled).sort((a, b) => a.when - b.when);
  }
}

/** Scheduled source recording its calls. */
export class RecordingSource implements ScheduledSource {
  readonly name = 'test';
  readonly calls: ({ type: 'schedule'; seg: PlaybackSegment } | { type: 'stop'; when: number | undefined })[] = [];
  schedule(seg: PlaybackSegment): void {
    this.calls.push({ type: 'schedule', seg });
  }
  stop(when?: number): void {
    this.calls.push({ type: 'stop', when });
  }
  schedules(): PlaybackSegment[] {
    return this.calls.flatMap((c) => (c.type === 'schedule' ? [c.seg] : []));
  }
}

/** Transport on a fake clock. `run(until)` advances time in `step`s, ticking each time. */
export function makeRig(opts: TransportOptions = {}) {
  const clock = { t: 0 };
  const sink = new RecordingSink(() => clock.t);
  const core = new TransportCore({ now: () => clock.t, clicks: sink }, opts);
  const run = (until: number, step = 0.025, horizon = 0.12): void => {
    while (clock.t + step <= until + 1e-9) {
      clock.t += step;
      core.tick(horizon);
    }
    clock.t = Math.max(clock.t, until);
    core.tick(horizon);
  };
  /** Live clicks that have sounded by now. */
  const played = (): RecordedClick[] => sink.live().filter((c) => c.when < clock.t);
  return { clock, sink, core, run, played };
}

/** Successive differences. */
export function diffs(xs: number[]): number[] {
  return xs.slice(1).map((x, i) => x - xs[i]!);
}
