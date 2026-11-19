/**
 * Data (T-020/T-035): settings and progress persist across a reload (IndexedDB), and an exported
 * backup restores them after "Delete all data" (export → import round trip, Replace mode).
 * Screenshot: `settings`.
 */
import type { Page } from '@playwright/test';
import { expect, inject, openApp, pressPlay, sessionNotes, shot, test, waitForSession, waitForSongTime } from './support/test';

const SONG = 'starter:open-strings-first-frets';

/** Play the first four notes of the first starter song through the test hook, end the run, see results. */
async function quickRun(page: Page): Promise<void> {
  await openApp(page, `/play/${encodeURIComponent(SONG)}?mode=play`);
  await waitForSession(page);
  const notes = (await sessionNotes(page)).slice(0, 4);
  await inject(page, notes.map((n) => ({ lane: n.lane, songTime: n.songTime })));
  await pressPlay(page);
  await waitForSongTime(page, (notes.at(-1)?.songTime ?? 0) + 0.2);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Paused' }).getByRole('button', { name: 'End run & see results' }).click();
  await expect(page).toHaveURL(/#\/results\//);
  await expect(page.getByRole('region', { name: 'Notes' })).toContainText('4');
}

/** The "Your data" count for a store on Settings → Data. */
function localCount(page: Page, key: string) {
  return page.locator(`.set-counts--local [data-count="${key}"] dd`);
}

/**
 * Hand the exported file to the Import section through the real file chooser ("Choose backup
 * file…" → Chrome's picker → `change`), as a player does.
 */
async function chooseBackup(page: Page, path: string): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Choose backup file…' }).click()]);
  await chooser.setFiles(path);
}

/** The "Feedback detail" choice on Settings → Gameplay. */
function feedbackDetail(page: Page) {
  return page.getByRole('tabpanel', { name: 'Gameplay' }).getByRole('group', { name: 'Feedback detail' });
}

async function openDataTab(page: Page): Promise<void> {
  await openApp(page, '/settings');
  await page.getByRole('tab', { name: 'Data' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Data' })).toBeVisible();
}

test('settings and progress persist across a reload', async ({ page }) => {
  await openApp(page, '/settings');
  const gameplay = page.getByRole('tabpanel', { name: 'Gameplay' });
  await feedbackDetail(page).getByText('Detailed', { exact: true }).click();
  await expect(feedbackDetail(page).getByRole('radio', { name: /^Detailed/ })).toBeChecked();
  const handCues = gameplay.getByRole('switch', { name: 'Hand-position cues' });
  await handCues.click();
  await expect(handCues).toHaveAttribute('aria-checked', 'false');
  await handCues.click();
  await expect(handCues).toHaveAttribute('aria-checked', 'true');
  const strict = gameplay.getByRole('switch', { name: 'Strict octave' });
  await strict.click();
  await expect(strict).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'settings');

  await quickRun(page);
  await page.reload();
  // The results page is rebuilt from storage.
  await expect(page.getByRole('heading', { level: 1, name: /Open Strings & First Frets/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Notes' }).locator('.rs-count[data-outcome="perfect"]')).toContainText('4');

  await openApp(page, '/settings');
  await page.reload();
  const after = page.getByRole('tabpanel', { name: 'Gameplay' });
  await expect(feedbackDetail(page).getByRole('radio', { name: /^Detailed/ })).toBeChecked();
  await expect(after.getByRole('switch', { name: 'Strict octave' })).toHaveAttribute('aria-checked', 'true');

  // The run is stored (a run ended early sets no best, so check the stores).
  await openDataTab(page);
  await page.reload();
  await expect(localCount(page, 'runs')).toHaveText('1');
  await expect(localCount(page, 'practiceDays')).toHaveText('1');
});

// The title stays ASCII: it names the output folder the backup is saved in, and Chromium's file
// input silently ignores a file whose path has non-ASCII characters (an arrow here once did; T-041 note 7).
test('export, delete all data, import (replace): progress and settings come back', async ({ page }, testInfo) => {
  await openApp(page, '/settings');
  await feedbackDetail(page).getByText('Minimal', { exact: true }).click();
  await expect(feedbackDetail(page).getByRole('radio', { name: /^Minimal/ })).toBeChecked();
  await quickRun(page);

  // ---- Export ----
  await openDataTab(page);
  await expect(localCount(page, 'runs')).toHaveText('1');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^riffway-backup-.*\.json$/);
  const backup = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(backup);
  await expect(page.getByText(`Saved ${download.suggestedFilename()}`)).toBeVisible();

  // ---- Delete everything ----
  await page.getByRole('button', { name: 'Delete all data…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete all Riffway data?' });
  await confirm.getByRole('button', { name: 'Delete everything' }).click();
  await expect(page.getByText('All data deleted.')).toBeVisible();
  await expect(localCount(page, 'runs')).toHaveText('0');
  await page.getByRole('tab', { name: 'Gameplay' }).click();
  await expect(feedbackDetail(page).getByRole('radio', { name: /^Standard/ })).toBeChecked();

  // ---- Import (replace) ----
  await page.getByRole('tab', { name: 'Data' }).click();
  await chooseBackup(page, backup);
  await expect(page.getByRole('heading', { name: 'Ready to import' })).toBeVisible();
  await expect(page.locator('.set-preview [data-count="runs"] dd')).toHaveText('1');
  await page.getByText('Replace', { exact: true }).click();
  await page.getByRole('button', { name: 'Replace my data' }).click();
  await page.getByRole('dialog', { name: 'Replace your data?' }).getByRole('button', { name: 'Replace my data' }).click();
  await expect(page.getByText('Backup restored.')).toBeVisible();
  await expect(localCount(page, 'runs')).toHaveText('1');

  // Restored settings and progress survive a reload too.
  await page.reload();
  await expect(localCount(page, 'runs')).toHaveText('1');
  await page.getByRole('tab', { name: 'Gameplay' }).click();
  await expect(feedbackDetail(page).getByRole('radio', { name: /^Minimal/ })).toBeChecked();
});
