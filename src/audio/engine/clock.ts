/**
 * The song clock (D5, docs/timing.md § Clock model). Pure and DOM-free so it is testable in Node
 * with a fake clock.
 *
 * Playback is a list of **segments**; each one is an anchor `{ctxStart, songStart, speed}` that holds
 * from its `ctxStart` until the next segment's:
 * `songTime = (ctxTime − ctxStart) × speed + songStart` (speed 0 = paused/stopped).
 * Re-anchors (play, seek, speed, loop wrap) append a segment at a *future* context time, so the
 * mapping at any context time, past or scheduled, is exact. A little history is kept so the judge
 * can map song times of the previous loop pass after a wrap.
 *
 * Consecutive segments of one pass form a **stretch** (a pause/resume or speed change continues it; a
 * wrap, seek or fresh play starts a new one). {@link SegmentTimeline.ctxTimeInPass} maps song times
 * within the newest stretch of a pass, which is what the judge needs (docs/timing.md § Passes).
 * @module
 */
import type {
  ClockAnchor,
  ClockChange,
  ClockChangeReason,
  PlaybackSegment,
  SongClock,
  TransportState,
  Unsubscribe,
} from '@shared/clock';
import type { PassClockMapping } from '@core/judge';

/** Why a playing segment ends on its own: at loop B (wrap) or at the end of the song. */
export type SegmentBound = { kind: 'loop' | 'end'; song: number };

/** One anchored stretch of the transport timeline. */
export interface Segment {
  /** Unique, increasing id (keys scheduled clicks). */
  readonly id: number;
  readonly ctxStart: number;
  readonly songStart: number;
  /** 0 while paused/stopped. */
  readonly speed: number;
  /** Loop pass (0 = first pass; +1 on every loop wrap, seek or jump). */
  readonly pass: number;
  /** Stretch id: increases whenever a segment does not continue its predecessor's pass. */
  readonly stretch: number;
  /** Reason of the first segment of this stretch (`'loop-wrap'` for a wrapped pass). */
  readonly origin: ClockChangeReason;
  /**
   * First song time this segment *covers* for the pass mapping: `songStart`, or the count-in target
   * for a count-in segment (song times played as count-in are not part of the pass).
   */
  readonly coverStart: number;
  /** Where a playing segment ends unless re-anchored earlier; null for holds or unbounded play. */
  readonly bound: SegmentBound | null;
  /** Re-anchor reason that created it. */
  readonly reason: ClockChangeReason;
  /** Context time where the next segment takes over (null while this is the last segment). */
  ctxEnd: number | null;
  /** Song time at `ctxEnd`, exact (bar line or loop B when the change was aligned to one). */
  songEnd: number | null;
}

/** Song time of `seg` at context time `ctx` (linear extrapolation). */
export function segSong(seg: Segment, ctx: number): number {
  return seg.songStart + (ctx - seg.ctxStart) * seg.speed;
}

/** Context time at which a playing `seg` reaches `song`. */
export function segCtx(seg: Segment, song: number): number {
  return seg.ctxStart + (song - seg.songStart) / seg.speed;
}

/** Exclusive song-time end of what `seg` plays (its successor's start, else its bound). */
export function segSongLimit(seg: Segment): number {
  return seg.songEnd ?? seg.bound?.song ?? Infinity;
}

/** Exclusive context-time end of `seg` (successor start, else bound, else ∞). */
export function segCtxLimit(seg: Segment): number {
  if (seg.ctxEnd !== null) return seg.ctxEnd;
  if (seg.speed > 0 && seg.bound) return segCtx(seg, seg.bound.song);
  return Infinity;
}

/** The {@link PlaybackSegment} handed to scheduled sources, starting at `ctxStart` (≥ seg start). */
export function toPlaybackSegment(seg: Segment, ctxStart: number = seg.ctxStart): PlaybackSegment {
  const out: PlaybackSegment = {
    ctxStart,
    songStart: ctxStart === seg.ctxStart ? seg.songStart : segSong(seg, ctxStart),
    speed: seg.speed,
    pass: seg.pass,
  };
  const songEnd = segSongLimit(seg);
  if (Number.isFinite(songEnd)) {
    out.songEnd = songEnd;
    out.ctxEnd = seg.ctxEnd ?? segCtx(seg, songEnd);
  }
  return out;
}

/** What a new segment looks like (the timeline assigns id and stretch and closes its predecessor). */
export interface SegmentInit {
  songStart: number;
  speed: number;
  pass: number;
  bound: SegmentBound | null;
  reason: ClockChangeReason;
  /** See {@link Segment.coverStart} (default `songStart`). */
  coverStart?: number;
  /** Start a new stretch even if the pass number equals the predecessor's (a fresh run). */
  newStretch?: boolean;
}

/** Result of {@link SegmentTimeline.reanchor}. */
export interface ReanchorResult {
  created: Segment;
  /** Segment that now ends at the re-anchor time (null if the new segment replaced the first one). */
  closed: Segment | null;
  /** Future segments that were discarded (they started at or after the re-anchor time). */
  dropped: Segment[];
}

/** Ordered segment list with exact ctx ↔ song mapping. */
export class SegmentTimeline {
  private segs: Segment[];
  private nextId = 1;
  private nextStretch = 1;

  /** Starts with a stopped hold at song time 0. */
  constructor(ctxNow: number) {
    this.segs = [this.make(ctxNow, { songStart: 0, speed: 0, pass: 0, bound: null, reason: 'stop' }, null)];
  }

  /** All retained segments, oldest first. */
  get segments(): readonly Segment[] {
    return this.segs;
  }

  /** The newest segment (possibly starting in the future). */
  get last(): Segment {
    return this.segs[this.segs.length - 1]!;
  }

  /** Segment in effect at `ctx` (the last one starting at or before it; the oldest if none). */
  at(ctx: number): Segment {
    for (let i = this.segs.length - 1; i > 0; i--) if (this.segs[i]!.ctxStart <= ctx) return this.segs[i]!;
    return this.segs[0]!;
  }

  /** Song time at a context time. A playing segment that has run past its bound holds at the bound. */
  songTimeAt(ctx: number): number {
    const seg = this.at(ctx);
    const song = segSong(seg, ctx);
    return seg.bound && seg.ctxEnd === null ? Math.min(song, seg.bound.song) : song;
  }

  /**
   * Context time at which `song` is played. Among retained playing segments whose song range contains
   * it, the occurrence nearest to `nowCtx` wins: right after a loop wrap, a song time near B maps to
   * the pass that just ended; right before it, a time near A maps to the coming pass. Otherwise the
   * mapping of the segment in effect at `nowCtx` is extrapolated (`idleSpeed` while paused).
   */
  ctxTimeAt(song: number, nowCtx: number, idleSpeed: number): number {
    let best = NaN;
    for (const seg of this.segs) {
      if (seg.speed <= 0 || song < seg.songStart || song >= segSongLimit(seg)) continue;
      const ctx = segCtx(seg, song);
      if (Number.isNaN(best) || Math.abs(ctx - nowCtx) < Math.abs(best - nowCtx)) best = ctx;
    }
    if (!Number.isNaN(best)) return best;
    const cur = this.at(nowCtx);
    if (cur.speed > 0) return segCtx(cur, song);
    return Math.max(nowCtx, cur.ctxStart) + (song - cur.songStart) / idleSpeed;
  }

  /**
   * Context time at which `song` is played **in pass `pass`** (the newest stretch with that number):
   * - finite: the playing segment of that stretch whose covered range `[coverStart, end)` contains it
   *   (the oldest one, so a count-in replay after a pause never moves a time already played);
   * - `-Infinity`: the pass will never play it (the pass is over, or the time lies before its start);
   * - `NaN`: not known (yet): the pass is unknown, not playing yet or no longer retained (history),
   *   paused or stopped before reaching it, or it lies past the current bound.
   */
  ctxTimeInPass(song: number, pass: number): number {
    let stretch = -1;
    for (let i = this.segs.length - 1; i >= 0; i--) {
      if (this.segs[i]!.pass === pass) {
        stretch = this.segs[i]!.stretch;
        break;
      }
    }
    if (stretch < 0) return NaN;
    let minCover = Infinity;
    for (const seg of this.segs) {
      if (seg.stretch !== stretch || seg.speed <= 0) continue;
      minCover = Math.min(minCover, seg.coverStart);
      if (song >= seg.coverStart && song < segSongLimit(seg)) return segCtx(seg, song);
    }
    if (minCover === Infinity) return NaN; // nothing played yet in this pass (or no longer retained)
    if (this.last.stretch !== stretch || song < minCover) return -Infinity;
    return NaN;
  }

  /**
   * Start a new segment at context time `ctx`: segments starting at or after `ctx` are dropped, the
   * one before is closed at `ctx` with song end `closeSongEnd` (default: its own mapping at `ctx`).
   */
  reanchor(ctx: number, init: SegmentInit, closeSongEnd?: number): ReanchorResult {
    let firstDropped = this.segs.findIndex((s) => s.ctxStart >= ctx);
    if (firstDropped === 0) firstDropped = 1; // keep one segment as history/base
    const dropped = firstDropped < 0 ? [] : this.segs.splice(firstDropped);
    let closed: Segment | null = this.last;
    if (closed.ctxStart >= ctx) {
      // Replacing the only (not yet started) segment.
      this.segs.pop();
      dropped.unshift(closed);
      closed = null;
    } else {
      closed.ctxEnd = ctx;
      closed.songEnd = closeSongEnd ?? segSong(closed, ctx);
    }
    const created = this.make(ctx, init, closed);
    this.segs.push(created);
    return { created, closed, dropped };
  }

  /** Replace everything with a single hold in pass `pass` (context recreated). */
  reset(ctxNow: number, songStart: number, reason: ClockChangeReason, pass = 0): Segment {
    this.segs = [this.make(ctxNow, { songStart, speed: 0, pass, bound: null, reason }, null)];
    return this.segs[0]!;
  }

  /** Forget segments that ended more than `keepSec` before `nowCtx` (the current one is always kept). */
  prune(nowCtx: number, keepSec: number): void {
    let n = 0;
    while (n < this.segs.length - 1 && (this.segs[n]!.ctxEnd ?? Infinity) < nowCtx - keepSec) n++;
    if (n > 0) this.segs.splice(0, n);
  }

  /** A new segment continuing `prev`'s stretch when it keeps its pass (and is not a fresh run). */
  private make(ctxStart: number, init: SegmentInit, prev: Segment | null): Segment {
    const { coverStart, newStretch, ...rest } = init;
    const continues = prev !== null && !newStretch && prev.pass === init.pass;
    return {
      id: this.nextId++,
      ctxStart,
      ...rest,
      stretch: continues ? prev.stretch : this.nextStretch++,
      origin: continues ? prev.origin : init.reason,
      coverStart: coverStart ?? init.songStart,
      ctxEnd: null,
      songEnd: null,
    };
  }
}

/** Output-side time sources (an `AudioContext` + `performance`), injectable for tests. */
export interface OutputClock {
  /** `ctx.currentTime`. */
  now(): number;
  /** `ctx.getOutputTimestamp()`, or null where unavailable (OfflineAudioContext, not running). */
  outputTimestamp(): { contextTime: number; performanceTime: number } | null;
  /** `performance.now()`. */
  perfNow(): number;
  /** Seconds between scheduling and hearing (`baseLatency + outputLatency`), for the fallback. */
  outputDelay(): number;
}

/** Output timestamps older than this (ms) are not extrapolated (stale; e.g. context suspended). */
const MAX_TIMESTAMP_AGE_MS = 1000;

/**
 * Context time of the sample being **heard** at `perfNowMs` (a `performance.now()` value):
 * `contextTime + (perfNow − performanceTime)/1000` from `getOutputTimestamp()`; without a usable
 * timestamp, `currentTime − outputDelay` shifted by the age of `perfNowMs`.
 */
export function heardCtxTime(out: OutputClock, perfNowMs: number): number {
  const ts = out.outputTimestamp();
  if (ts && ts.performanceTime > 0) {
    const ageMs = perfNowMs - ts.performanceTime;
    if (ageMs > -MAX_TIMESTAMP_AGE_MS && ageMs < MAX_TIMESTAMP_AGE_MS) return ts.contextTime + ageMs / 1000;
  }
  return out.now() - out.outputDelay() - (out.perfNow() - perfNowMs) / 1000;
}

/** What the {@link SongClock} adapter reads from the transport. */
export interface ClockSource {
  readonly state: TransportState;
  readonly speed: number;
  readonly anchor: Readonly<ClockAnchor>;
  songTimeAt(ctxTime: number): number;
  ctxTimeAt(songTime: number): number;
  /** Pass-aware mapping (see {@link SegmentTimeline.ctxTimeInPass}). */
  ctxTimeInPass(songTime: number, pass: number): number;
  /** Speed of the segment in effect at `ctxTime` (0 while paused). */
  speedAt(ctxTime: number): number;
  onChange(cb: (change: ClockChange) => void): Unsubscribe;
}

/**
 * The read-only {@link SongClock}. `heardSongTime(perfNow)` =
 * `songTimeAt(heardCtxTime(perfNow)) − visualOffset × speed` (docs/timing.md § Rendering time).
 * It is also a {@link PassClockMapping}, so the judge resolves note times per loop pass.
 */
export function createSongClock(src: ClockSource, out: OutputClock, visualOffsetMs: () => number): SongClock & PassClockMapping {
  return {
    get state() {
      return src.state;
    },
    get speed() {
      return src.speed;
    },
    get anchor() {
      return src.anchor;
    },
    songTimeAt: (ctxTime) => src.songTimeAt(ctxTime),
    ctxTimeAt: (songTime) => src.ctxTimeAt(songTime),
    ctxTimeInPass: (songTime, pass) => src.ctxTimeInPass(songTime, pass),
    nowCtx: () => out.now(),
    nowSong: () => src.songTimeAt(out.now()),
    heardSongTime(perfNow = out.perfNow()) {
      const ctx = heardCtxTime(out, perfNow);
      return src.songTimeAt(ctx) - (visualOffsetMs() / 1000) * src.speedAt(ctx);
    },
    onChange: (cb) => src.onChange(cb),
  };
}
