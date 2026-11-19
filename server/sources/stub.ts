/**
 * Helpers for adapter stubs (T-010): a safe default `status()`.
 * @module
 */
import type { SourceAdapter, SourceStatus } from '@shared/sources';

/** Idle status with zero entries. */
export function idleStatus(adapter: Pick<SourceAdapter, 'id' | 'displayName' | 'kind' | 'termsDoc'>, message?: string): SourceStatus {
  const status: SourceStatus = {
    id: adapter.id,
    displayName: adapter.displayName,
    kind: adapter.kind,
    enabled: true,
    indexed: 0,
    lastRefresh: null,
    state: 'idle',
    termsDoc: adapter.termsDoc,
  };
  if (message) status.message = message;
  return status;
}
