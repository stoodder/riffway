import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { ExportFile, StoreName } from '@shared/storage';
import { backupFileName, ImportValidationError, mergeStores, parseBackup, serializeBackup, type RiffwayStorage } from '../../src/storage';
import { emptyStores } from '../../src/storage/export';
import { freshStorage, makeBest, makeCache, makeLink, makeProgress, makeRun } from './fixtures';

const open: RiffwayStorage[] = [];
async function storage(): Promise<RiffwayStorage> {
  const s = await freshStorage();
  open.push(s);
  return s;
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

/** A storage with something in every store. */
async function populated(): Promise<RiffwayStorage> {
  const s = await storage();
  await s.settings.update({ tuner: { a4: 442 }, calibration: { inputOffsetMs: 23.5, method: 'play-to-click', measuredAt: 1_000 } });
  const r1 = await s.addRun(makeRun({ startedAt: 1_000 }));
  await s.addRun(makeRun({ startedAt: 2_000, speed: 1, loop: { startBar: 4, endBar: 8 }, clean: false, accuracy: 71.25 }));
  await s.putBestIfBetter(makeBest({ runId: r1 }));
  await s.putSectionProgress(makeProgress());
  await s.putSectionProgress(makeProgress({ sectionIdx: 1, masteredAt: 5_000, nextCheckAt: 90_000 }));
  await s.addPracticeTime('2026-11-18', 640, 4);
  await s.addPracticeTime('2026-11-19', 125.5, 1);
  await s.putStreak({ weekTarget: 4, current: 3, best: 7, freezes: 1, weeksTowardFreeze: 1, lastEvaluatedWeek: '2026-W46', repairWeek: '2026-W46' });
  await s.putAudioLink(makeLink());
  await s.putSongCache(makeCache());
  await s.putSongCache(makeCache({ songId: 'local:x', lastPlayedAt: null, favourite: true }));
  return s;
}

/** Export without the timestamp (differs between calls). */
const contents = (f: ExportFile): Omit<ExportFile, 'exportedAt'> => {
  const { exportedAt: _ignored, ...rest } = f;
  return rest;
};

describe('export file', () => {
  it('is versioned and carries every store', async () => {
    const s = await populated();
    const file = await s.exportAll();
    expect(file).toMatchObject({ app: 'riffway', schemaVersion: 1, exportedAt: '2026-11-19T20:00:00.000Z', server: { sidecars: {} } });
    expect(file.settings.tuner.a4).toBe(442);
    expect(file.stores.runs).toHaveLength(2);
    expect(file.stores.streak?.best).toBe(7);
    expect(s.previewImport(file)).toEqual({
      ok: true,
      errors: [],
      schemaVersion: 1,
      exportedAt: '2026-11-19T20:00:00.000Z',
      counts: { runs: 2, bests: 1, sectionProgress: 2, practiceDays: 2, streak: 1, audioLinks: 1, songCache: 2, sidecars: 0 },
    });
  });

  it('names backups by local date', () => {
    expect(backupFileName(new Date(2026, 10, 19, 23, 30).getTime())).toBe('riffway-backup-2026-11-19.json');
  });
});

describe('round trip', () => {
  it('export → JSON → wipe → import (replace) yields identical stores', async () => {
    const s = await populated();
    const before = await s.exportAll();
    const text = serializeBackup(before);

    await s.clearAll();
    expect((await s.exportAll()).stores.runs).toEqual([]);

    const { preview, file } = parseBackup(text);
    expect(preview.ok).toBe(true);
    await s.importAll(file!, 'replace');
    const after = await s.exportAll();
    expect(contents(after)).toStrictEqual(contents(before));
    expect(s.settings.get()).toStrictEqual(before.settings);

    // Typed reads see the same records, and the run id generator continues after the imported ids.
    expect(await s.getBests('starter:ode', 0)).toStrictEqual(before.stores.bests);
    expect(await s.listDueChecks(100_000)).toHaveLength(1);
    expect(await s.addRun(makeRun({ startedAt: 9_000 }))).toBe(3);
  });

  it('round-trips into a different database too', async () => {
    const a = await populated();
    const b = await storage();
    const file = await a.exportAll();
    await b.importAll(JSON.parse(serializeBackup(file)) as ExportFile, 'replace');
    expect(contents(await b.exportAll())).toStrictEqual(contents(file));
  });

  it('keeps unknown extra fields', async () => {
    const s = await storage();
    const file = await (await populated()).exportAll();
    (file.stores.runs[0] as unknown as Record<string, unknown>).futureField = { x: 1 };
    await s.importAll(file, 'replace');
    expect((await s.exportAll()).stores.runs[0]).toMatchObject({ futureField: { x: 1 } });
  });
});

describe('validation', () => {
  const valid = async (): Promise<ExportFile> => JSON.parse(serializeBackup(await (await populated()).exportAll())) as ExportFile;

  it('rejects text that is not JSON', () => {
    const { preview, file } = parseBackup('{"app": "riffway",');
    expect(file).toBeNull();
    expect(preview.ok).toBe(false);
    expect(preview.errors[0]).toMatch(/^This file is not valid JSON \(/);
  });

  it('rejects foreign files with a clear message', () => {
    expect(parseBackup('[1,2]').preview.errors).toEqual(['This file is not a Riffway backup (expected a JSON object).']);
    expect(parseBackup('{"name":"package"}').preview.errors).toEqual(['This file is not a Riffway backup (no "app" field).']);
    expect(parseBackup('{"app":"other-app","schemaVersion":1}').preview.errors).toEqual([
      'This file is not a Riffway backup ("app" is "other-app").',
    ]);
  });

  it('rejects files from a newer version and bad versions', async () => {
    const file = await valid();
    const newer = parseBackup(JSON.stringify({ ...file, schemaVersion: 2 }));
    expect(newer.preview).toMatchObject({ ok: false, schemaVersion: 2 });
    expect(newer.preview.errors[0]).toBe(
      'This backup was made by a newer version of Riffway (schema 2); this version reads schema 1 and older. Update Riffway to import it.',
    );
    expect(parseBackup(JSON.stringify({ ...file, schemaVersion: '1' })).preview.errors).toEqual(['schemaVersion: expected a positive integer.']);
    expect(parseBackup(JSON.stringify({ ...file, schemaVersion: 0 })).preview.errors).toEqual(['schemaVersion: expected a positive integer.']);
  });

  it('reports malformed records with their path', async () => {
    const file = await valid();
    const bad = structuredClone(file) as unknown as { stores: Record<string, Record<string, unknown>[]>; settings: Record<string, unknown> };
    bad.stores.runs[1]!.accuracy = 140;
    delete bad.stores.runs[0]!.songId;
    bad.stores.practiceDays[0]!.date = '19/11/2026';
    bad.stores.audioLinks[0]!.anchors = [{ songTime: 'x', audioTime: 0 }];
    (bad.settings.tuner as Record<string, unknown>).a4 = 'loud';
    (bad.settings.input as Record<string, unknown>).channel = 3;
    const { preview, file: out } = parseBackup(JSON.stringify(bad));
    expect(out).toBeNull();
    expect(preview.errors).toEqual([
      'settings.input.channel: expected one of 0, 1, "mix"',
      'settings.tuner.a4: expected number, got string',
      'stores.runs[0].songId: missing',
      'stores.runs[1].accuracy: expected a number 0–100',
      'stores.practiceDays[0].date: expected a date YYYY-MM-DD',
      'stores.audioLinks[0].anchors[0].songTime: expected a finite number, got string',
    ]);
    expect(preview.counts.runs).toBe(2);
  });

  it('reports missing parts, bad timestamps, bad sidecars and duplicate keys', async () => {
    const file = await valid();
    const { stores, ...rest } = file;
    const { songCache: _dropped, ...partial } = stores;
    const errs = parseBackup(
      JSON.stringify({ ...rest, exportedAt: 'yesterday', stores: partial, server: { sidecars: { 'local:a': { schema: 1 } } } }),
    ).preview.errors;
    expect(errs).toContain('exportedAt: expected an ISO 8601 timestamp');
    expect(errs).toContain('stores.songCache: missing');
    expect(errs).toContain('server.sidecars["local:a"].bpm: missing');

    const dup = structuredClone(file);
    dup.stores.bests.push(dup.stores.bests[0]!);
    dup.stores.runs[1]!.id = dup.stores.runs[0]!.id;
    expect(parseBackup(JSON.stringify(dup)).preview.errors).toEqual([
      'stores.runs[1]: duplicate key 1',
      'stores.bests[1]: duplicate key ["starter:ode",0,70]',
    ]);
  });

  it('caps the error list', async () => {
    const file = await valid();
    file.stores.practiceDays = Array.from({ length: 30 }, (_, i) => ({ date: `bad-${i}`, activeSec: 1, runs: 0 }));
    const errs = parseBackup(JSON.stringify(file)).preview.errors;
    expect(errs).toHaveLength(21);
    expect(errs[20]).toBe('…and 10 more problems');
  });

  it('importAll throws ImportValidationError and leaves data untouched', async () => {
    const s = await populated();
    const before = await s.exportAll();
    const bad = { ...before, app: 'nope' } as unknown as ExportFile;
    await expect(s.importAll(bad, 'replace')).rejects.toBeInstanceOf(ImportValidationError);
    await expect(s.importAll(bad, 'replace')).rejects.toThrow('The backup cannot be imported: This file is not a Riffway backup ("app" is "nope").');
    expect(contents(await s.exportAll())).toStrictEqual(contents(before));
  });

  it('counts sidecars in the preview', async () => {
    const file = await valid();
    file.server.sidecars['local:a'] = { schema: 1, bpm: 90, timeSig: [4, 4], grid: 8, onsets: [0, 0.5], method: 'snap', savedAt: 1 };
    expect(parseBackup(JSON.stringify(file)).preview).toMatchObject({ ok: true, counts: { sidecars: 1 } });
  });
});

describe('merge', () => {
  it('unions by key, keeps local settings, and is idempotent', async () => {
    const remote = await storage();
    await remote.settings.update({ tuner: { a4: 415 } });
    await remote.addRun(makeRun({ songId: 'remote:1', startedAt: 50 }));
    await remote.addPracticeTime('2026-11-01', 900, 2);
    await remote.putSongCache(makeCache({ songId: 'remote:1', lastPlayedAt: 50 }));
    const file = await remote.exportAll();

    const s = await populated();
    const changes = new Set<StoreName>();
    s.onChange((store) => changes.add(store));
    const before = await s.exportAll();
    await s.importAll(file, 'merge');
    const once = await s.exportAll();
    expect(once.settings).toStrictEqual(before.settings);
    expect(once.stores.runs.map((r) => [r.id, r.songId])).toEqual([
      [1, 'starter:ode'],
      [2, 'starter:ode'],
      [3, 'remote:1'],
    ]);
    expect(once.stores.practiceDays.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-18', '2026-11-19']);
    expect(once.stores.songCache.map((e) => e.songId)).toEqual(['local:x', 'remote:1', 'starter:ode']);
    expect(changes.size).toBe(8);

    await s.importAll(file, 'merge');
    await s.importAll(before, 'merge');
    expect(contents(await s.exportAll())).toStrictEqual(contents(once));
  });

  it('replace uses the file settings and drops local-only records', async () => {
    const remote = await storage();
    await remote.settings.update({ tuner: { a4: 415 } });
    const file = await remote.exportAll();
    const s = await populated();
    await s.importAll(file, 'replace');
    expect(s.settings.get().tuner.a4).toBe(415);
    expect(contents(await s.exportAll())).toStrictEqual(contents(file));
  });

  it('applies the conflict rules per store', () => {
    const local = {
      ...emptyStores(),
      runs: [{ ...makeRun({ startedAt: 10 }), id: 1 }],
      bests: [makeBest({ score: 500, runId: 1 }), makeBest({ speedBucket: 100, score: 900, runId: 1 })],
      sectionProgress: [makeProgress({ sectionIdx: 0, cleanRuns: 5 }), makeProgress({ sectionIdx: 1, cleanRuns: 2 })],
      practiceDays: [{ date: '2026-11-18', activeSec: 600, runs: 3 }],
      streak: { weekTarget: 4, current: 2, best: 9, freezes: 0, weeksTowardFreeze: 0, lastEvaluatedWeek: '2026-W45' },
      audioLinks: [makeLink({ gainDb: -1 })],
      songCache: [makeCache({ songId: 'a', lastPlayedAt: 100 }), makeCache({ songId: 'b', lastPlayedAt: 900 })],
    };
    const incoming = {
      ...emptyStores(),
      runs: [
        { ...makeRun({ startedAt: 10 }), id: 7 }, // same run as local id 1
        { ...makeRun({ startedAt: 20 }), id: 1 }, // new run whose id is taken locally
      ],
      bests: [makeBest({ score: 800, runId: 1 }), makeBest({ speedBucket: 100, score: 100, runId: 7 })],
      sectionProgress: [makeProgress({ sectionIdx: 0, cleanRuns: 4 }), makeProgress({ sectionIdx: 1, cleanRuns: 6 })],
      practiceDays: [{ date: '2026-11-18', activeSec: 300, runs: 9 }],
      streak: { weekTarget: 5, current: 1, best: 3, freezes: 1, weeksTowardFreeze: 1, lastEvaluatedWeek: '2026-W46' },
      audioLinks: [makeLink({ gainDb: -9 })],
      songCache: [makeCache({ songId: 'a', lastPlayedAt: 200 }), makeCache({ songId: 'b', lastPlayedAt: null })],
    };
    const merged = mergeStores(local, incoming);
    expect(merged.runs.map((r) => [r.id, r.startedAt])).toEqual([
      [1, 10],
      [8, 20],
    ]);
    // Imported best (score 800) wins and its runId follows the renumbering 1 → 8.
    expect(merged.bests.map((b) => [b.speedBucket, b.score, b.runId])).toEqual([
      [70, 800, 8],
      [100, 900, 1],
    ]);
    expect(merged.sectionProgress.map((p) => p.cleanRuns)).toEqual([5, 6]);
    expect(merged.practiceDays).toEqual([{ date: '2026-11-18', activeSec: 600, runs: 3 }]);
    expect(merged.streak).toEqual({ ...incoming.streak, best: 9 });
    expect(merged.audioLinks[0]?.gainDb).toBe(-1);
    expect(merged.songCache.map((e) => [e.songId, e.lastPlayedAt])).toEqual([
      ['a', 200],
      ['b', 900],
    ]);
    // Inputs are not mutated.
    expect(incoming.runs[1]?.id).toBe(1);
  });

  it('a replace import keeps run ids and numbers runs without one', () => {
    const merged = mergeStores(emptyStores(), {
      ...emptyStores(),
      runs: [{ ...makeRun({ startedAt: 1 }), id: 4 }, makeRun({ startedAt: 2 }) as never],
    });
    expect(merged.runs.map((r) => r.id)).toEqual([4, 5]);
  });

  it('settings from an older file are merged over defaults on replace', async () => {
    const s = await storage();
    const file = await s.exportAll();
    const partial = { ...file, settings: { schema: 1, tuner: { a4: 430 } } } as unknown as ExportFile;
    await s.importAll(partial, 'replace');
    expect(s.settings.get()).toStrictEqual({ ...structuredClone(DEFAULT_SETTINGS), tuner: { a4: 430 } });
  });
});
