/**
 * Song worker protocol (T-021) in Node: `song.worker.ts` runs in-process behind a fake `Worker`
 * (its `self` and `fetch` stubbed) and is driven through {@link SongWorkerClient}: load, render
 * chunks with song-time stamps, cancellation, sidecar re-import and error codes.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SongWorkerRequest, SongWorkerResponse } from '@shared/audio-events';
import type { RhythmSidecar } from '@shared/song';
import { isImportError } from '@core/import/errors';
import { type PcmChunk, SongWorkerClient, type WorkerLike } from '../../src/audio/guide/client';
import { ISOLATED_TEX, texBundle } from './fixtures';

const require = createRequire(import.meta.url);
const SF2 = readFileSync(require.resolve('@coderline/alphatab/soundfont/sonivox.sf2'));
const SR = 48000;

type Listener = (ev: MessageEvent) => void;
const toWorker: Listener[] = [];
const toMain: Listener[] = [];
const posted: SongWorkerRequest[] = [];

/** In-process stand-in for `new Worker(song.worker.ts)`. */
const fakeWorker: WorkerLike = {
  postMessage(message: SongWorkerRequest) {
    posted.push(message);
    const data = structuredClone(message);
    queueMicrotask(() => toWorker.forEach((l) => l({ data } as MessageEvent)));
  },
  addEventListener(type: 'message' | 'error', listener: Listener | ((ev: ErrorEvent) => void)) {
    if (type === 'message') toMain.push(listener as Listener);
  },
  terminate() {},
};

let client: SongWorkerClient;

beforeAll(async () => {
  vi.stubGlobal('self', {
    // Transfer like a real worker: the sender's buffers are detached afterwards.
    postMessage: (msg: SongWorkerResponse, transfer: Transferable[] = []) => {
      const data = structuredClone(msg, { transfer: transfer as Transferable[] });
      toMain.forEach((l) => l({ data } as MessageEvent));
    },
    addEventListener: (_type: 'message', l: Listener) => toWorker.push(l),
  });
  vi.stubGlobal('fetch', async (url: string) => {
    expect(String(url)).toMatch(/sonivox\.sf2/);
    return new Response(SF2);
  });
  await import('../../src/audio/guide/song.worker');
  client = new SongWorkerClient(fakeWorker);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function collect(fromSec: number, speed: number, chunkSec = 1): { chunks: PcmChunk[]; done: Promise<void> } {
  const chunks: PcmChunk[] = [];
  const h = client.render({ speed, sampleRate: SR, fromSec, chunkSec }, (c) => chunks.push(c));
  return { chunks, done: h.done };
}

describe('song worker', () => {
  it('loads a song with loadSong', async () => {
    const song = await client.load(texBundle(ISOLATED_TEX), 0);
    expect(song.notes).toHaveLength(9);
    expect(song.meta.rhythm).toBe('exact');
  });

  it('renders from the bar containing fromSec, stamping each chunk with its song time', async () => {
    const song = await client.load(texBundle(ISOLATED_TEX), 0);
    const bar = song.timing.bars[2]!;
    const speed = 0.5;
    const { chunks, done } = collect(bar.time + 0.3, speed);
    await done;
    // Full 1 s chunks, a shorter last one, then an empty `done` marker.
    expect(chunks.at(-1)).toMatchObject({ done: true, left: new Float32Array(0) });
    expect(chunks.slice(0, -2).every((c) => !c.done && c.left.length === SR && c.right.length === SR)).toBe(true);
    expect(chunks[0]?.startSec).toBeCloseTo(bar.time, 9);
    let samples = 0;
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.startSec).toBeCloseTo(bar.time + (samples / SR) * speed, 9);
      samples += c.left.length;
      expect(c.speed).toBe(speed);
      expect(c.sampleRate).toBe(SR);
    });
    expect(samples / SR).toBeCloseTo((song.meta.durationSec - bar.time) / speed, 2);
  });

  it('stops a cancelled render and keeps serving later requests', async () => {
    await client.load(texBundle(ISOLATED_TEX), 0);
    const chunks: PcmChunk[] = [];
    const h = client.render({ speed: 0.4, sampleRate: SR, fromSec: 0, chunkSec: 0.5 }, (c) => {
      chunks.push(c);
      if (chunks.length === 2) h.cancel();
    });
    const next = collect(0, 1);
    await next.done;
    expect(chunks).toHaveLength(2);
    expect(posted.some((m) => m.type === 'cancel' && m.reqId === h.reqId)).toBe(true);
    expect(next.chunks.at(-1)?.done).toBe(true);
  });

  it('drops a render cancelled while still queued', async () => {
    await client.load(texBundle(ISOLATED_TEX), 0);
    const first = collect(0, 1);
    const chunks: PcmChunk[] = [];
    const queued = client.render({ speed: 1, sampleRate: SR, fromSec: 0, chunkSec: 1 }, (c) => chunks.push(c));
    queued.cancel();
    const last = collect(0, 1);
    await Promise.all([first.done, last.done]);
    expect(chunks).toEqual([]);
  });

  it('re-imports an ASCII song with a rhythm sidecar', async () => {
    const tab = ['e|-0---3---|', 'B|---------|', 'G|---------|', 'D|---------|', 'A|---------|', 'E|---------|'].join('\n');
    const song = await client.load({ fileName: 'riff.txt', data: new TextEncoder().encode(tab) }, 0);
    expect(song.notes).toHaveLength(2);
    const sidecar: RhythmSidecar = { schema: 1, bpm: 60, timeSig: [4, 4], grid: 8, onsets: [0, 1.5], method: 'manual', savedAt: 0 };
    const aligned = await client.applySidecar(sidecar);
    expect(aligned.meta.rhythm).toBe('aligned');
    expect(aligned.notes.map((n) => n.time)).toEqual([0, 1.5]);
    // The guide renders the aligned song (MIDI built from its notes, DEC-21).
    const { chunks, done } = collect(0, 1);
    await done;
    expect(chunks[0]?.left.some((x) => Math.abs(x) > 0.01)).toBe(true);
  });

  it('rejects with the ImportError code for bad files', async () => {
    const err = await client.load(texBundle('\\title "x" . :4 0.6 (((('), 0).catch((e: unknown) => e);
    expect(isImportError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('syntax');
    const unsupported = await client.load({ fileName: 'song.pdf', data: new Uint8Array(4) }, 0).catch((e: unknown) => e);
    expect((unsupported as { code: string }).code).toBe('unsupported');
  });
});
