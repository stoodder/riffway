/**
 * Smoke (T-010, refreshed in T-041): the production build loads with fake media + autoplay flags,
 * the API answers on the same origin, the `?e2e=1` hook is installed, and a fresh profile sees the
 * first-run home screen (screenshot `home`).
 */
import { expect, openApp, shot, test } from './support/test';

test('app shell loads with the e2e hook, API, fake media and the first-run home', async ({ page, request }) => {
  const health = await request.get('/api/health');
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({ ok: true });

  await openApp(page, '/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const label of ['Home', 'Library', 'Import', 'Audio setup', 'Settings']) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Riffway' })).toBeVisible();

  const hook = await page.evaluate(() => {
    const t = window.__riffwayTest;
    return t ? { version: t.version, ready: t.ready(), state: t.getState() } : null;
  });
  expect(hook).toMatchObject({ version: 1, ready: false, state: { route: { screen: 'home' }, session: null } });

  const media = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    stream.getTracks().forEach((t) => t.stop());
    const ctx = new AudioContext();
    await ctx.resume();
    const state = ctx.state;
    await ctx.close();
    return { inputs: inputs.length, state };
  });
  expect(media.inputs).toBeGreaterThan(0);
  expect(media.state).toBe('running');

  // First run: the setup checklist and the starter picks, easiest first.
  const checklist = page.getByRole('region', { name: /steps to your first song/i });
  await expect(checklist).toBeVisible();
  await expect(checklist.getByRole('link', { name: 'Choose input' })).toBeVisible();
  const starterPicks = page.getByRole('heading', { level: 2, name: 'Start here' });
  await expect(starterPicks).toBeVisible();
  await expect(page.getByRole('link', { name: /Open Strings & First Frets/ }).first()).toBeVisible();
  await shot(page, 'home');

  await nav.getByRole('link', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
});
