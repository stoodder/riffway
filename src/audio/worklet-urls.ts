/**
 * AudioWorklet module URLs (Vite `?worker&url`: a self-contained bundle in build, ESM in dev).
 * Load with `await ctx.audioWorklet.addModule(WORKLET_URLS.analysis)`, then
 * `new AudioWorkletNode(ctx, PROCESSOR_NAMES.analysis, …)` (`@shared/audio-events`).
 * Frozen by T-010: add a worklet here via a contract change request.
 * @module
 */
import analysisUrl from './worklets/analysis.worklet.ts?worker&url';
import ampUrl from './worklets/amp.worklet.ts?worker&url';
import noopUrl from './worklets/noop.worklet.ts?worker&url';

export const WORKLET_URLS = {
  /** Onset/pitch/level/tuner analysis (T-022). */
  analysis: analysisUrl,
  /** Amp sim (T-023). */
  amp: ampUrl,
  /** Pass-through used by the foundation smoke test. */
  noop: noopUrl,
} as const;
