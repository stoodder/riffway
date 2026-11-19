/**
 * Visual offset (docs/timing.md § Latency calibration): a marker scrolls into a hit line and flashes
 * there with every click; the player nudges the offset until flash and click coincide. Same formula
 * as the highway: the drawn time is `heardCtx − visualOffsetMs / 1000`, so a positive offset draws
 * later. Pure helpers plus an endless look-ahead click loop; DOM-free.
 * @module
 */
import type { CalibrationClickSink } from './run';

/** Range and nudge step of the visual offset (ms). */
export const VISUAL_OFFSET = { min: -150, max: 150, step: 5 } as const;

/** Clamp to the range and round to whole ms. */
export function clampVisualOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.round(Math.min(VISUAL_OFFSET.max, Math.max(VISUAL_OFFSET.min, ms)));
}

/** `ms` moved by `steps` nudges (±5 ms each), clamped. */
export function nudgeVisualOffset(ms: number, steps: number): number {
  return clampVisualOffset(ms + steps * VISUAL_OFFSET.step);
}

/** Where the marker is for one frame. */
export interface VisualFrame {
  /** Seconds until the next click reaches the hit line (0…period). */
  untilNext: number;
  /** Flash strength 0–1: 1 right as a click is drawn on the line, decaying over ~100 ms. */
  flash: number;
  /** Index of the latest click that has reached the line (−1 before the first). */
  beat: number;
}

/** Flash decay time constant (s). */
export const FLASH_DECAY_SEC = 0.06;

/**
 * Frame state for clicks at `firstClick + k × period` (k ≥ 0), heard-domain context time
 * `heardCtx`, and the visual offset.
 */
export function visualFrame(heardCtx: number, visualOffsetMs: number, firstClick: number, period: number): VisualFrame {
  const drawn = heardCtx - visualOffsetMs / 1000;
  const k = Math.floor((drawn - firstClick) / period);
  if (k < 0) return { untilNext: firstClick - drawn, flash: 0, beat: -1 };
  const last = firstClick + k * period;
  return { untilNext: last + period - drawn, flash: Math.exp(-(drawn - last) / FLASH_DECAY_SEC), beat: k };
}

/** Host of a {@link ClickLoop}. */
export interface ClickLoopHost {
  now(): number;
  clicks: CalibrationClickSink;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/** Endless clicks at a fixed period, scheduled a little ahead by a timer. */
export class ClickLoop {
  /** Context time of click 0. */
  readonly firstClick: number;
  private next = 0;
  private timer: unknown = null;
  private stopped = false;
  private readonly handles: { at: number; h: { cancel(): void } }[] = [];
  private readonly lookahead: number;
  private readonly beatsPerBar: number;

  constructor(
    private readonly host: ClickLoopHost,
    readonly period: number,
    opts: { leadSec?: number; lookaheadSec?: number; beatsPerBar?: number } = {},
  ) {
    this.firstClick = host.now() + (opts.leadSec ?? 0.2);
    this.lookahead = opts.lookaheadSec ?? 0.3;
    this.beatsPerBar = opts.beatsPerBar ?? 4;
    this.pump();
  }

  /** Stop clicking (cancels clicks not yet played). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const clear = this.host.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (this.timer !== null) clear(this.timer);
    const now = this.host.now();
    for (const { at, h } of this.handles) if (at > now) h.cancel();
    this.handles.length = 0;
  }

  private pump(): void {
    if (this.stopped) return;
    const now = this.host.now();
    while (this.firstClick + this.next * this.period < now + this.lookahead) {
      const at = this.firstClick + this.next * this.period;
      if (at >= now) this.handles.push({ at, h: this.host.clicks.schedule(at, this.next % this.beatsPerBar === 0) });
      this.next++;
    }
    while (this.handles.length && this.handles[0]!.at < now - 1) this.handles.shift();
    const set = this.host.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = set(() => this.pump(), (this.lookahead * 1000) / 3);
  }
}
