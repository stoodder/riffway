/**
 * Guitar Pro free pack source adapter (T-026); terms and approach in `docs/sources/candidates.md`.
 * **Stub (T-010):** contributes nothing yet.
 * @module
 */
import type { SourceAdapter } from '@shared/sources';
import { idleStatus } from '../stub';

export function createGpPackAdapter(): SourceAdapter {
  const adapter: SourceAdapter = {
    id: 'gp-pack',
    displayName: 'Guitar Pro free pack',
    kind: 'link-out',
    termsDoc: 'docs/sources/candidates.md',
    linkOuts: () => [],
    status: async () => idleStatus(adapter, 'Not implemented yet (T-026)'),
  };
  return adapter;
}
