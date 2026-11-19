/**
 * Gathers the home screen's input (T-034): the library listing from the server and progress from
 * IndexedDB. Also evaluates the weekly streak lazily on open (docs/progress.md § Streaks) and stores
 * it when it changed. A server failure leaves `candidates` null; the local panels still render.
 * @module
 */
import type { AppContext } from '@shared/ui';
import type { SectionProgress, SongCacheEntry, StreakState } from '@shared/storage';
import { DAY_MS, evaluateStreak } from '@core/progress';
import { arrKey, type HomeInput } from './model';
import { readChecklist, readFocus } from './prefs';

/** Songs read from the server for recommendations and starter picks (server maximum). */
export const LISTING_LIMIT = 500;
/** Next-day checks are listed up to this far ahead (due now + due tomorrow). */
export const CHECK_HORIZON_MS = 2 * DAY_MS;

function sameStreak(a: StreakState | null, b: StreakState): boolean {
  if (!a) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof StreakState)[]);
  return [...keys].every((k) => a[k] === b[k]);
}

/** Load everything {@link buildHomeModel} needs. Persists the re-evaluated streak if it changed. */
export async function loadHomeInput(ctx: AppContext, now: number, prefs: Storage | null): Promise<HomeInput> {
  const settings = ctx.settings.get();
  const [candidates, runs, checks, practiceDays, prevStreak] = await Promise.all([
    ctx.api.search({ limit: LISTING_LIMIT }).then(
      (r) => r.results,
      () => null,
    ),
    ctx.storage.listRuns(),
    ctx.storage.listDueChecks(now + CHECK_HORIZON_MS),
    ctx.storage.listPracticeDays(),
    ctx.storage.getStreak(),
  ]);

  const streak = evaluateStreak(prevStreak, practiceDays, now, settings.goals.weeklyDays);
  if (!sameStreak(prevStreak, streak)) await ctx.storage.putStreak(streak);

  const arrangements = new Map<string, { songId: string; arrangement: number }>();
  for (const r of runs) arrangements.set(arrKey(r.songId, r.arrangement), { songId: r.songId, arrangement: r.arrangement });
  const songIds = new Set([...runs.map((r) => r.songId), ...checks.map((c) => c.songId)]);

  const [progressList, cacheList] = await Promise.all([
    Promise.all([...arrangements].map(async ([key, a]) => [key, await ctx.storage.getSectionProgress(a.songId, a.arrangement)] as const)),
    Promise.all([...songIds].map((id) => ctx.storage.getSongCache(id))),
  ]);
  const progress = new Map<string, readonly SectionProgress[]>(progressList);
  const songCache = new Map<string, SongCacheEntry>();
  for (const entry of cacheList) if (entry) songCache.set(entry.songId, entry);

  return {
    now,
    settings,
    candidates,
    runs,
    checks,
    practiceDays,
    streak,
    songCache,
    progress,
    checklist: readChecklist(prefs),
    focus: readFocus(prefs),
  };
}
