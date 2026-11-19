/**
 * Vitest: two projects sharing vite.config.ts (aliases).
 * - `node`: `tests/**\/*.test.ts` in Node. DOM tests opt in per file with
 *   `// @vitest-environment happy-dom`; IndexedDB tests `import 'fake-indexeddb/auto'`.
 * - `browser`: `tests/**\/*.browser.test.ts` in headless Chromium (Playwright) for Web Audio
 *   (`OfflineAudioContext`, worklets). Autoplay is allowed; fake media devices are on.
 * Run one: `npm run test:node` / `npm run test:browser`.
 */
import { existsSync } from 'node:fs';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

/** Pre-installed Chromium in the agent container (the pinned Playwright may expect another revision). */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';

export const chromiumArgs = [
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'node',
            environment: 'node',
            include: ['tests/**/*.test.ts'],
            exclude: ['tests/**/*.browser.test.ts', 'node_modules/**'],
          },
        },
        {
          extends: true,
          test: {
            name: 'browser',
            include: ['tests/**/*.browser.test.ts'],
            browser: {
              enabled: true,
              headless: true,
              screenshotFailures: false,
              provider: playwright({
                launchOptions: {
                  args: chromiumArgs,
                  ...(existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {}),
                },
              }),
              instances: [{ browser: 'chromium' }],
            },
          },
        },
      ],
    },
  }),
);
