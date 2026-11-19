/**
 * One calibration run: schedules the click plan on a click sink, collects event times from a source
 * (guitar onsets, keyboard taps or loopback onsets), reports a live provisional estimate after each
 * event and resolves with the final {@link OffsetEstimate} once the last click's pair window (plus
 * the input's delivery lag) has passed. DOM-free: the host supplies the clock, clicks, events and
 * timers, so the flow is tested in Node with a fake clock.
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import { CALIBRATION, estimateOffset, type EstimatorOptions, type OffsetEstimate } from './estimate';
import { clickPlan, measuredTimes, type ClickPlanOptions, type PlannedClick } from './plan';

/** Plays one click at a context time (the engine's click voice). */
export interface CalibrationClickSink {
  schedule(when: number, accent: boolean): { cancel(): void };
}

/** What a run needs from its environment. */
export interface CalibrationRunHost {
  /** Context time now (`ctx.currentTime`). */
  now(): number;
  clicks: CalibrationClickSink;
  /** Subscribe to event times (context seconds, uncalibrated). */
  listen(cb: (ctxTime: number) => void): Unsubscribe;
  /** Timers (default: global `setTimeout` / `clearTimeout`). */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/** Run options. */
export interface CalibrationRunOptions {
  /** Delay from `start()` to the first click (s; default 0.3). */
  leadSec?: number;
  /** Override the click plan (tests). */
  plan?: Partial<ClickPlanOptions>;
  /** Override estimator rules (tests). */
  estimator?: Partial<EstimatorOptions>;
  /** Extra wait after the last pair window closes, for late-delivered events (s; default 0.15). */
  tailSec?: number;
}

/** Live state while a run is in progress. */
export interface CalibrationProgress {
  /** Events received so far. */
  events: number;
  /** Provisional estimate over the clicks already played. */
  estimate: OffsetEstimate;
}

/** Thrown (rejected) when a run is aborted. */
export class CalibrationAbortedError extends Error {
  constructor(reason = 'Calibration stopped') {
    super(reason);
    this.name = 'CalibrationAbortedError';
  }
}

/** A single calibration run. Create, subscribe with {@link onProgress}, then {@link start}. */
export class CalibrationRun {
  /** The click plan (set by {@link start}; empty before). */
  plan: PlannedClick[] = [];
  private readonly events: number[] = [];
  private readonly handles: { cancel(): void }[] = [];
  private readonly progressCbs = new Set<(p: CalibrationProgress) => void>();
  private unlisten: Unsubscribe | null = null;
  private timer: unknown = null;
  private settle: { resolve(e: OffsetEstimate): void; reject(err: Error): void } | null = null;
  private state: 'idle' | 'running' | 'done' = 'idle';

  constructor(
    private readonly host: CalibrationRunHost,
    private readonly opts: CalibrationRunOptions = {},
  ) {}

  /** True while clicks are playing or the run waits for late events. */
  get running(): boolean {
    return this.state === 'running';
  }

  /** Context time the run ends (last measured click + pair window + tail). NaN before start. */
  get endsAt(): number {
    const last = this.plan[this.plan.length - 1];
    if (!last) return Number.NaN;
    const windowSec = (this.opts.estimator?.pairWindowMs ?? CALIBRATION.pairWindowMs) / 1000;
    return last.ctxTime + windowSec + (this.opts.tailSec ?? 0.15);
  }

  /** Called after every event with a provisional estimate. */
  onProgress(cb: (p: CalibrationProgress) => void): Unsubscribe {
    this.progressCbs.add(cb);
    return () => this.progressCbs.delete(cb);
  }

  /** Schedule the clicks and collect events; resolves with the estimate (rejects if aborted). */
  start(): Promise<OffsetEstimate> {
    if (this.state !== 'idle') return Promise.reject(new Error('A calibration run can only be started once'));
    this.state = 'running';
    this.plan = clickPlan(this.host.now() + (this.opts.leadSec ?? 0.3), this.opts.plan);
    this.unlisten = this.host.listen((t) => this.onEvent(t));
    for (const c of this.plan) this.handles.push(this.host.clicks.schedule(c.ctxTime, c.accent));
    return new Promise<OffsetEstimate>((resolve, reject) => {
      this.settle = { resolve, reject };
      this.arm();
    });
  }

  /** Stop the clicks and reject the pending `start()`. No-op once finished. */
  abort(reason?: string): void {
    if (this.state !== 'running') return;
    for (const h of this.handles) h.cancel();
    this.finish();
    this.settle?.reject(new CalibrationAbortedError(reason));
  }

  /** Estimate over everything received so far (all measured clicks). */
  estimate(): OffsetEstimate {
    return estimateOffset(measuredTimes(this.plan), this.events, this.opts.estimator);
  }

  private onEvent(ctxTime: number): void {
    if (this.state !== 'running' || !Number.isFinite(ctxTime)) return;
    this.events.push(ctxTime);
    const windowSec = (this.opts.estimator?.pairWindowMs ?? CALIBRATION.pairWindowMs) / 1000;
    const horizon = Math.max(this.host.now(), ctxTime) + windowSec;
    const played = measuredTimes(this.plan).filter((t) => t <= horizon);
    const progress: CalibrationProgress = { events: this.events.length, estimate: estimateOffset(played, this.events, this.opts.estimator) };
    for (const cb of this.progressCbs) {
      try {
        cb(progress);
      } catch (err) {
        console.error('Riffway: calibration progress listener failed', err);
      }
    }
  }

  /** Wait until {@link endsAt} on the context clock (timers may fire early or late). */
  private arm(): void {
    const remainingMs = (this.endsAt - this.host.now()) * 1000;
    if (remainingMs <= 0) {
      const result = this.estimate();
      this.finish();
      this.settle?.resolve(result);
      return;
    }
    const set = this.host.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      if (this.state === 'running') this.arm();
    }, Math.min(remainingMs + 5, 1000));
  }

  private finish(): void {
    this.state = 'done';
    this.unlisten?.();
    this.unlisten = null;
    if (this.timer !== null) {
      const clear = this.host.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
      clear(this.timer);
      this.timer = null;
    }
  }
}
