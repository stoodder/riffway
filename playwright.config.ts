/**
 * Playwright e2e (keyboard mode). `npm run test:e2e` builds first, then this config starts the
 * production server (`node dist-server/index.js`) on port 5175 with a throwaway data dir.
 * Chromium flags: autoplay without gesture + fake media devices. T-041 adds
 * `--use-file-for-fake-audio-capture=<abs>.wav` per spec via `test.use({ launchOptions })`.
 * Screenshots go to `e2e/screenshots/`. On a fresh Mac run `npx playwright install chromium` once.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.RIFFWAY_E2E_PORT || 5175);
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';
const dataDir = process.env.RIFFWAY_E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'riffway-e2e-'));

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
      ...(existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {}),
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium', viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: 'node dist-server/index.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { RIFFWAY_PORT: String(PORT), RIFFWAY_DATA_DIR: dataDir, RIFFWAY_LIBRARY_DIR: join(dataDir, 'library'), RIFFWAY_LOG_LEVEL: 'warn' },
  },
});
