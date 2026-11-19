/**
 * `GET /api/search`: unified search → `{results, linkOuts, total}` (T-017). Query parameters per
 * `SearchQuery`; arrays are comma-separated (`source=local,starter`, `tags=rock,bends`).
 * @module
 */
import type { SearchQuery, SearchResponse } from '@shared/api';
import { SOURCE_IDS, type SourceId } from '@shared/song';
import { sendError } from '../http';
import { SEARCH_LIMITS } from '../indexer/search';
import type { RouteModule } from '../types';

/** A malformed search parameter. */
export class SearchParamError extends Error {}

/** Flatten a query value (repeated keys arrive as arrays) to one string. */
function str(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(String).join(',');
  return typeof value === 'string' ? value : undefined;
}

function list(value: unknown): string[] | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  const items = s.split(',').map((v) => v.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function int(value: unknown, name: string, min: number, max: number): number | undefined {
  const s = str(value);
  if (s === undefined || s === '') return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) throw new SearchParamError(`${name} must be an integer ${min}–${max}`);
  return n;
}

/** Parse and validate `GET /api/search` query parameters. Throws {@link SearchParamError}. */
export function parseSearchQuery(raw: Record<string, unknown>): SearchQuery {
  const query: SearchQuery = {};
  const q = str(raw.q);
  if (q) query.q = q.slice(0, 200);
  const sources = list(raw.source);
  if (sources) {
    const bad = sources.filter((s) => !SOURCE_IDS.includes(s as SourceId));
    if (bad.length) throw new SearchParamError(`Unknown source: ${bad.join(', ')}`);
    query.source = sources as SourceId[];
  }
  const tierMin = int(raw.tierMin, 'tierMin', 1, 10);
  if (tierMin !== undefined) query.tierMin = tierMin;
  const tierMax = int(raw.tierMax, 'tierMax', 1, 10);
  if (tierMax !== undefined) query.tierMax = tierMax;
  const tuning = str(raw.tuning)?.trim();
  if (tuning) query.tuning = tuning;
  const playable = str(raw.playable);
  if (playable !== undefined && playable !== '') {
    if (playable !== 'true' && playable !== 'false') throw new SearchParamError('playable must be true or false');
    query.playable = playable === 'true';
  }
  const tags = list(raw.tags);
  if (tags) query.tags = tags;
  const limit = int(raw.limit, 'limit', 1, SEARCH_LIMITS.max);
  if (limit !== undefined) query.limit = limit;
  return query;
}

export const register: RouteModule = async (app, ctx) => {
  app.get('/api/search', async (req, reply) => {
    let query: SearchQuery;
    try {
      query = parseSearchQuery(req.query as Record<string, unknown>);
    } catch (err) {
      if (err instanceof SearchParamError) return sendError(reply, 400, 'bad-request', err.message);
      throw err;
    }
    const response: SearchResponse = ctx.library.search(query);
    return response;
  });
};
