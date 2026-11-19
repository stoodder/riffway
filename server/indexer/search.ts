/**
 * Unified search over the library index (T-017): a MiniSearch full-text index (fuzzy + prefix) plus
 * structured filters (source, tier range, tuning, playable, tags) and the projection of an
 * `IndexEntry` to a `SearchResult`.
 * @module
 */
import MiniSearch from 'minisearch';
import type { Availability, IndexEntry, SearchFilters, SearchResult } from '@shared/sources';

/** Default and maximum result counts for `GET /api/search`. */
export const SEARCH_LIMITS = { default: 50, max: 500 } as const;

/** Text fields indexed by MiniSearch. */
interface SearchDoc {
  id: string;
  title: string;
  artist: string;
  composer: string;
  fileName: string;
  tags: string;
}

/** Whether an entry can be played right now (see `Availability`). */
export function availabilityOf(entry: IndexEntry): Availability {
  if (entry.error || entry.defaultArrangement < 0) return 'needs-import';
  return entry.rhythm === 'needs-alignment' ? 'needs-rhythm' : 'playable';
}

/** Project an index entry to a search result row. */
export function toSearchResult(entry: IndexEntry, score: number): SearchResult {
  const result: SearchResult = {
    id: entry.id,
    source: entry.source,
    title: entry.title,
    fileName: entry.fileName,
    tier: entry.difficulty?.tier ?? null,
    rating: entry.difficulty?.rating ?? null,
    ratingProvisional: entry.difficulty?.provisional ?? entry.rhythm === 'needs-alignment',
    tuningId: entry.tuningId,
    tuningLabel: entry.tuningLabel,
    tags: entry.tags,
    rhythm: entry.rhythm,
    availability: availabilityOf(entry),
    arrangements: entry.tracks.filter((t) => t.playable).length,
    defaultArrangement: entry.defaultArrangement,
    durationSec: entry.durationSec,
    score,
  };
  if (entry.artist) result.artist = entry.artist;
  if (entry.composer) result.composer = entry.composer;
  return result;
}

/** True when the entry passes every structured filter (text query excluded). */
export function matchesFilters(entry: IndexEntry, filters: SearchFilters): boolean {
  if (filters.source?.length && !filters.source.includes(entry.source)) return false;
  if (filters.tierMin !== undefined || filters.tierMax !== undefined) {
    const tier = entry.difficulty?.tier;
    if (tier === undefined) return false;
    if (filters.tierMin !== undefined && tier < filters.tierMin) return false;
    if (filters.tierMax !== undefined && tier > filters.tierMax) return false;
  }
  if (filters.tuning && entry.tuningId !== filters.tuning) return false;
  if (filters.playable !== undefined && (availabilityOf(entry) === 'playable') !== filters.playable) return false;
  if (filters.tags?.length) {
    const have = new Set([...entry.tags.style, ...entry.tags.genre, ...entry.tags.skills].map((t) => t.toLowerCase()));
    if (!filters.tags.every((t) => have.has(t.toLowerCase()))) return false;
  }
  return true;
}

function toDoc(entry: IndexEntry): SearchDoc {
  const t = entry.tags;
  return {
    id: entry.id,
    title: entry.title,
    artist: entry.artist ?? '',
    composer: entry.composer ?? '',
    fileName: entry.fileName.replace(/\.[^.]+$/, ''),
    tags: [...t.style, ...t.genre, ...t.skills].join(' '),
  };
}

/** Incrementally maintained full-text index of entries. */
export class SearchIndex {
  private readonly mini = new MiniSearch<SearchDoc>({
    fields: ['title', 'artist', 'composer', 'fileName', 'tags'],
    searchOptions: {
      boost: { title: 3, artist: 2, composer: 2 },
      fuzzy: 0.2,
      prefix: true,
      combineWith: 'AND',
    },
  });

  /** Add or replace an entry. */
  upsert(entry: IndexEntry): void {
    const doc = toDoc(entry);
    if (this.mini.has(entry.id)) this.mini.replace(doc);
    else this.mini.add(doc);
  }

  /** Remove an entry by id (no-op when absent). */
  remove(id: string): void {
    if (this.mini.has(id)) this.mini.discard(id);
  }

  /**
   * Run a query over `entries` (the candidates already narrowed to enabled sources). An empty
   * query lists every entry passing the filters, sorted by title (score 0); otherwise results are
   * ranked by MiniSearch relevance.
   */
  query(q: string, entries: ReadonlyMap<string, IndexEntry>, filters: SearchFilters): { results: SearchResult[]; total: number } {
    const limit = Math.min(Math.max(1, filters.limit ?? SEARCH_LIMITS.default), SEARCH_LIMITS.max);
    let rows: SearchResult[];
    const text = q.trim();
    if (!text) {
      rows = [...entries.values()]
        .filter((e) => matchesFilters(e, filters))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
        .map((e) => toSearchResult(e, 0));
    } else {
      rows = [];
      for (const hit of this.mini.search(text)) {
        const entry = entries.get(String(hit.id));
        if (entry && matchesFilters(entry, filters)) rows.push(toSearchResult(entry, hit.score));
      }
    }
    return { results: rows.slice(0, limit), total: rows.length };
  }
}
