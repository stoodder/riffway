/**
 * Monitoring + amp/cab sim (T-023): input → trim → amp worklet → cab biquads → monitor bus, latency
 * estimate, headphone card, speaker and runaway guards (docs/monitoring.md).
 * Signature frozen by T-010; reached via `ctx.services.get('monitor')`.
 * @module
 */
import type { AudioEngine, InputService, MonitorService } from '@shared/services';
import type { SettingsStore } from '@shared/settings';
import { notImplemented } from '@shared/errors';

export async function createMonitor(engine: AudioEngine, input: InputService, settings: SettingsStore): Promise<MonitorService> {
  return notImplemented('createMonitor', 'T-023');
}
