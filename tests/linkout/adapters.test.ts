import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext, SourceAdapter } from '@shared/sources';
import { createGpPackAdapter, GP_PACK_URL } from '../../server/sources/linkout/gp-pack';
import { createSongsterrAdapter, songsterrSearchUrl } from '../../server/sources/linkout/songsterr';
import { createUltimateGuitarAdapter, ultimateGuitarSearchUrl } from '../../server/sources/linkout/ultimate-guitar';

const LINKOUT_DIR = join(import.meta.dirname, '../../server/sources/linkout');

/** Every network entry point throws, so any I/O by the adapters fails the test. */
function forbidNetwork(): void {
  const boom = (): never => {
    throw new Error('network I/O is forbidden in link-out adapters');
  };
  vi.stubGlobal('fetch', vi.fn(boom));
  vi.spyOn(http, 'request').mockImplementation(boom);
  vi.spyOn(http, 'get').mockImplementation(boom);
  vi.spyOn(https, 'request').mockImplementation(boom);
  vi.spyOn(https, 'get').mockImplementation(boom);
  vi.spyOn(net, 'connect').mockImplementation(boom);
  vi.spyOn(net, 'createConnection').mockImplementation(boom);
}

const adapters = (): SourceAdapter[] => [createSongsterrAdapter(), createUltimateGuitarAdapter(), createGpPackAdapter()];
const ctx = { dataDir: '/nowhere', libraryDir: '/nowhere', entries: () => [] } as unknown as AdapterContext;

describe('link-out URL builders', () => {
  it('builds the Songsterr search URL from docs/sources/songsterr.md', () => {
    expect(songsterrSearchUrl('Enter Sandman')).toBe('https://www.songsterr.com/?pattern=Enter%20Sandman');
    expect(songsterrSearchUrl('  AC/DC & friends?#1 ')).toBe('https://www.songsterr.com/?pattern=AC%2FDC%20%26%20friends%3F%231');
    expect(songsterrSearchUrl('Motörhead')).toBe('https://www.songsterr.com/?pattern=Mot%C3%B6rhead');
  });

  it('builds the Ultimate Guitar title search URL from docs/sources/ultimate-guitar.md', () => {
    expect(ultimateGuitarSearchUrl('Enter Sandman')).toBe('https://www.ultimate-guitar.com/search.php?search_type=title&value=Enter%20Sandman');
    expect(ultimateGuitarSearchUrl('a&b=c')).toBe('https://www.ultimate-guitar.com/search.php?search_type=title&value=a%26b%3Dc');
  });

  it('links the Guitar Pro free pack page from docs/sources/candidates.md', () => {
    expect(GP_PACK_URL).toBe('https://www.guitar-pro.com/free-tabs');
  });

  it('never targets an API path', () => {
    for (const url of [songsterrSearchUrl('x'), ultimateGuitarSearchUrl('x'), GP_PACK_URL]) {
      expect(new URL(url).protocol).toBe('https:');
      expect(url).not.toMatch(/\/api\//i);
    }
  });
});

describe('link-out adapters', () => {
  beforeEach(forbidNetwork);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('are registered as link-out sources with a terms doc and no scan/refresh/watch', () => {
    for (const a of adapters()) {
      expect(a.kind).toBe('link-out');
      expect(a.termsDoc).toMatch(/^docs\/sources\/.+\.md$/);
      expect(a.scan).toBeUndefined();
      expect(a.refresh).toBeUndefined();
      expect(a.watch).toBeUndefined();
      expect(a.readBundle).toBeUndefined();
    }
  });

  it('offer one plain-text link-out per non-empty query, in registry order', () => {
    const outs = adapters().flatMap((a) => a.linkOuts?.('Iron Man', {}) ?? []);
    expect(outs.map((o) => [o.source, o.label, o.url])).toEqual([
      ['songsterr', 'Search on Songsterr', 'https://www.songsterr.com/?pattern=Iron%20Man'],
      ['ultimate-guitar', 'Search on Ultimate Guitar', 'https://www.ultimate-guitar.com/search.php?search_type=title&value=Iron%20Man'],
      ['gp-pack', 'Get the free Guitar Pro pack', 'https://www.guitar-pro.com/free-tabs'],
    ]);
    for (const o of outs) expect(o.hint).toBeTruthy();
    expect(outs[0]?.hint).toMatch(/Free accounts have no file download/);
  });

  it('offer nothing for a blank query', () => {
    for (const a of adapters()) expect(a.linkOuts?.('   ', {})).toEqual([]);
  });

  it('only Songsterr matches local entries (one badge per row)', () => {
    const [songsterr, ug, gp] = adapters();
    expect(songsterr?.matchLocal).toBeTypeOf('function');
    expect(ug?.matchLocal).toBeUndefined();
    expect(gp?.matchLocal).toBeUndefined();
  });

  it('report an idle status explaining the link-out', async () => {
    for (const a of adapters()) {
      const s = await a.status(ctx);
      expect(s).toMatchObject({ id: a.id, kind: 'link-out', state: 'idle', indexed: 0, termsDoc: a.termsDoc });
      expect(s.message).toMatch(/Link-out only/);
    }
  });

  it('perform no network I/O while building links, matching and reporting status', async () => {
    for (const a of adapters()) {
      a.linkOuts?.('anything', { tierMin: 1 });
      a.matchLocal?.('anything', []);
      await a.status(ctx);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('source files contain no network calls or Node network modules', () => {
    for (const file of readdirSync(LINKOUT_DIR)) {
      const src = readFileSync(join(LINKOUT_DIR, file), 'utf8');
      expect(src, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|from 'node:(?:http|https|net|tls|dns)'|songsterr\.com\/api/);
    }
  });
});
