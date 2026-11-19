import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SearchResponse, SourcesResponse } from '@shared/api';
import { createGpPackAdapter } from '../../server/sources/linkout/gp-pack';
import { createSongsterrAdapter } from '../../server/sources/linkout/songsterr';
import { createUltimateGuitarAdapter } from '../../server/sources/linkout/ultimate-guitar';
import { fakeSong, makeTempDirs, startApp, writeStarter, type TempDirs, type TestApp } from '../server/helpers';

/** Real link-out adapters behind `GET /api/search`, with outbound fetch forbidden. */
describe('link-out adapters in unified search', () => {
  let dirs: TempDirs;
  let t: TestApp;
  const fetchSpy = vi.fn(() => {
    throw new Error('network I/O is forbidden');
  });

  const get = async <T>(url: string): Promise<T> => {
    const res = await t.app.inject({ method: 'GET', url });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<T>();
  };

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy);
    dirs = makeTempDirs();
    writeFileSync(join(dirs.libraryDir, 'sandman.gp'), fakeSong({ title: 'Enter Sandman (Remastered)', artist: 'Metallica', tier: 5 }));
    writeFileSync(join(dirs.libraryDir, 'lagrima.txt'), fakeSong({ title: 'Lagrima', composer: 'Tárrega', tier: 4, rhythm: 'needs-alignment' }));
    writeStarter(dirs.starterDir, [{ slug: 'hall', title: 'In the Hall of the Mountain King', content: fakeSong({ title: 'In the Hall of the Mountain King', tier: 2 }) }]);
    t = await startApp(dirs, { extraSources: [createSongsterrAdapter, createUltimateGuitarAdapter, createGpPackAdapter] });
  });
  afterAll(async () => {
    await t.app.close();
    dirs.cleanup();
    vi.unstubAllGlobals();
  });

  it('adds Songsterr, Ultimate Guitar and GP pack link-outs to a text search', async () => {
    const r = await get<SearchResponse>('/api/search?q=metallica%20sandman');
    expect(r.results.map((x) => x.title)).toEqual(['Enter Sandman (Remastered)']);
    expect(r.linkOuts.map((o) => o.source)).toEqual(['songsterr', 'ultimate-guitar', 'gp-pack']);
    expect(r.linkOuts[0]).toMatchObject({ url: 'https://www.songsterr.com/?pattern=metallica%20sandman', localMatchIds: [r.results[0]!.id] });
    expect(r.linkOuts[1]?.localMatchIds).toBeUndefined();
    expect(r.results[0]!.badges).toEqual([{ source: 'songsterr', label: 'In your library – playable' }]);
  });

  it('labels a match that still needs rhythm as "In your library"', async () => {
    const r = await get<SearchResponse>('/api/search?q=tarrega%20lagrima');
    expect(r.results[0]).toMatchObject({ title: 'Lagrima', availability: 'needs-rhythm', badges: [{ source: 'songsterr', label: 'In your library' }] });
  });

  it('offers link-outs even when nothing local matches', async () => {
    const r = await get<SearchResponse>('/api/search?q=master%20of%20puppets');
    expect(r.results).toEqual([]);
    expect(r.linkOuts.map((o) => o.label)).toEqual(['Search on Songsterr', 'Search on Ultimate Guitar', 'Get the free Guitar Pro pack']);
    expect(r.linkOuts[0]!.localMatchIds).toBeUndefined();
  });

  it('offers no link-outs without a query', async () => {
    const r = await get<SearchResponse>('/api/search');
    expect(r.total).toBe(3);
    expect(r.linkOuts).toEqual([]);
  });

  it('drops link-outs of disabled sources', async () => {
    await t.ctx.config.update({ enabledSources: ['local', 'starter', 'ultimate-guitar'] });
    try {
      const r = await get<SearchResponse>('/api/search?q=sandman');
      expect(r.linkOuts.map((o) => o.source)).toEqual(['ultimate-guitar']);
      expect(r.results[0]!.badges).toBeUndefined();
    } finally {
      await t.ctx.config.update({ enabledSources: ['local', 'starter', 'songsterr', 'ultimate-guitar', 'gp-pack'] });
    }
  });

  it('lists the link-out sources with their status', async () => {
    const { sources } = await get<SourcesResponse>('/api/sources');
    const linkOuts = sources.filter((s) => s.kind === 'link-out');
    expect(linkOuts.map((s) => [s.id, s.state, s.termsDoc])).toEqual([
      ['songsterr', 'idle', 'docs/sources/songsterr.md'],
      ['ultimate-guitar', 'idle', 'docs/sources/ultimate-guitar.md'],
      ['gp-pack', 'idle', 'docs/sources/candidates.md'],
    ]);
  });

  it('made no outbound request', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
