/**
 * Guide render sample rate (T-021). Kept apart from `./render.ts` so the main thread can use it
 * without loading alphaTab.
 * @module
 */

/**
 * Lowest sample rate the guide renders at. alphaSynth 1.9.0 outputs NaN at some lower rates
 * (measured: 22050 and 32000 Hz; 8000, 16000 and 44100–192000 Hz are fine), so a context below
 * this gets a 48 kHz render that Web Audio resamples.
 */
export const MIN_RENDER_RATE = 44100;

/** Sample rate to render at for a context running at `contextRate`. */
export function renderRateFor(contextRate: number): number {
  return contextRate >= MIN_RENDER_RATE ? contextRate : 48000;
}
