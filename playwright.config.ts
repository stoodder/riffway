/**
 * Playwright e2e (T-041). `npm run test:e2e` builds first, then this config starts the production
 * server (`node dist-server/index.js`) on a free port with a throwaway data dir whose library folder
 * holds authored fixtures (a Guitar Pro file and an ASCII tab; the starter library is always there).
 * Chromium flags: autoplay without a gesture, fake media devices, and a fake microphone that plays a
 * generated WAV (plucked A2). Screenshots (device scale factor 2) go to the git-ignored
 * `test-results/e2e-screenshots/`; `RIFFWAY_UPDATE_SCREENSHOTS=1 npm run test:e2e` refreshes the
 * committed `e2e/screenshots/` instead (see `e2e/support/env.ts` `screenshotDir`).
 *
 * Env: `RIFFWAY_E2E_PORT` (default: a free port, chosen once in the runner and inherited by the
 * workers, which re-evaluate this file) and `RIFFWAY_E2E_DATA_DIR` (default: a new temp dir).
 * On a fresh Mac run `npx playwright install chromium` once; the agent container uses its
 * preinstalled Chromium.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { fakeMicWav, freePortSync, libraryDir, prepareDataDir } from './e2e/support/env';

const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';

process.env.RIFFWAY_E2E_PORT ||= String(freePortSync());
process.env.RIFFWAY_E2E_DATA_DIR ||= mkdtempSync(join(tmpdir(), 'riffway-e2e-'));
const PORT = Number(process.env.RIFFWAY_E2E_PORT);
const dataDir = process.env.RIFFWAY_E2E_DATA_DIR;
// Idempotent: the runner seeds the dir; workers find it seeded and leave it alone.
prepareDataDir(dataDir);

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${fakeMicWav(dataDir)}`,
      ],
      ...(existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {}),
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 },
    },
  ],
  webServer: {
    command: 'node dist-server/index.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { RIFFWAY_PORT: String(PORT), RIFFWAY_DATA_DIR: dataDir, RIFFWAY_LIBRARY_DIR: libraryDir(dataDir), RIFFWAY_LOG_LEVEL: 'warn' },
  },
});
