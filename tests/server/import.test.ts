import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, type ImportResponse, type SearchResponse } from '@shared/api';
import { MAX_IMPORT_FILES } from '../../server/routes/library';
import { fakeSong, libraryChanged, makeTempDirs, multipart, startApp, waitForEvent, type TempDirs, type TestApp } from './helpers';

describe('POST /api/library/import', () => {
  let dirs: TempDirs;
  let t: TestApp;

  beforeEach(async () => {
    dirs = makeTempDirs();
  });
  afterEach(async () => {
    await t.app.close();
    dirs.cleanup();
  });

  const upload = async (files: { name: string; data: string | Uint8Array }[]): Promise<ImportResponse> => {
    const res = await t.app.inject({ method: 'POST', url: '/api/library/import', ...(await multipart(files)) });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ImportResponse>();
  };

  it('imports allowed files, suffixes collisions, dedupes by sha1 and rejects the rest', async () => {
    t = await startApp(dirs);
    const song = fakeSong({ title: 'Song', tier: 2 });
    const r = await upload([
      { name: 'Song.gp5', data: song },
      { name: 'Song.gp5', data: fakeSong({ title: 'Other', tier: 2 }) },
      { name: 'copy.gp5', data: song },
      { name: 'Lagrima.TXT', data: 'tab' },
      { name: 'Lagrima.mid', data: 'MThd' },
      { name: 'evil.exe', data: 'MZ' },
      { name: 'empty.atex', data: '' },
      { name: 'we<ird>:name?.atex', data: 'x' },
    ]);
    expect(r.files).toEqual([
      { name: 'Song.gp5', status: 'imported', path: 'Song.gp5' },
      { name: 'Song.gp5', status: 'imported', path: 'Song (2).gp5' },
      { name: 'copy.gp5', status: 'duplicate', path: 'Song.gp5' },
      { name: 'Lagrima.TXT', status: 'imported', path: 'Lagrima.txt' },
      { name: 'Lagrima.mid', status: 'imported', path: 'Lagrima.mid' },
      { name: 'evil.exe', status: 'rejected', reason: expect.stringContaining('Unsupported file type .exe') },
      { name: 'empty.atex', status: 'rejected', reason: 'File is empty' },
      { name: 'we<ird>:name?.atex', status: 'imported', path: 'we_ird__name_.atex' },
    ]);
    expect(readFileSync(join(dirs.libraryDir, 'Song.gp5'), 'utf8')).toBe(song);
    // No temp files left behind.
    expect(readdirSync(dirs.libraryDir).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('reports content already in the library as a duplicate, even under the same name', async () => {
    t = await startApp(dirs);
    const song = fakeSong({ title: 'Song', tier: 2 });
    await upload([{ name: 'a.atex', data: song }]);
    await t.ctx.library.rescan();
    expect((await upload([{ name: 'b.atex', data: song }])).files[0]).toEqual({ name: 'b.atex', status: 'duplicate', path: 'a.atex' });
    expect((await upload([{ name: 'a.atex', data: song }])).files[0]).toEqual({ name: 'a.atex', status: 'duplicate', path: 'a.atex' });
  });

  it('blocks path traversal in file names and the import subfolder', async () => {
    t = await startApp(dirs);
    const r = await upload([
      { name: '../../escape.atex', data: 'x' },
      { name: '..\\escape.atex', data: 'x' },
      { name: '/etc/passwd.txt', data: 'x' },
      { name: '..', data: 'x' },
    ]);
    for (const f of r.files) expect(f).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/path|Invalid|Unsupported/) });
    expect(existsSync(join(dirs.root, 'escape.atex'))).toBe(false);
    expect(existsSync(join(dirs.libraryDir, 'escape.atex'))).toBe(false);

    for (const importSubfolder of ['../outside', '/abs', 'a/../../b', '.hidden']) {
      const res = await t.app.inject({ method: 'PUT', url: '/api/config', payload: { importSubfolder } });
      expect(res.statusCode, importSubfolder).toBe(400);
    }
    await t.app.inject({ method: 'PUT', url: '/api/config', payload: { importSubfolder: 'Imported/Drops' } });
    expect((await upload([{ name: 'in.atex', data: 'y' }])).files[0]).toMatchObject({ status: 'imported', path: 'Imported/Drops/in.atex' });
  });

  it('caps the size at 20 MB', async () => {
    t = await startApp(dirs);
    const big = new Uint8Array(LIMITS.importBytes + 1).fill(65);
    const r = await upload([{ name: 'big.gp', data: big }, { name: 'ok.gp', data: 'fine' }]);
    expect(r.files).toEqual([
      { name: 'big.gp', status: 'rejected', reason: 'File is larger than 20 MB' },
      { name: 'ok.gp', status: 'imported', path: 'ok.gp' },
    ]);
    expect(existsSync(join(dirs.libraryDir, 'big.gp'))).toBe(false);
  });

  it('answers 400 to non-multipart or empty requests', async () => {
    t = await startApp(dirs);
    const json = await t.app.inject({ method: 'POST', url: '/api/library/import', payload: { files: [] } });
    expect(json.statusCode).toBe(400);
    const empty = await t.app.inject({ method: 'POST', url: '/api/library/import', ...(await multipart([], 'files')) });
    expect(empty.statusCode).toBe(400);
  });

  it('never overwrites a file when concurrent imports race for the same name (R1-P-08)', async () => {
    t = await startApp(dirs);
    const count = 12;
    const bodies = await Promise.all(Array.from({ length: count }, (_, i) => multipart([{ name: 'Race.atex', data: `content ${i}` }])));
    const responses = await Promise.all(bodies.map((b) => t.app.inject({ method: 'POST', url: '/api/library/import', ...b })));
    const results = responses.map((r) => r.json<ImportResponse>().files[0]!);
    expect(results.every((f) => f.status === 'imported')).toBe(true);
    const paths = results.map((f) => f.path ?? '');
    expect(new Set(paths).size).toBe(count);
    // Every response points at its own content.
    paths.forEach((path, i) => expect(readFileSync(join(dirs.libraryDir, path), 'utf8'), path).toBe(`content ${i}`));
    expect(readdirSync(dirs.libraryDir).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it(`refuses a request with more than ${MAX_IMPORT_FILES} files before saving any of them (R1-P-09)`, async () => {
    t = await startApp(dirs);
    const files = Array.from({ length: MAX_IMPORT_FILES + 1 }, (_, i) => ({ name: `f${i}.atex`, data: `song ${i}` }));
    const res = await t.app.inject({ method: 'POST', url: '/api/library/import', ...(await multipart(files)) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'too-many-files' });
    expect(readdirSync(dirs.libraryDir)).toEqual([]);
    // Exactly the limit is fine.
    expect((await upload(files.slice(0, MAX_IMPORT_FILES))).files).toHaveLength(MAX_IMPORT_FILES);
  });

  it('import → indexed by the watcher → searchable within 2 s', async () => {
    t = await startApp(dirs, { watch: true });
    await t.watcherReady;
    const added = waitForEvent(t.ctx.events, libraryChanged('added'));
    const started = Date.now();
    await upload([{ name: 'Mountain King.atex', data: fakeSong({ title: 'Hall of the Mountain King', tier: 3 }) }]);
    const event = await added;
    expect(Date.now() - started).toBeLessThan(2000);
    const res = await t.app.inject({ method: 'GET', url: '/api/search?q=mountain%20king' });
    const results = res.json<SearchResponse>().results;
    expect(results.map((r) => r.id)).toEqual(event.ids);
    expect(results[0]).toMatchObject({ source: 'local', tier: 3, fileName: 'Mountain King.atex' });
  });
});
