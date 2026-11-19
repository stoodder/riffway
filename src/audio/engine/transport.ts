/**
 * Transport + look-ahead scheduling logic (docs/timing.md § Scheduling, § Speed changes, § Count-in,
 * loops and pre-roll). Pure and DOM-free: time comes from `host.now()` (`ctx.currentTime` in the app,
 * a fake clock in tests) and clicks go to a {@link ClickSink}, so all timing logic runs in Node.
 *
 * Every `tick(horizon)` (driven by the {@link LookaheadLoop}) derives *all* event times from the
 * segment timeline, never from timer arrival times, so late or throttled ticks cannot drift: they can
 * only skip clicks that are already in the past. Clicks are keyed by `(segment, song time)`, so
 * re-running a tick never duplicates one and a re-anchor cancels exactly the clicks it supersedes.
 *
 * Passes (docs/timing.md § Passes): every loop wrap, seek and jump (`play({from})` while running or
 * paused) starts a new pass number; pause/resume, speed and loop changes continue the pass; `play()`
 * from `stopped` starts a fresh run at pass 0. A `loop-wrap` is announced once the new pass has begun
 * (detected by the tick), so a wrap that is scheduled and then superseded is never announced.
 * @module
 */
import type {
  ClockAnchor,
  ClockChange,
  ClockChangeReason,
  PlayOptions,
  ScheduledSource,
  Transport,
  TransportLoop,
  TransportState,
  TransportTimeline,
  Unsubscribe,
} from '@shared/clock';
import { type BeatClick, beatsInRange, countInClicks, nextBarLine } from './beats';
import {
  type ReanchorResult,
  type Segment,
  type SegmentBound,
  type SegmentInit,
  SegmentTimeline,
  segCtx,
  segCtxLimit,
  segSong,
  segSongLimit,
  toPlaybackSegment,
} from './clock';

/** A click that can still be cancelled before it sounds. */
export interface ClickHandle {
  cancel(): void;
}

/** Plays metronome / count-in clicks at exact context times (see `metronome.ts`). */
export interface ClickSink {
  schedule(when: number, accent: boolean): ClickHandle;
}

/** What the transport needs from the outside world. */
export interface TransportHost {
  /** Current context time (s). */
  now(): number;
  clicks: ClickSink;
}

/** Tunables (defaults per docs/timing.md). */
export interface TransportOptions {
  /** Default count-in bars for `play()` without `countInBars` (settings `practice.countInBars`). */
  countInBars?: number;
  /** Metronome on (settings `practice.metronome`). */
  metronome?: boolean;
  /** Re-anchor lead: changes take effect at `now + lead` (0.05 s). */
  reanchorLeadSec?: number;
  /** Segment history kept for mapping the previous pass after a wrap (2 s). */
  historySec?: number;
}

/** Speed range accepted by {@link TransportCore.setSpeed}. */
export const SPEED_MIN = 0.4;
export const SPEED_MAX = 1.1;
/** Default re-anchor lead (docs/timing.md: `t0 = ctx.currentTime + 0.05`). */
export const REANCHOR_LEAD_SEC = 0.05;
/** Default click horizon (docs/timing.md: 120 ms). */
export const DEFAULT_HORIZON_SEC = 0.12;
/** Clicks closer to `now` than this are treated as already sounding and are never cancelled. */
const CANCEL_GUARD_SEC = 0.01;
/** Slack when converting a context window to song time; the exact filter is in context time. */
const SONG_EPS = 1e-9;
/** Safety cap on loop wraps appended per tick (a 1-bar loop at 110% is ≥ 0.5 s long). */
const MAX_WRAPS_PER_TICK = 64;

type ClickKind = 'count-in' | 'preroll' | 'grid';

interface ScheduledClick {
  segId: number;
  song: number;
  when: number;
  kind: ClickKind;
  handle: ClickHandle;
}

interface CountIn {
  /** First segment of the count-in (segment ids increase, so later segments compare greater). */
  segId: number;
  pass: number;
  /** Song time where the count-in ends and judged playback begins. */
  from: number;
  clicks: BeatClick[];
}

/** Rethrow listener/source errors asynchronously so one faulty consumer cannot corrupt transport state. */
function isolate(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    queueMicrotask(() => {
      throw err;
    });
  }
}

/**
 * The transport state machine and click scheduler behind `AudioEngine.transport` / `.clock`.
 * Implements {@link Transport}; the engine wraps it with the output-side {@link SongClock} adapter.
 */
export class TransportCore implements Transport {
  private readonly host: TransportHost;
  private readonly lead: number;
  private readonly historySec: number;
  private readonly timeline: SegmentTimeline;
  private readonly clicks = new Map<string, ScheduledClick>();
  private readonly sources = new Set<ScheduledSource>();
  private readonly changeListeners = new Set<(c: ClockChange) => void>();
  private readonly endedListeners = new Set<() => void>();

  private song: TransportTimeline = { durationSec: Infinity, bars: [] };
  private _state: TransportState = 'stopped';
  private _loop: TransportLoop | null = null;
  private countIn: CountIn | null = null;
  private metronome: boolean;
  /** Speed new segments are created with (changes once a pending speed change is ready). */
  private playSpeed = 1;
  /** Speed most recently requested via `setSpeed` (public `speed`). */
  private requestedSpeed = 1;
  private speedToken = 0;
  private horizon = DEFAULT_HORIZON_SEC;
  /** Id of the newest `loop-wrap` segment already announced (wraps are announced once begun). */
  private announcedWrap = 0;
  /** Nesting depth of control operations; notifications wait until the outermost one finishes. */
  private depth = 0;
  private readonly pending: (() => void)[] = [];

  /** Default count-in bars for `play()` (settings `practice.countInBars`, 0–2). */
  countInBars: number;

  constructor(host: TransportHost, opts: TransportOptions = {}) {
    this.host = host;
    this.lead = opts.reanchorLeadSec ?? REANCHOR_LEAD_SEC;
    this.historySec = opts.historySec ?? 2;
    this.countInBars = opts.countInBars ?? 1;
    this.metronome = opts.metronome ?? true;
    this.timeline = new SegmentTimeline(host.now());
  }

  // ---------------------------------------------------------------------------------------------
  // Read side (also backs the SongClock)
  // ---------------------------------------------------------------------------------------------

  get state(): TransportState {
    return this._state;
  }

  /** The requested speed (also while paused or while a change waits for its bar line). */
  get speed(): number {
    return this.requestedSpeed;
  }

  get loop(): Readonly<TransportLoop> | null {
    return this._loop;
  }

  /** Playing or counting in. */
  get running(): boolean {
    return this._state === 'playing' || this._state === 'count-in';
  }

  /** Latest anchor (it may start up to one re-anchor lead or horizon in the future). */
  get anchor(): Readonly<ClockAnchor> {
    return this.anchorOf(this.timeline.last);
  }

  /** Song time at a context time (exact for past and already-scheduled times). */
  songTimeAt(ctxTime: number): number {
    return this.timeline.songTimeAt(ctxTime);
  }

  /** Context time of `songTime`, nearest occurrence to now (see {@link SegmentTimeline.ctxTimeAt}). */
  ctxTimeAt(songTime: number): number {
    return this.timeline.ctxTimeAt(songTime, this.host.now(), this.playSpeed);
  }

  /**
   * Context time of `songTime` in pass `pass` (see {@link SegmentTimeline.ctxTimeInPass}): finite when
   * the pass plays (played / will play) it, `-Infinity` when it never will, `NaN` while not yet known
   * (paused or stopped before it). The judge's mapping (`PassClockMapping`).
   */
  ctxTimeInPass(songTime: number, pass: number): number {
    return this.timeline.ctxTimeInPass(songTime, pass);
  }

  /** Pass of the segment in effect now (0 = first pass of the run). */
  get pass(): number {
    return this.timeline.at(this.host.now()).pass;
  }

  /** Speed of the segment in effect at `ctxTime` (0 while paused). */
  speedAt(ctxTime: number): number {
    return this.timeline.at(ctxTime).speed;
  }

  /** Retained segments (diagnostics and tests). */
  get segments(): readonly Readonly<Segment>[] {
    return this.timeline.segments;
  }

  /** Context times of clicks still scheduled (diagnostics and tests). */
  scheduledClickTimes(): number[] {
    return [...this.clicks.values()].map((c) => c.when).sort((a, b) => a - b);
  }

  onChange(cb: (change: ClockChange) => void): Unsubscribe {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  onEnded(cb: () => void): Unsubscribe {
    this.endedListeners.add(cb);
    return () => this.endedListeners.delete(cb);
  }

  // ---------------------------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------------------------

  load(timeline: TransportTimeline): void {
    this.op(() => {
      if (!(timeline.durationSec >= 0)) throw new RangeError(`durationSec must be ≥ 0, got ${timeline.durationSec}`);
      this.tick();
      this.song = { durationSec: timeline.durationSec, bars: [...timeline.bars].sort((a, b) => a.time - b.time) };
      this._loop = null;
      this.goStopped(0);
    });
  }

  play(opts: PlayOptions = {}): void {
    this.op(() => {
      this.tick();
      if (this.running && opts.from === undefined) return;
      const t = this.host.now() + this.lead;
      let from = opts.from ?? this.timeline.songTimeAt(t);
      if (opts.from === undefined && from >= this.song.durationSec) from = 0;
      from = this.clampSong(from);
      // Fresh run from stopped: pass 0. Resume: the paused pass. A jump while running/paused: next pass.
      const fresh = this._state === 'stopped';
      const current = this.timeline.at(t).pass;
      const pass = fresh ? 0 : opts.from === undefined ? current : current + 1;
      const bars = opts.countInBars ?? this.countInBars;
      const ci = bars > 0 ? countInClicks(this.song, from, bars) : null;
      const counting = ci !== null && ci.clicks.length > 0;
      this.countIn = counting ? { segId: Infinity, pass, from, clicks: ci.clicks } : null;
      this._state = counting ? 'count-in' : 'playing';
      const seg = this.startPlaying(t, counting ? ci.start : from, pass, 'play', this.playSpeed, undefined, fresh);
      if (this.countIn) this.countIn.segId = seg.id;
      this.tick();
    });
  }

  pause(): void {
    this.op(() => {
      this.tick();
      if (!this.running) return;
      const t = this.host.now() + this.lead;
      const seg = this.timeline.at(t);
      const pos = this._state === 'count-in' && this.countIn ? this.countIn.from : segSong(seg, t);
      this.countIn = null;
      this._state = 'paused';
      this.stopSourcesAt(t);
      this.reanchor(t, this.holdInit(pos, 'pause', seg.pass), 'pause');
    });
  }

  stop(): void {
    this.op(() => {
      this.tick();
      this.goStopped(0);
    });
  }

  seek(songTime: number): void {
    this.op(() => {
      if (!Number.isFinite(songTime)) throw new RangeError(`seek time must be finite, got ${songTime}`);
      this.tick();
      const pos = this.clampSong(songTime);
      if (this.running) {
        const t = this.host.now() + this.lead;
        this.countIn = null;
        this._state = 'playing';
        this.startPlaying(t, pos, this.timeline.at(t).pass + 1, 'seek');
        this.tick();
      } else {
        // Paused: the jump starts a new pass (resumed later). Stopped: the next play() is a fresh run.
        const t = this.idleReanchorTime();
        const pass = this.timeline.at(t).pass;
        this.reanchor(t, this.holdInit(pos, 'seek', this._state === 'paused' ? pass + 1 : pass), 'seek');
      }
    });
  }

  setSpeed(speed: number, opts: { atNextBar?: boolean; ready?: Promise<void> } = {}): void {
    if (!Number.isFinite(speed)) throw new RangeError(`speed must be finite, got ${speed}`);
    const s = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
    const token = ++this.speedToken;
    this.requestedSpeed = s;
    const apply = (): void => {
      if (token === this.speedToken) this.op(() => this.applySpeed(s, opts.atNextBar ?? true));
    };
    if (!this.running || !opts.ready) {
      apply();
      return;
    }
    opts.ready.then(apply, () => {
      // The re-render failed: keep playing at the applied speed.
      if (token === this.speedToken) this.requestedSpeed = this.playSpeed;
    });
  }

  setLoop(loop: TransportLoop | null): void {
    this.op(() => {
      if (loop) {
        if (![loop.start, loop.end, loop.preroll].every(Number.isFinite) || loop.preroll < 0) {
          throw new RangeError('loop start/end/preroll must be finite and preroll ≥ 0');
        }
        const end = Math.min(loop.end, this.song.durationSec);
        if (!(end > loop.start)) throw new RangeError(`loop end (${loop.end}) must be after start (${loop.start})`);
        this.tick();
        this._loop = { start: loop.start, end, preroll: loop.preroll };
      } else {
        this.tick();
        this._loop = null;
      }
      if (!this.running) return;
      const t = this.host.now() + this.lead;
      const seg = this.timeline.at(t);
      const pos = segSong(seg, t);
      if (this._loop && pos >= this._loop.end) {
        // Already past B: jump into the loop's pre-roll now.
        this.countIn = null;
        this._state = 'playing';
        this.startPlaying(t, this._loop.start - this._loop.preroll, seg.pass + 1, 'loop-wrap');
      } else {
        // Same mapping, new bound: split so sources and clicks see the new end. The split drops
        // later segments, so a bar-aligned speed change still pending is placed again (R2-I-02).
        const split = this.startPlaying(t, pos, seg.pass, null, seg.speed);
        if (split.speed !== this.playSpeed) this.placeSpeedChange(split, t, pos, true, null);
      }
      this.tick();
    });
  }

  setMetronome(on: boolean): void {
    this.op(() => {
      this.metronome = on;
      if (!on) this.cancelClicks((c) => c.kind === 'grid' && c.when >= this.host.now() + CANCEL_GUARD_SEC);
      this.tick();
    });
  }

  /** Register long audio; scheduled from `now + lead` right away if playing. */
  addSource(source: ScheduledSource): Unsubscribe {
    this.sources.add(source);
    if (this.running) {
      const t = this.host.now() + this.lead;
      for (const seg of this.timeline.segments) {
        if (seg.speed <= 0 || segCtxLimit(seg) <= t) continue;
        const start = Math.max(seg.ctxStart, t);
        isolate(() => source.schedule(toPlaybackSegment(seg, start)));
      }
    }
    return () => this.sources.delete(source);
  }

  /**
   * One scheduler pass: append due loop wraps (one segment lead ahead), detect count-in end and song
   * end, then schedule every click in `[now, now + horizon)`. Called by the look-ahead loop and by
   * every control method. Safe to call at any rate.
   */
  tick(horizon: number = this.horizon): void {
    this.op(() => {
      this.horizon = horizon;
      const now = this.host.now();
      this.advance(now, 2 * horizon);
      if (this.running) this.scheduleClicks(now, now + horizon);
      this.timeline.prune(now, this.historySec);
      for (const [key, c] of this.clicks) if (c.when < now - 1) this.clicks.delete(key);
    });
  }

  /**
   * The context was recreated (sample-rate change): cancel everything and hold at `songTime` on the
   * new clock (`now`). A running transport becomes paused.
   */
  rebase(songTime: number): void {
    this.op(() => {
      const wasRunning = this.running;
      const pass = this.pass;
      this.cancelClicks(() => true);
      for (const s of this.sources) isolate(() => s.stop());
      this.countIn = null;
      this._state = wasRunning ? 'paused' : this._state;
      const seg = this.timeline.reset(this.host.now(), songTime, 'pause', pass);
      if (wasRunning) this.emit('pause', seg);
    });
  }

  /** Cancel pending clicks and forget sources and listeners. */
  dispose(): void {
    this.cancelClicks(() => true);
    for (const s of this.sources) isolate(() => s.stop());
    this.sources.clear();
    this.changeListeners.clear();
    this.endedListeners.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  private applySpeed(s: number, atNextBar: boolean): void {
    this.tick();
    this.playSpeed = s;
    if (!this.running) {
      this.emit('speed', this.timeline.last);
      return;
    }
    const t0 = this.host.now() + this.lead;
    let seg = this.timeline.at(t0);
    const pos = segSong(seg, t0);
    if (seg !== this.timeline.last) {
      // Drop pending wraps / bar-aligned changes made at the old speed: continue unchanged from t0.
      seg = this.startPlaying(t0, pos, seg.pass, null, seg.speed);
    }
    this.placeSpeedChange(seg, t0, pos, atNextBar, 'speed');
    this.tick();
  }

  /**
   * Switch the playing segment `seg` (in effect at `t0`, at song time `pos`) to `playSpeed`: at the
   * next bar line (`atNextBar`) or at `t0`. When that bar is past the segment's end the change lands
   * on loop B (the wrap uses `playSpeed`) or after the song end. `reason` is emitted (null: the
   * change was announced before, e.g. when a loop change re-places a pending one).
   */
  private placeSpeedChange(seg: Segment, t0: number, pos: number, atNextBar: boolean, reason: 'speed' | null): void {
    const s = this.playSpeed;
    const bar = atNextBar ? nextBarLine(this.song, pos) : pos;
    if (bar !== null && bar < segSongLimit(seg)) {
      this.startPlaying(Math.max(t0, segCtx(seg, bar)), bar, seg.pass, reason, s, bar);
    } else if (bar === null && seg.bound?.kind !== 'loop') {
      this.startPlaying(t0, pos, seg.pass, reason, s);
    }
  }

  /** Append due wraps; end count-in; stop at song end. */
  private advance(now: number, segmentLead: number): void {
    for (let i = 0; i < MAX_WRAPS_PER_TICK; i++) {
      const last = this.timeline.last;
      if (last.speed <= 0 || !last.bound) break;
      const boundCtx = segCtx(last, last.bound.song);
      if (last.bound.kind === 'loop' && this._loop && boundCtx < now + segmentLead) {
        const start = this._loop.start - this._loop.preroll;
        this.startPlaying(boundCtx, start, last.pass + 1, 'loop-wrap', this.playSpeed, last.bound.song);
        continue;
      }
      if (last.bound.kind === 'end' && now >= boundCtx) {
        this.countIn = null;
        this._state = 'stopped';
        this.stopSourcesAt(boundCtx);
        this.reanchor(boundCtx, this.holdInit(last.bound.song, 'stop', last.pass), 'stop', last.bound.song);
        this.pending.push(() => {
          for (const cb of [...this.endedListeners]) isolate(cb);
        });
      }
      break;
    }
    this.announceWraps(now);
    if (this._state === 'count-in' && this.countIn) {
      const seg = this.timeline.at(now);
      const started = seg.id >= this.countIn.segId;
      if (started && (seg.pass !== this.countIn.pass || segSong(seg, now) >= this.countIn.from)) {
        this.countIn = null;
        this._state = 'playing';
        this.emit('count-in-end', this.timeline.last);
      }
    }
  }

  /** Announce `loop-wrap` for every wrap segment that has begun by `now` (once each, in order). */
  private announceWraps(now: number): void {
    for (const seg of this.timeline.segments) {
      if (seg.reason !== 'loop-wrap' || seg.id <= this.announcedWrap || seg.ctxStart > now) continue;
      this.announcedWrap = seg.id;
      this.emit('loop-wrap', seg);
    }
  }

  /** Schedule clicks with context time in `[now, end)` for every playing segment. */
  private scheduleClicks(now: number, end: number): void {
    for (const seg of this.timeline.segments) {
      if (seg.speed <= 0 || seg.ctxStart >= end || segCtxLimit(seg) <= now) continue;
      const lo = Math.max(seg.songStart, segSong(seg, now) - SONG_EPS);
      const hi = Math.min(segSongLimit(seg), segSong(seg, end) + SONG_EPS);
      for (const click of this.clicksIn(seg, lo, hi)) {
        const when = segCtx(seg, click.time);
        if (when < now || when >= end) continue;
        const key = `${seg.id}:${click.time}`;
        if (this.clicks.has(key)) continue;
        const handle = this.host.clicks.schedule(when, click.accent);
        this.clicks.set(key, { segId: seg.id, song: click.time, when, kind: click.kind, handle });
      }
    }
  }

  /** Clicks a segment plays in song range `[lo, hi)`: count-in, loop pre-roll, metronome. */
  private clicksIn(seg: Segment, lo: number, hi: number): (BeatClick & { kind: ClickKind })[] {
    const out: (BeatClick & { kind: ClickKind })[] = [];
    let gridLo = lo;
    const ci = this.countIn;
    if (ci && seg.pass === ci.pass) {
      for (const c of ci.clicks) if (c.time >= lo && c.time < hi) out.push({ ...c, kind: 'count-in' });
      gridLo = Math.max(lo, ci.from);
    }
    const loop = this._loop;
    if (loop && seg.origin === 'loop-wrap' && gridLo < loop.start) {
      // Loop pre-roll always clicks (docs/timing.md: "1 bar of guide audio + click").
      for (const c of beatsInRange(this.song, gridLo, Math.min(hi, loop.start))) out.push({ ...c, kind: 'preroll' });
      gridLo = loop.start;
    }
    if (this.metronome) for (const c of beatsInRange(this.song, gridLo, hi)) out.push({ ...c, kind: 'grid' });
    return out;
  }

  /**
   * Re-anchor to a playing segment at `ctx` and schedule sources for it. `fresh` starts a new run
   * (new stretch even at an equal pass number). While counting in, the pass mapping covers song
   * times from the count-in target on only.
   */
  private startPlaying(
    ctx: number,
    songStart: number,
    pass: number,
    reason: ClockChangeReason | null,
    speed: number = this.playSpeed,
    closeSongEnd?: number,
    fresh = false,
  ): Segment {
    const ci = this.countIn;
    const coverStart = ci && ci.pass === pass ? Math.max(songStart, ci.from) : songStart;
    const init: SegmentInit = {
      songStart,
      speed,
      pass,
      bound: this.boundFor(songStart),
      reason: reason ?? 'seek',
      coverStart,
      newStretch: fresh,
    };
    const { created } = this.reanchor(ctx, init, reason, closeSongEnd);
    for (const s of this.sources) isolate(() => s.schedule(toPlaybackSegment(created)));
    return created;
  }

  /**
   * Re-anchor and cancel the clicks the new segment supersedes; emit `reason` if non-null, except
   * `loop-wrap`, which {@link announceWraps} emits once the wrap has begun.
   */
  private reanchor(ctx: number, init: SegmentInit, reason: ClockChangeReason | null, closeSongEnd?: number): ReanchorResult {
    const res = this.timeline.reanchor(ctx, init, closeSongEnd);
    const droppedIds = new Set(res.dropped.map((s) => s.id));
    const closed = res.closed;
    this.cancelClicks(
      (c) => droppedIds.has(c.segId) || (closed !== null && c.segId === closed.id && c.song >= segSongLimit(closed)),
    );
    if (reason && reason !== 'loop-wrap') this.emit(reason, res.created);
    return res;
  }

  /** Where a playing segment starting at `songStart` ends by itself. */
  private boundFor(songStart: number): SegmentBound | null {
    const loop = this._loop;
    if (loop && songStart < loop.end) return { kind: 'loop', song: loop.end };
    return Number.isFinite(this.song.durationSec) ? { kind: 'end', song: this.song.durationSec } : null;
  }

  /** A hold (speed 0) at `songStart`; it continues pass `pass` (a pause, a stop, a seek while idle). */
  private holdInit(songStart: number, reason: ClockChangeReason, pass: number): SegmentInit {
    return { songStart, speed: 0, pass, bound: null, reason };
  }

  /** Re-anchor time for changes while idle: now, but never before a pending (future) segment. */
  private idleReanchorTime(): number {
    return Math.max(this.host.now(), this.timeline.last.ctxStart);
  }

  /** Stop (sources too, one lead ahead when running) and hold at `pos`. */
  private goStopped(pos: number): void {
    const wasRunning = this.running;
    const t = wasRunning ? this.host.now() + this.lead : this.idleReanchorTime();
    this.countIn = null;
    this._state = 'stopped';
    if (wasRunning) this.stopSourcesAt(t);
    this.reanchor(t, this.holdInit(pos, 'stop', this.timeline.at(t).pass), 'stop');
  }

  private stopSourcesAt(ctx: number): void {
    for (const s of this.sources) isolate(() => s.stop(ctx));
  }

  private cancelClicks(pred: (c: ScheduledClick) => boolean): void {
    for (const [key, c] of this.clicks) {
      if (pred(c)) {
        c.handle.cancel();
        this.clicks.delete(key);
      }
    }
  }

  private clampSong(t: number): number {
    return Math.min(t, this.song.durationSec);
  }

  private anchorOf(seg: Segment): ClockAnchor {
    return { anchorCtxTime: seg.ctxStart, anchorSongTime: seg.songStart, speed: seg.speed };
  }

  /** Queue a change notification (delivered when the outermost operation completes). */
  private emit(reason: ClockChangeReason, seg: Segment): void {
    const change: ClockChange = { reason, anchor: this.anchorOf(seg), state: this._state, pass: seg.pass };
    this.pending.push(() => {
      for (const cb of [...this.changeListeners]) isolate(() => cb(change));
    });
  }

  /**
   * Run a control operation. Listeners are notified only after the outermost operation has finished,
   * so a listener that calls back into the transport never observes (or interrupts) a half-done change.
   */
  private op(fn: () => void): void {
    this.depth++;
    try {
      fn();
    } finally {
      this.depth--;
    }
    if (this.depth > 0) return;
    while (this.pending.length > 0) this.pending.shift()!();
  }
}
