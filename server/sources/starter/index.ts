/**
 * Starter library source adapter (T-017); content and licensing in `starter/README.md` (T-019).
 * **Stub (T-010):** contributes nothing yet.
 * @module
 */
import type { SourceAdapter } from '@shared/sources';
import { idleStatus } from '../stub';

export function createStarterAdapter(): SourceAdapter {
  const adapter: SourceAdapter = {
    id: 'starter',
    displayName: 'Starter library',
    kind: 'library',
    termsDoc: 'starter/README.md',
    scan: async () => [],
    status: async () => idleStatus(adapter, 'Not implemented yet (T-017)'),
  };
  return adapter;
}
