/**
 * ClassTab source adapter (T-025); terms and approach in `docs/sources/classtab.md`.
 * **Stub (T-010):** contributes nothing yet.
 * @module
 */
import type { SourceAdapter } from '@shared/sources';
import { idleStatus } from '../stub';

export function createClassTabAdapter(): SourceAdapter {
  const adapter: SourceAdapter = {
    id: 'classtab',
    displayName: 'ClassTab',
    kind: 'download',
    termsDoc: 'docs/sources/classtab.md',
    scan: async () => [],
    status: async () => idleStatus(adapter, 'Not implemented yet (T-025)'),
  };
  return adapter;
}
