/**
 * Source adapter registry (frozen by T-010). Order = display order in search and settings.
 * Link-out adapters must do no network I/O (D1; `songsterr.com/api` is forbidden).
 * @module
 */
import type { SourceId } from '@shared/song';
import type { SourceAdapter, SourceAdapterFactory } from '@shared/sources';
import { createClassTabAdapter } from './classtab';
import { createGpPackAdapter } from './linkout/gp-pack';
import { createSongsterrAdapter } from './linkout/songsterr';
import { createUltimateGuitarAdapter } from './linkout/ultimate-guitar';
import { createLocalAdapter } from './local';
import { createStarterAdapter } from './starter';

export const SOURCE_REGISTRY: readonly { id: SourceId; owner: string; create: SourceAdapterFactory }[] = [
  { id: 'local', owner: 'T-017', create: createLocalAdapter },
  { id: 'starter', owner: 'T-017', create: createStarterAdapter },
  { id: 'classtab', owner: 'T-025', create: createClassTabAdapter },
  { id: 'songsterr', owner: 'T-026', create: createSongsterrAdapter },
  { id: 'ultimate-guitar', owner: 'T-026', create: createUltimateGuitarAdapter },
  { id: 'gp-pack', owner: 'T-026', create: createGpPackAdapter },
];

/** Default adapter factories, in registry order. */
export const DEFAULT_SOURCE_FACTORIES: readonly SourceAdapterFactory[] = SOURCE_REGISTRY.map((s) => s.create);

/** Instantiate adapters. */
export function createAdapters(factories: readonly SourceAdapterFactory[] = DEFAULT_SOURCE_FACTORIES): SourceAdapter[] {
  return factories.map((f) => f());
}
