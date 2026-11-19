/**
 * Messages that cross thread boundaries: AudioWorklet ports (analysis, amp) and the song worker.
 * Small plain objects only (≤ 50 msgs/s from worklets); PCM moves as transferable `Float32Array`s.
 *
 * Frames are **context sample frames** (`currentFrame` in the worklet). The main thread converts:
 * `ctxTime = frame / sampleRate`, then subtracts the calibrated offset (docs/timing.md).
 *
 * Loading a worklet (Vite): `import url from './analysis.worklet.ts?worker&url'` then
 * `await ctx.audioWorklet.addModule(url)`; URLs are collected in `src/audio/worklets/urls.ts`.
 *
 * DOM-free.
 * @module
 */
import type { RhythmSidecar, Song, SongBundle } from './song';

/** `registerProcessor` names. */
export const PROCESSOR_NAMES = {
  analysis: 'riffway-analysis',
  amp: 'riffway-amp',
  /** Pass-through processor used by the foundation smoke test. */
  noop: 'riffway-noop',
} as const;

// ---------------------------------------------------------------------------------------------
// Analysis worklet (src/audio/worklets/analysis.worklet.ts, T-022; DSP from src/core/dsp, T-015)
// ---------------------------------------------------------------------------------------------

/** Analysis worklet → main thread. */
export type AnalysisEvent =
  /** Every ~50 ms: peak and RMS of channel being analysed, dBFS. */
  | { type: 'level'; frame: number; peakDb: number; rmsDb: number }
  /** Amplitude onset; pitch measured 25 ms later. `midi: null` when clarity < 0.6 (a `pitch` may follow within 40 ms). */
  | { type: 'onset'; frame: number; midi: number | null; cents: number; clarity: number; rmsDb: number }
  /** Follow-up pitch for the onset at `onsetFrame`. */
  | { type: 'pitch'; frame: number; onsetFrame: number; midi: number; cents: number; clarity: number }
  /** Legato: pitch moved ≥ 0.8 semitone for ≥ 25 ms without an amplitude onset. */
  | { type: 'pitch-change'; frame: number; midi: number; cents: number; clarity: number }
  /** Tuner mode only: continuous pitch frames (~21 Hz). `freq` 0 when no pitch. */
  | { type: 'tuner'; frame: number; freq: number; clarity: number }
  /** Sent once after construction. */
  | { type: 'ready'; sampleRate: number };

/** Main thread → analysis worklet. */
export type AnalysisCommand =
  /** Expected pitch range of upcoming notes (selects window N and search range). `null` = E2–E6. */
  | { type: 'expect'; range: { minMidi: number; maxMidi: number } | null }
  | { type: 'config'; channel: 0 | 1 | 'mix'; tuner: boolean }
  | { type: 'reset' };

/** `AudioWorkletNode` processorOptions for the analysis worklet. */
export interface AnalysisProcessorOptions {
  channel: 0 | 1 | 'mix';
  tuner: boolean;
}

// ---------------------------------------------------------------------------------------------
// Amp worklet (src/audio/worklets/amp.worklet.ts, T-023; DSP from src/core/dsp/amp)
// ---------------------------------------------------------------------------------------------

/** Amp parameters (docs/monitoring.md presets). */
export interface AmpParams {
  /** Linear drive into the clipper. */
  drive: number;
  /** Clipper asymmetry. */
  bias: number;
  /** Tone stack gains, dB (low shelf 120 Hz, peak 700 Hz, high shelf 3 kHz). */
  low: number;
  mid: number;
  high: number;
  /** Output level, dB. */
  level: number;
  /** DI preset: bypass everything. */
  bypass: boolean;
}

/** Main thread → amp worklet. */
export type AmpCommand = { type: 'params'; params: AmpParams };

// ---------------------------------------------------------------------------------------------
// Song worker (src/audio/guide/song.worker.ts, T-021)
// ---------------------------------------------------------------------------------------------

/** Main thread → song worker. `reqId` correlates responses. */
export type SongWorkerRequest =
  /** Parse the bundle with `loadSong` (same code as the server). Bundle bytes are transferred. */
  | { type: 'load'; reqId: number; bundle: SongBundle; arrangement: number }
  /** Render guide PCM for the loaded song at `speed` (tempo × speed, no pitch shift), from `fromSec` (song s). */
  | { type: 'render'; reqId: number; speed: number; sampleRate: number; fromSec: number; chunkSec: number }
  /** Apply a new sidecar to the loaded ASCII song and return the updated `Song`. */
  | { type: 'apply-sidecar'; reqId: number; sidecar: RhythmSidecar }
  | { type: 'cancel'; reqId: number };

/** Song worker → main thread. */
export type SongWorkerResponse =
  | { type: 'song'; reqId: number; song: Song }
  /**
   * One PCM chunk (stereo, transferred). `startSec` is the song time of the first sample at the
   * requested speed's timeline origin; i.e. sample i plays at song time `startSec + i / sampleRate × speed`.
   */
  | {
      type: 'pcm';
      reqId: number;
      index: number;
      startSec: number;
      sampleRate: number;
      speed: number;
      left: Float32Array;
      right: Float32Array;
      done: boolean;
    }
  | { type: 'error'; reqId: number; message: string; code?: string };
