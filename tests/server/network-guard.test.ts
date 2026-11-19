/**
 * Source-tree guard for forbidden network access (R1-P-12; spec "no automated access" to Ultimate
 * Guitar, D1 for Songsterr). ESLint bans `songsterr.com/api`; this test also keeps every Ultimate Guitar
 * URL in code a `www.ultimate-guitar.com/search.php` link-out (opened by the user, never requested).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SCANNED_DIRS = ['src', 'server', 'shared', 'scripts', 'tests', 'e2e'];
const CODE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const SELF = relative(ROOT, import.meta.filename);

function* codeFiles(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* codeFiles(path);
    else if (CODE_FILE.test(e.name)) yield path;
  }
}

/** Code lines (comments skipped) of every scanned file, with `file:line` labels. */
function codeLines(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of codeFiles(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      if (rel === SELF) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((text, i) => {
          if (/^\s*(?:\/\/|\/\*|\*)/.test(text)) return;
          out.push({ where: `${rel}:${i + 1}`, text });
        });
    }
  }
  return out;
}

/** Ultimate Guitar URLs that are not the search link-out. */
function forbiddenUltimateGuitarUrls(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/([\w.-]*)ultimate-guitar\.com([^\s'"`)]*)/gi)) {
    const host = m[1].replace(/^.*?\/\//, '').toLowerCase();
    if ((host === '' || host === 'www.') && m[2].startsWith('/search.php')) continue;
    found.push(m[0]);
  }
  return found;
}

describe('forbidden network access in code (R1-P-12)', () => {
  it('recognises allowed link-outs and forbidden UG endpoints', () => {
    expect(forbiddenUltimateGuitarUrls("const base = 'https://www.ultimate-guitar.com/search.php';")).toEqual([]);
    expect(forbiddenUltimateGuitarUrls("fetch('https://tabs.ultimate-guitar.com/tab/x')")).toEqual(['tabs.ultimate-guitar.com/tab/x']);
    expect(forbiddenUltimateGuitarUrls('`https://api.ultimate-guitar.com/api/v1/tab/search`')).toHaveLength(1);
    expect(forbiddenUltimateGuitarUrls("'https://www.ultimate-guitar.com/explore'")).toHaveLength(1);
  });

  it('has no Ultimate Guitar URL other than the search link-out', () => {
    const hits = codeLines().flatMap(({ where, text }) => forbiddenUltimateGuitarUrls(text).map((url) => `${where}: ${url}`));
    expect(hits).toEqual([]);
  });

  it('never names the Songsterr API', () => {
    const hits = codeLines().filter(({ text }) => /songsterr\.com\/api/i.test(text)).map(({ where }) => where);
    expect(hits).toEqual([]);
  });
});
