/**
 * Guitar Pro free pack source adapter (T-026, D11); terms and approach in `docs/sources/candidates.md`
 * § Guitar Pro free pack.
 *
 * **Link-out only.** The pack has no licence and sits behind an email form, so nothing is downloaded
 * or committed: the adapter offers a link to the pack's page (opened in a new tab by the user's
 * browser) with "drop the files into your library" instructions. No network I/O.
 * @module
 */
import type { LinkOut, SourceAdapter } from '@shared/sources';
import { idleStatus } from '../stub';

/** The free pack's page on guitar-pro.com (no direct file URL exists). */
export const GP_PACK_URL = 'https://www.guitar-pro.com/free-tabs';

/** Hint shown under the link-out. */
export const GP_PACK_HINT = 'Free exercises, riffs and licks (an email address is required). Unzip the download and drop the .gp files here.';

/** Create the Guitar Pro free pack link-out adapter. It offers its link for any non-empty query. */
export function createGpPackAdapter(): SourceAdapter {
  const adapter: SourceAdapter = {
    id: 'gp-pack',
    displayName: 'Guitar Pro free pack',
    kind: 'link-out',
    termsDoc: 'docs/sources/candidates.md',
    linkOuts(query): LinkOut[] {
      if (!query.trim()) return [];
      return [{ source: 'gp-pack', label: 'Get the free Guitar Pro pack', url: GP_PACK_URL, hint: GP_PACK_HINT }];
    },
    status: async () => idleStatus(adapter, 'Link-out only: download the pack yourself, then drop the files into your library.'),
  };
  return adapter;
}
