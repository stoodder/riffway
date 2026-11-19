import { expect, test } from '@playwright/test';

// Foundation smoke (T-010): the production build loads with fake media + autoplay flags,
// the API answers through the same origin, and the ?e2e=1 hook is installed.
test('app shell loads with the e2e hook, API and fake media', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  const health = await request.get('/api/health');
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({ ok: true });

  await page.goto('/?e2e=1');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  for (const label of ['Home', 'Library', 'Import', 'Audio setup', 'Settings']) {
    await expect(page.getByRole('link', { name: label })).toBeVisible();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();

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

  await page.getByRole('link', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  expect(errors).toEqual([]);
});
