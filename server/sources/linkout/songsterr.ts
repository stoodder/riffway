/**
 * Songsterr source adapter (T-026); terms and approach in `docs/sources/songsterr.md`.
 * **Stub (T-010):** contributes nothing yet.
 * @module
 */
import type { SourceAdapter } from '@shared/sources';
import { idleStatus } from '../stub';

export function createSongsterrAdapter(): SourceAdapter {
  const adapter: SourceAdapter = {
    id: 'songsterr',
    displayName: 'Songsterr',
    kind: 'link-out',
    termsDoc: 'docs/sources/songsterr.md',
    linkOuts: () => [],
    status: async () => idleStatus(adapter, 'Not implemented yet (T-026)'),
  };
  return adapter;
}
