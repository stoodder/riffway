/**
 * In-memory LRU cache for remote search (docs/guides/songsterr-search.md § 3b): normalized query →
 * hits, 24 h TTL. Hits are stored without `localMatchIds` (recomputed per request).
 * @module
 */
import type { RemoteSearchHit } from '@shared/sources';

interface Entry {
  at: number;
  hits: RemoteSearchHit[];
}

/** The cache's view of a query: trimmed, lower-case, single spaces. */
export function cacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Small LRU cache of query → hits. */
export function createSearchCache(max = 200, ttlMs = 24 * 3600_000, now: () => number = Date.now) {
  const map = new Map<string, Entry>();
  return {
    get(q: string): RemoteSearchHit[] | undefined {
      const k = cacheKey(q);
      const e = map.get(k);
      if (!e) return undefined;
      if (now() - e.at > ttlMs) {
        map.delete(k);
        return undefined;
      }
      map.delete(k);
      map.set(k, e); // refresh LRU order
      return e.hits;
    },
    set(q: string, hits: RemoteSearchHit[]): void {
      const k = cacheKey(q);
      map.delete(k);
      map.set(k, { at: now(), hits });
      while (map.size > max) map.delete(map.keys().next().value as string);
    },
    get size(): number {
      return map.size;
    },
  };
}

export type SearchCache = ReturnType<typeof createSearchCache>;
