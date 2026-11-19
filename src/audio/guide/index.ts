/**
 * Guide synth + song worker client (T-021, D3, DEC-21). Signatures frozen by T-010.
 *
 * - {@link createSongLoader}: `loadSong` in a song worker (`song.worker.ts`), the same code the
 *   server indexes with.
 * - {@link createGuide}: the guide service. Its own song worker renders the arrangement offline with
 *   alphaSynth (`sonivox.sf2`, bundled via Vite `?url`) in 5 s chunks at `tempo × speed` (no pitch
 *   change); a {@link GuidePlayer} schedules the PCM on `engine.buses.guide` through
 *   `engine.registerScheduledSource`, so seeks, loop wraps and bar-aligned speed changes follow the
 *   transport (docs/timing.md).
 *
 * **Render plan.** A speed's audio is two renders: from the *priority bar* to the end first, then
 * from 0 up to that bar (cancelled once it gets there), so the whole song is synthesised once and
 * what is needed next is ready after one chunk. The priority bar is the loop's pre-roll start when
 * a loop is set (a 2-bar loop at 2:30 is playable after ~10 ms of rendering, not after rendering
 * 2:30 of audio), else the bar under the playhead. Loops, seeks and wraps then slice the rendered
 * audio; nothing is re-rendered until the speed changes. The current and the requested speed are
 * kept; older renders are dropped.
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import type { AudioEngine, GuideService, SongLoader } from '@shared/services';
import type { Song, SongBundle } from '@shared/song';
import { barAt } from '@core/model';
import { prerollBars } from '@core/practice';
import { type PcmChunk, type RenderHandle, SongWorkerClient, spawnSongWorker } from './client';
import { type GuidePiece, GuidePlayer, speedKey } from './player';
import { renderRateFor } from './rate';

export { CHUNK_SEC, SongWorkerClient, spawnSongWorker, type PcmChunk, type RenderHandle, type RenderParams, type WorkerLike } from './client';
export { FADE_SEC, GuidePlayer, LATE_LEAD_SEC, type GuidePiece, type GuidePlayerHost } from './player';

/** Song loader backed by a song worker. */
class WorkerSongLoader implements SongLoader {
  constructor(private readonly client: SongWorkerClient) {}
  load(bundle: SongBundle, arrangement: number): Promise<Song> {
    return this.client.load(bundle, arrangement);
  }
}

/** Song loader backed by the song worker (same `loadSong` as the server). */
export async function createSongLoader(): Promise<SongLoader> {
  return new WorkerSongLoader(new SongWorkerClient(spawnSongWorker()));
}

/** One speed's renders. */
interface RenderSet {
  speed: number;
  /**
   * Resolves when the priority render has its first chunk; rejects if it fails first or the set is
   * dropped ({@link GuideSupersededError}) before that.
   */
  ready: Promise<void>;
  jobs: RenderHandle[];
  pieces: GuidePiece[];
  /** Cancel the renders and reject a still-pending `ready`. */
  abort(): void;
}

/** `setSpeed`/`load` readiness rejected because the render was dropped (unload, newer speeds). */
export class GuideSupersededError extends Error {
  constructor() {
    super('Guide render superseded');
    this.name = 'GuideSupersededError';
  }
}

/** Options for {@link GuideImpl} (tests inject a client). */
export interface GuideOptions {
  /** Song worker client; default: a new worker owned (and terminated) by the guide. */
  client?: SongWorkerClient;
}

/** The guide service; see the module doc. Exported for tests; the app uses {@link createGuide}. */
export class GuideImpl implements GuideService {
  private readonly client: SongWorkerClient;
  private readonly ownsClient: boolean;
  private readonly player: GuidePlayer;
  private readonly sets = new Map<number, RenderSet>();
  private readonly progressListeners = new Set<(fraction: number) => void>();
  private readonly unsubs: Unsubscribe[] = [];
  private unregister: Unsubscribe | null = null;
  private song: Song | null = null;
  private target = 1;
  /** Bumped by `load`/`unload` so stale async work is ignored. */
  private generation = 0;

  constructor(
    private readonly engine: AudioEngine,
    opts: GuideOptions = {},
  ) {
    this.client = opts.client ?? new SongWorkerClient(spawnSongWorker());
    this.ownsClient = !opts.client;
    this.player = new GuidePlayer(engine.ctx, engine.buses.guide, {
      missing: (speed, songTime) => {
        if (this.song) this.ensure(speed, songTime);
      },
    });
    this.unsubs.push(engine.onContextChange((ctx) => this.player.reconnect(ctx, this.engine.buses.guide)));
  }

  get muted(): boolean {
    return this.player.muted;
  }

  /** Underlying player (diagnostics and tests). */
  get guidePlayer(): GuidePlayer {
    return this.player;
  }

  async load(song: Song, bundle: SongBundle, speed: number): Promise<void> {
    this.unload();
    const gen = this.generation;
    this.song = song;
    this.player.setDuration(song.meta.durationSec);
    await this.client.load(bundle, song.arrangement);
    if (gen !== this.generation) return;
    const ready = this.setSpeed(speed);
    // Registered while playing, the engine schedules us from now + 50 ms right away.
    this.unregister = this.engine.registerScheduledSource(this.player);
    try {
      await ready;
    } catch (err) {
      // A newer load/unload superseded this one: resolve quietly (callers that unload on any error
      // would tear down the newer load); callers that must know check {@link holds}.
      if (gen === this.generation) throw err;
    }
  }

  /**
   * True while `song` is the loaded song (its `load` was not superseded by a newer load or an
   * unload). A game session checks it after `load` resolves (R2-I-01).
   */
  holds(song: Song): boolean {
    return this.song === song;
  }

  setSpeed(speed: number): Promise<void> {
    if (!this.song) return Promise.reject(new Error('No guide song loaded'));
    this.target = speed;
    const set = this.ensure(speed, this.priorityTime(speed));
    this.emitProgress();
    return set.ready;
  }

  setMuted(muted: boolean): void {
    this.player.setMuted(muted);
  }

  onProgress(cb: (fraction: number) => void): Unsubscribe {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }

  unload(): void {
    this.generation++;
    this.unregister?.();
    this.unregister = null;
    for (const set of this.sets.values()) set.abort();
    this.sets.clear();
    this.player.clear();
    this.song = null;
  }

  /** Unload, disconnect and (when owned) terminate the worker. */
  dispose(): void {
    this.unload();
    for (const u of this.unsubs.splice(0)) u();
    this.player.dispose();
    this.progressListeners.clear();
    if (this.ownsClient) this.client.terminate();
  }

  /** Song time the next render should start at: the loop's pre-roll, else the playhead. */
  private priorityTime(speed: number): number {
    const song = this.song as Song;
    const loop = this.engine.transport.loop;
    if (loop && song.timing.bars.length > 0) {
      const bar = Math.max(0, barAt(song, loop.start + 1e-9) - prerollBars(speed));
      return song.timing.bars[bar]?.time ?? 0;
    }
    return Math.min(Math.max(this.engine.clock.nowSong(), 0), song.meta.durationSec);
  }

  /** The render set for `speed`, starting one at the bar containing `fromSec` if there is none. */
  private ensure(speed: number, fromSec: number): RenderSet {
    const key = speedKey(speed);
    const existing = this.sets.get(key);
    if (existing) return existing;
    this.evict();
    const song = this.song as Song;
    const bars = song.timing.bars;
    const start = bars.length > 0 ? (bars[barAt(song, fromSec + 1e-9)]?.time ?? 0) : 0;
    const gen = this.generation;
    const sampleRate = renderRateFor(this.engine.ctx.sampleRate);
    const jobs: RenderHandle[] = [];
    let settle: { resolve(): void; reject(err: unknown): void } = { resolve: () => undefined, reject: () => undefined };
    const ready = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    const set: RenderSet = {
      speed,
      ready,
      jobs,
      pieces: [],
      abort: () => {
        for (const job of jobs) job.cancel();
        settle.reject(new GuideSupersededError());
      },
    };
    ready.catch((err: unknown) => {
      if (err instanceof GuideSupersededError) return;
      console.error('Riffway: guide render failed', err);
      // Forget the failed render so the next request (setSpeed, or a segment at this speed) retries.
      if (this.sets.get(key) === set) {
        set.abort();
        this.sets.delete(key);
        this.player.dropSpeed(speed);
      }
    });

    const main = this.player.addPiece(speed, start, song.meta.durationSec);
    set.pieces.push(main);
    const mainJob = this.client.render({ speed, sampleRate, fromSec: start }, (c) => {
      if (gen !== this.generation) return;
      this.receive(set, main, c);
      settle.resolve();
    });
    mainJob.done.then(settle.resolve, settle.reject);
    jobs.push(mainJob);

    if (start > 0) {
      // The part before the priority bar, rendered after it and stopped once it gets there.
      const head = this.player.addPiece(speed, 0, start);
      set.pieces.push(head);
      const headJob = this.client.render({ speed, sampleRate, fromSec: 0 }, (c) => {
        if (gen !== this.generation) return;
        this.receive(set, head, c);
        if (head.renderedTo >= start) {
          headJob.cancel();
          this.player.completePiece(head);
        }
      });
      headJob.done.catch((err: unknown) => console.error('Riffway: guide render failed', err));
      jobs.push(headJob);
    }
    this.sets.set(key, set);
    return set;
  }

  private receive(set: RenderSet, piece: GuidePiece, c: PcmChunk): void {
    if (c.left.length > 0) {
      const buffer = new AudioBuffer({ numberOfChannels: 2, length: c.left.length, sampleRate: c.sampleRate });
      // Transferred from the worker, so backed by a plain ArrayBuffer.
      buffer.copyToChannel(c.left as Float32Array<ArrayBuffer>, 0);
      buffer.copyToChannel(c.right as Float32Array<ArrayBuffer>, 1);
      this.player.appendChunk(piece, buffer, c.startSec);
    }
    if (c.done) this.player.completePiece(piece);
    if (speedKey(set.speed) === speedKey(this.target)) this.emitProgress();
  }

  /** Drop renders of speeds that are neither playing nor requested. */
  private evict(): void {
    const playing = this.player.playingSpeed;
    for (const [key, set] of this.sets) {
      if (key === speedKey(this.target) || (playing !== null && key === speedKey(playing))) continue;
      set.abort();
      this.player.dropSpeed(set.speed);
      this.sets.delete(key);
    }
  }

  private emitProgress(): void {
    const song = this.song;
    const set = this.sets.get(speedKey(this.target));
    if (!song || !set || this.progressListeners.size === 0) return;
    let covered = 0;
    for (const p of set.pieces) covered += p.complete ? p.songTo - p.songFrom : Math.max(0, Math.min(p.renderedTo, p.songTo) - p.songFrom);
    const total = song.meta.durationSec;
    const fraction = total > 0 ? Math.min(1, covered / total) : 1;
    for (const cb of [...this.progressListeners]) cb(fraction);
  }
}

/**
 * Guide player on `engine.buses.guide`. `loader` is not used: the guide keeps its own worker
 * because the worker protocol is stateful (its current song) and the loader may load other songs
 * (song page previews) while the guide plays.
 */
export async function createGuide(engine: AudioEngine, loader: SongLoader): Promise<GuideService> {
  return new GuideImpl(engine);
}
