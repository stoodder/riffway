/**
 * Opt-in Songsterr results in Library search (T-130, docs/guides/songsterr-search.md), in fixture
 * mode: `playwright.config.ts` starts the server with `RIFFWAY_SONGSTERR_FIXTURES=e2e/fixtures/songsterr-mapped`,
 * so the adapter reads synthetic, already-mapped hits from `<query slug>.json` and requests nothing.
 * Turn it on in Settings, search, open a hit through the `window.open` stub (no tab, no request) and
 * play a hit that matches a library song. The network guard stays on; the setting is reset afterwards.
 * Screenshot: `library-songsterr`.
 */
import type { Page } from '@playwright/test';
import { expect, openApp, shot, test } from './support/test';

interface OpenedWindow {
  url: string;
  target: string | undefined;
  features: string | undefined;
}

declare global {
  interface Window {
    __openedWindows?: OpenedWindow[];
  }
}

/** Replace `window.open` with a recorder before the app loads (no tab, no request). */
async function stubWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__openedWindows = [];
    window.open = (url?: string | URL, target?: string, features?: string): Window | null => {
      window.__openedWindows?.push({ url: String(url), target, features });
      return null;
    };
  });
}

test.afterEach(async ({ request }) => {
  // The data dir is shared by the whole run: leave remote search off for the other specs.
  const res = await request.put('/api/config', { data: { remoteSearch: [] } });
  expect(res.ok()).toBe(true);
});

test('Songsterr results in Library search: opt in, open a hit, play a library match', async ({ page }) => {
  await stubWindowOpen(page);

  // Off by default: no "On Songsterr" group.
  await openApp(page, '/library');
  const search = page.getByRole('searchbox', { name: 'Search songs' });
  await search.fill('greensleeves');
  await expect(page.getByRole('region', { name: 'Find more tabs' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'On Songsterr' })).toHaveCount(0);

  // Opt in under Settings › Library & sources.
  await openApp(page, '/settings?tab=library');
  const toggle = page.getByRole('switch', { name: 'Show Songsterr results in Library search' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Library search now also shows Songsterr results.')).toBeVisible();

  await openApp(page, '/library');
  await page.getByRole('searchbox', { name: 'Search songs' }).fill('greensleeves');
  const remote = page.getByRole('region', { name: 'On Songsterr' });
  await expect(remote).toBeVisible();
  const open = remote.getByRole('button', { name: 'Open Fixture Riff Variations on Songsterr (opens a new tab)' });
  const play = remote.getByRole('button', { name: 'Play Greensleeves (in your library)' });
  await expect(open).toBeVisible();
  await expect(play).toBeVisible();
  await expect(remote).toContainText('The Fixture Band');
  await expect(remote).toContainText('Drop D');
  await remote.scrollIntoViewIfNeeded();
  await shot(page, 'library-songsterr');

  await open.click();
  const opened = await page.evaluate(() => window.__openedWindows ?? []);
  expect(opened).toEqual([{ url: 'https://fixtures.invalid/fixture-riff-variations', target: '_blank', features: 'noopener,noreferrer' }]);
  expect(page.context().pages()).toHaveLength(1);

  await play.click();
  await expect(page).toHaveURL(/#\/song\/starter%3Agreensleeves/);
});
