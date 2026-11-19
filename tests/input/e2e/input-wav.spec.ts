/**
 * T-022 with Chrome's fake microphone playing generated WAVs: the input panel opens the fake device
 * (constraints honoured, level meter moving) and the tuner reads the tone — an in-tune A2 in
 * standard tuning and a flat D2 in Drop D. Screenshots go to `test-results/input-e2e/`.
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type Page } from '@playwright/test';
import { writeToneWav } from './wav';

const SHOTS = fileURLToPath(new URL('../../../test-results/input-e2e/', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'riffway-input-e2e-'));
// 110 Hz × 4.8 s and 72.5 Hz × 4.8 s are whole numbers of periods: the fake device loops seamlessly.
const A2_WAV = join(dir, 'a2.wav');
const FLAT_D2_WAV = join(dir, 'd2-flat.wav');
writeToneWav(A2_WAV, 110, 4.8);
writeToneWav(FLAT_D2_WAV, 72.5, 4.8);
if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';

function chromeWith(wav: string) {
  return {
    ...(existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {}),
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
    ],
  };
}

/** Launch Chromium whose fake microphone plays `wav`, run `body` on a fresh page, close it. */
async function withFakeMic(
  baseURL: string | undefined,
  wav: string,
  body: (page: Page) => Promise<void>,
): Promise<void> {
  const browser = await chromium.launch(chromeWith(wav));
  try {
    const page = await browser.newPage({ baseURL, viewport: { width: 1280, height: 800 } });
    await body(page);
  } finally {
    await browser.close();
  }
}

async function connect(page: Page, query = ''): Promise<void> {
  await page.goto(`/tests/input/e2e/harness.html${query}`);
  await expect(page.locator('body[data-ready="1"]')).toBeAttached();
  // With the fake-UI flag Chrome reports the microphone as granted, so the panel may already have
  // opened the input on mount (as it does for a returning player); otherwise connect explicitly.
  const connectButton = page.locator('[data-panel="input"] .rw-input__connect button');
  if (await connectButton.isVisible()) await connectButton.click();
  await expect(page.locator('[data-panel="input"] .rw-input__status')).toHaveText('Listening');
}

test('in-tune A2: meter moves, no processing warning, tuner shows A2 in tune on string 5', async ({ baseURL }) => {
  await withFakeMic(baseURL, A2_WAV, async (page) => {
    await connect(page);
    const input = page.locator('[data-panel="input"]');
    await expect(input.locator('[data-notice]')).toHaveCount(0);
    await expect(input.locator('.rw-input__details')).toContainText('kHz');
    const meter = input.locator('[role="meter"]');
    await expect.poll(async () => Number(await meter.getAttribute('aria-valuenow')), { timeout: 5000 }).toBeGreaterThan(-20);

    const tuner = page.locator('[data-panel="tuner"]');
    await expect(tuner.locator('.rw-tuner__name')).toHaveText('A', { timeout: 5000 });
    await expect(tuner.locator('.rw-tuner__oct')).toHaveText('2');
    await expect(tuner.locator('.rw-tuner__stage')).toHaveAttribute('data-state', 'in-tune', { timeout: 5000 });
    await expect(tuner.locator('.rw-tuner__hint')).toHaveText('String 5 in tune');
    await expect(tuner.locator('.rw-tuner__string[data-string="5"]')).toHaveClass(/is-target/);
    const cents = Number((await tuner.locator('.rw-tuner__cents').textContent())?.replace('−', '-').replace(/[^\d+-]/g, ''));
    expect(Math.abs(cents)).toBeLessThanOrEqual(3);
    await page.screenshot({ path: join(SHOTS, 'input-tuner-a2-in-tune.png'), fullPage: true });

    // The choice persists (IndexedDB settings): a reload re-opens the same input without a click.
    await page.reload();
    await expect(page.locator('body[data-ready="1"]')).toBeAttached();
    await expect(input.locator('.rw-input__status')).toHaveText('Listening');
  });
});

test('flat D2 in Drop D: tuner targets string 6 = D2 and says to tune up', async ({ baseURL }) => {
  await withFakeMic(baseURL, FLAT_D2_WAV, async (page) => {
    await connect(page, '?tuning=drop-d');
    const tuner = page.locator('[data-panel="tuner"]');
    await expect(tuner.locator('.rw-card__aside')).toHaveText('Drop D');
    await expect(tuner.locator('.rw-tuner__name')).toHaveText('D', { timeout: 5000 });
    await expect(tuner.locator('.rw-tuner__hint')).toHaveText('Tune up to D2');
    await expect(tuner.locator('.rw-tuner__string[data-string="6"]')).toHaveAttribute('data-direction', 'up');
    await expect(tuner.locator('.rw-tuner__cents')).toHaveText(/^−(2[0-3]) ¢$/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, 'input-tuner-drop-d-flat.png'), fullPage: true });
  });
});
