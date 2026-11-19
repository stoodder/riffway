/**
 * Guide service render plan (T-021) with a scripted song worker: priority/head renders, the head
 * render's cancellation at its bar, eviction of stale speeds, retry after a failed render and
 * superseded readiness on unload. The engine is a minimal stand-in on an `OfflineAudioContext`.
 */
import { describe, expect, it } from 'vitest';
import type { SongWorkerRequest, SongWorkerResponse } from '@shared/audio-events';
import type { ScheduledSource, TransportLoop } from '@shared/clock';
import type { AudioEngine } from '@shared/services';
import type { Song } from '@shared/song';
import { GuideImpl, GuideSupersededError, SongWorkerClient, type WorkerLike } from '../../src/audio/guide';

const SR = 48000;
const BAR = 2;
const BARS = 10;

function makeSong(): Song {
  const bars = Array.from({ length: BARS }, (_, i) => ({ index: i, time: i * BAR, dur: BAR, num: 4, den: 4, beats: [0, 0.5, 1, 1.5].map((b) => i * BAR + b) }));
  return {
    schema: 1,
    id: 'local:plan',
    arrangement: 0,
    meta: {
      title: 'Plan',
      source: { source: 'local' },
      tags: { style: ['pick'], genre: [], skills: [] },
      tuning: [64, 59, 55, 50, 45, 40],
      capo: 0,
      durationSec: BARS * BAR,
      rhythm: 'exact',
      tracks: [],
    },
    timing: { tempos: [{ time: 0, bpm: 120 }], bars },
    sections: [],
    notes: [],
    chords: [],
  };
}

/** Scripted worker: answers `load`, streams `chunkSec` chunks for renders (or fails them). */
class ScriptedWorker implements WorkerLike {
  readonly requests: SongWorkerRequest[] = [];
  failRenders = false;
  private listener: ((ev: MessageEvent<SongWorkerResponse>) => void) | null = null;
  private readonly cancelled = new Set<number>();
  constructor(private readonly song: Song) {}

  postMessage(message: SongWorkerRequest): void {
    this.requests.push(message);
    if (message.type === 'cancel') this.cancelled.add(message.reqId);
    queueMicrotask(() => void this.answer(message));
  }
  addEventListener(type: 'message' | 'error', listener: ((ev: MessageEvent<SongWorkerResponse>) => void) | ((ev: ErrorEvent) => void)): void {
    if (type === 'message') this.listener = listener as (ev: MessageEvent<SongWorkerResponse>) => void;
  }
  terminate(): void {}

  renders(): Extract<SongWorkerRequest, { type: 'render' }>[] {
    return this.requests.filter((r): r is Extract<SongWorkerRequest, { type: 'render' }> => r.type === 'render');
  }

  private send(msg: SongWorkerResponse): void {
    this.listener?.({ data: msg } as MessageEvent<SongWorkerResponse>);
  }

  private async answer(req: SongWorkerRequest): Promise<void> {
    if (req.type === 'load') this.send({ type: 'song', reqId: req.reqId, song: this.song });
    if (req.type !== 'render') return;
    if (this.failRenders) {
      this.send({ type: 'error', reqId: req.reqId, message: 'synth exploded' });
      return;
    }
    const start = Math.floor(req.fromSec / BAR) * BAR;
    const len = Math.round(req.chunkSec * SR);
    let t = start;
    for (let i = 0; t < this.song.meta.durationSec; i++) {
      if (this.cancelled.has(req.reqId)) return;
      const n = Math.min(len, Math.round(((this.song.meta.durationSec - t) / req.speed) * SR));
      this.send({ type: 'pcm', reqId: req.reqId, index: i, startSec: t, sampleRate: SR, speed: req.speed, left: new Float32Array(n), right: new Float32Array(n), done: false });
      t += (n / SR) * req.speed;
      await new Promise((r) => setTimeout(r, 0));
    }
    this.send({ type: 'pcm', reqId: req.reqId, index: -1, startSec: t, sampleRate: SR, speed: req.speed, left: new Float32Array(0), right: new Float32Array(0), done: true });
  }
}

interface FakeEngine {
  engine: AudioEngine;
  sources: ScheduledSource[];
  setLoop(loop: TransportLoop | null): void;
  setNow(song: number): void;
}

function fakeEngine(): FakeEngine {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR, sampleRate: SR });
  const guide = new GainNode(ctx);
  const sources: ScheduledSource[] = [];
  let loop: TransportLoop | null = null;
  let now = 0;
  const engine = {
    ctx,
    buses: { guide },
    transport: {
      get loop() {
        return loop;
      },
    },
    clock: { nowSong: () => now },
    registerScheduledSource: (s: ScheduledSource) => {
      sources.push(s);
      return () => sources.splice(sources.indexOf(s), 1);
    },
    onContextChange: () => () => undefined,
  } as unknown as AudioEngine;
  return { engine, sources, setLoop: (l) => (loop = l), setNow: (t) => (now = t) };
}

function setup(): { guide: GuideImpl; worker: ScriptedWorker; fake: FakeEngine; song: Song } {
  const song = makeSong();
  const worker = new ScriptedWorker(song);
  const fake = fakeEngine();
  const guide = new GuideImpl(fake.engine, { client: new SongWorkerClient(worker) });
  return { guide, worker, fake, song };
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('guide service render plan', () => {
  it('load renders from the playhead bar first, then the head up to it, and registers with the engine', async () => {
    const { guide, worker, fake } = setup();
    fake.setNow(7.3);
    await guide.load(makeSong(), { fileName: 'plan.atex', data: new Uint8Array(1) }, 1);
    expect(fake.sources).toEqual([guide.guidePlayer]);
    expect(worker.renders().map((r) => [r.fromSec, r.speed, r.sampleRate, r.chunkSec])).toEqual([
      [6, 1, SR, 5],
      [0, 1, SR, 5],
    ]);
    await settle();
    const [main, head] = guide.guidePlayer.piecesFor(1);
    expect([main!.songFrom, main!.songTo, main!.complete]).toEqual([6, 20, true]);
    expect([head!.songFrom, head!.songTo, head!.complete]).toEqual([0, 6, true]);
    // The head render was cancelled once it reached bar 3 (it renders 5 s chunks: 0–5, 5–10).
    expect(worker.requests.some((r) => r.type === 'cancel' && r.reqId === worker.renders()[1]!.reqId)).toBe(true);
    guide.dispose();
    expect(fake.sources).toEqual([]);
  });

  it('a speed change with a loop renders from the loop pre-roll (2 bars below 60%)', async () => {
    const { guide, worker, fake } = setup();
    await guide.load(makeSong(), { fileName: 'plan.atex', data: new Uint8Array(1) }, 1);
    fake.setLoop({ start: 12, end: 16, preroll: 2 });
    await guide.setSpeed(0.5);
    expect(worker.renders().filter((r) => r.speed === 0.5).map((r) => r.fromSec)).toEqual([8, 0]);
    await guide.setSpeed(0.8);
    expect(worker.renders().filter((r) => r.speed === 0.8).map((r) => r.fromSec)).toEqual([10, 0]);
    guide.dispose();
  });

  it('reuses a rendered speed and evicts speeds that are neither playing nor requested', async () => {
    const { guide, worker } = setup();
    await guide.load(makeSong(), { fileName: 'plan.atex', data: new Uint8Array(1) }, 1);
    guide.guidePlayer.schedule({ ctxStart: 0, songStart: 0, speed: 1, pass: 0 });
    await guide.setSpeed(0.5);
    await guide.setSpeed(0.7);
    // 1 is playing, 0.7 requested: 0.5 is dropped.
    expect(guide.guidePlayer.piecesFor(0.5)).toEqual([]);
    expect(guide.guidePlayer.piecesFor(1).length).toBeGreaterThan(0);
    const before = worker.renders().length;
    await guide.setSpeed(1);
    expect(worker.renders().length).toBe(before);
    guide.dispose();
  });

  it('reports monotonic progress up to 1 for the requested speed', async () => {
    const { guide } = setup();
    const progress: number[] = [];
    guide.onProgress((f) => progress.push(f));
    await guide.load(makeSong(), { fileName: 'plan.atex', data: new Uint8Array(1) }, 0.5);
    await settle(100);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]!)).toBe(true);
    guide.dispose();
  });

  it('a failed render rejects readiness and is retried on the next request', async () => {
    const { guide, worker } = setup();
    await guide.load(makeSong(), { fileName: 'plan.atex', data: new Uint8Array(1) }, 1);
    worker.failRenders = true;
    await expect(guide.setSpeed(0.6)).rejects.toThrow('synth exploded');
    worker.failRenders = false;
    await expect(guide.setSpeed(0.6)).resolves.toBeUndefined();
    expect(worker.renders().filter((r) => r.speed === 0.6)).toHaveLength(2);
    guide.dispose();
  });

  it('unload supersedes pending readiness and stops listening to the engine', async () => {
    const { guide, fake } = setup();
    await guide.load(makeSong(), { fileName: 'plan.atex', data: new Uint8Array(1) }, 1);
    const pending = guide.setSpeed(0.45);
    guide.unload();
    await expect(pending).rejects.toBeInstanceOf(GuideSupersededError);
    expect(fake.sources).toEqual([]);
    await expect(guide.setSpeed(1)).rejects.toThrow(/No guide song/);
    // A load superseded by another load (or an unload) resolves quietly; `holds` tells (R2-I-01).
    const songA = makeSong();
    const songB = makeSong();
    const first = guide.load(songA, { fileName: 'plan.atex', data: new Uint8Array(1) }, 1);
    const second = guide.load(songB, { fileName: 'plan.atex', data: new Uint8Array(1) }, 1);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(guide.holds(songA)).toBe(false);
    expect(guide.holds(songB)).toBe(true);
    const third = guide.load(songA, { fileName: 'plan.atex', data: new Uint8Array(1) }, 1);
    guide.unload();
    await expect(third).resolves.toBeUndefined();
    expect(guide.holds(songA)).toBe(false);
    guide.dispose();
  });
});
