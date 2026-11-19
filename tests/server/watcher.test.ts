import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@shared/api';
import { fakeSong, libraryChanged, makeTempDirs, startApp, waitForEvent, type TempDirs, type TestApp } from './helpers';

describe('library watcher (chokidar)', () => {
  let dirs: TempDirs;
  let t: TestApp;

  beforeEach(async () => {
    dirs = makeTempDirs();
    t = await startApp(dirs, { watch: true, local: { debounceMs: 100, stabilityMs: 100 } });
    await t.watcherReady;
  });
  afterEach(async () => {
    await t.app.close();
    dirs.cleanup();
  });

  it('indexes added, changed and removed files', async () => {
    const file = join(dirs.libraryDir, 'Sub', 'riff.atex');
    mkdirSync(join(dirs.libraryDir, 'Sub'));

    const added = waitForEvent(t.ctx.events, libraryChanged('added'));
    writeFileSync(file, fakeSong({ title: 'Riff', tier: 2 }));
    const { ids } = await added;
    expect(ids).toHaveLength(1);
    const id = ids[0]!;
    expect(t.ctx.library.get(id)).toMatchObject({ title: 'Riff', path: 'Sub/riff.atex' });

    const changed = waitForEvent(t.ctx.events, libraryChanged('changed', id));
    writeFileSync(file, fakeSong({ title: 'Riff v2', tier: 2 }));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await changed;
    expect(t.ctx.library.get(id)?.title).toBe('Riff v2');

    const removed = waitForEvent(t.ctx.events, libraryChanged('removed', id));
    rmSync(file);
    await removed;
    expect(t.ctx.library.get(id)).toBeUndefined();
  });

  it('ignores hidden files and other extensions', async () => {
    const added = waitForEvent(t.ctx.events, libraryChanged('added'));
    writeFileSync(join(dirs.libraryDir, '.partial.atex'), fakeSong({ title: 'Hidden' }));
    writeFileSync(join(dirs.libraryDir, 'cover.jpg'), 'jpg');
    writeFileSync(join(dirs.libraryDir, 'real.atex'), fakeSong({ title: 'Real', tier: 1 }));
    await added;
    expect(t.ctx.library.all().map((e) => e.title)).toEqual(['Real']);
  });

  it('streams library.changed over SSE on /api/events', async () => {
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { address, port } = t.app.server.address() as AddressInfo;
    expect(address).toBe('127.0.0.1');

    const received: ServerEvent[] = [];
    let connected!: () => void;
    const isConnected = new Promise<void>((r) => (connected = r));
    const firstEvent = new Promise<{ contentType: string | undefined }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { accept: 'text/event-stream' } }, (res) => {
        // The route subscribes to the bus before it writes the first bytes, so we are live now.
        connected();
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = block.split('\n').find((l) => l.startsWith('data: '));
            if (data) received.push(JSON.parse(data.slice(6)) as ServerEvent);
          }
          if (received.some((e) => e.type === 'library.changed')) {
            resolve({ contentType: res.headers['content-type'] });
            req.destroy();
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
    await isConnected;
    writeFileSync(join(dirs.libraryDir, 'live.atex'), fakeSong({ title: 'Live', tier: 1 }));
    const { contentType } = await firstEvent;
    expect(contentType).toMatch(/^text\/event-stream/);
    expect(received.find((e) => e.type === 'library.changed')).toMatchObject({ type: 'library.changed', reason: 'added' });
    expect(received.some((e) => e.type === 'index.progress' && e.source === 'local')).toBe(true);
  });
});
