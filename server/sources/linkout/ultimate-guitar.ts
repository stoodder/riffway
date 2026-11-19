/**
 * Ultimate Guitar source adapter (T-026); terms and approach in `docs/sources/ultimate-guitar.md`.
 * **Stub (T-010):** contributes nothing yet.
 * @module
 */
import type { SourceAdapter } from '@shared/sources';
import { idleStatus } from '../stub';

export function createUltimateGuitarAdapter(): SourceAdapter {
  const adapter: SourceAdapter = {
    id: 'ultimate-guitar',
    displayName: 'Ultimate Guitar',
    kind: 'link-out',
    termsDoc: 'docs/sources/ultimate-guitar.md',
    linkOuts: () => [],
    status: async () => idleStatus(adapter, 'Not implemented yet (T-026)'),
  };
  return adapter;
}
