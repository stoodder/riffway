/**
 * Playwright config for the T-022 fake-capture tests: Chrome's fake microphone plays a generated WAV
 * (`--use-file-for-fake-audio-capture`) into the input + tuner panels on a Vite dev server.
 * Run: `npx playwright test -c tests/input/e2e/playwright.config.ts`. Screenshots land in
 * `test-results/input-e2e/` (git-ignored). Port: `RIFFWAY_INPUT_E2E_PORT` or a random one in 5200–5999.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// Chosen once in the runner and inherited by the workers (which re-evaluate this file).
process.env.RIFFWAY_INPUT_E2E_PORT ||= String(5200 + Math.floor(Math.random() * 800));
const PORT = Number(process.env.RIFFWAY_INPUT_E2E_PORT);
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: `${ROOT}test-results/input-e2e/output`,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    channel: 'chromium',
    viewport: { width: 1280, height: 800 },
    launchOptions: existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {},
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: ROOT,
    url: `http://127.0.0.1:${PORT}/tests/input/e2e/harness.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
