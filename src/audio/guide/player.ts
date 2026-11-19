/**
 * Guide player (T-021): plays rendered guide PCM on our `AudioContext` as an engine
 * {@link ScheduledSource} (docs/timing.md § Scheduling). Works on any `BaseAudioContext`, so tests
 * drive it on an `OfflineAudioContext`.
 *
 * Audio is held as **pieces**: one render at one speed covering song time `[songFrom, songTo)`,
 * made of chunk buffers that arrive while playback may already be running. A render at speed `s`
 * plays at rate 1 in real time: song time `t` of a segment sounds at
 * `ctxStart + (t − songStart) / s`. Loops, seeks and wraps are slices of the same pieces (no
 * re-render); `schedule(seg)` replaces everything from `seg.ctxStart` on.
 *
 * Every played slice is an `AudioBufferSourceNode` → `GainNode` voice → mute gain → destination.
 * Slices that start mid-stream fade in and slices cut short (loop B, re-anchor, stop) fade out over
 * {@link FADE_SEC}, so there are no clicks; a slice that starts where its render starts (a bar line
 * rendered from silence) or ends at the song end is not faded. Chunks that arrive after their
 * start time are joined in progress (fade-in at `now + LATE_LEAD_SEC`).
 * @module
 */
import type { PlaybackSegment, ScheduledSource } from '@shared/clock';

/** Fade length for cut slices, seconds. */
export const FADE_SEC = 0.003;
/** A late chunk starts this long after `currentTime`. */
export const LATE_LEAD_SEC = 0.01;
/** Time comparison slack, seconds. */
const EPS = 1e-7;
/** A voice cut within this long after its start is dropped instead of faded. */
const CUT_MIN_SEC = 1e-5;

/** One rendered chunk of a piece. */
interface Chunk {
  buffer: AudioBuffer;
  /** Song time of the first sample. */
  songStart: number;
  /** Song time after the last sample. */
  songEnd: number;
}

/** A render at one speed over `[songFrom, songTo)`. Returned by {@link GuidePlayer.addPiece}. */
export interface GuidePiece {
  readonly speed: number;
  /** Song time where the render starts (a bar line). */
  readonly songFrom: number;
  /** Song time where this piece stops being used (exclusive). */
  readonly songTo: number;
  /** Song time up to which audio has arrived. */
  readonly renderedTo: number;
  readonly complete: boolean;
}

class Piece implements GuidePiece {
  readonly chunks: Chunk[] = [];
  renderedTo: number;
  complete = false;
  constructor(
    readonly speed: number,
    readonly songFrom: number,
    readonly songTo: number,
  ) {
    this.renderedTo = songFrom;
  }
}

/** A planned stretch of one segment played from one piece. */
interface Span {
  piece: Piece;
  /** Segment mapping: song `t` sounds at `ctxStart + (t − songStart) / speed`. */
  ctxStart: number;
  songStart: number;
  speed: number;
  from: number;
  to: number;
  fadeIn: boolean;
  fadeOut: boolean;
  /** Indices of chunks already turned into voices. */
  realized: Set<number>;
}

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
  ctxStart: number;
  ctxEnd: number;
  /** End of the fade-in ramp (= `ctxStart` when not faded in). */
  fadeInEnd: number;
  /** Start of the fade-out ramp (= `ctxEnd` when not faded out). */
  fadeOutStart: number;
}

/** The voice's scheduled gain at ctx time `t` (linear fades, 1 in between). */
function gainAt(v: Voice, t: number): number {
  if (t <= v.ctxStart) return v.fadeInEnd > v.ctxStart ? 0 : 1;
  if (t < v.fadeInEnd) return (t - v.ctxStart) / (v.fadeInEnd - v.ctxStart);
  if (t > v.fadeOutStart) return Math.max(0, (v.ctxEnd - t) / (v.ctxEnd - v.fadeOutStart));
  return 1;
}

/** Callbacks into the owner (the guide service). */
export interface GuidePlayerHost {
  /** No piece exists for `speed` (the transport moved on without waiting for a render): start one at `songTime`. */
  missing(speed: number, songTime: number): void;
}

/** Speed values compare by key (transport speeds are the numbers it was given, but be safe). */
export function speedKey(speed: number): number {
  return Math.round(speed * 10000);
}

/** Plays guide pieces on a context; see the module doc. */
export class GuidePlayer implements ScheduledSource {
  readonly name = 'guide';
  private ctx: BaseAudioContext;
  private out: GainNode;
  private destination: AudioNode;
  private readonly pieces = new Map<number, Piece[]>();
  private spans: Span[] = [];
  private readonly voices = new Set<Voice>();
  private duration = 0;
  private _muted = false;
  private lastSpeed: number | null = null;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    private readonly host: GuidePlayerHost,
  ) {
    this.ctx = ctx;
    this.destination = destination;
    this.out = this.makeOut();
  }

  /** Song duration (s at 100%): nothing plays past it. */
  setDuration(durationSec: number): void {
    this.duration = Math.max(0, durationSec);
  }

  get muted(): boolean {
    return this._muted;
  }

  /** Mute/unmute (10 ms smoothing; never disconnects). */
  setMuted(muted: boolean): void {
    this._muted = muted;
    this.out.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.01);
  }

  /** Speed of the most recently scheduled segment (null before the first one). */
  get playingSpeed(): number | null {
    return this.lastSpeed;
  }

  /** Register a render covering `[songFrom, songTo)` at `speed`; chunks follow via {@link appendChunk}. */
  addPiece(speed: number, songFrom: number, songTo: number): GuidePiece {
    const piece = new Piece(speed, songFrom, songTo);
    const key = speedKey(speed);
    const list = this.pieces.get(key) ?? [];
    list.push(piece);
    this.pieces.set(key, list);
    return piece;
  }

  /** Pieces registered for `speed`. */
  piecesFor(speed: number): readonly GuidePiece[] {
    return this.pieces.get(speedKey(speed)) ?? [];
  }

  /**
   * Add the next chunk of `piece` (`songStart` = song time of its first sample) and play whatever
   * part of it already-planned spans need.
   */
  appendChunk(piece: GuidePiece, buffer: AudioBuffer, songStart: number): void {
    const p = piece as Piece;
    if (buffer.length === 0) return;
    const chunk: Chunk = { buffer, songStart, songEnd: songStart + buffer.duration * p.speed };
    p.chunks.push(chunk);
    p.renderedTo = Math.max(p.renderedTo, chunk.songEnd);
    const index = p.chunks.length - 1;
    for (const span of this.spans) if (span.piece === p) this.realize(span, index);
  }

  /** Mark `piece` fully rendered. */
  completePiece(piece: GuidePiece): void {
    (piece as Piece).complete = true;
  }

  /** Forget every piece of `speed` (voices already scheduled keep playing). */
  dropSpeed(speed: number): void {
    const list = this.pieces.get(speedKey(speed));
    if (!list) return;
    this.pieces.delete(speedKey(speed));
    this.spans = this.spans.filter((s) => !list.includes(s.piece));
  }

  /** {@link ScheduledSource.schedule}: replace everything from `seg.ctxStart` on. */
  schedule(seg: PlaybackSegment): void {
    this.truncate(seg.ctxStart);
    if (!(seg.speed > 0)) return;
    this.lastSpeed = seg.speed;
    const from = Math.max(seg.songStart, 0);
    const end = Math.min(seg.songEnd ?? Infinity, this.duration);
    if (end - from <= EPS) return;
    if (!this.pieces.has(speedKey(seg.speed))) this.host.missing(seg.speed, from);
    const pieces = this.pieces.get(speedKey(seg.speed));
    if (!pieces) return;

    let t = from;
    while (end - t > EPS) {
      const piece = pickPiece(pieces, t);
      if (!piece) {
        // A gap (should not happen: renders cover the song): skip to the next piece start.
        const next = Math.min(...pieces.map((p) => (p.songFrom > t + EPS ? p.songFrom : Infinity)));
        if (!Number.isFinite(next)) break;
        t = next;
        continue;
      }
      const to = Math.min(piece.songTo, end);
      const span: Span = {
        piece,
        ctxStart: seg.ctxStart,
        songStart: seg.songStart,
        speed: seg.speed,
        from: t,
        to,
        fadeIn: t > piece.songFrom + EPS,
        fadeOut: to < this.duration - EPS,
        realized: new Set(),
      };
      this.spans.push(span);
      for (let i = 0; i < piece.chunks.length; i++) this.realize(span, i);
      t = to;
    }
  }

  /** {@link ScheduledSource.stop}: silence everything from `when` (default now). */
  stop(when?: number): void {
    this.truncate(when ?? this.ctx.currentTime);
  }

  /** Move to a new context (sample-rate change): drops voices and plans; pieces are kept. */
  reconnect(ctx: BaseAudioContext, destination: AudioNode): void {
    for (const v of [...this.voices]) this.kill(v);
    this.spans = [];
    this.out.disconnect();
    this.ctx = ctx;
    this.destination = destination;
    this.out = this.makeOut();
  }

  /** Stop everything now and forget all pieces. */
  clear(): void {
    for (const v of [...this.voices]) this.kill(v);
    this.spans = [];
    this.pieces.clear();
    this.lastSpeed = null;
  }

  /** Disconnect from the destination. */
  dispose(): void {
    this.clear();
    this.out.disconnect();
  }

  /** Number of planned spans still able to receive chunks (diagnostics, tests). */
  get plannedSpans(): number {
    return this.spans.length;
  }

  /** Number of voices scheduled or playing (diagnostics, tests). */
  get activeVoices(): number {
    return this.voices.size;
  }

  private makeOut(): GainNode {
    const out = new GainNode(this.ctx, { gain: this._muted ? 0 : 1 });
    out.connect(this.destination);
    return out;
  }

  /** Cut every voice and span at ctx time `when` (clamped to now). */
  private truncate(when: number): void {
    const now = this.ctx.currentTime;
    const at = Math.max(when, now);
    for (const v of [...this.voices]) {
      if (v.ctxStart >= at - CUT_MIN_SEC) {
        this.kill(v);
      } else if (v.ctxEnd > at + EPS) {
        // Keep the envelope up to `fadeFrom` (ramping to its own value there), then fade to 0 at `at`.
        // Explicit ramps instead of `cancelAndHoldAtTime`: after a plain `setValueAtTime` Chrome
        // would start the new ramp at that event, not at the hold time.
        const fadeFrom = Math.max(at - FADE_SEC, now, v.ctxStart + CUT_MIN_SEC / 2);
        const g = v.gain.gain;
        g.cancelScheduledValues(fadeFrom);
        g.linearRampToValueAtTime(gainAt(v, fadeFrom), fadeFrom);
        g.linearRampToValueAtTime(0, at);
        v.src.stop(at);
        v.fadeOutStart = fadeFrom;
        v.ctxEnd = at;
      }
    }
    const kept: Span[] = [];
    for (const s of this.spans) {
      const cut = s.songStart + (at - s.ctxStart) * s.speed;
      if (cut <= s.from + EPS) continue;
      // Finished spans (earlier loop passes) are forgotten so the list stays short.
      if (s.ctxStart + (s.to - s.songStart) / s.speed <= now) continue;
      if (cut < s.to) {
        s.to = cut;
        s.fadeOut = true;
      }
      kept.push(s);
    }
    this.spans = kept;
  }

  /** Turn the part of chunk `index` that `span` needs into a voice (once). */
  private realize(span: Span, index: number): void {
    if (span.realized.has(index)) return;
    const chunk = span.piece.chunks[index];
    if (!chunk) return;
    let u = Math.max(span.from, chunk.songStart);
    const v = Math.min(span.to, chunk.songEnd);
    if (v - u <= EPS) return;
    span.realized.add(index);
    const ctxAt = (song: number): number => span.ctxStart + (song - span.songStart) / span.speed;
    let fadeIn = span.fadeIn && Math.abs(u - span.from) <= EPS;
    const fadeOut = span.fadeOut && Math.abs(v - span.to) <= EPS;
    let ctxU = ctxAt(u);
    const ctxV = ctxAt(v);
    const earliest = this.ctx.currentTime + LATE_LEAD_SEC;
    if (ctxU < earliest) {
      // Arrived late (or a re-anchor in progress): join mid-way.
      if (ctxV <= earliest + FADE_SEC) return;
      u += (earliest - ctxU) * span.speed;
      ctxU = earliest;
      fadeIn = true;
    }
    const src = new AudioBufferSourceNode(this.ctx, { buffer: chunk.buffer });
    const gain = new GainNode(this.ctx, { gain: fadeIn ? 0 : 1 });
    src.connect(gain).connect(this.out);
    const fade = Math.min(FADE_SEC, (ctxV - ctxU) / 2);
    // Always start with an event, so a later cut's ramps start from a known point.
    gain.gain.setValueAtTime(fadeIn ? 0 : 1, ctxU);
    if (fadeIn) gain.gain.linearRampToValueAtTime(1, ctxU + fade);
    if (fadeOut) {
      gain.gain.setValueAtTime(1, ctxV - fade);
      gain.gain.linearRampToValueAtTime(0, ctxV);
    }
    const voice: Voice = {
      src,
      gain,
      ctxStart: ctxU,
      ctxEnd: ctxV,
      fadeInEnd: fadeIn ? ctxU + fade : ctxU,
      fadeOutStart: fadeOut ? ctxV - fade : ctxV,
    };
    this.voices.add(voice);
    src.onended = () => this.release(voice);
    src.start(ctxU, (u - chunk.songStart) / span.speed, (v - u) / span.speed);
  }

  /** Silence a voice now (one that has not started yet never sounds). */
  private kill(v: Voice): void {
    v.src.stop();
    this.release(v);
  }

  private release(v: Voice): void {
    if (!this.voices.delete(v)) return;
    v.src.onended = null;
    v.src.disconnect();
    v.gain.disconnect();
  }
}

/** The piece that plays song time `t`: covering pieces first, the one with audio furthest ahead. */
function pickPiece(pieces: readonly Piece[], t: number): Piece | null {
  let best: Piece | null = null;
  for (const p of pieces) {
    if (p.songFrom > t + EPS || p.songTo <= t + EPS) continue;
    if (!best || p.renderedTo > best.renderedTo) best = p;
  }
  return best;
}
