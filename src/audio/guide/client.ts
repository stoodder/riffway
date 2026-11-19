/**
 * Main-thread client of the song worker (`song.worker.ts`): request/response correlation by
 * `reqId`, streamed render chunks, cancellation and error rehydration (`ImportError` keeps its code).
 * @module
 */
import type { SongWorkerRequest, SongWorkerResponse } from '@shared/audio-events';
import type { RhythmSidecar, Song, SongBundle } from '@shared/song';
import { ImportError, type ImportErrorCode } from '@core/import/errors';

/** Guide chunk length requested from the worker, seconds of rendered (real) time. */
export const CHUNK_SEC = 5;

/** One rendered chunk as received from the worker. */
export type PcmChunk = Extract<SongWorkerResponse, { type: 'pcm' }>;

/** What to render: the current song at `speed`, from the bar containing `fromSec` to the end. */
export interface RenderParams {
  speed: number;
  sampleRate: number;
  fromSec: number;
  /** Default {@link CHUNK_SEC}. */
  chunkSec?: number;
}

/** A running render. */
export interface RenderHandle {
  readonly reqId: number;
  /** Resolves after the last chunk; rejects on a worker error; never settles once cancelled. */
  readonly done: Promise<void>;
  /** Stop rendering; no further chunks are delivered. Idempotent. */
  cancel(): void;
}

/** The subset of `Worker` the client needs (tests may pass a fake). */
export interface WorkerLike {
  postMessage(message: SongWorkerRequest): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<SongWorkerResponse>) => void): void;
  addEventListener(type: 'error', listener: (ev: ErrorEvent) => void): void;
  terminate(): void;
}

interface Pending {
  resolve(song: Song): void;
  reject(err: Error): void;
}

interface Streaming {
  onChunk(chunk: PcmChunk): void;
  resolve(): void;
  reject(err: Error): void;
}

const IMPORT_CODES: ReadonlySet<string> = new Set<ImportErrorCode>(['unsupported', 'no-playable-track', 'bad-arrangement', 'syntax', 'empty', 'internal']);

function rehydrate(message: string, code?: string): Error {
  return code !== undefined && IMPORT_CODES.has(code) ? new ImportError(code as ImportErrorCode, message) : new Error(message);
}

/** Spawn the song worker (Vite bundles it as an ES module worker). */
export function spawnSongWorker(): Worker {
  return new Worker(new URL('./song.worker.ts', import.meta.url), { type: 'module', name: 'riffway-song' });
}

/** Typed RPC over one song worker. */
export class SongWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly renders = new Map<number, Streaming>();
  private closed = false;

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener('message', (ev) => this.onMessage(ev.data));
    worker.addEventListener('error', (ev) => this.failAll(new Error(`Song worker failed: ${ev.message || 'unknown error'}`)));
  }

  /** Parse a bundle with `loadSong` in the worker; the song becomes the worker's current song. The bundle is copied, not transferred. */
  load(bundle: SongBundle, arrangement: number): Promise<Song> {
    return this.request((reqId) => ({ type: 'load', reqId, bundle, arrangement }));
  }

  /** Re-import the worker's current (ASCII) song with a rhythm sidecar. */
  applySidecar(sidecar: RhythmSidecar): Promise<Song> {
    return this.request((reqId) => ({ type: 'apply-sidecar', reqId, sidecar }));
  }

  /** Render the current song; `onChunk` gets every chunk in order (the last has `done: true`). */
  render(params: RenderParams, onChunk: (chunk: PcmChunk) => void): RenderHandle {
    const reqId = this.nextId++;
    let cancelled = false;
    const done = new Promise<void>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('Song worker is closed'));
        return;
      }
      this.renders.set(reqId, { onChunk, resolve, reject });
    });
    // Callers that never await `done` must not see unhandled rejections.
    done.catch(() => undefined);
    if (!this.closed) {
      const { speed, sampleRate, fromSec, chunkSec = CHUNK_SEC } = params;
      this.worker.postMessage({ type: 'render', reqId, speed, sampleRate, fromSec, chunkSec });
    }
    return {
      reqId,
      done,
      cancel: () => {
        if (cancelled || !this.renders.delete(reqId)) return;
        cancelled = true;
        this.worker.postMessage({ type: 'cancel', reqId });
      },
    };
  }

  /** Terminate the worker; pending requests reject. */
  terminate(): void {
    if (this.closed) return;
    this.failAll(new Error('Song worker terminated'));
    this.closed = true;
    this.worker.terminate();
  }

  private request(make: (reqId: number) => SongWorkerRequest): Promise<Song> {
    if (this.closed) return Promise.reject(new Error('Song worker is closed'));
    const reqId = this.nextId++;
    return new Promise<Song>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.worker.postMessage(make(reqId));
    });
  }

  private onMessage(msg: SongWorkerResponse): void {
    switch (msg.type) {
      case 'song': {
        const p = this.pending.get(msg.reqId);
        this.pending.delete(msg.reqId);
        p?.resolve(msg.song);
        return;
      }
      case 'pcm': {
        const r = this.renders.get(msg.reqId);
        if (!r) return;
        if (msg.done) this.renders.delete(msg.reqId);
        r.onChunk(msg);
        if (msg.done) r.resolve();
        return;
      }
      case 'error': {
        const err = rehydrate(msg.message, msg.code);
        const p = this.pending.get(msg.reqId);
        if (p) {
          this.pending.delete(msg.reqId);
          p.reject(err);
          return;
        }
        const r = this.renders.get(msg.reqId);
        this.renders.delete(msg.reqId);
        r?.reject(err);
        return;
      }
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    for (const r of this.renders.values()) r.reject(err);
    this.pending.clear();
    this.renders.clear();
  }
}
