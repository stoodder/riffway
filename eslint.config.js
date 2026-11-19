// ESLint flat config (non-type-aware for speed; `npm run typecheck` covers types).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Forbidden anywhere (app, server, scripts, tests): the Songsterr API (access declined, D1). */
const songsterrApi = [
  { selector: 'Literal[value=/songsterr\\.com\\/api/i]', message: 'The Songsterr API is forbidden (D1, docs/sources/songsterr.md).' },
  { selector: 'TemplateElement[value.raw=/songsterr\\.com\\/api/i]', message: 'The Songsterr API is forbidden (D1, docs/sources/songsterr.md).' },
];

/**
 * Ultimate Guitar is link-out only (docs/sources/ultimate-guitar.md): its URLs may appear only in the
 * link-out builders, which the player opens in a new tab and the app never requests.
 */
const ultimateGuitarUrls = [
  {
    selector: 'Literal[value=/ultimate-guitar\\.com/i]',
    message: 'Ultimate Guitar URLs belong in the link-out builders only (server/sources/linkout/, src/ui/screens/import/model.ts).',
  },
  {
    selector: 'TemplateElement[value.raw=/ultimate-guitar\\.com/i]',
    message: 'Ultimate Guitar URLs belong in the link-out builders only (server/sources/linkout/, src/ui/screens/import/model.ts).',
  },
];

/** The only modules allowed to build Ultimate Guitar URLs. */
const ULTIMATE_GUITAR_LINKOUT_BUILDERS = ['server/sources/linkout/**', 'src/ui/screens/import/model.ts'];

export default tseslint.config(
  {
    ignores: ['dist/**', 'dist-server/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'e2e/screenshots/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-restricted-syntax': ['error', ...songsterrApi],
    },
  },
  {
    // Shipped code (not tests, which assert the link-out URLs): no Ultimate Guitar URL outside the builders.
    files: ['src/**/*.ts', 'server/**/*.ts', 'shared/**/*.ts', 'scripts/**/*.ts'],
    ignores: ULTIMATE_GUITAR_LINKOUT_BUILDERS,
    rules: { 'no-restricted-syntax': ['error', ...songsterrApi, ...ultimateGuitarUrls] },
  },
  {
    // src/core is isomorphic (server, worker, worklet): no DOM/Web Audio/Node built-ins, no app layers.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'fs', 'path', 'os', 'crypto'], message: 'src/core must run in browsers/worklets too.' },
            { group: ['**/audio/**', '**/ui/**', '**/game/**', '**/storage/**', '**/api/**', '**/server/**'], message: 'src/core must not depend on app layers.' },
            { group: ['@shared/ui', '@shared/services'], message: 'Browser-only contracts are not allowed in src/core.' },
          ],
        },
      ],
    },
  },
  {
    // Browser code never imports server code or Node built-ins.
    files: ['src/**/*.ts'],
    ignores: ['src/core/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:*', '**/server/**'], message: 'Browser code cannot import Node or server modules.' }] }],
    },
  },
);
