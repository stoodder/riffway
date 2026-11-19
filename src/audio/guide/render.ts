/**
 * Offline guide render (T-021, D3). DOM-free: runs in the song worker and in Node tests.
 *
 * `AlphaSynth.exportAudio` streams a {@link MidiRecipe} (see `./midi.ts`) rendered at a speed into
 * stereo PCM chunks. A render covers a bar range `[fromBar, toBar)` of the played-order bars via
 * alphaSynth's playback range, so sample 0 of a render is the song time of `fromBar` and sample
 * `i` is song time `bars[fromBar].time + (i / sampleRate) × speed`. The soundfont is parsed once
 * per {@link GuideSynth}. alphaSynth's own player and `AudioContext` are never used.
 * @module
 */
import { synth } from '@coderline/alphatab';
import { buildMidiFile, type MidiRecipe } from './midi';

/** Chunk length, ms of rendered (real) time: playback can start once the first chunk is in. */
export const RENDER_CHUNK_MS = 5000;

/** What to render. */
export interface RenderRange {
  /** Speed factor (tempo × speed, pitch unchanged). */
  speed: number;
  /** Output sample rate (the engine context's). */
  sampleRate: number;
  /** First played-order bar (inclusive). */
  fromBar: number;
  /** Bar after the last one (exclusive); `null` = to the end of the song. */
  toBar: number | null;
  /** Chunk length in ms (default {@link RENDER_CHUNK_MS}). */
  chunkMs?: number;
}

/** No-op event emitter for the unused live output. */
function silentEmitter<T>(): synth.ISynthOutput['samplesPlayed'] & synth.ISynthOutput['ready'] {
  const emitter = {
    on: (_cb: (arg: T) => void) => () => undefined,
    off: (_cb: (arg: T) => void) => undefined,
  };
  return emitter as synth.ISynthOutput['samplesPlayed'] & synth.ISynthOutput['ready'];
}

/** `ISynthOutput` that plays nothing: AlphaSynth needs one, but we only use `exportAudio`. */
function nullOutput(sampleRate: number): synth.ISynthOutput {
  return {
    sampleRate,
    open: () => undefined,
    play: () => undefined,
    destroy: () => undefined,
    pause: () => undefined,
    addSamples: () => undefined,
    resetSamples: () => undefined,
    activate: () => undefined,
    ready: silentEmitter<void>(),
    samplesPlayed: silentEmitter<number>(),
    sampleRequest: silentEmitter<void>(),
    enumerateOutputDevices: () => Promise.resolve([]),
    setOutputDevice: () => Promise.resolve(),
    getOutputDevice: () => Promise.resolve(null),
  };
}

/** Clamp a bar index into `[0, bars]` (`bars` = the song end). */
function clampBar(recipe: MidiRecipe, bar: number): number {
  return Math.max(0, Math.min(recipe.barTicks.length - 1, Math.floor(bar)));
}

/** One rendered chunk, deinterleaved. */
export interface StereoChunk {
  left: Float32Array;
  right: Float32Array;
}

/** alphaSynth's interleaved stereo → separate channels. */
export function deinterleave(interleaved: Float32Array): StereoChunk {
  const n = interleaved.length >> 1;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    left[i] = interleaved[j] as number;
    right[i] = interleaved[j + 1] as number;
  }
  return { left, right };
}

/** alphaSynth with a parsed soundfont, rendering recipes offline. */
export class GuideSynth {
  private readonly synth: synth.AlphaSynth;

  /** @param soundFont SF2 bytes (`sonivox.sf2`, bundled with alphaTab; Apache-2.0). */
  constructor(soundFont: Uint8Array) {
    this.synth = new synth.AlphaSynth(nullOutput(48000), 500);
    // loadSoundFont reports a parse failure through an event instead of throwing.
    let failure: unknown = null;
    const off = this.synth.soundFontLoadFailed.on((err) => (failure = err));
    this.synth.loadSoundFont(soundFont, false);
    off();
    if (failure !== null) throw new Error(`The guide soundfont could not be loaded: ${String(failure)}`, { cause: failure });
  }

  /**
   * Render `range` of `recipe` as stereo chunks of about {@link RENDER_CHUNK_MS} each (the last one
   * may be shorter). Lazy: each `next()` synthesises one chunk, so a caller can yield between
   * chunks and abandon the iterator to cancel.
   */
  *render(recipe: MidiRecipe, range: RenderRange): Generator<StereoChunk, void, undefined> {
    const from = clampBar(recipe, range.fromBar);
    const to = range.toBar === null ? recipe.barTicks.length - 1 : clampBar(recipe, range.toBar);
    if (to <= from) return;
    const opts = new synth.AudioExportOptions();
    opts.sampleRate = range.sampleRate;
    opts.useSyncPoints = false;
    opts.metronomeVolume = 0;
    opts.masterVolume = 1;
    const playbackRange = new synth.PlaybackRange();
    playbackRange.startTick = recipe.barTicks[from] as number;
    playbackRange.endTick = recipe.barTicks[to] as number;
    opts.playbackRange = playbackRange;
    const exporter = this.synth.exportAudio(opts, buildMidiFile(recipe, range.speed), [], new Map(recipe.transpositionPitches));
    const chunkMs = range.chunkMs ?? RENDER_CHUNK_MS;
    for (let chunk = exporter.render(chunkMs); chunk; chunk = exporter.render(chunkMs)) {
      if (chunk.samples.length === 0) continue;
      if (!chunk.samples.every(Number.isFinite)) throw new Error(`Guide render produced invalid samples at ${range.sampleRate} Hz`);
      yield deinterleave(chunk.samples);
    }
  }
}
