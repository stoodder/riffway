/**
 * Song worker (T-021, D3, DEC-12). Speaks the `SongWorkerRequest` / `SongWorkerResponse` protocol
 * of `@shared/audio-events`:
 * - `load`: `loadSong()` (the same code the server indexes with) → `song`; the song becomes the
 *   worker's current song.
 * - `apply-sidecar`: re-import the current ASCII song with a rhythm sidecar → `song`.
 * - `render`: offline alphaSynth render of the current song's guide track at `speed`, from the bar
 *   containing `fromSec` to the end, in `chunkSec` chunks → `pcm`… (the last one has `done: true`
 *   and may be empty). Renders run one at a time in request order and yield between chunks, so a
 *   `cancel` (or a newer request) is handled within one chunk.
 *
 * Imports alphaTab's **main** entry (its `initializeMain()` leaves `onmessage` alone in a worker),
 * never `@coderline/alphatab/worker`. The soundfont (`sonivox.sf2`, Apache-2.0) is served from our
 * own origin via Vite `?url` and fetched on the first render.
 * @module
 */
import soundFontUrl from '@coderline/alphatab/soundfont/sonivox.sf2?url';
import type { SongWorkerRequest, SongWorkerResponse } from '@shared/audio-events';
import type { Song, SongBundle } from '@shared/song';
import { loadAlphaTabScore } from '@core/import/alphatab';
import { detectFormat, isImportError, loadSong } from '@core/import/load-song';
import { barAt } from '@core/model';
import { recipeFromAlphaTab, recipeFromSong, type MidiRecipe } from './midi';
import { GuideSynth, type StereoChunk } from './render';

/** The part of `DedicatedWorkerGlobalScope` we use (the app compiles with the DOM lib). */
interface WorkerScope {
  postMessage(message: SongWorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<SongWorkerRequest>) => void): void;
}

/** The current song and its lazily built guide MIDI. */
interface Loaded {
  bundle: SongBundle;
  arrangement: number;
  song: Song;
  recipe?: MidiRecipe;
}

interface RenderJob {
  reqId: number;
  loaded: Loaded;
  speed: number;
  sampleRate: number;
  fromSec: number;
  chunkSec: number;
}

const scope = self as unknown as WorkerScope;
let current: Loaded | null = null;
let synthPromise: Promise<GuideSynth> | null = null;
const queue: RenderJob[] = [];
/** Request id of the render in progress, if any. */
let running: number | null = null;
let cancelled = false;

function post(msg: SongWorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}

function postError(reqId: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  post(isImportError(err) ? { type: 'error', reqId, message, code: err.code } : { type: 'error', reqId, message });
}

/** Parse the soundfont once, on first use. A failed fetch is retried on the next render. */
function getSynth(): Promise<GuideSynth> {
  synthPromise ??= fetch(soundFontUrl)
    .then((res) => {
      if (!res.ok) throw new Error(`Guide soundfont: HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    .then((buf) => new GuideSynth(new Uint8Array(buf)))
    .catch((err: unknown) => {
      synthPromise = null;
      throw err;
    });
  return synthPromise;
}

/** Guide MIDI: alphaTab's generator for scores it can read, else built from the notes (DEC-21). */
function recipeOf(loaded: Loaded): MidiRecipe {
  if (!loaded.recipe) {
    const format = detectFormat(loaded.bundle.fileName, loaded.bundle.data);
    if (format === 'ascii') {
      loaded.recipe = recipeFromSong(loaded.song);
    } else {
      const { score, settings } = loadAlphaTabScore(loaded.bundle);
      loaded.recipe = recipeFromAlphaTab(score, settings, loaded.song.arrangement);
    }
  }
  return loaded.recipe;
}

/** Let queued messages (cancel, load) run between chunks; avoids the nested-`setTimeout` clamp. */
function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

async function runJob(job: RenderJob): Promise<void> {
  const synth = await getSynth();
  if (cancelled) return;
  const { song } = job.loaded;
  const fromBar = song.timing.bars.length > 0 ? barAt(song, job.fromSec + 1e-9) : 0;
  const startSec = song.timing.bars[fromBar]?.time ?? 0;
  const chunks = synth.render(recipeOf(job.loaded), {
    speed: job.speed,
    sampleRate: job.sampleRate,
    fromBar,
    toBar: null,
    chunkMs: job.chunkSec * 1000,
  });
  let index = 0;
  let samples = 0;
  const base = { type: 'pcm', reqId: job.reqId, sampleRate: job.sampleRate, speed: job.speed } as const;
  for (let r = chunks.next(); !r.done; r = chunks.next()) {
    const { left, right }: StereoChunk = r.value;
    const length = left.length; // read before the transfer detaches the buffer
    // Each chunk's own start, so the receiver never has to count samples.
    post({ ...base, index, startSec: startSec + (samples / job.sampleRate) * job.speed, left, right, done: false }, [left.buffer, right.buffer]);
    samples += length;
    index++;
    await yieldToEvents();
    if (cancelled) return;
  }
  const empty = new Float32Array(0);
  post({ ...base, index, startSec: startSec + (samples / job.sampleRate) * job.speed, left: empty, right: empty, done: true });
}

async function pump(): Promise<void> {
  if (running !== null) return;
  for (let job = queue.shift(); job; job = queue.shift()) {
    running = job.reqId;
    cancelled = false;
    try {
      await runJob(job);
    } catch (err) {
      if (!cancelled) postError(job.reqId, err);
    }
  }
  running = null;
}

function handle(req: SongWorkerRequest): void {
  switch (req.type) {
    case 'load': {
      const song = loadSong(req.bundle, { arrangement: req.arrangement });
      current = { bundle: req.bundle, arrangement: req.arrangement, song };
      post({ type: 'song', reqId: req.reqId, song });
      return;
    }
    case 'apply-sidecar': {
      if (!current) throw new Error('No song loaded');
      const bundle = { ...current.bundle, sidecar: req.sidecar };
      const song = loadSong(bundle, { arrangement: current.arrangement });
      current = { bundle, arrangement: current.arrangement, song };
      post({ type: 'song', reqId: req.reqId, song });
      return;
    }
    case 'render': {
      if (!current) throw new Error('No song loaded');
      if (!(req.speed > 0) || !(req.sampleRate > 0) || !(req.chunkSec > 0)) throw new RangeError('Invalid render request');
      queue.push({ reqId: req.reqId, loaded: current, speed: req.speed, sampleRate: req.sampleRate, fromSec: req.fromSec, chunkSec: req.chunkSec });
      void pump();
      return;
    }
    case 'cancel': {
      const i = queue.findIndex((j) => j.reqId === req.reqId);
      if (i >= 0) queue.splice(i, 1);
      else if (req.reqId === running) cancelled = true;
      return;
    }
  }
}

scope.addEventListener('message', (ev) => {
  try {
    handle(ev.data);
  } catch (err) {
    postError(ev.data.reqId, err);
  }
});
