/**
 * Shared Playwright fixtures and helpers for the e2e specs.
 *
 * Every test gets two automatic guards:
 * - **Network guard:** the browser context routes every request; anything not on the loopback
 *   server is aborted and fails the test. Songsterr and Ultimate Guitar are named explicitly (D1):
 *   specs assert link-out URLs and targets, they never follow them.
 * - **Page errors:** an uncaught exception in the page fails the test.
 * @module
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import type { Judgement } from '@shared/judge';
import type { TestHookState } from '@shared/ui';
import type { RiffwayTestHookExt, TestHookNote } from '../../src/test-hooks';
import { screenshotDir } from './env';

/** Hosts the app and the tests must never contact (link-out only, D1). */
export const FORBIDDEN_HOSTS = /(^|\.)(songsterr\.com|ultimate-guitar\.com)$/i;

function isLoopback(url: URL): boolean {
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
}

interface Guards {
  /** Requests the network guard blocked (non-loopback), for specs that want to inspect them. */
  blockedRequests: string[];
  pageErrors: string[];
}

export const test = base.extend<Guards>({
  blockedRequests: [
    async ({ context }, use) => {
      const blocked: string[] = [];
      await context.route(
        (url) => FORBIDDEN_HOSTS.test(url.hostname) || ((url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:') && !isLoopback(url)),
        (route) => {
          blocked.push(route.request().url());
          return route.abort('blockedbyclient');
        },
      );
      await use(blocked);
      expect(blocked, 'requests outside the local server (Songsterr/UG must never be contacted)').toEqual([]);
    },
    { auto: true },
  ],
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await use(errors);
      expect(errors, 'uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Open a hash route with the e2e hook installed (`/?e2e=1#/…`). */
export async function openApp(page: Page, hashPath = '/'): Promise<void> {
  await page.goto(`/?e2e=1#${hashPath.startsWith('/') ? hashPath : `/${hashPath}`}`);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/**
 * Save a full-resolution screenshot as `<name>.png` in {@link screenshotDir}: `test-results/e2e-screenshots/`
 * by default, the committed `e2e/screenshots/` with `RIFFWAY_UPDATE_SCREENSHOTS=1`.
 */
export async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}): Promise<void> {
  const dir = screenshotDir();
  mkdirSync(dir, { recursive: true });
  // Let fonts settle; never capture a blinking caret.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: opts.fullPage ?? false, caret: 'hide' });
}

/** Wait until the game session on screen has loaded (test hook `ready()`). */
export async function waitForSession(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__riffwayTest?.ready() === true, null, { timeout: 30_000 });
}

/** The session song's judge targets (test hook `getNotes()`). */
export function sessionNotes(page: Page): Promise<TestHookNote[]> {
  return page.evaluate(() => (window.__riffwayTest as RiffwayTestHookExt).getNotes());
}

/** Test hook state snapshot. */
export function hookState(page: Page): Promise<TestHookState> {
  return page.evaluate(() => (window.__riffwayTest as RiffwayTestHookExt).getState());
}

/** Final judgements of the current (or last) run. */
export function judgements(page: Page): Promise<Judgement[]> {
  return page.evaluate(() => (window.__riffwayTest as RiffwayTestHookExt).getJudgements());
}

/** Script onsets through the test hook (queued until the pass reaches each time). */
export async function inject(page: Page, events: { lane: number; songTime: number; wrongPitch?: boolean }[]): Promise<void> {
  await page.evaluate((evs) => {
    const hook = window.__riffwayTest as RiffwayTestHookExt;
    for (const e of evs) hook.inject({ lane: e.lane as 1 | 2 | 3 | 4 | 5 | 6, songTime: e.songTime, ...(e.wrongPitch ? { wrongPitch: true } : {}) });
  }, events);
}

/** Wait until the session's song time reaches `songTime` (polled every animation frame). */
export async function waitForSongTime(page: Page, songTime: number, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (t) => {
      const s = window.__riffwayTest?.getState().session;
      return s !== null && s !== undefined && (s.state === 'playing' || s.state === 'count-in') && s.songTime >= t;
    },
    songTime,
    { polling: 'raf', timeout },
  );
}

/** Press Play on the start card (the session must be ready). */
export async function pressPlay(page: Page): Promise<void> {
  await page.getByRole('dialog', { name: 'Ready to play' }).getByRole('button', { name: 'Play', exact: true }).click();
}
