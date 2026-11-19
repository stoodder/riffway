import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HealthResponse, ServerConfig } from '@shared/api';
import { SOURCE_IDS } from '@shared/song';
import { fakeSong, libraryChanged, makeTempDirs, startApp, waitForEvent, type TempDirs, type TestApp } from './helpers';

describe('config, health and local-only guard', () => {
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

  it('serves defaults and persists updates to <dataDir>/config.json', async () => {
    t = await startApp(dirs);
    const get = await t.app.inject({ method: 'GET', url: '/api/config' });
    expect(get.json<ServerConfig>()).toEqual({ schema: 1, libraryDir: dirs.libraryDir, enabledSources: [...SOURCE_IDS], importSubfolder: '' });

    const put = await t.app.inject({ method: 'PUT', url: '/api/config', payload: { enabledSources: ['starter', 'local'], importSubfolder: 'Imported/' } });
    expect(put.statusCode).toBe(200);
    expect(put.json<ServerConfig>()).toMatchObject({ enabledSources: ['local', 'starter'], importSubfolder: 'Imported' });
    const stored = JSON.parse(readFileSync(join(dirs.dataDir, 'config.json'), 'utf8')) as ServerConfig;
    expect(stored).toMatchObject({ schema: 1, enabledSources: ['local', 'starter'], importSubfolder: 'Imported' });
    await t.app.close();

    // The library override (tests, RIFFWAY_LIBRARY_DIR) is not persisted; other fields are reloaded.
    t = await startApp(dirs, { libraryDir: join(dirs.root, 'other') });
    expect(t.ctx.config.get()).toMatchObject({ libraryDir: join(dirs.root, 'other'), importSubfolder: 'Imported' });
    expect(stored.libraryDir).not.toBe(join(dirs.root, 'other'));
  });

  it('rejects invalid updates', async () => {
    t = await startApp(dirs);
    const bad = [{ libraryDir: 'relative/path' }, { libraryDir: 42 }, { enabledSources: ['nope'] }, { enabledSources: 'local' }, { importSubfolder: '../x' }, { schema: 2 }, { surprise: true }, []];
    for (const payload of bad) {
      const res = await t.app.inject({ method: 'PUT', url: '/api/config', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'bad-request' });
    }
  });

  it('ignores invalid fields of a hand-edited config file', async () => {
    writeFileSync(join(dirs.dataDir, 'config.json'), JSON.stringify({ schema: 1, enabledSources: ['bogus'], importSubfolder: '../../x', libraryDir: join(dirs.root, 'lib2') }));
    const { createApp } = await import('../../server/app');
    const { app, ctx } = await createApp({ dataDir: dirs.dataDir, staticDir: null, watch: false, sources: [] });
    expect(ctx.config.get()).toEqual({ schema: 1, libraryDir: join(dirs.root, 'lib2'), enabledSources: [...SOURCE_IDS], importSubfolder: '' });
    await app.close();
  });

  it('switching the library folder re-indexes from the new folder', async () => {
    writeFileSync(join(dirs.libraryDir, 'old.atex'), fakeSong({ title: 'Old', tier: 1 }));
    const other = join(dirs.root, 'lib2');
    mkdirSync(other);
    writeFileSync(join(other, 'new.atex'), fakeSong({ title: 'New', tier: 1 }));
    t = await startApp(dirs);
    expect(t.ctx.library.all().map((e) => e.title)).toEqual(['Old']);
    const rescanned = waitForEvent(t.ctx.events, libraryChanged('rescan'));
    await t.app.inject({ method: 'PUT', url: '/api/config', payload: { libraryDir: other } });
    await rescanned;
    expect(t.ctx.library.all().map((e) => e.title)).toEqual(['New']);
    const health = (await t.app.inject({ method: 'GET', url: '/api/health' })).json<HealthResponse>();
    expect(health.libraryDir).toBe(other);
  });

  it('POST /api/library/rescan starts a rescan', async () => {
    t = await startApp(dirs);
    const rescanned = waitForEvent(t.ctx.events, libraryChanged('rescan'));
    writeFileSync(join(dirs.libraryDir, 'late.atex'), fakeSong({ title: 'Late', tier: 1 }));
    const res = await t.app.inject({ method: 'POST', url: '/api/library/rescan' });
    expect(res.json()).toEqual({ started: true });
    expect((await rescanned).ids).toHaveLength(1);
    expect(t.ctx.library.all().map((e) => e.title)).toEqual(['Late']);
  });

  it('accepts only loopback Host and Origin headers', async () => {
    t = await startApp(dirs);
    const ok = await t.app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:5174', origin: 'http://localhost:5174' } });
    expect(ok.statusCode).toBe(200);
    const proxied = await t.app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' } });
    expect(proxied.statusCode).toBe(200);
    // R1-P-07: another loopback origin (a different local server) may not post to the API.
    const otherLocal = await t.app.inject({ method: 'POST', url: '/api/library/rescan', headers: { host: '127.0.0.1:5174', origin: 'http://localhost:9999' } });
    expect(otherLocal.statusCode).toBe(403);
    const rebinding = await t.app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:5174' } });
    expect(rebinding.statusCode).toBe(403);
    const crossSite = await t.app.inject({ method: 'POST', url: '/api/library/rescan', headers: { origin: 'https://evil.example' } });
    expect(crossSite.statusCode).toBe(403);
    const nullOrigin = await t.app.inject({ method: 'POST', url: '/api/library/rescan', headers: { origin: 'null' } });
    expect(nullOrigin.statusCode).toBe(403);
    const notSse = await t.app.inject({ method: 'GET', url: '/api/events' });
    expect(notSse.statusCode).toBe(400);
  });

  it('closes cleanly with an SSE client still connected', async () => {
    t = await startApp(dirs);
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as AddressInfo;
    let connected!: () => void;
    const isConnected = new Promise<void>((r) => (connected = r));
    const ended = new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { accept: 'text/event-stream' } }, (res) => {
        connected();
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
    await isConnected;
    await t.app.close();
    t = undefined;
    await ended;
  });
});
