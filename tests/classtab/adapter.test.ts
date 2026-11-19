import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClassTabRefreshResponse, ClassTabStatus, SearchResponse, ServerEvent, SongMeta } from '@shared/api';
import type { IndexEntry } from '@shared/sources';
import { createApp } from '../../server/app';
import { createClassTabAdapter, isClassTabAdapter, type ClassTabAdapter, type ClassTabAdapterOptions } from '../../server/sources/classtab';
import { readClassTabState, writeClassTabState } from '../../server/sources/classtab/state';
import type { ServerContext } from '../../server/types';
import { buildZip, fakeSleep, startZipServer, SYNTHETIC_DIR, syntheticEntries, tempDir, type ZipServer } from './helpers';

type Progress = Extract<ServerEvent, { type: 'classtab.progress' }>;
const DAY = 24 * 60 * 60 * 1000;

describe('ClassTab adapter + routes', () => {
  let tmp: ReturnType<typeof tempDir>;
  let dataDir: string;
  let server: ZipServer;
  let clock: number;
  let app: FastifyInstance | undefined;
  let ctx: ServerContext;
  let adapter: ClassTabAdapter;
  let events: Progress[];

  beforeEach(async () => {
    tmp = tempDir();
    dataDir = join(tmp.dir, 'data');
    mkdirSync(join(tmp.dir, 'lib'), { recursive: true });
    server = await startZipServer(buildZip(syntheticEntries()));
    clock = Date.UTC(2026, 10, 19, 12);
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    await server.close();
    tmp.cleanup();
  });

  /** Start the app with only the ClassTab adapter (real importers) pointed at the local server. */
  async function start(over: ClassTabAdapterOptions = {}): Promise<void> {
    adapter = createClassTabAdapter({ url: server.url, sleep: fakeSleep().sleep, now: () => clock, ...over });
    ({ app, ctx } = await createApp({ dataDir, libraryDir: join(tmp.dir, 'lib'), staticDir: null, watch: false, sources: [() => adapter] }));
    await ctx.library.ready;
    events = [];
    ctx.events.subscribe((e) => {
      if (e.type === 'classtab.progress') events.push(e);
    });
  }

  const classtab = (): IndexEntry[] => ctx.library.all().filter((e) => e.source === 'classtab');
  const byFile = (name: string): IndexEntry => classtab().find((e) => e.fileName === name)!;
  const status = async (): Promise<ClassTabStatus> => (await app!.inject({ method: 'GET', url: '/api/classtab/status' })).json<ClassTabStatus>();
  const post = (body: unknown) => app!.inject({ method: 'POST', url: '/api/classtab/refresh', payload: body as object });

  /** POST a refresh and wait for its terminal progress event. */
  async function refreshViaRoute(body: object): Promise<Progress> {
    const done = new Promise<Progress>((resolve) => {
      const off = ctx.events.subscribe((e) => {
        if (e.type === 'classtab.progress' && ['done', 'not-modified', 'error'].includes(e.phase)) {
          off();
          resolve(e);
        }
      });
    });
    const res = await post(body);
    expect(res.statusCode).toBe(202);
    expect(res.json<ClassTabRefreshResponse>()).toEqual({ started: true });
    return done;
  }

  it('is not downloaded before the first refresh', async () => {
    await start();
    expect(isClassTabAdapter(adapter)).toBe(true);
    expect(await status()).toMatchObject({ state: 'not-downloaded', lastRefresh: null, tabs: 0, rhythm: { midi: 0, ruler: 0, needsAlignment: 0 } });
    expect((await adapter.status(ctx.adapterContext)).state).toBe('not-downloaded');
    expect(server.requests).toEqual([]);
  });

  it('200: downloads, extracts and indexes with pairing, rhythm statuses, tags and composer', async () => {
    await start();
    const done = await refreshViaRoute({});
    expect(done.phase).toBe('done');
    expect(events.map((e) => e.phase).filter((p, i, a) => a.indexOf(p) === i)).toEqual(['checking', 'downloading', 'extracting', 'indexing', 'done']);
    expect(events.find((e) => e.phase === 'downloading')).toMatchObject({ bytes: expect.any(Number), totalBytes: expect.any(Number) });

    const s = await status();
    expect(s).toMatchObject({ state: 'ready', lastRefresh: clock, tabs: 5, midis: 6, rhythm: { midi: 3, ruler: 1, needsAlignment: 1 } });
    expect(s.etag).toMatch(/^".+"$/);
    expect(s.lastModified).toBe('Sun, 01 Nov 2026 20:06:35 GMT');
    expect(done.message).toMatch(/5 tabs, 6 MIDI files: 4 paired with MIDI; rhythm from MIDI 3, beat ruler 1, needs alignment 1/);

    expect(classtab()).toHaveLength(5);
    expect(Object.fromEntries(classtab().map((e) => [e.fileName, e.rhythm]))).toEqual({
      'riffway_study_no1_in_e.txt': 'midi',
      'riffway_march_in_c.txt': 'midi',
      'riffway_two_preludes.txt': 'midi',
      'riffway_waltz_in_a.txt': 'ruler',
      'riffway_lament_unpaired.txt': 'needs-alignment',
    });
    for (const e of classtab()) {
      expect(e.id).toMatch(/^classtab:[0-9a-f]{16}$/);
      expect(e.tags.style).toContain('fingerstyle');
      expect(e.tags.genre).toContain('classical');
      expect(e.url).toBe(`https://www.classtab.org/${e.fileName}`);
      expect(e.path).toBe(e.fileName);
    }
    expect(byFile('riffway_study_no1_in_e.txt')).toMatchObject({ composer: 'Ada Fictional', title: 'Study No 1 in E minor', hasMidi: true });
    expect(byFile('riffway_march_in_c.txt')).toMatchObject({ composer: 'Bérénice Exemple', title: 'Marche élégante in C' }); // windows-1252
    expect(byFile('riffway_lament_unpaired.txt').hasMidi).toBe(false);
    expect(byFile('riffway_waltz_in_a.txt').hasMidi).toBe(true); // paired, but the MIDI does not match: ruler wins

    // Only .txt/.mid on disk; the zip and state are kept beside them.
    const layoutRoot = join(dataDir, 'classtab');
    expect(readdirSync(layoutRoot).sort()).toEqual(['classtab.zip', 'files', 'pairs.json', 'state.json']);
    expect(readdirSync(join(layoutRoot, 'files')).every((n) => /\.(txt|mid)$/.test(n))).toBe(true);
    expect((await adapter.status(ctx.adapterContext)).message).toBe('5 tabs, 6 MIDI files');
  });

  it('serves the paired MIDI on GET /api/songs/:id/rhythm and 404s otherwise', async () => {
    await start();
    await refreshViaRoute({});
    const study = byFile('riffway_study_no1_in_e.txt');
    const meta = (await app!.inject({ method: 'GET', url: `/api/songs/${encodeURIComponent(study.id)}` })).json<SongMeta>();
    expect(meta.files.rhythm).toBe(`/api/songs/${encodeURIComponent(study.id)}/rhythm`);
    const res = await app!.inject({ method: 'GET', url: meta.files.rhythm! });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/midi');
    expect(Buffer.compare(res.rawPayload, readFileSync(join(SYNTHETIC_DIR, 'riffway_study_no1_in_e.mid')))).toBe(0);

    const preludes = await app!.inject({ method: 'GET', url: `/api/songs/${encodeURIComponent(byFile('riffway_two_preludes.txt').id)}/rhythm` });
    expect(Buffer.compare(preludes.rawPayload, readFileSync(join(SYNTHETIC_DIR, 'riffway_two_preludes_01.mid')))).toBe(0); // version 1

    const lament = await app!.inject({ method: 'GET', url: `/api/songs/${encodeURIComponent(byFile('riffway_lament_unpaired.txt').id)}/rhythm` });
    expect(lament.statusCode).toBe(404);
    expect((await app!.inject({ method: 'GET', url: '/api/songs/classtab%3Anope/rhythm' })).statusCode).toBe(404);
  });

  it('fingerstyle is filterable, not hidden', async () => {
    await start();
    await refreshViaRoute({});
    const search = async (qs: string) => (await app!.inject({ method: 'GET', url: `/api/search?${qs}` })).json<SearchResponse>();
    expect((await search('tags=fingerstyle')).results).toHaveLength(5);
    expect((await search('tags=pick')).results).toHaveLength(0);
    expect((await search('q=waltz')).results.map((r) => r.fileName)).toContain('riffway_waltz_in_a.txt');
  });

  it('limits refresh to once a day unless forced; a forced check answers 304 and changes nothing', async () => {
    await start();
    await refreshViaRoute({});
    const before = classtab().map((e) => ({ id: e.id, mtimeMs: e.mtimeMs }));
    const filesMtime = statSync(join(dataDir, 'classtab', 'files')).mtimeMs;

    clock += 3 * 60 * 60 * 1000;
    const skipped = await post({});
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json<ClassTabRefreshResponse>()).toMatchObject({ started: false, reason: expect.stringMatching(/once a day/) });
    expect(await adapter.refresh(ctx.adapterContext, {})).toMatchObject({ status: 'skipped' });
    expect(server.requests).toHaveLength(1);

    const done = await refreshViaRoute({ force: true });
    expect(done.phase).toBe('not-modified');
    expect(server.requests.at(-1)).toMatchObject({ status: 304 });
    expect(server.requests.at(-1)!.headers['if-none-match']).toBe((await status()).etag);
    expect(server.requests.at(-1)!.headers['if-modified-since']).toBe('Sun, 01 Nov 2026 20:06:35 GMT');
    expect(classtab().map((e) => ({ id: e.id, mtimeMs: e.mtimeMs }))).toEqual(before);
    expect(statSync(join(dataDir, 'classtab', 'files')).mtimeMs).toBe(filesMtime);
    expect((await status()).lastRefresh).toBe(clock);

    clock += DAY;
    expect(await adapter.refresh(ctx.adapterContext, {})).toMatchObject({ status: 'not-modified' });
  });

  it('a new zip replaces the corpus: ids of unchanged tabs stay, removed tabs leave the index', async () => {
    await start();
    await refreshViaRoute({});
    const studyId = byFile('riffway_study_no1_in_e.txt').id;
    server.setZip(buildZip(syntheticEntries().filter((e) => !e.name.includes('lament'))));
    clock += DAY + 1;
    expect(await adapter.refresh(ctx.adapterContext, {})).toMatchObject({ status: 'updated' });
    expect(classtab().map((e) => e.fileName).sort()).not.toContain('riffway_lament_unpaired.txt');
    expect(classtab()).toHaveLength(4);
    expect(byFile('riffway_study_no1_in_e.txt').id).toBe(studyId);
    expect(readdirSync(join(dataDir, 'classtab')).filter((n) => n.startsWith('files'))).toEqual(['files']);
  });

  it('refuses zip-slip entries in a served zip and writes nothing outside the files folder', async () => {
    server.setZip(buildZip([...syntheticEntries(), { name: '../../evil.txt', data: 'x' }, { name: 'classtab/../../../evil2.txt', data: 'x' }]));
    await start();
    expect(await adapter.refresh(ctx.adapterContext, {})).toMatchObject({ status: 'updated' });
    expect(classtab()).toHaveLength(5);
    for (const dir of [tmp.dir, dataDir, join(dataDir, 'classtab')]) {
      expect(readdirSync(dir).some((n) => n.startsWith('evil'))).toBe(false);
    }
  });

  it('a failed refresh keeps the previous files and index and reports the error', async () => {
    await start();
    await refreshViaRoute({});
    server.failNext(3, 503);
    const sleeper = fakeSleep();
    await app!.close();
    await start({ sleep: sleeper.sleep });
    expect(classtab()).toHaveLength(5); // re-scanned from the extracted files at start, no network
    const before = server.requests.length;
    const done = await refreshViaRoute({ force: true });
    expect(done).toMatchObject({ phase: 'error', message: expect.stringMatching(/HTTP 503/) });
    expect(server.requests.length - before).toBe(3);
    expect(sleeper.delays.every((d) => d >= 10_000)).toBe(true);
    expect(await status()).toMatchObject({ state: 'error', error: expect.stringMatching(/503/), tabs: 5 });
    expect(classtab()).toHaveLength(5);

    clock += DAY + 1;
    expect(await adapter.refresh(ctx.adapterContext, {})).toMatchObject({ status: 'not-modified' });
    expect((await status()).state).toBe('ready');
  });

  it('rejects a download that is not a zip without touching the corpus', async () => {
    await start();
    await refreshViaRoute({});
    server.setZip(Buffer.from('<html>maintenance</html>'));
    clock += DAY + 1;
    const res = await adapter.refresh(ctx.adapterContext, {});
    expect(res).toMatchObject({ status: 'error', message: expect.stringMatching(/Not a readable zip/) });
    expect(classtab()).toHaveLength(5);
    expect(readdirSync(join(dataDir, 'classtab')).filter((n) => n.startsWith('files'))).toEqual(['files']);
  });

  it('validates the refresh body and runs one refresh at a time', async () => {
    await start();
    expect((await app!.inject({ method: 'POST', url: '/api/classtab/refresh' })).statusCode).toBe(400);
    expect((await post({ force: 'yes' })).statusCode).toBe(400);
    const first = adapter.refresh(ctx.adapterContext, {});
    expect(adapter.isRefreshing()).toBe(true);
    expect((await status()).state).toBe('refreshing');
    expect((await post({ force: true })).json<ClassTabRefreshResponse>()).toMatchObject({ started: false, reason: expect.stringMatching(/already running/) });
    expect(await adapter.refresh(ctx.adapterContext, {})).toMatchObject({ status: 'skipped' });
    expect(await first).toMatchObject({ status: 'updated' });
    expect(adapter.isRefreshing()).toBe(false);
    expect(server.requests).toHaveLength(1);
  });

  it('watch reports a refresh made by another process (state.json lastDownload changes)', async () => {
    await start({ debounceMs: 10 });
    await adapter.init!(ctx.adapterContext);
    const changed = new Promise<string[]>((resolve) => {
      const stop = adapter.watch!(ctx.adapterContext, (paths) => {
        stop();
        resolve(paths);
      });
    });
    const file = join(dataDir, 'classtab', 'state.json');
    await writeClassTabState(file, { ...(await readClassTabState(file)), lastDownload: clock, tabs: 5 });
    expect(await changed).toEqual([join(dataDir, 'classtab', 'files')]);
    expect(existsSync(file)).toBe(true);
  });
});
