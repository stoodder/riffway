/**
 * Look-ahead loop (docs/timing.md § Scheduling): a timer wakes every 25 ms and asks the transport to
 * schedule everything in `[now, now + horizon)`. The timer only decides *when we look*; every event
 * time comes from the `AudioContext` clock, so timer jitter never moves a click.
 *
 * Throttling: background tabs may only fire timers about once per second. The horizon adapts to the
 * observed gap between wake-ups (in context time) and is raised up front while the page is hidden,
 * so the next wake-up always lands before the end of what is already scheduled. Pure and DOM-free;
 * the timer and visibility are injected.
 * @module
 */

/** Timer functions (`globalThis.setInterval` in the app, fakes in tests). */
export interface LoopTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Options for {@link LookaheadLoop}. */
export interface LookaheadOptions {
  /** Context time now (`ctx.currentTime`). */
  now(): number;
  /** One scheduling pass up to `now + horizon`. Returns false when there is nothing left to do (the loop stops). */
  tick(horizonSec: number): boolean;
  timer?: LoopTimer;
  /** True while the page is hidden (timers throttled); raises the horizon to `hiddenHorizonSec`. */
  hidden?: () => boolean;
  /** Wake-up interval (25 ms). */
  intervalMs?: number;
  /** Normal horizon (120 ms). */
  horizonSec?: number;
  /** Horizon while hidden (1.5 s: Chrome throttles hidden-tab timers to ~1 Hz). */
  hiddenHorizonSec?: number;
  /** Upper bound for the adaptive horizon (3 s). */
  maxHorizonSec?: number;
}

/** Margin added to the observed wake-up gap. */
const GAP_MARGIN_SEC = 0.05;

/** The look-ahead timer. Starts on demand and stops itself when `tick` returns false. */
export class LookaheadLoop {
  private readonly opts: Required<Omit<LookaheadOptions, 'timer' | 'hidden'>> & Pick<LookaheadOptions, 'hidden'>;
  private readonly timer: LoopTimer;
  private handle: unknown = null;
  private lastRun: number | null = null;
  private _horizon: number;

  constructor(opts: LookaheadOptions) {
    this.opts = {
      intervalMs: 25,
      horizonSec: 0.12,
      hiddenHorizonSec: 1.5,
      maxHorizonSec: 3,
      ...opts,
    };
    this.timer = opts.timer ?? {
      setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
      clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>),
    };
    this._horizon = this.opts.horizonSec;
  }

  /** True while the timer is armed. */
  get running(): boolean {
    return this.handle !== null;
  }

  /** Horizon used by the latest pass (s). */
  get horizon(): number {
    return this._horizon;
  }

  /** Arm the timer (if needed) and run a pass now. */
  start(): void {
    if (this.handle === null) {
      this.lastRun = null;
      this.handle = this.timer.setInterval(() => this.run(), this.opts.intervalMs);
    }
    this.run();
  }

  /** Disarm the timer. */
  stop(): void {
    if (this.handle !== null) this.timer.clearInterval(this.handle);
    this.handle = null;
    this.lastRun = null;
  }

  /** One pass: adapt the horizon, tick, stop when idle. */
  run(): void {
    const now = this.opts.now();
    const gap = this.lastRun === null ? 0 : Math.max(0, now - this.lastRun);
    this.lastRun = now;
    const floor = this.opts.hidden?.() ? this.opts.hiddenHorizonSec : this.opts.horizonSec;
    this._horizon = Math.min(this.opts.maxHorizonSec, Math.max(floor, gap + GAP_MARGIN_SEC));
    if (!this.opts.tick(this._horizon)) this.stop();
  }
}
