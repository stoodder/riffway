import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { StoreName } from '@shared/storage';
import { openStorage, type RiffwayStorage } from '../../src/storage';
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

describe('schema v1', () => {
  it('creates the stores, keys and indexes of docs/progress.md', async () => {
    const name = `riffway-schema-${Math.random()}`;
    (await openStorage({ dbName: name })).close();
    const db = await openDB(name);
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames].sort()).toEqual(
      ['audioLinks', 'bests', 'practiceDays', 'runs', 'sectionProgress', 'settings', 'songCache', 'streak'].sort(),
    );
    const tx = db.transaction([...db.objectStoreNames]);
    const shape = (s: string): unknown => {
      const store = tx.objectStore(s);
      return {
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: Object.fromEntries([...store.indexNames].map((i) => [i, store.index(i).keyPath])),
      };
    };
    expect(shape('settings')).toEqual({ keyPath: null, autoIncrement: false, indexes: {} });
    expect(shape('runs')).toEqual({
      keyPath: 'id',
      autoIncrement: true,
      indexes: { songId_arrangement_startedAt: ['songId', 'arrangement', 'startedAt'], startedAt: 'startedAt' },
    });
    expect(shape('bests')).toMatchObject({ keyPath: ['songId', 'arrangement', 'speedBucket'] });
    expect(shape('sectionProgress')).toEqual({
      keyPath: ['songId', 'arrangement', 'sectionIdx'],
      autoIncrement: false,
      indexes: { nextCheckAt: 'nextCheckAt' },
    });
    expect(shape('practiceDays')).toMatchObject({ keyPath: 'date' });
    expect(shape('streak')).toMatchObject({ keyPath: null });
    expect(shape('audioLinks')).toMatchObject({ keyPath: ['songId', 'arrangement'] });
    expect(shape('songCache')).toEqual({ keyPath: 'songId', autoIncrement: false, indexes: { lastPlayedAt: 'lastPlayedAt' } });
    db.close();
  });
});

describe('settings store', () => {
  it('starts with defaults and deep-merges updates, notifying subscribers', async () => {
    const s = await storage();
    expect(s.settings.get()).toEqual(DEFAULT_SETTINGS);
    const seen = vi.fn();
    const changes: StoreName[] = [];
    s.settings.subscribe(seen);
    s.onChange((store) => changes.push(store));
    const next = await s.settings.update({ mixer: { guide: 0.2 }, keyboard: { lanes: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH'] } });
    expect(next.mixer).toEqual({ ...DEFAULT_SETTINGS.mixer, guide: 0.2 });
    expect(next.keyboard.lanes[0]).toBe('KeyA');
    expect(s.settings.get()).toBe(next);
    expect(seen).toHaveBeenCalledWith(next);
    expect(changes).toEqual(['settings']);
  });

  it('persists across reopen and merges stored values over defaults', async () => {
    const name = `riffway-settings-${Math.random()}`;
    const a = await openStorage({ dbName: name });
    await a.settings.update({ tuner: { a4: 432 } });
    a.close();
    // Simulate an older record missing newer fields.
    const db = await openDB(name);
    await db.put('settings', { schema: 1, goals: { weeklyDays: 5 } }, 'settings');
    db.close();
    const b = await openStorage({ dbName: name });
    expect(b.settings.get().goals).toEqual({ dailyMinutes: 15, weeklyDays: 5 });
    expect(b.settings.get().mixer).toEqual(DEFAULT_SETTINGS.mixer);
    b.close();
  });

  it('replace() merges over defaults; unsubscribe stops notifications', async () => {
    const s = await storage();
    const seen = vi.fn();
    const off = s.settings.subscribe(seen);
    await s.settings.replace({ ...structuredClone(DEFAULT_SETTINGS), tuner: { a4: 442 } } as never);
    expect(s.settings.get().tuner.a4).toBe(442);
    off();
    await s.settings.update({ tuner: { a4: 440 } });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('runs', () => {
  it('adds runs with increasing ids and lists newest first with filters', async () => {
    const s = await storage();
    const ids = [
      await s.addRun(makeRun({ startedAt: 100 })),
      await s.addRun(makeRun({ startedAt: 300 })),
      await s.addRun(makeRun({ startedAt: 200, arrangement: 1 })),
      await s.addRun(makeRun({ startedAt: 400, songId: 'starter:other' })),
    ];
    expect(ids).toEqual([1, 2, 3, 4]);
    expect((await s.listRuns()).map((r) => r.id)).toEqual([4, 2, 3, 1]);
    expect((await s.listRuns({ limit: 2 })).map((r) => r.id)).toEqual([4, 2]);
    expect((await s.listRuns({ since: 200 })).map((r) => r.id)).toEqual([4, 2, 3]);
    expect((await s.listRuns({ songId: 'starter:ode' })).map((r) => r.id)).toEqual([2, 3, 1]);
    expect((await s.listRuns({ songId: 'starter:ode', arrangement: 0 })).map((r) => r.id)).toEqual([2, 1]);
    expect((await s.listRuns({ songId: 'starter:ode', arrangement: 0, since: 150, limit: 5 })).map((r) => r.id)).toEqual([2]);
    expect((await s.listRuns({ songId: 'starter:ode', limit: 1 })).map((r) => r.id)).toEqual([2]);
    expect((await s.listRuns({ arrangement: 1 })).map((r) => r.id)).toEqual([3]);
  });

  it('does not store undefined-valued fields', async () => {
    const s = await storage();
    await s.addRun({ ...makeRun(), loop: undefined });
    const [r] = await s.listRuns();
    expect(r && 'loop' in r).toBe(false);
  });
});

describe('bests', () => {
  it('keeps the higher score per speed bucket', async () => {
    const s = await storage();
    expect(await s.putBestIfBetter(makeBest({ score: 100 }))).toBe(true);
    expect(await s.putBestIfBetter(makeBest({ score: 90 }))).toBe(false);
    expect(await s.putBestIfBetter(makeBest({ score: 100, runId: 9 }))).toBe(false);
    expect(await s.putBestIfBetter(makeBest({ score: 150, runId: 2 }))).toBe(true);
    expect(await s.putBestIfBetter(makeBest({ speedBucket: 100, score: 50 }))).toBe(true);
    await s.putBestIfBetter(makeBest({ arrangement: 1, score: 999 }));
    const bests = await s.getBests('starter:ode', 0);
    expect(bests.map((b) => [b.speedBucket, b.score, b.runId])).toEqual([
      [70, 150, 2],
      [100, 50, 1],
    ]);
  });

  it('serialises concurrent writes to one bucket', async () => {
    const s = await storage();
    const results = await Promise.all([10, 30, 20].map((score) => s.putBestIfBetter(makeBest({ score }))));
    expect(results).toEqual([true, true, false]);
    expect((await s.getBests('starter:ode', 0))[0]?.score).toBe(30);
  });
});

describe('section progress and due checks', () => {
  it('stores per section and lists due checks earliest first', async () => {
    const s = await storage();
    await s.putSectionProgress(makeProgress({ sectionIdx: 0 }));
    await s.putSectionProgress(makeProgress({ sectionIdx: 1, masteredAt: 10, nextCheckAt: 500 }));
    await s.putSectionProgress(makeProgress({ sectionIdx: 2, masteredAt: 10, nextCheckAt: 300 }));
    await s.putSectionProgress(makeProgress({ songId: 'x', sectionIdx: 0, masteredAt: 10, nextCheckAt: 900 }));
    expect((await s.getSectionProgress('starter:ode', 0)).map((p) => p.sectionIdx)).toEqual([0, 1, 2]);
    expect((await s.listDueChecks(500)).map((p) => p.sectionIdx)).toEqual([2, 1]);
    expect(await s.listDueChecks(299)).toEqual([]);
    // Locking in clears nextCheckAt, which drops the record from the index.
    const locked = makeProgress({ sectionIdx: 2, masteredAt: 10, lockedInAt: 400 });
    await s.putSectionProgress(locked);
    expect((await s.listDueChecks(1000)).map((p) => p.sectionIdx)).toEqual([1, 0]);
    expect((await s.getSectionProgress('starter:ode', 0))[2]).toEqual(locked);
  });
});

describe('practice days, streak, audio links, song cache', () => {
  it('accumulates active time per local day', async () => {
    const s = await storage();
    await s.addPracticeTime('2026-11-18', 120, 1);
    await s.addPracticeTime('2026-11-19', 200);
    const day = await s.addPracticeTime('2026-11-19', 250, 2);
    expect(day).toEqual({ date: '2026-11-19', activeSec: 450, runs: 2 });
    await s.addPracticeTime('2026-11-21', 60, 1);
    expect((await s.listPracticeDays()).map((d) => d.date)).toEqual(['2026-11-18', '2026-11-19', '2026-11-21']);
    expect((await s.listPracticeDays('2026-11-19')).map((d) => d.date)).toEqual(['2026-11-19', '2026-11-21']);
    expect((await s.listPracticeDays(undefined, '2026-11-19')).map((d) => d.date)).toEqual(['2026-11-18', '2026-11-19']);
    expect((await s.listPracticeDays('2026-11-19', '2026-11-20')).map((d) => d.date)).toEqual(['2026-11-19']);
  });

  it('stores the streak record', async () => {
    const s = await storage();
    expect(await s.getStreak()).toBeNull();
    const state = { weekTarget: 4, current: 2, best: 5, freezes: 1, weeksTowardFreeze: 0, lastEvaluatedWeek: '2026-W46' };
    await s.putStreak(state);
    expect(await s.getStreak()).toEqual(state);
  });

  it('puts, gets and deletes audio links', async () => {
    const s = await storage();
    expect(await s.getAudioLink('local:abc', 0)).toBeNull();
    await s.putAudioLink(makeLink());
    expect(await s.getAudioLink('local:abc', 0)).toEqual(makeLink());
    await s.deleteAudioLink('local:abc', 0);
    expect(await s.getAudioLink('local:abc', 0)).toBeNull();
  });

  it('lists recently played songs, most recent first, skipping never-played entries', async () => {
    const s = await storage();
    await s.putSongCache(makeCache({ songId: 'a', lastPlayedAt: 100 }));
    await s.putSongCache(makeCache({ songId: 'b', lastPlayedAt: 300 }));
    await s.putSongCache(makeCache({ songId: 'c', lastPlayedAt: null }));
    await s.putSongCache(makeCache({ songId: 'd', lastPlayedAt: 200 }));
    expect((await s.listRecentSongs(10)).map((e) => e.songId)).toEqual(['b', 'd', 'a']);
    expect((await s.listRecentSongs(1)).map((e) => e.songId)).toEqual(['b']);
    expect((await s.getSongCache('c'))?.lastPlayedAt).toBeNull();
    expect(await s.getSongCache('zzz')).toBeNull();
  });
});

describe('change notifications and clearAll', () => {
  it('fires onChange per written store', async () => {
    const s = await storage();
    const changes: StoreName[] = [];
    const off = s.onChange((store) => changes.push(store));
    await s.addRun(makeRun());
    await s.putBestIfBetter(makeBest());
    await s.putBestIfBetter(makeBest({ score: 1 })); // not better: no write, no event
    await s.putSectionProgress(makeProgress());
    await s.addPracticeTime('2026-11-19', 1);
    await s.putStreak({ weekTarget: 4, current: 0, best: 0, freezes: 0, weeksTowardFreeze: 0, lastEvaluatedWeek: null });
    await s.putAudioLink(makeLink());
    await s.deleteAudioLink('local:abc', 0);
    await s.putSongCache(makeCache());
    off();
    await s.addRun(makeRun());
    expect(changes).toEqual(['runs', 'bests', 'sectionProgress', 'practiceDays', 'streak', 'audioLinks', 'audioLinks', 'songCache']);
  });

  it('clearAll deletes everything and resets settings to defaults', async () => {
    const s = await storage();
    await s.settings.update({ tuner: { a4: 430 } });
    await s.addRun(makeRun());
    await s.putSongCache(makeCache());
    await s.putStreak({ weekTarget: 4, current: 1, best: 1, freezes: 0, weeksTowardFreeze: 1, lastEvaluatedWeek: '2026-W46' });
    const seen = vi.fn();
    s.settings.subscribe(seen);
    await s.clearAll();
    expect(s.settings.get()).toEqual(DEFAULT_SETTINGS);
    expect(seen).toHaveBeenCalledOnce();
    const file = await s.exportAll();
    expect(file.stores).toEqual({ runs: [], bests: [], sectionProgress: [], practiceDays: [], streak: null, audioLinks: [], songCache: [] });
  });
});
