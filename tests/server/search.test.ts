import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchResponse } from '@shared/api';
import type { IndexEntry, SourceAdapter } from '@shared/sources';
import { fakeSong, libraryChanged, makeTempDirs, startApp, waitForEvent, writeStarter, type TempDirs, type TestApp } from './helpers';

/** A link-out adapter like T-026's: no I/O, a URL and local title matching. */
function fakeLinkOut(): SourceAdapter {
  const adapter: SourceAdapter = {
    id: 'songsterr',
    displayName: 'Songsterr',
    kind: 'link-out',
    termsDoc: 'docs/sources/songsterr.md',
    linkOuts: (q) => [{ source: 'songsterr', label: 'Search on Songsterr', url: `https://www.songsterr.com/?pattern=${encodeURIComponent(q)}` }],
    matchLocal: (q, entries: readonly IndexEntry[]) => entries.filter((e) => e.title.toLowerCase().includes(q.toLowerCase())).map((e) => e.id),
    status: async () => ({ id: 'songsterr', displayName: 'Songsterr', kind: 'link-out', enabled: true, indexed: 0, lastRefresh: null, state: 'idle', termsDoc: adapter.termsDoc }),
  };
  return adapter;
}

describe('unified search', () => {
  let dirs: TempDirs;
  let t: TestApp;

  const search = async (qs: string): Promise<SearchResponse> => {
    const res = await t.app.inject({ method: 'GET', url: `/api/search${qs}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<SearchResponse>();
  };
  const titles = (r: SearchResponse): string[] => r.results.map((x) => x.title).sort();

  beforeAll(async () => {
    dirs = makeTempDirs();
    const lib = (name: string, fields: Record<string, string | number>): void => writeFileSync(join(dirs.libraryDir, name), fakeSong(fields));
    lib('hall.atex', { title: 'In the Hall of the Mountain King', composer: 'Grieg', tier: 3, genre: 'classical,metal' });
    lib('iron.atex', { title: 'Iron Riff', artist: 'Metal Band', tier: 6, tuning: 'drop-d', genre: 'metal', skills: 'bends' });
    lib('lagrima.txt', { title: 'Lagrima', composer: 'Tarrega', tier: 4, rhythm: 'needs-alignment', genre: 'classical' });
    lib('blues.atex', { title: 'Twelve Bar Blues', tier: 2, genre: 'blues', skills: 'bends,legato' });
    writeStarter(dirs.starterDir, [{ slug: 'ode-to-joy', title: 'Ode to Joy', content: fakeSong({ title: 'Ode to Joy', tier: 1 }), genre: ['classical'] }]);
    t = await startApp(dirs, { extraSources: [fakeLinkOut] });
  });
  afterAll(async () => {
    await t.app.close();
    dirs.cleanup();
  });

  it('lists everything sorted by title without a query', async () => {
    const r = await search('');
    expect(r.total).toBe(5);
    expect(r.results.map((x) => x.title)).toEqual(['In the Hall of the Mountain King', 'Iron Riff', 'Lagrima', 'Ode to Joy', 'Twelve Bar Blues']);
    expect(r.linkOuts).toEqual([]);
  });

  it('matches fuzzy and prefix queries across title, artist and composer', async () => {
    expect(titles(await search('?q=mountain%20king'))).toEqual(['In the Hall of the Mountain King']);
    expect(titles(await search('?q=mountian'))).toEqual(['In the Hall of the Mountain King']);
    expect(titles(await search('?q=lagr'))).toEqual(['Lagrima']);
    expect(titles(await search('?q=tarrega'))).toEqual(['Lagrima']);
    expect(titles(await search('?q=metal%20band'))).toEqual(['Iron Riff']);
  });

  it('projects results with tier, tuning, availability and source', async () => {
    const [hall] = (await search('?q=mountain')).results;
    expect(hall).toMatchObject({ source: 'local', tier: 3, rating: 3, tuningId: 'standard', availability: 'playable', arrangements: 1, ratingProvisional: false });
    const [lagrima] = (await search('?q=lagrima')).results;
    expect(lagrima).toMatchObject({ availability: 'needs-rhythm', rhythm: 'needs-alignment', ratingProvisional: true });
    const [ode] = (await search('?q=ode')).results;
    expect(ode).toMatchObject({ id: 'starter:ode-to-joy', source: 'starter' });
  });

  it('filters by source, tier range, tuning, playable and tags', async () => {
    expect(titles(await search('?source=starter'))).toEqual(['Ode to Joy']);
    expect(titles(await search('?tierMin=3&tierMax=4'))).toEqual(['In the Hall of the Mountain King', 'Lagrima']);
    expect(titles(await search('?tierMin=5'))).toEqual(['Iron Riff']);
    expect(titles(await search('?tuning=drop-d'))).toEqual(['Iron Riff']);
    expect(titles(await search('?playable=false'))).toEqual(['Lagrima']);
    expect((await search('?playable=true')).total).toBe(4);
    expect(titles(await search('?tags=bends'))).toEqual(['Iron Riff', 'Twelve Bar Blues']);
    expect(titles(await search('?tags=bends,legato'))).toEqual(['Twelve Bar Blues']);
    expect(titles(await search('?q=riff&tags=classical'))).toEqual([]);
    const limited = await search('?limit=2');
    expect(limited.results).toHaveLength(2);
    expect(limited.total).toBe(5);
  });

  it('merges link-outs with local matches and badges', async () => {
    const r = await search('?q=iron');
    expect(r.linkOuts).toHaveLength(1);
    const [out] = r.linkOuts;
    expect(out).toMatchObject({ source: 'songsterr', url: 'https://www.songsterr.com/?pattern=iron' });
    expect(out!.localMatchIds).toEqual([r.results[0]!.id]);
    expect(r.results[0]!.badges).toEqual([{ source: 'songsterr', label: 'In your library – playable' }]);
  });

  it('rejects malformed parameters', async () => {
    for (const qs of ['?source=nope', '?tierMin=0', '?tierMax=11', '?playable=yes', '?limit=abc']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/search${qs}` });
      expect(res.statusCode, qs).toBe(400);
      expect(res.json()).toMatchObject({ code: 'bad-request' });
    }
  });

  it('hides disabled sources and their link-outs', async () => {
    const done = waitForEvent(t.ctx.events, libraryChanged('rescan'));
    await t.ctx.config.update({ enabledSources: ['local'] });
    await done;
    const r = await search('?q=ode');
    expect(r.results).toEqual([]);
    expect(r.linkOuts).toEqual([]);
    expect((await search('?source=starter')).total).toBe(0);
  });
});
