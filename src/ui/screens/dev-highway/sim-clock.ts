/**
 * A stand-in song clock for the highway dev screen: `performance.now()` plays the role of the
 * AudioContext clock, so the renderer can be driven, sped up, looped and scrubbed without audio.
 * Implements the same {@link SongClock} contract as the engine; the screen calls {@link SimClock.tick}
 * once per frame to apply loop wraps and the end of the song (the renderer itself never advances time).
 * @module
 */
import type { ClockAnchor, ClockChange, ClockChangeReason, SongClock, TransportLoop, TransportState, Unsubscribe } from '@shared/clock';

/** Simulated transport + clock. */
export class SimClock implements SongClock {
  state: TransportState = 'paused';
  speed = 1;
  anchor: ClockAnchor = { anchorCtxTime: 0, anchorSongTime: 0, speed: 0 };
  loop: TransportLoop | null = null;
  /** Loop pass counter (increments on every wrap). */
  pass = 0;
  private readonly listeners = new Set<(c: ClockChange) => void>();

  constructor(private readonly duration: number) {}

  nowCtx(): number {
    return performance.now() / 1000;
  }

  songTimeAt(ctxTime: number): number {
    return this.anchor.anchorSongTime + (ctxTime - this.anchor.anchorCtxTime) * this.anchor.speed;
  }

  ctxTimeAt(songTime: number): number {
    const s = this.anchor.speed || this.speed;
    return this.anchor.anchorCtxTime + (songTime - this.anchor.anchorSongTime) / s;
  }

  nowSong(): number {
    return this.songTimeAt(this.nowCtx());
  }

  heardSongTime(perfNow: number = performance.now()): number {
    return this.songTimeAt(perfNow / 1000);
  }

  onChange(cb: (change: ClockChange) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  play(): void {
    if (this.state === 'playing') return;
    this.state = 'playing';
    this.reanchor('play', this.nowSong());
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.reanchor('pause', this.nowSong());
  }

  seek(songTime: number): void {
    this.reanchor('seek', Math.max(-2, Math.min(this.duration, songTime)));
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.reanchor('speed', this.nowSong());
  }

  setLoop(loop: TransportLoop | null): void {
    this.loop = loop;
  }

  /** Apply loop wraps and the end of the song at `perfNow` (called once per frame by the screen). */
  tick(perfNow: number): void {
    if (this.state !== 'playing') return;
    const t = this.heardSongTime(perfNow);
    if (this.loop && t >= this.loop.end) {
      this.pass++;
      this.reanchorAt('loop-wrap', this.loop.start - this.loop.preroll, perfNow / 1000);
    } else if (t >= this.duration) {
      this.reanchorAt('seek', -1, perfNow / 1000);
    }
  }

  private reanchor(reason: ClockChangeReason, songTime: number): void {
    this.reanchorAt(reason, songTime, this.nowCtx());
  }

  private reanchorAt(reason: ClockChangeReason, songTime: number, ctxTime: number): void {
    this.anchor = { anchorCtxTime: ctxTime, anchorSongTime: songTime, speed: this.state === 'playing' ? this.speed : 0 };
    const change: ClockChange = { reason, anchor: this.anchor, state: this.state, pass: this.pass };
    for (const cb of this.listeners) cb(change);
  }
}
