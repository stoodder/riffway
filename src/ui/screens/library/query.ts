/**
 * Library screen state ↔ route params ↔ `GET /api/search` query. Pure (no DOM), so the URL contract
 * is unit-tested: `#/library?q=…&source=local,starter&tierMin=2&tierMax=5&tuning=drop-d&playable=true&tags=fingerstyle`
 * (the same names and encodings as the search API; see `src/ui/screens/index.ts`).
 * @module
 */
import type { SearchQuery } from '@shared/api';
import { SOURCE_IDS, type SourceId } from '@shared/song';
import type { RouteParams } from '@shared/ui';

/** Right-hand technique filter (a `SongTags.style` value). */
export type Technique = 'pick' | 'fingerstyle';

/** "Playable now" vs "needs import or rhythm" filter. */
export type PlayableFilter = 'all' | 'playable' | 'needs-work';

/**
 * Result order, applied in the browser to the rows the server returned: `''` keeps the server order
 * (best match for a query, A–Z without one), `easiest` sorts by difficulty, `az` by title and
 * `recent` puts recently played songs first.
 */
export type SortOrder = '' | 'easiest' | 'az' | 'recent';

/** Every sort order (the `sort` route param). */
export const SORT_ORDERS: readonly SortOrder[] = ['', 'easiest', 'az', 'recent'];

/** Everything the library screen searches with. Defaults mean "no filter". */
export interface LibraryQuery {
  /** Free text (trimmed when sent). */
  q: string;
  /** Restrict to these sources; empty = every enabled source. */
  sources: SourceId[];
  /** Difficulty tier range, 1–10 inclusive (1–10 = no filter, so unrated songs stay visible). */
  tierMin: number;
  tierMax: number;
  /** Tuning slug (`IndexEntry.tuningId`), `''` = any. */
  tuning: string;
  playable: PlayableFilter;
  technique: Technique | '';
  /** Other required tags (genre/skill), e.g. from a "songs with bends" link. */
  tags: string[];
  /** Result order (not sent to the server). */
  sort: SortOrder;
}

/** Tier bounds. */
export const TIER_MIN = 1;
export const TIER_MAX = 10;

/** Max rows fetched per search (the server caps at 500). */
export const RESULT_LIMIT = 200;

/** The unfiltered query. */
export const DEFAULT_QUERY: Readonly<LibraryQuery> = Object.freeze({
  q: '',
  sources: [],
  tierMin: TIER_MIN,
  tierMax: TIER_MAX,
  tuning: '',
  playable: 'all',
  technique: '',
  tags: [],
  sort: '',
});

const TECHNIQUES: readonly Technique[] = ['pick', 'fingerstyle'];

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

function tierParam(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n >= TIER_MIN && n <= TIER_MAX ? n : fallback;
}

/**
 * Read the screen state from route params. Lenient: unknown sources, bad tiers and unknown values are
 * dropped (a hand-edited URL never breaks the screen); a reversed tier range is swapped.
 */
export function queryFromParams(params: RouteParams): LibraryQuery {
  const tags = list(params.tags).map((t) => t.toLowerCase());
  const technique = TECHNIQUES.find((t) => tags.includes(t)) ?? '';
  let tierMin = tierParam(params.tierMin, TIER_MIN);
  let tierMax = tierParam(params.tierMax, TIER_MAX);
  if (tierMin > tierMax) [tierMin, tierMax] = [tierMax, tierMin];
  return {
    q: params.q ?? '',
    sources: SOURCE_IDS.filter((id) => list(params.source).includes(id)),
    tierMin,
    tierMax,
    tuning: (params.tuning ?? '').trim(),
    playable: params.playable === 'true' ? 'playable' : params.playable === 'false' ? 'needs-work' : 'all',
    technique,
    tags: [...new Set(tags.filter((t) => !TECHNIQUES.includes(t as Technique)))],
    sort: SORT_ORDERS.find((o) => o && o === params.sort) ?? '',
  };
}

/** All required tags (technique first). */
function allTags(query: LibraryQuery): string[] {
  return query.technique ? [query.technique, ...query.tags] : [...query.tags];
}

/** Route params for the state; defaults are omitted so the plain library URL stays `#/library`. */
export function queryToParams(query: LibraryQuery): RouteParams {
  const params: RouteParams = {};
  if (query.q.trim()) params.q = query.q.trim();
  if (query.sources.length) params.source = query.sources.join(',');
  if (query.tierMin > TIER_MIN) params.tierMin = String(query.tierMin);
  if (query.tierMax < TIER_MAX) params.tierMax = String(query.tierMax);
  if (query.tuning) params.tuning = query.tuning;
  if (query.playable !== 'all') params.playable = String(query.playable === 'playable');
  const tags = allTags(query);
  if (tags.length) params.tags = tags.join(',');
  if (query.sort) params.sort = query.sort;
  return params;
}

/** The `GET /api/search` query for the state. */
export function toSearchQuery(query: LibraryQuery, limit = RESULT_LIMIT): SearchQuery {
  const out: SearchQuery = { limit };
  if (query.q.trim()) out.q = query.q.trim();
  if (query.sources.length) out.source = [...query.sources];
  if (query.tierMin > TIER_MIN) out.tierMin = query.tierMin;
  if (query.tierMax < TIER_MAX) out.tierMax = query.tierMax;
  if (query.tuning) out.tuning = query.tuning;
  if (query.playable !== 'all') out.playable = query.playable === 'playable';
  const tags = allTags(query);
  if (tags.length) out.tags = tags;
  return out;
}

/** True when any filter (not the text) narrows the results. */
export function hasFilters(query: LibraryQuery): boolean {
  return (
    query.sources.length > 0 ||
    query.tierMin > TIER_MIN ||
    query.tierMax < TIER_MAX ||
    query.tuning !== '' ||
    query.playable !== 'all' ||
    query.technique !== '' ||
    query.tags.length > 0
  );
}

/** What {@link sortResults} needs per song beyond the result itself. */
export interface SortContext {
  /** Epoch ms each song was last played (missing = never). */
  lastPlayed?: ReadonlyMap<string, number>;
}

/**
 * Order rows for `sort`. Stable: ties keep the server order. `easiest` puts unrated songs last;
 * `recent` lists played songs newest first, then the rest A–Z. Returns a new array.
 */
export function sortResults<T extends { id: string; title: string; rating: number | null }>(rows: readonly T[], sort: SortOrder, ctx: SortContext = {}): T[] {
  const out = [...rows];
  const byTitle = (a: T, b: T): number => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
  switch (sort) {
    case '':
      return out;
    case 'az':
      return out.sort(byTitle);
    case 'easiest':
      return out.sort((a, b) => (a.rating ?? Infinity) - (b.rating ?? Infinity) || byTitle(a, b));
    case 'recent': {
      const at = (r: T): number => ctx.lastPlayed?.get(r.id) ?? -Infinity;
      return out.sort((a, b) => at(b) - at(a) || byTitle(a, b));
    }
  }
}

/** Same search (text compared trimmed). */
export function sameQuery(a: LibraryQuery, b: LibraryQuery): boolean {
  const pa = queryToParams(a);
  const pb = queryToParams(b);
  const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  return [...keys].every((k) => pa[k] === pb[k]);
}
