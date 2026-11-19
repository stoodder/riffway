/**
 * Local library source adapter (T-017); terms and approach in `docs/sources/local-folder.md`.
 * **Stub (T-010):** contributes nothing yet.
 * @module
 */
import type { SourceAdapter } from '@shared/sources';
import { idleStatus } from '../stub';

export function createLocalAdapter(): SourceAdapter {
  const adapter: SourceAdapter = {
    id: 'local',
    displayName: 'Local library',
    kind: 'library',
    termsDoc: 'docs/sources/local-folder.md',
    scan: async () => [],
    status: async () => idleStatus(adapter, 'Not implemented yet (T-017)'),
  };
  return adapter;
}
