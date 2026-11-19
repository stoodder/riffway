/**
 * Clock, transport and scheduling contracts (docs/timing.md). Implemented by the audio engine
 * (`src/audio/engine/`, T-016); consumed by the judge, renderer, guide/backing players and session.
 *
 * The `AudioContext` is the only clock (D5):
 * `songTime = (ctxTime − anchorCtxTime) × speed + anchorSongTime`.
 * - *ctx time*: `AudioContext.currentTime` seconds (real time).
 * - *song time*: seconds at 100% speed; negative during count-in / pre-roll.
 * - *speed*: 0.4–1.1 (1 = 100%). Timing windows are in real seconds and never scale with speed.
 *
 * DOM-free (the judge in `src/core` uses {@link SongClockMapping}).
 * @module
 */

/** Unsubscribe / dispose callback returned by every `on*` method. */
export type Unsubscribe = () => void;

/** Transport state machine. */
export type TransportState = 'stopped' | 'count-in' | 'playing' | 'paused';

/** The anchor that defines the current ctx ↔ song mapping. */
export interface ClockAnchor {
  /** Context time of the anchor (s). */
  anchorCtxTime: number;
  /** Song time at the anchor (s at 100%). */
  anchorSongTime: number;
  /** Playback speed factor (1 = 100%). 0 while paused/stopped. */
  speed: number;
}

/** Pure ctx ↔ song time mapping (what the judge needs). */
export interface SongClockMapping {
  /** Song time at a context time. */
  songTimeAt(ctxTime: number): number;
  /** Context time at which `songTime` is (or was) reached in the current pass. */
  ctxTimeAt(songTime: number): number;
}

/** Why the anchor changed. */
export type ClockChangeReason = 'play' | 'pause' | 'stop' | 'seek' | 'speed' | 'loop-wrap' | 'count-in-end';

/** Emitted whenever the transport re-anchors. */
export interface ClockChange {
  reason: ClockChangeReason;
  anchor: Readonly<ClockAnchor>;
  state: TransportState;
  /** Loop pass counter (0 = first pass); increments on every loop wrap. */
  pass: number;
}

/** The song clock. Read-only; the renderer never advances time. */
export interface SongClock extends SongClockMapping {
  readonly state: TransportState;
  /** Current speed factor (the requested speed, also while paused). */
  readonly speed: number;
  /** Current anchor. */
  readonly anchor: Readonly<ClockAnchor>;
  /** `ctx.currentTime`. */
  nowCtx(): number;
  /** Song time now (scheduling domain: what is being *scheduled*, not heard). */
  nowSong(): number;
  /**
   * Song time being **heard** at `perfNow` (a `performance.now()` value, default now), using
   * `ctx.getOutputTimestamp()` extrapolation and minus `visualOffsetMs × speed`. The renderer
   * draws at this time so a gem reaches the hit line when its sound is heard.
   */
  heardSongTime(perfNow?: number): number;
  /** Subscribe to re-anchors (play, seek, speed change, loop wrap, …). */
  onChange(cb: (change: ClockChange) => void): Unsubscribe;
}

/** A loop region in song time (A/B). A and B are already snapped (sections, then bars). */
export interface TransportLoop {
  /** A: loop start, song seconds (a bar line). */
  start: number;
  /** B: loop end, song seconds (a bar line, > start). */
  end: number;
  /** Pre-roll before A on every pass, song seconds (1 bar; 2 bars below 60% speed). */
  preroll: number;
}

/** Options for {@link Transport.play}. */
export interface PlayOptions {
  /** Song time to start from (default: current position). */
  from?: number;
  /** Count-in bars of clicks before `from` (default: settings `practice.countInBars`). Only first pass. */
  countInBars?: number;
}

/** Transport controls. Every change re-anchors at `ctx.currentTime + 0.05`. */
export interface Transport {
  readonly state: TransportState;
  readonly speed: number;
  readonly loop: Readonly<TransportLoop> | null;
  /** Beat grid + duration of the loaded song (drives metronome, count-in and bar-aligned speed changes). */
  load(timeline: TransportTimeline): void;
  play(opts?: PlayOptions): void;
  pause(): void;
  /** Stop and return to the start. */
  stop(): void;
  seek(songTime: number): void;
  /**
   * Change speed (0.4–1.1). While playing the change applies at the next bar line
   * (`atNextBar`, default true) once `ready` resolves (guide re-render); while paused it is immediate.
   */
  setSpeed(speed: number, opts?: { atNextBar?: boolean; ready?: Promise<void> }): void;
  setLoop(loop: TransportLoop | null): void;
  setMetronome(on: boolean): void;
  onChange(cb: (change: ClockChange) => void): Unsubscribe;
  /** Fired when playback passes the end of the song (not in a loop). */
  onEnded(cb: () => void): Unsubscribe;
}

/** What the transport needs to know about the loaded song. */
export interface TransportTimeline {
  /** Song duration (s at 100%). */
  durationSec: number;
  /** Bars with beat times (`Song.timing.bars`). */
  bars: readonly { time: number; dur: number; beats: readonly number[] }[];
}

/**
 * One contiguous stretch of playback the engine asks a {@link ScheduledSource} to render:
 * from ctx time `ctxStart`, play song time `songStart` onward at `speed`, until `ctxEnd`
 * (or until the next `schedule`/`stop` call).
 */
export interface PlaybackSegment {
  ctxStart: number;
  songStart: number;
  /** Song time where this segment ends (loop B), if bounded. */
  songEnd?: number;
  /** Context time where this segment ends, if bounded. */
  ctxEnd?: number;
  speed: number;
  /** Loop pass number of this segment. */
  pass: number;
}

/**
 * Long audio (guide PCM, backing track) registered with the engine via
 * `AudioEngine.registerScheduledSource()`. The engine calls `schedule` on play, seek, speed change
 * and loop wrap (at least one scheduler horizon ahead), and `stop` on pause/stop.
 */
export interface ScheduledSource {
  /** Diagnostic name (`'guide'`, `'backing'`). */
  readonly name: string;
  schedule(segment: PlaybackSegment): void;
  /** Stop everything at ctx time `when` (default now). */
  stop(when?: number): void;
}
