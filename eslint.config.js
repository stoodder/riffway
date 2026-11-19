// ESLint flat config (non-type-aware for speed; `npm run typecheck` covers types).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Forbidden anywhere: the Songsterr API (access declined, D1). */
const noSongsterrApi = [
  'error',
  { selector: 'Literal[value=/songsterr\\.com\\/api/i]', message: 'The Songsterr API is forbidden (D1, docs/sources/songsterr.md).' },
  { selector: 'TemplateElement[value.raw=/songsterr\\.com\\/api/i]', message: 'The Songsterr API is forbidden (D1, docs/sources/songsterr.md).' },
];

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
      'no-restricted-syntax': noSongsterrApi,
    },
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
