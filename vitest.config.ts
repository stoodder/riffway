/**
 * Vitest: two projects sharing vite.config.ts (aliases).
 * - `node`: `tests/**\/*.test.ts` in Node. DOM tests opt in per file with
 *   `// @vitest-environment happy-dom`; IndexedDB tests `import 'fake-indexeddb/auto'`.
 * - `browser`: `tests/**\/*.browser.test.ts` in headless Chromium (Playwright) for Web Audio
 *   (`OfflineAudioContext`, worklets). Autoplay is allowed; fake media devices are on.
 * Run one: `npm run test:node` / `npm run test:browser`.
 *
 * Browser server port: Vitest's default (23315, then the next free one) collides when two runs
 * overlap (parallel agents, watch + CI): a port free on one loopback address can be taken on the
 * other, and a run's Chromium then talks to the other run's server. So the server binds 127.0.0.1
 * only, on `RIFFWAY_VITEST_BROWSER_PORT` when set (fixed, strict) or on a free port the OS picks.
 */
import { existsSync } from 'node:fs';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

/** Pre-installed Chromium in the agent container (the pinned Playwright may expect another revision). */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';

/** Browser-mode server: a fixed port from the environment, else 0 (the OS picks a free one). */
export function browserApiConfig(env: NodeJS.ProcessEnv = process.env): { host: string; port: number; strictPort: boolean } {
  const fixed = Number(env.RIFFWAY_VITEST_BROWSER_PORT);
  const port = Number.isInteger(fixed) && fixed > 0 && fixed < 65536 ? fixed : 0;
  return { host: '127.0.0.1', port, strictPort: port !== 0 };
}

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
            api: browserApiConfig(),
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
