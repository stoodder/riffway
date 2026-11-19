/**
 * Songsterr source adapter (T-026); terms and approach in `docs/sources/songsterr.md`.
 *
 * **Link-out only (D1).** Songsterr declined API access to automated clients, so this adapter does
 * no network I/O at all: it builds the site's search URL (opened by the user's browser in a new tab)
 * and matches songs already in the library by normalised title/artist. Never request
 * `songsterr.com` from the app, the server or tests.
 * @module
 */
import type { LinkOut, SourceAdapter } from '@shared/sources';
import { idleStatus } from '../stub';
import { matchLocalEntries } from './match';

/** Songsterr's search page (the query goes in `pattern`). */
export const SONGSTERR_SEARCH_BASE = 'https://www.songsterr.com/';

/** URL of Songsterr's search results for `query`: `https://www.songsterr.com/?pattern=<query>`. */
export function songsterrSearchUrl(query: string): string {
  return `${SONGSTERR_SEARCH_BASE}?pattern=${encodeURIComponent(query.trim())}`;
}

/** Hint shown under the link-out: how a Songsterr song gets into the library (no workaround for free users). */
export const SONGSTERR_HINT =
  'Songsterr Plus can download the Guitar Pro file; drop it here to play it. Free accounts have no file download.';

/** Create the Songsterr link-out adapter. */
export function createSongsterrAdapter(): SourceAdapter {
  const adapter: SourceAdapter = {
    id: 'songsterr',
    displayName: 'Songsterr',
    kind: 'link-out',
    termsDoc: 'docs/sources/songsterr.md',
    linkOuts(query): LinkOut[] {
      if (!query.trim()) return [];
      return [{ source: 'songsterr', label: 'Search on Songsterr', url: songsterrSearchUrl(query), hint: SONGSTERR_HINT }];
    },
    matchLocal: matchLocalEntries,
    status: async () => idleStatus(adapter, 'Link-out only: opens Songsterr search in a new tab and matches songs you imported.'),
  };
  return adapter;
}
