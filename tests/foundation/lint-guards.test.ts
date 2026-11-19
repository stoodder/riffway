/**
 * The source-policy lint guards in eslint.config.js (D1, docs/sources/): `songsterr.com/api` is
 * banned everywhere; Ultimate Guitar URLs only appear in the link-out builders.
 */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: process.cwd() });
/** The banned path, assembled so this file does not trip the guard it tests. */
const SONGSTERR_API = ['songsterr.com', 'api'].join('/');
/** Ultimate Guitar's domain, assembled for the same reason (tests/server/network-guard.test.ts). */
const UG = ['ultimate-guitar', 'com'].join('.');

/** Messages of the `no-restricted-syntax` rule for `code` linted as if it lived at `filePath`. */
async function restricted(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
}

describe('lint guards', () => {
  it('bans the Songsterr API in app, server and test code (string and template literals)', async () => {
    for (const file of ['src/app/x.ts', 'server/sources/linkout/x.ts', 'tests/foundation/x.test.ts']) {
      expect(await restricted(`export const u = 'https://www.${SONGSTERR_API}/songs';\n`, file)).toHaveLength(1);
      expect(await restricted(`export const u = (q: string): string => \`https://${SONGSTERR_API}/search?q=\${q}\`;\n`, file)).toHaveLength(1);
    }
    expect(await restricted("export const u = 'https://www.songsterr.com/?pattern=x';\n", 'server/sources/linkout/x.ts')).toEqual([]);
  });

  it('allows Ultimate Guitar URLs only in the link-out builders', async () => {
    const code = "export const u = 'https://www.ultimate-guitar.com/search.php';\n";
    const tpl = `export const u = (q: string): string => \`https://tabs.${UG}/tab/\${q}\`;\n`;
    for (const file of ['src/ui/screens/library/x.ts', 'server/routes/x.ts', 'shared/x.ts', 'scripts/x.ts']) {
      expect(await restricted(code, file)).toEqual([expect.stringContaining('link-out builders only')]);
      expect(await restricted(tpl, file)).toHaveLength(1);
    }
    for (const file of ['server/sources/linkout/ultimate-guitar.ts', 'src/ui/screens/import/model.ts', 'tests/linkout/x.test.ts']) {
      expect(await restricted(code, file)).toEqual([]);
    }
    // The source id is not a URL.
    expect(await restricted("export const id = 'ultimate-guitar';\n", 'src/app/x.ts')).toEqual([]);
  });
});
