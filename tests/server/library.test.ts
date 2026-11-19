import { mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SongMeta, SourcesResponse } from '@shared/api';
import type { RhythmSidecar } from '@shared/song';
import { ImportError } from '@core/import/errors';
import { defaultAnalyzer, isSkippableImportError } from '../../server/indexer/analyzer';
import { createFakeAnalyzer, fakeSong, libraryChanged, makeTempDirs, startApp, waitForEvent, writeStarter, type TempDirs, type TestApp } from './helpers';

const sidecar: RhythmSidecar = { schema: 1, bpm: 90, timeSig: [4, 4], grid: 8, onsets: [0, 0.5], method: 'tap', savedAt: 1 };

describe('library index', () => {
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

  const lib = (rel: string, content: string): string => {
    const abs = join(dirs.libraryDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  };

  it('indexes local files with DEC-14 ids and starter items as starter:<slug>', async () => {
    lib('Rock/riff.atex', fakeSong({ title: 'Big Riff', artist: 'Band', tier: 3 }));
    lib('notes.md', 'not a song extension');
    lib('.hidden/secret.atex', fakeSong({ title: 'Hidden' }));
    writeStarter(dirs.starterDir, [{ slug: 'ode-to-joy', title: 'Ode to Joy', content: fakeSong({ title: 'Ode to Joy', tier: 1 }), genre: ['classical'] }]);
    t = await startApp(dirs);
    const entries = t.ctx.library.all();
    expect(entries.map((e) => e.title).sort()).toEqual(['Big Riff', 'Ode to Joy']);
    const local = entries.find((e) => e.source === 'local')!;
    expect(local.id).toMatch(/^local:[0-9a-f]{16}$/);
    expect(local.id).toBe(`local:${local.sha1.slice(0, 16)}`);
    expect(local.path).toBe('Rock/riff.atex');
    expect(local.difficulty?.tier).toBe(3);
    const starter = t.ctx.library.get('starter:ode-to-joy')!;
    expect(starter.source).toBe('starter');
    expect(starter.tags.genre).toEqual(['classical']);
    expect(starter.tags.style).toEqual(['pick']);
  });

  it('keeps ids sticky per path, for moved files, and salts duplicate content', async () => {
    const a = lib('a.atex', fakeSong({ title: 'A', tier: 2 }));
    t = await startApp(dirs);
    const id = t.ctx.library.all()[0]!.id;

    writeFileSync(a, fakeSong({ title: 'A edited', tier: 2 }));
    utimesSync(a, new Date(), new Date(Date.now() + 5000));
    await t.ctx.library.rescan();
    expect(t.ctx.library.get(id)?.title).toBe('A edited');

    renameSync(a, join(dirs.libraryDir, 'moved.atex'));
    await t.ctx.library.rescan();
    expect(t.ctx.library.get(id)?.path).toBe('moved.atex');

    lib('copy.atex', fakeSong({ title: 'A edited', tier: 2 }));
    await t.ctx.library.rescan();
    const ids = t.ctx.library.all().map((e) => e.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(id);
  });

  it('reuses the index.json cache for unchanged files after a restart', async () => {
    lib('one.atex', fakeSong({ title: 'One', tier: 2 }));
    lib('two.atex', fakeSong({ title: 'Two', tier: 4 }));
    t = await startApp(dirs);
    expect(t.analyzer.calls).toHaveLength(2);
    const before = t.ctx.library.all().map((e) => e.id).sort();
    await t.app.close();

    const changed = lib('two.atex', fakeSong({ title: 'Two v2', tier: 4 }));
    utimesSync(changed, new Date(), new Date(Date.now() + 5000));
    const analyzer = createFakeAnalyzer();
    t = await startApp(dirs, { analyzer });
    expect(analyzer.calls).toEqual(['two.atex']);
    expect(t.ctx.library.all().map((e) => e.id).sort()).toEqual(before);
    expect(t.ctx.library.all().map((e) => e.title).sort()).toEqual(['One', 'Two v2']);
  });

  it('skips non-songs silently and keeps broken songs visible with an error', async () => {
    lib('readme.txt', 'NOT A SONG at all');
    lib('broken.gp5', 'BROKEN file');
    lib('bass.atex', fakeSong({ title: 'Bass only', tracks: 0 }));
    t = await startApp(dirs);
    const entries = t.ctx.library.all();
    expect(entries.map((e) => e.fileName).sort()).toEqual(['bass.atex', 'broken.gp5']);
    const broken = entries.find((e) => e.fileName === 'broken.gp5')!;
    expect(broken.error).toContain('Bad syntax');
    expect(broken.format).toBe('gp5');
    expect(broken.defaultArrangement).toBe(-1);
    expect(entries.find((e) => e.fileName === 'bass.atex')!.error).toMatch(/playable/);
    // Deterministic failures (syntax, no playable track) and skipped files are cached by mtime + size.
    t.analyzer.calls.length = 0;
    await t.ctx.library.rescan();
    expect(t.analyzer.calls).toEqual([]);
  });

  it('lists a text file without tab as a failed import instead of skipping it (T-103)', async () => {
    lib('Some Band - Notes.txt', 'NO TAB in here, only words');
    lib('weird.xml', 'NOT A SONG: an XML file that is not MusicXML');
    t = await startApp(dirs);
    const entries = t.ctx.library.all();
    expect(entries.map((e) => e.fileName)).toEqual(['Some Band - Notes.txt']);
    const failed = entries[0]!;
    expect(failed).toMatchObject({ format: 'ascii', title: 'Notes', artist: 'Some Band', defaultArrangement: -1 });
    expect(failed.error).toMatch(/No guitar tab found/);
    const res = await t.app.inject({ method: 'GET', url: '/api/search' });
    expect(res.json<{ results: { fileName: string; availability: string }[] }>().results).toEqual([
      expect.objectContaining({ fileName: 'Some Band - Notes.txt', availability: 'needs-import' }),
    ]);
  });

  it('lists tab-less .txt files with the real importers too (T-103)', async () => {
    lib('lyrics.txt', 'Just some lyrics\nand chords: Am G F E\n');
    t = await startApp(dirs, { analyzer: defaultAnalyzer });
    const [entry] = t.ctx.library.all();
    expect(entry).toMatchObject({ fileName: 'lyrics.txt', title: 'lyrics', error: expect.stringMatching(/No guitar tab found/) });
    expect(isSkippableImportError(new ImportError('empty', 'No guitar tab found'))).toBe(false);
    expect(isSkippableImportError(new ImportError('unsupported', 'not a song'))).toBe(true);
  });

  it('retries only transient failures on later scans and restarts (R1-P-10)', async () => {
    lib('broken.gp5', 'BROKEN file');
    lib('bass.atex', fakeSong({ title: 'Bass only', tracks: 0 }));
    lib('crash.atex', 'CRASH please');
    t = await startApp(dirs);
    expect(t.ctx.library.all().find((e) => e.fileName === 'crash.atex')!.error).toBe('Importer crashed');
    t.analyzer.calls.length = 0;
    await t.ctx.library.rescan();
    expect(t.analyzer.calls).toEqual(['crash.atex']);
    await t.app.close();

    const analyzer = createFakeAnalyzer();
    t = await startApp(dirs, { analyzer });
    expect(analyzer.calls).toEqual(['crash.atex']);
    expect(t.ctx.library.all().map((e) => e.fileName).sort()).toEqual(['bass.atex', 'broken.gp5', 'crash.atex']);
  });

  it('retries failed entries from an older cache once (records without the retry flag)', async () => {
    lib('broken.gp5', 'BROKEN file');
    t = await startApp(dirs);
    await t.app.close();
    const cacheFile = join(dirs.dataDir, 'index.json');
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as { records: Record<string, unknown>[] };
    for (const r of cache.records) delete r.retry;
    writeFileSync(cacheFile, JSON.stringify(cache));

    const analyzer = createFakeAnalyzer();
    t = await startApp(dirs, { analyzer });
    expect(analyzer.calls).toEqual(['broken.gp5']);
    analyzer.calls.length = 0;
    await t.ctx.library.rescan();
    expect(analyzer.calls).toEqual([]);
  });

  it('pairs a sibling .mid, reads sidecars and re-indexes on demand', async () => {
    lib('Tabs/Lagrima.txt', fakeSong({ title: 'Lagrima', rhythm: 'needs-alignment', tier: 4 }));
    lib('Tabs/lagrima.MID', 'MThd');
    lib('Other/solo.txt', fakeSong({ title: 'Solo', rhythm: 'needs-alignment', tier: 2 }));
    t = await startApp(dirs);
    const lagrima = t.ctx.library.all().find((e) => e.title === 'Lagrima')!;
    expect(lagrima.hasMidi).toBe(true);
    expect(t.ctx.library.midiPath(lagrima)).toBe(join(dirs.libraryDir, 'Tabs/lagrima.MID'));
    const bundle = await t.ctx.library.readBundle(lagrima.id);
    expect(bundle.midi?.fileName).toBe('lagrima.MID');
    expect(bundle.source).toEqual({ source: 'local', path: 'Tabs/Lagrima.txt' });

    const solo = t.ctx.library.all().find((e) => e.title === 'Solo')!;
    expect(solo.hasSidecar).toBe(false);
    expect(t.ctx.library.sidecarPath(solo.id)).toBe(join(dirs.dataDir, 'sidecars', `${encodeURIComponent(solo.id)}.json`));
    mkdirSync(join(dirs.dataDir, 'sidecars'), { recursive: true });
    writeFileSync(t.ctx.library.sidecarPath(solo.id), JSON.stringify(sidecar));
    const updated = await t.ctx.library.reindex(solo.id);
    expect(updated?.hasSidecar).toBe(true);
    expect(updated?.rhythm).toBe('aligned');
    expect((await t.ctx.library.readBundle(solo.id)).sidecar).toEqual(sidecar);
    expect(await t.ctx.library.reindex('local:nope')).toBeNull();
  });

  it('serves song meta with per-arrangement difficulty and the raw file', async () => {
    const content = fakeSong({ title: 'Duet', tier: 3, tracks: 2 });
    lib('duet.atex', content);
    t = await startApp(dirs);
    const id = t.ctx.library.all()[0]!.id;
    const res = await t.app.inject({ method: 'GET', url: `/api/songs/${encodeURIComponent(id)}` });
    expect(res.statusCode).toBe(200);
    const meta = res.json<SongMeta>();
    expect(meta.entry.id).toBe(id);
    expect(meta.arrangements).toHaveLength(2);
    expect(Object.keys(meta.difficulty).sort()).toEqual(['0', '1']);
    expect(meta.difficulty[1]?.rating).toBe(4);
    expect(meta.files).toEqual({ main: `/api/songs/${encodeURIComponent(id)}/file` });
    // Computed once, then cached.
    await t.app.inject({ method: 'GET', url: `/api/songs/${encodeURIComponent(id)}` });
    expect(t.analyzer.difficultyCalls).toEqual([1]);

    const file = await t.app.inject({ method: 'GET', url: meta.files.main });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/octet-stream');
    expect(file.body).toBe(content);

    expect((await t.app.inject({ method: 'GET', url: '/api/songs/local%3Amissing' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/songs/..%2F..%2Fetc%2Fpasswd/file' })).statusCode).toBe(404);
  });

  it('reports sources with indexed counts and the enabled flag', async () => {
    lib('x.atex', fakeSong({ title: 'X', tier: 1 }));
    writeStarter(dirs.starterDir, [{ slug: 'scale', title: 'Scale', content: fakeSong({ title: 'Scale', tier: 1 }) }]);
    t = await startApp(dirs);
    const rescanned = waitForEvent(t.ctx.events, libraryChanged('rescan'));
    await t.ctx.config.update({ enabledSources: ['local'] });
    await rescanned;
    const res = await t.app.inject({ method: 'GET', url: '/api/sources' });
    const { sources } = res.json<SourcesResponse>();
    expect(sources.map((s) => [s.id, s.enabled, s.indexed, s.state])).toEqual([
      ['local', true, 1, 'idle'],
      ['starter', false, 1, 'idle'],
    ]);
    expect(sources[0]!.lastRefresh).toBeGreaterThan(0);
  });
});
