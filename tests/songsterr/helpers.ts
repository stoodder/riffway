/**
 * Offline helpers for the remote-search tests: synthetic hits (invented titles, `fixtures.invalid`
 * URLs), a recording fake `fetch`, a pass-through fake mapper and a minimal adapter context. No test
 * here touches the network or uses any real site's response format.
 */
import { vi } from 'vitest';
import type { AdapterContext, IndexEntry, RemoteSearchHit } from '@shared/sources';
import type { FetchLike } from '../../server/sources/songsterr/client';

export const hit = (title: string, extra: Partial<RemoteSearchHit> = {}): RemoteSearchHit => ({
  source: 'songsterr',
  remoteId: title.toLowerCase().replace(/\W+/g, '-'),
  title,
  url: `https://fixtures.invalid/${encodeURIComponent(title)}`,
  tracks: [{ name: 'Lead', tuning: [64, 59, 55, 50, 45, 40] }],
  tuning: [64, 59, 55, 50, 45, 40],
  tuningId: 'standard',
  tuningLabel: 'Standard',
  ...extra,
});

/** The fake site's body is already a list of hits; the fake mapper passes it through. */
export const passThroughMapper = (json: unknown): RemoteSearchHit[] => (Array.isArray(json) ? (json as RemoteSearchHit[]) : []);

/** A fake fetch answering every request with `status` and `body` (JSON), recording calls. */
export function fakeFetch(status: number, body: unknown = []): FetchLike & ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as FetchLike &
    ReturnType<typeof vi.fn>;
}

/** URL builder for tests (never a real host). */
export const testUrl = (q: string): string => `https://remote.invalid/search?q=${encodeURIComponent(q)}`;

export function entry(id: string, title: string, artist?: string): IndexEntry {
  // Only id/title/artist/composer matter for local matching.
  return { id, title, ...(artist ? { artist } : {}) } as unknown as IndexEntry;
}

/** Minimal adapter context: `entries()` and a recording logger. */
export function adapterContext(entries: IndexEntry[] = []): AdapterContext & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    dataDir: '/tmp/none',
    libraryDir: '/tmp/none',
    log: { info: () => {}, debug: () => {}, error: () => {}, warn: (msg: string) => void warnings.push(msg) },
    indexFiles: async () => [],
    entries: () => entries,
    emit: () => {},
    warnings,
  };
}
