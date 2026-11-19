/**
 * Import (T-028): paste an ASCII tab, check what was read, snap its rhythm to the grid, preview,
 * save it to the library and play it. The Ultimate Guitar link on this screen is asserted (URL,
 * `_blank`, `noopener`), never followed. Screenshot: `import-alignment`.
 */
import { readFileSync } from 'node:fs';
import { FIXTURES } from './support/env';
import { expect, openApp, sessionNotes, shot, test, waitForSession } from './support/test';

test('paste ASCII → snap to grid → save → playable', async ({ page }) => {
  await openApp(page, '/import');
  await expect(page.getByRole('heading', { level: 1, name: 'Import a tab' })).toBeVisible();

  const ug = page.getByRole('link', { name: 'Search on Ultimate Guitar' });
  await expect(ug).toHaveAttribute('href', /^https:\/\/www\.ultimate-guitar\.com\/search\.php\?/);
  await expect(ug).toHaveAttribute('target', '_blank');
  await expect(ug).toHaveAttribute('rel', /noopener/);

  const save = page.getByRole('button', { name: 'Save to library' });
  await expect(save).toBeDisabled();
  await page.getByRole('textbox', { name: 'Tab text' }).fill(readFileSync(FIXTURES.pasteTab, 'utf8'));
  // What Riffway read: one six-string staff, four bars.
  const read = page.getByRole('status').filter({ hasText: /bar|note|string/i }).first();
  await expect(read).toBeVisible();
  await expect(read).not.toContainText('Nothing pasted yet');

  await page.getByRole('textbox', { name: 'Title' }).fill('E2E Arpeggio Study');
  await page.getByRole('textbox', { name: 'Artist' }).fill('Riffway Tests');
  await page.getByRole('spinbutton', { name: 'Tempo (BPM, quarter notes)' }).fill('90');

  // Snap to grid (the default method) with an explicit 1/8 grid: the tab spacing is eighth notes.
  await expect(page.getByRole('tab', { name: 'Snap to grid' })).toHaveAttribute('aria-selected', 'true');
  const grid = page.getByRole('radiogroup', { name: 'Grid' });
  await grid.getByText('1/8', { exact: true }).click();
  await expect(grid.getByRole('radio', { name: '1/8', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Play preview' })).toBeEnabled();
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find((el) => el.textContent === '3 · Rhythm');
    h?.scrollIntoView({ block: 'start' });
    // Clear the sticky app header.
    window.scrollBy(0, -(document.querySelector('header')?.getBoundingClientRect().height ?? 0) - 16);
  });
  await shot(page, 'import-alignment');

  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText(/Saved “E2E Arpeggio Study” to your library/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'E2E Arpeggio Study' })).toBeVisible({ timeout: 15_000 });
  const play = page.getByRole('link', { name: 'Play', exact: true });
  await expect(play).toBeVisible();

  // Playable: the game loads it, with 4 bars × 8 eighths = 32 notes on the highway.
  await play.click();
  await waitForSession(page);
  await expect(page.getByRole('dialog', { name: 'Ready to play' })).toContainText('E2E Arpeggio Study');
  const notes = await sessionNotes(page);
  expect(notes).toHaveLength(32);
  // Snapped to the eighth-note grid at 90 BPM: every onset is a multiple of 1/3 s (stored to the microsecond).
  for (const n of notes) expect(Math.abs(n.songTime * 3 - Math.round(n.songTime * 3))).toBeLessThan(1e-4);

  // It is in the library now, playable, under "My files".
  await openApp(page, '/library');
  await page.getByRole('searchbox', { name: 'Search songs' }).fill('E2E Arpeggio');
  const row = page.getByRole('list', { name: 'Songs' }).getByRole('listitem').filter({ hasText: 'E2E Arpeggio Study' });
  await expect(row).toContainText('Playable now');
  await expect(row).toContainText('My files');
});
