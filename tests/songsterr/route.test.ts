import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RemoteSearchResponse, ServerConfig } from '@shared/api';
import { createSongsterrAdapter, type SongsterrAdapterDeps } from '../../server/sources/songsterr';
import { fakeSong, makeTempDirs, startApp, type TempDirs, type TestApp } from '../server/helpers';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeFetch, hit, passThroughMapper, testUrl } from './helpers';

const URL_ = '/api/search/remote?q=fixture+riff&source=songsterr';

describe('GET /api/search/remote', () => {
  let dirs: TempDirs;
  let t: TestApp | undefined;

  beforeEach(() => {
    dirs = makeTempDirs();
  });
  afterEach(async () => {
    await t?.app.close();
    t = undefined;
    dirs.cleanup();
  });

  async function start(deps: SongsterrAdapterDeps): Promise<TestApp> {
    t = await startApp(dirs, {
      extraSources: [() => createSongsterrAdapter({ buildUrl: testUrl, mapResponse: passThroughMapper, intervalMs: 0, fixturesDir: '', ...deps })],
    });
    return t;
  }
  const enable = async (app: TestApp['app']): Promise<void> => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', payload: { remoteSearch: ['songsterr'] } });
    expect(res.json<ServerConfig>().remoteSearch).toEqual(['songsterr']);
  };
  const get = async (app: TestApp['app'], url = URL_): Promise<RemoteSearchResponse> => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return res.json<RemoteSearchResponse>();
  };

  it('is off by default and sends nothing', async () => {
    const fetchImpl = fakeFetch(200, [hit('Fixture Riff')]);
    const { app } = await start({ fetchImpl });
    expect(await get(app)).toEqual({ source: 'songsterr', status: 'off', hits: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enabled → ok with hits, matched against the library', async () => {
    writeFileSync(join(dirs.libraryDir, 'riff.atex'), fakeSong({ title: 'Fixture Riff', artist: 'The Testers', tier: 2 }));
    const fetchImpl = fakeFetch(200, [hit('Fixture Riff', { artist: 'The Testers' }), hit('Other Fixture')]);
    const { app, ctx } = await start({ fetchImpl });
    await enable(app);
    const res = await get(app);
    expect(res.status).toBe('ok');
    expect(res.hits.map((h) => h.title)).toEqual(['Fixture Riff', 'Other Fixture']);
    const local = ctx.library.all().find((e) => e.title === 'Fixture Riff');
    expect(res.hits[0]?.localMatchIds).toEqual([local?.id]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stays off when the source itself is disabled', async () => {
    const fetchImpl = fakeFetch(200, [hit('Fixture Riff')]);
    const { app } = await start({ fetchImpl });
    await enable(app);
    await app.inject({ method: 'PUT', url: '/api/config', payload: { enabledSources: ['local', 'starter'] } });
    expect((await get(app)).status).toBe('off');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('403 → refused, and refused again without another request', async () => {
    const fetchImpl = fakeFetch(403, 'Declined');
    const { app } = await start({ fetchImpl });
    await enable(app);
    expect(await get(app)).toEqual({ source: 'songsterr', status: 'refused', message: 'Declined', hits: [] });
    expect((await get(app, '/api/search/remote?q=another')).status).toBe('refused');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('500 → error with a hint at the link-out', async () => {
    const { app } = await start({ fetchImpl: fakeFetch(500) });
    await enable(app);
    const res = await get(app);
    expect(res.status).toBe('error');
    expect(res.message).toContain('Search on Songsterr');
  });

  it('not set up → off with a message, nothing sent', async () => {
    const fetchImpl = fakeFetch(200, [hit('Fixture Riff')]);
    const { app } = await start({ fetchImpl, buildUrl: () => null });
    await enable(app);
    expect(await get(app)).toEqual({ source: 'songsterr', status: 'off', message: 'Songsterr search isn’t set up yet.', hits: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unknown sources and sources without remote search', async () => {
    const { app } = await start({ fetchImpl: fakeFetch(200) });
    expect((await app.inject({ method: 'GET', url: '/api/search/remote?q=abc&source=nope' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/search/remote?q=abc&source=local' })).statusCode).toBe(404);
  });
});

describe('PUT /api/config remoteSearch', () => {
  let dirs: TempDirs;
  let t: TestApp | undefined;
  beforeEach(() => {
    dirs = makeTempDirs();
  });
  afterEach(async () => {
    await t?.app.close();
    dirs.cleanup();
  });

  it('defaults to [], validates and normalises the list', async () => {
    t = await startApp(dirs);
    expect(t.ctx.config.get().remoteSearch).toEqual([]);
    const ok = await t.app.inject({ method: 'PUT', url: '/api/config', payload: { remoteSearch: ['songsterr', 'songsterr'] } });
    expect(ok.json<ServerConfig>().remoteSearch).toEqual(['songsterr']);
    for (const payload of [{ remoteSearch: 'songsterr' }, { remoteSearch: ['nope'] }, { remoteSearch: [1] }]) {
      const res = await t.app.inject({ method: 'PUT', url: '/api/config', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const off = await t.app.inject({ method: 'PUT', url: '/api/config', payload: { remoteSearch: [] } });
    expect(off.json<ServerConfig>().remoteSearch).toEqual([]);
  });
});
