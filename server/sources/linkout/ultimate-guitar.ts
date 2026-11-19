/**
 * Ultimate Guitar source adapter (T-026); terms and approach in `docs/sources/ultimate-guitar.md`.
 *
 * **Link-out only.** UG's terms allow linking but no automated access (and robots.txt disallows
 * `/search.php`), so this adapter only builds the search URL that the user's browser opens in a new
 * tab. Tabs come in through the user's own action: ASCII paste on the Import screen, or a Guitar Pro
 * file from their account dropped into the library. Never request `ultimate-guitar.com`.
 * @module
 */
import type { LinkOut, SourceAdapter } from '@shared/sources';
import { idleStatus } from '../stub';

/** UG's title search page. */
export const ULTIMATE_GUITAR_SEARCH_BASE = 'https://www.ultimate-guitar.com/search.php';

/** URL of UG's title search for `query`: `…/search.php?search_type=title&value=<query>`. */
export function ultimateGuitarSearchUrl(query: string): string {
  return `${ULTIMATE_GUITAR_SEARCH_BASE}?search_type=title&value=${encodeURIComponent(query.trim())}`;
}

/** Hint shown under the link-out: the paste flow and manual file import. */
export const ULTIMATE_GUITAR_HINT = 'Copy a tab for personal practice and paste it on the Import screen, or drop a Guitar Pro file here.';

/** Create the Ultimate Guitar link-out adapter. */
export function createUltimateGuitarAdapter(): SourceAdapter {
  const adapter: SourceAdapter = {
    id: 'ultimate-guitar',
    displayName: 'Ultimate Guitar',
    kind: 'link-out',
    termsDoc: 'docs/sources/ultimate-guitar.md',
    linkOuts(query): LinkOut[] {
      if (!query.trim()) return [];
      return [{ source: 'ultimate-guitar', label: 'Search on Ultimate Guitar', url: ultimateGuitarSearchUrl(query), hint: ULTIMATE_GUITAR_HINT }];
    },
    status: async () => idleStatus(adapter, 'Link-out only: opens Ultimate Guitar search in a new tab; paste tabs on the Import screen.'),
  };
  return adapter;
}
