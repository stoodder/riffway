/**
 * Backing audio (T-027): upload via `POST /api/audio`, `AudioLink` in IndexedDB, warp anchors,
 * signalsmith-stretch worklet playback (`rate = speed × slope`) on the backing bus.
 * Signature frozen by T-010; reached via `ctx.services.get('backing')`.
 * @module
 */
import type { ApiClient } from '@shared/api';
import type { AudioEngine, BackingService } from '@shared/services';
import type { StorageService } from '@shared/storage';
import { notImplemented } from '@shared/errors';

export async function createBacking(engine: AudioEngine, api: ApiClient, storage: StorageService): Promise<BackingService> {
  return notImplemented('createBacking', 'T-027');
}
