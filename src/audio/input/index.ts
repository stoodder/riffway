/**
 * Guitar input (T-022): device listing/persistence/re-matching, `getUserMedia` constraints exactly
 * per docs/audio-input.md, analysis worklet bridge (frames → ctx seconds, `inputOffsetMs` applied).
 * Signature frozen by T-010; reached via `ctx.services.get('input')`.
 * @module
 */
import type { AudioEngine, InputService } from '@shared/services';
import type { SettingsStore } from '@shared/settings';
import { notImplemented } from '@shared/errors';

export async function createInputService(engine: AudioEngine, settings: SettingsStore): Promise<InputService> {
  return notImplemented('createInputService', 'T-022');
}
