/**
 * Guide synth + song worker client (T-021): `song.worker.ts` runs `loadSong` and alphaSynth offline
 * render (sonivox.sf2 via Vite `?url`); the guide player schedules PCM on the guide bus through
 * `engine.registerScheduledSource`. Signatures frozen by T-010.
 * @module
 */
import type { AudioEngine, GuideService, SongLoader } from '@shared/services';
import { notImplemented } from '@shared/errors';

/** Song loader backed by the song worker (same `loadSong` as the server). */
export async function createSongLoader(): Promise<SongLoader> {
  return notImplemented('createSongLoader', 'T-021');
}

/** Guide player on `engine.buses.guide`. */
export async function createGuide(engine: AudioEngine, loader: SongLoader): Promise<GuideService> {
  return notImplemented('createGuide', 'T-021');
}
