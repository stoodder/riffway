/**
 * Audio setup with Chrome's fake microphone playing plucked A2s (see `support/env.ts`): the input
 * step opens the fake device and the level meter moves; the tuner reads A2 on string 5; the
 * latency step shows the calibration panel. Screenshots: `audio-setup`, `tuner`, `calibration`.
 */
import type { Locator } from '@playwright/test';
import { expect, openApp, shot, test } from './support/test';

/** Sample a meter's `aria-valuenow` (dB) a few times. */
async function sampleMeter(meter: Locator, count: number, everyMs: number): Promise<number[]> {
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    values.push(Number(await meter.getAttribute('aria-valuenow')));
    await meter.page().waitForTimeout(everyMs);
  }
  return values;
}

test('fake device: meter moves, tuner reads A2, calibration step', async ({ page }) => {
  await openApp(page, '/audio-setup');
  await expect(page.getByRole('heading', { level: 1, name: 'Audio setup' })).toBeVisible();
  const steps = page.getByRole('navigation', { name: 'Setup steps' });

  // ---- Step 1: input + level ----
  // The card (`.rw-input`, not the screen's slot, which shares `data-panel`) settles first: the input
  // either opened on its own (the fake-UI flag grants the permission) or offers "Connect". Only then
  // is the button clicked, so it can't vanish under the click (R2-S-03).
  const input = page.locator('.rw-input[data-panel="input"]');
  await expect(input).toHaveAttribute('data-state', /^(listening|idle|disconnected)$/);
  if ((await input.getAttribute('data-state')) !== 'listening') await input.getByRole('button', { name: 'Connect guitar input' }).click();
  await expect(input).toHaveAttribute('data-state', 'listening');
  await expect(input.locator('.rw-input__status')).toHaveText('Listening');
  await expect(input.getByRole('combobox', { name: 'Input device' })).toBeVisible();
  const meter = input.getByRole('meter', { name: 'Input level' });
  await expect.poll(async () => Number(await meter.getAttribute('aria-valuenow')), { timeout: 10_000 }).toBeGreaterThan(-30);
  // Plucks decay by ~12 dB each: the meter must move, not sit at one value.
  const levels = await sampleMeter(meter, 8, 150);
  expect(new Set(levels).size, `meter values ${levels.join(', ')}`).toBeGreaterThan(1);
  expect(Math.max(...levels)).toBeGreaterThan(-30);
  await shot(page, 'audio-setup');

  // ---- Step 2: tuner ----
  await steps.getByRole('button', { name: /^Tune/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Tune up' })).toBeVisible();
  const tuner = page.locator('[data-panel="tuner"]');
  await expect(tuner.locator('.rw-tuner__name')).toHaveText('A', { timeout: 10_000 });
  await expect(tuner.locator('.rw-tuner__oct')).toHaveText('2');
  await expect(tuner.locator('.rw-tuner__stage')).toHaveAttribute('data-state', 'in-tune', { timeout: 10_000 });
  await expect(tuner.locator('.rw-tuner__string[data-string="5"]')).toHaveClass(/is-target/);
  await shot(page, 'tuner');

  // ---- Step 4: latency calibration ----
  await steps.getByRole('button', { name: /^Latency/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Calibrate latency' })).toBeVisible();
  const calibration = page.getByRole('region', { name: 'Latency calibration' });
  await expect(calibration).toBeVisible();
  await expect(calibration.getByText('Loading calibration…')).toHaveCount(0);
  await expect(calibration.getByText('Current calibration')).toBeVisible();
  await shot(page, 'calibration');
});
