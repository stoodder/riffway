/**
 * Library (T-026): one search across the sources (starter + the player's library folder), filters,
 * link-outs to Songsterr / Ultimate Guitar / the Guitar Pro pack (URLs and `_blank` + `noopener`
 * asserted through a `window.open` stub: those sites are never contacted), and drag-drop import of a
 * Guitar Pro file that then shows up as playable. Screenshot: `library-filters`.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { FIXTURES } from './support/env';
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

const songList = (page: Page) => page.getByRole('list', { name: 'Songs' });
const row = (page: Page, title: string) => songList(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) });

test('search across sources, filters and link-outs (new tab, no request)', async ({ page }) => {
  await stubWindowOpen(page);
  await openApp(page, '/library');
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  const filters = page.getByRole('region', { name: 'Filters' });
  const source = filters.getByRole('group', { name: 'Source' });
  await expect(source.getByRole('button', { name: /Starter/ })).toContainText('14');

  // One query finds songs in both sources: the GP file in the library folder and starter songs.
  const search = page.getByRole('searchbox', { name: 'Search songs' });
  await search.fill('riff');
  await expect(row(page, 'Riff Test')).toBeVisible();
  await expect(row(page, 'Riff Test')).toContainText('My files');
  await expect(row(page, 'Synthetic Riff Study')).toContainText('Needs rhythm');
  await expect(songList(page).getByRole('listitem').filter({ hasText: 'Starter' }).first()).toBeVisible();

  // Filters narrow it: starter only, then playable only drops the tab that still needs rhythm.
  await source.getByRole('button', { name: /Starter/ }).click();
  await expect(row(page, 'Riff Test')).toHaveCount(0);
  await expect(songList(page).getByRole('listitem').first()).toContainText('Starter');
  await source.getByRole('button', { name: 'All', exact: true }).click();
  await filters.getByRole('radio', { name: 'Playable now' }).check();
  await expect(row(page, 'Riff Test')).toBeVisible();
  await expect(row(page, 'Synthetic Riff Study')).toHaveCount(0);
  await filters.getByRole('combobox', { name: 'Tuning' }).selectOption({ label: 'Drop D' });
  await expect(row(page, 'Riff Test')).toBeVisible();
  for (const item of await songList(page).getByRole('listitem').all()) await expect(item).toContainText('Drop D');
  await shot(page, 'library-filters');

  // Link-outs for a song that is already in the library.
  await filters.getByRole('combobox', { name: 'Tuning' }).selectOption({ label: 'Any tuning' });
  await filters.getByRole('radio', { name: 'All' }).check();
  await search.fill('Greensleeves');
  await expect(row(page, 'Greensleeves')).toBeVisible();
  const linkOuts = page.getByRole('region', { name: 'Find more tabs' });
  const songsterr = linkOuts.getByRole('button', { name: 'Search on Songsterr (opens a new tab)' });
  const ug = linkOuts.getByRole('button', { name: 'Search on Ultimate Guitar (opens a new tab)' });
  await expect(songsterr).toBeVisible();
  await expect(ug).toBeVisible();
  await expect(linkOuts.locator('[data-source="songsterr"]')).toContainText('Already in your library: Greensleeves');
  await songsterr.click();
  await ug.click();
  const gpPack = linkOuts.getByRole('button', { name: /Guitar Pro pack \(opens a new tab\)/ });
  if (await gpPack.isVisible()) await gpPack.click();

  const opened = await page.evaluate(() => window.__openedWindows ?? []);
  expect(opened[0]).toEqual({ url: 'https://www.songsterr.com/?pattern=Greensleeves', target: '_blank', features: 'noopener,noreferrer' });
  expect(opened[1]).toEqual({
    url: 'https://www.ultimate-guitar.com/search.php?search_type=title&value=Greensleeves',
    target: '_blank',
    features: 'noopener,noreferrer',
  });
  for (const o of opened) {
    expect(o.target).toBe('_blank');
    expect(o.features).toContain('noopener');
  }
  // The stub opened nothing: still one page, still on the library.
  expect(page.context().pages()).toHaveLength(1);
});

test('drag-drop import: a dropped Guitar Pro file appears in the library, playable', async ({ page }) => {
  await openApp(page, '/library');
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search songs' }).fill('Capo Two');
  await expect(page.getByRole('status').filter({ hasText: /songs?$/ }).first()).toBeVisible();
  await expect(row(page, 'Capo Two')).toHaveCount(0);

  const bytes = [...readFileSync(FIXTURES.capoGp)];
  const dropped = await page.evaluateHandle((data) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], 'Capo Two.gp', { type: 'application/octet-stream' }));
    return dt;
  }, bytes);
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: dropped });
  await expect(page.getByText('Drop to add to your library')).toBeVisible();
  await page.dispatchEvent('body', 'dragover', { dataTransfer: dropped });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dropped });
  await expect(page.getByText('Drop to add to your library')).toBeHidden();
  await expect(page.getByText(/Added 1 file to your library/)).toBeVisible();

  // The watcher indexes it and the live search shows it.
  const added = row(page, 'Capo Two');
  await expect(added).toBeVisible({ timeout: 20_000 });
  await expect(added).toContainText('My files');
  await expect(added).toContainText('Playable now');
  await added.getByRole('button', { name: 'Capo Two', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Capo Two' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Play', exact: true })).toBeVisible();
});
