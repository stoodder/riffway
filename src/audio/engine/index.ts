/**
 * Audio engine (T-016): `AudioContext` (`latencyHint: 0`, matched sample rate), clock (D5),
 * transport, look-ahead scheduler (25 ms / 120 ms), metronome from the beat grid, mixer buses
 * `monitor/backing/guide/metronome → master → safety limiter`. See docs/timing.md.
 * Signature frozen by T-010; reached in the app via `ctx.services.get('engine')`.
 * @module
 */
import type { AudioEngine, EngineOptions } from '@shared/services';
import { notImplemented } from '@shared/errors';

/** Create the engine. The context starts suspended until `resume()` is called from a gesture. */
export async function createEngine(opts: EngineOptions = {}): Promise<AudioEngine> {
  return notImplemented('createEngine', 'T-016');
}
