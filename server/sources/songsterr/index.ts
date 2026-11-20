/**
 * Songsterr adapter: the link-out (always; `../linkout/songsterr.ts`) plus opt-in remote search
 * (`ServerConfig.remoteSearch`, off by default; docs/guides/songsterr-search.md).
 *
 * Remote search sends only the typed query, at most one request per second, caches answers for 24 h,
 * stops for the rest of the session on 403/429 ({@link RemoteSearchRefused}) and stays off while the
 * request URL isn't set up ({@link RemoteSearchUnavailable}, `client.ts`). Metadata only: no tab content.
 *
 * Fixture mode (`RIFFWAY_SONGSTERR_FIXTURES=<dir>`, used by the e2e suite): hits come from
 * `<dir>/<fixtureSlug(query)>.json` (already-mapped `RemoteSearchHit[]`, synthetic data) and nothing
 * is requested. A missing file means no hits.
 * @module
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RemoteSearchRefused, type RemoteSearchHit, type SourceAdapter } from '@shared/sources';
import { createSongsterrAdapter as createLinkOut } from '../linkout/songsterr';
import { matchLocalEntries } from '../linkout/match';
import { idleStatus } from '../stub';
import { createSearchCache } from './cache';
import { buildSearchUrl, fetchSearch, type FetchLike, type SearchUrlBuilder } from './client';
import { createLimiter } from './limiter';
import { mapSearchResponse } from './map';

/** Shorter queries return no hits and send nothing. */
export const MIN_QUERY = 3;
/** Queries are cut to this length. */
export const MAX_QUERY = 200;
/** Hits kept per query. */
export const MAX_HITS = 20;
/** Minimum time between two remote requests. */
export const REQUEST_INTERVAL_MS = 1000;
/** Env var for fixture mode (e2e). */
export const FIXTURES_ENV = 'RIFFWAY_SONGSTERR_FIXTURES';

/** Injectable dependencies (tests); the defaults are the real ones. */
export interface SongsterrAdapterDeps {
  /** Default: global `fetch`. */
  fetchImpl?: FetchLike;
  /** Default: `buildSearchUrl` from `client.ts` (null = not set up). */
  buildUrl?: SearchUrlBuilder;
  /** Default: `mapSearchResponse` from `map.ts`. */
  mapResponse?: (json: unknown) => RemoteSearchHit[];
  /** Fixture directory; default `process.env.RIFFWAY_SONGSTERR_FIXTURES` (unset = off). */
  fixturesDir?: string;
  /** Clock for the limiter and cache. */
  now?: () => number;
  /** Limiter interval (default {@link REQUEST_INTERVAL_MS}). */
  intervalMs?: number;
}

/** File name stem of a fixture for `query`: lower-case ASCII words joined by `-` (`"Fixture Riff!"` → `fixture-riff`). */
export function fixtureSlug(query: string): string {
  return query
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isHit(value: unknown): value is RemoteSearchHit {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.remoteId === 'string' && typeof v.title === 'string' && typeof v.url === 'string' && Array.isArray(v.tracks);
}

/** Read `<dir>/<slug>.json` (mapped hits). Missing file → `[]`; invalid items are skipped. */
export async function readFixtureHits(dir: string, query: string): Promise<RemoteSearchHit[]> {
  const slug = fixtureSlug(query);
  if (!slug) return [];
  let text: string;
  try {
    text = await readFile(join(dir, `${slug}.json`), 'utf8');
  } catch {
    return [];
  }
  const json: unknown = JSON.parse(text);
  if (!Array.isArray(json)) return [];
  return json.filter(isHit).map(({ localMatchIds: _ignored, ...hit }) => ({ ...hit, source: 'songsterr' as const }));
}

/** Songsterr: link-out (always) + opt-in remote search. */
export function createSongsterrAdapter(deps: SongsterrAdapterDeps = {}): SourceAdapter {
  const base = createLinkOut();
  const now = deps.now ?? Date.now;
  const cache = createSearchCache(200, 24 * 3600_000, now);
  const slot = createLimiter(deps.intervalMs ?? REQUEST_INTERVAL_MS, now);
  const buildUrl = deps.buildUrl ?? buildSearchUrl;
  const mapResponse = deps.mapResponse ?? mapSearchResponse;
  const fixturesDir = deps.fixturesDir ?? (process.env[FIXTURES_ENV] || undefined);
  let refused: { status: number; message: string } | null = null;

  async function remoteHits(q: string, signal: AbortSignal): Promise<RemoteSearchHit[]> {
    if (fixturesDir) return (await readFixtureHits(fixturesDir, q)).slice(0, MAX_HITS);
    const cached = cache.get(q);
    if (cached) return cached;
    await slot(signal);
    const hits = mapResponse(await fetchSearch(q, signal, { fetchImpl: deps.fetchImpl, buildUrl })).slice(0, MAX_HITS);
    cache.set(q, hits);
    return hits;
  }

  const adapter: SourceAdapter = {
    ...base,
    kind: 'link-out',
    async searchRemote(query, ctx, signal): Promise<RemoteSearchHit[]> {
      const q = query.trim().slice(0, MAX_QUERY);
      if (q.length < MIN_QUERY) return [];
      if (refused) throw new RemoteSearchRefused(refused.status, refused.message);
      let hits: RemoteSearchHit[];
      try {
        hits = await remoteHits(q, signal);
      } catch (err) {
        if (err instanceof RemoteSearchRefused) {
          refused = { status: err.status, message: err.message };
          ctx.log.warn(`Songsterr refused remote search (HTTP ${err.status}); off until restart`);
        }
        throw err;
      }
      const entries = ctx.entries();
      return hits.map((h) => {
        const ids = matchLocalEntries(`${h.title} ${h.artist ?? ''}`, entries);
        return ids.length ? { ...h, localMatchIds: ids } : h;
      });
    },
    status: async () => {
      if (refused) return idleStatus(adapter, `Remote search refused by the site (${refused.message.slice(0, 80)}). Link-out still works.`);
      if (fixturesDir) return idleStatus(adapter, `Link-out, plus remote search from local fixtures (${FIXTURES_ENV}).`);
      if (buildUrl('riffway') === null) return idleStatus(adapter, 'Link-out only: opens Songsterr search in a new tab and matches songs you imported. Remote search isn’t set up yet.');
      return idleStatus(adapter, 'Link-out, plus remote search when enabled in Settings.');
    },
  };
  return adapter;
}
