import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteSearchRefused, RemoteSearchUnavailable } from '@shared/sources';
import { fetchSearch, NOT_SET_UP_MESSAGE, TIMEOUT_MS, USER_AGENT } from '../../server/sources/songsterr/client';
import { createSongsterrAdapter, FIXTURES_ENV, fixtureSlug, MAX_HITS, readFixtureHits, type SongsterrAdapterDeps } from '../../server/sources/songsterr';
import { adapterContext, entry, fakeFetch, hit, passThroughMapper, testUrl } from './helpers';

const signal = () => new AbortController().signal;
const make = (deps: SongsterrAdapterDeps) => createSongsterrAdapter({ buildUrl: testUrl, mapResponse: passThroughMapper, intervalMs: 0, fixturesDir: '', ...deps });

describe('Songsterr adapter: remote search (offline, injected fetch + mapper)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps the link-out behaviour', () => {
    const adapter = make({ fetchImpl: fakeFetch(200) });
    expect(adapter.kind).toBe('link-out');
    expect(adapter.linkOuts?.('fixture riff', {})).toHaveLength(1);
    expect(typeof adapter.searchRemote).toBe('function');
  });

  it('200 → mapped hits; the same query again is served from the cache', async () => {
    const fetchImpl = fakeFetch(200, [hit('Fixture Riff', { artist: 'The Testers' }), hit('Another Fixture')]);
    const mapResponse = vi.fn(passThroughMapper);
    const adapter = make({ fetchImpl, mapResponse });
    const ctx = adapterContext();
    const hits = await adapter.searchRemote!('fixture riff', ctx, signal());
    expect(hits.map((h) => h.title)).toEqual(['Fixture Riff', 'Another Fixture']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mapResponse).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(testUrl('fixture riff'));
    expect((init.headers as Record<string, string>)['user-agent']).toBe(USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(await adapter.searchRemote!('  Fixture   RIFF ', ctx, signal())).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it(`keeps at most ${MAX_HITS} hits`, async () => {
    const many = Array.from({ length: MAX_HITS + 5 }, (_, i) => hit(`Fixture ${i}`));
    const adapter = make({ fetchImpl: fakeFetch(200, many) });
    expect(await adapter.searchRemote!('fixture', adapterContext(), signal())).toHaveLength(MAX_HITS);
  });

  it.each([403, 429])('%i → RemoteSearchRefused, then off for the session without another request', async (status) => {
    const fetchImpl = fakeFetch(status, 'No automated access, please.');
    const adapter = make({ fetchImpl });
    const ctx = adapterContext();
    const first = await adapter.searchRemote!('fixture riff', ctx, signal()).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(RemoteSearchRefused);
    expect(first).toMatchObject({ status, message: 'No automated access, please.' });
    expect(ctx.warnings.join()).toContain(String(status));
    await expect(adapter.searchRemote!('another query', ctx, signal())).rejects.toBeInstanceOf(RemoteSearchRefused);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await adapter.status(ctx)).message).toMatch(/refused/i);
  });

  it('500 → plain Error and the feature stays on', async () => {
    const fetchImpl = fakeFetch(500);
    const adapter = make({ fetchImpl });
    const err = await adapter.searchRemote!('fixture riff', adapterContext(), signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RemoteSearchRefused);
    expect((err as Error).message).toContain('HTTP 500');
    await expect(adapter.searchRemote!('fixture riff', adapterContext(), signal())).rejects.toThrow('HTTP 500');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('timeout → plain Error and the feature stays on (nothing cached)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    const adapter = make({ fetchImpl });
    const err = await adapter.searchRemote!('fixture riff', adapterContext(), signal()).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RemoteSearchRefused);
    expect((err as Error).name).toBe('TimeoutError');
    await adapter.searchRemote!('fixture riff', adapterContext(), signal()).catch(() => {});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('queries shorter than 3 characters → [] without a request', async () => {
    const fetchImpl = fakeFetch(200, [hit('Fixture Riff')]);
    const adapter = make({ fetchImpl });
    expect(await adapter.searchRemote!('ab', adapterContext(), signal())).toEqual([]);
    expect(await adapter.searchRemote!('   a  ', adapterContext(), signal())).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fills localMatchIds from indexed songs with the same title and artist (not cached)', async () => {
    const fetchImpl = fakeFetch(200, [hit('Fixture Riff', { artist: 'The Testers' }), hit('Unknown Fixture')]);
    const adapter = make({ fetchImpl });
    const entries = [entry('local:1', 'Fixture Riff (Live)', 'Testers'), entry('local:2', 'Something Else')];
    const hits = await adapter.searchRemote!('fixture', adapterContext(entries), signal());
    expect(hits[0]?.localMatchIds).toEqual(['local:1']);
    expect(hits[1]?.localMatchIds).toBeUndefined();
    // Recomputed per request: an empty library gives no matches for the cached hits.
    const again = await adapter.searchRemote!('fixture', adapterContext([]), signal());
    expect(again[0]?.localMatchIds).toBeUndefined();
  });

  it('not set up (URL builder returns null) → RemoteSearchUnavailable without a request', async () => {
    const fetchImpl = fakeFetch(200, [hit('Fixture Riff')]);
    const adapter = make({ fetchImpl, buildUrl: () => null });
    const err = await adapter.searchRemote!('fixture riff', adapterContext(), signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteSearchUnavailable);
    expect((err as Error).message).toBe(NOT_SET_UP_MESSAGE);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await adapter.status(adapterContext())).message).toMatch(/isn’t set up/);
  });

  it('waits for the limiter between two different queries', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = fakeFetch(200, [hit('Fixture Riff')]);
      const adapter = make({ fetchImpl, intervalMs: 1000 });
      await adapter.searchRemote!('first query', adapterContext(), signal());
      const second = adapter.searchRemote!('second query', adapterContext(), signal());
      await vi.advanceTimersByTimeAsync(500);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      await second;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fetchSearch', () => {
  it('passes a combined signal that aborts with the caller', async () => {
    let seen: AbortSignal | undefined;
    const ac = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen = init.signal ?? undefined;
      ac.abort();
      return new Response('[]', { status: 200 });
    });
    await fetchSearch('fixture', ac.signal, { fetchImpl, buildUrl: testUrl });
    expect(seen?.aborted).toBe(true);
    expect(TIMEOUT_MS).toBe(4000);
  });

  it('bad JSON → Error', async () => {
    await expect(fetchSearch('fixture', signal(), { fetchImpl: fakeFetch(200, 'not json'), buildUrl: testUrl })).rejects.toThrow();
  });
});

describe('fixture mode (RIFFWAY_SONGSTERR_FIXTURES)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function writeFixtures(): string {
    dir = mkdtempSync(join(tmpdir(), 'riffway-remote-fixtures-'));
    writeFileSync(join(dir, 'fixture-riff.json'), JSON.stringify([hit('Fixture Riff'), { title: 'bad item' }, hit('Second Fixture', { localMatchIds: ['stale'] })]));
    return dir;
  }

  it('slugs queries to safe file names', () => {
    expect(fixtureSlug('  Fixture Riff! ')).toBe('fixture-riff');
    expect(fixtureSlug('Café Ñandú')).toBe('cafe-nandu');
    expect(fixtureSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(fixtureSlug('!!!')).toBe('');
  });

  it('reads mapped hits from <dir>/<slug>.json, skipping invalid items, and never fetches', async () => {
    const fetchImpl = fakeFetch(200);
    const adapter = make({ fetchImpl, fixturesDir: writeFixtures() });
    const hits = await adapter.searchRemote!('Fixture Riff', adapterContext([entry('local:1', 'Second Fixture')]), signal());
    expect(hits.map((h) => h.title)).toEqual(['Fixture Riff', 'Second Fixture']);
    expect(hits[1]?.localMatchIds).toEqual(['local:1']);
    expect(await adapter.searchRemote!('no such fixture', adapterContext(), signal())).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await adapter.status(adapterContext())).message).toContain(FIXTURES_ENV);
  });

  it('is picked up from the environment', async () => {
    vi.stubEnv(FIXTURES_ENV, writeFixtures());
    const fetchImpl = fakeFetch(200);
    const adapter = createSongsterrAdapter({ fetchImpl, buildUrl: () => null });
    expect(await adapter.searchRemote!('fixture riff', adapterContext(), signal())).toHaveLength(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('readFixtureHits: missing dir → []', async () => {
    expect(await readFixtureHits(join(tmpdir(), 'riffway-does-not-exist'), 'fixture riff')).toEqual([]);
  });
});
