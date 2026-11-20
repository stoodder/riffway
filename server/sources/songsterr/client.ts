/**
 * Remote search request (docs/guides/songsterr-search.md § 3c). This is the only module that may talk
 * to the remote site, and only for the opt-in search (`ServerConfig.remoteSearch`, off by default).
 *
 * The generic part is done: honest User-Agent, 4 s timeout, caller's abort signal, 403/429 →
 * {@link RemoteSearchRefused}, other failures → `Error`, no retries and no header games.
 *
 * OWNER: {@link buildSearchUrl} is yours to write. Until it returns a URL, remote search is
 * "not set up": {@link fetchSearch} throws {@link RemoteSearchUnavailable} without any request and
 * the route answers `status: 'off'` with {@link NOT_SET_UP_MESSAGE}.
 * @module
 */
import { RemoteSearchRefused, RemoteSearchUnavailable } from '@shared/sources';

/** Honest identification; no personal info. */
export const USER_AGENT = 'Riffway/0.1 (personal local practice app)';
export const TIMEOUT_MS = 4000;

/** Shown in the Library while {@link buildSearchUrl} returns null. */
export const NOT_SET_UP_MESSAGE = 'Songsterr search isn’t set up yet.';

/**
 * OWNER: build the search request URL for `query` (already trimmed, ≥ 3 characters, ≤ 200).
 * Returns null while not implemented: remote search then stays off and nothing is requested.
 */
export function buildSearchUrl(query: string): string | null {
  void query;
  return null;
}

/** Builds the request URL for a query, or null when remote search isn't set up. */
export type SearchUrlBuilder = (query: string) => string | null;

/** Injected in tests; defaults to global fetch. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Options for {@link fetchSearch} (tests inject both). */
export interface FetchSearchOptions {
  fetchImpl?: FetchLike;
  buildUrl?: SearchUrlBuilder;
}

/**
 * GET the search URL and return the parsed JSON. Throws {@link RemoteSearchUnavailable} (no request)
 * when the URL builder returns null, {@link RemoteSearchRefused} on 403/429 and `Error` otherwise
 * (timeout, network, non-2xx, bad JSON).
 */
export async function fetchSearch(query: string, signal: AbortSignal, opts: FetchSearchOptions = {}): Promise<unknown> {
  const url = (opts.buildUrl ?? buildSearchUrl)(query);
  if (url === null) throw new RemoteSearchUnavailable(NOT_SET_UP_MESSAGE);
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const res = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (res.status === 403 || res.status === 429) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new RemoteSearchRefused(res.status, text || `HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  return res.json();
}
