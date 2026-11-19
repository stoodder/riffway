/**
 * Run bookkeeping for the game session (docs/progress.md): per-section statistics from the judgement
 * log, section-progress updates (clean runs, speed trainer, mastery, next-day check, plateau) with a
 * player-facing description of what changed, and persisting a finished run (run record, bests per
 * speed bucket, section progress, active time per local day, the weekly streak and the song cache).
 *
 * The statistics and descriptions are pure; {@link persistRun} / {@link SectionProgressBook} do the I/O.
 * @module
 */
import type { BarLoop, InputSource, Judgement, RunSummary } from '@shared/judge';
import type { SearchResult } from '@shared/sources';
import type { IndexEntry } from '@shared/sources';
import type { Song } from '@shared/song';
import type { BestRecord, RunMode, RunRecord, SectionProgress, StorageService } from '@shared/storage';
import { passStats, type PassStats } from '@core/judge';
import { sectionAt } from '@core/model';
import {
  addDays,
  applySectionRun,
  evaluateStreak,
  isCheckDue,
  isPlateau,
  localDate,
  PLATEAU_MESSAGE,
  speedBucket,
} from '@core/progress';

/** Per-section statistics of a run (or one pass of it). */
export interface SectionPassStats extends PassStats {
  idx: number;
  /** Judge targets in the section (onset-group notes, tied destinations excluded). */
  targetNotes: number;
}

/** Number of judgeable notes per section (tied destinations are not targets). */
export function sectionTargetCounts(song: Pick<Song, 'notes' | 'sections' | 'timing'>): number[] {
  const counts = song.sections.map(() => 0);
  for (const n of song.notes) {
    if (n.tiedFrom !== undefined) continue;
    const idx = sectionAt(song as Song, n.time);
    if (idx >= 0 && idx < counts.length) counts[idx] = (counts[idx] ?? 0) + 1;
  }
  return counts;
}

/**
 * Per-section {@link PassStats} from a judgement log (only final judgements count; `pass` restricts to
 * one pass). Sections without judged notes are omitted.
 */
export function sectionStats(song: Song, judgements: readonly Judgement[], pass?: number): SectionPassStats[] {
  const bySection = new Map<number, Judgement[]>();
  for (const j of judgements) {
    if (pass !== undefined && j.pass !== pass) continue;
    const idx = sectionAt(song, j.songTime);
    if (idx < 0) continue;
    let list = bySection.get(idx);
    if (!list) bySection.set(idx, (list = []));
    list.push(j);
  }
  const targets = sectionTargetCounts(song);
  const out: SectionPassStats[] = [];
  for (const [idx, list] of [...bySection.entries()].sort(([a], [b]) => a - b)) {
    const stats = passStats(list);
    if (stats.judgedNotes === 0) continue;
    out.push({ ...stats, idx, targetNotes: targets[idx] ?? 0 });
  }
  return out;
}

/**
 * Distinct notes judged at least once per section (across passes), to tell whether a section was
 * played completely (a quit or a forward seek leaves notes unjudged).
 */
export function sectionCoverage(song: Song, judgements: readonly Judgement[]): Map<number, number> {
  const seen = new Map<number, Set<number>>();
  for (const j of judgements) {
    if (!j.final) continue;
    const idx = sectionAt(song, j.songTime);
    let set = seen.get(idx);
    if (!set) seen.set(idx, (set = new Set()));
    for (const id of j.noteIds) set.add(id);
  }
  return new Map([...seen].map(([idx, set]) => [idx, set.size]));
}

/** What a section-progress update means for the player. */
export type SectionEvent = 'clean' | 'mastered' | 'locked-in' | 'check-failed' | 'plateau';

/** One section's progress change (results screen "clean runs & mastery"). */
export interface SectionUpdate {
  sectionIdx: number;
  name: string;
  accuracy: number;
  speed: number;
  events: SectionEvent[];
  /** Lifetime clean runs after the update. */
  cleanRuns: number;
  /** Clean runs at 100% in the current practice session (2 master a section). */
  sessionCleanAt100: number;
  /** Trainer speed for the next run. */
  nextSpeed: number;
  progress: SectionProgress;
}

/** Events between two progress records of one section after a run at `at`. */
export function sectionEvents(prev: SectionProgress | null, next: SectionProgress, clean: boolean, at: number): SectionEvent[] {
  const events: SectionEvent[] = [];
  if (clean) events.push('clean');
  if (next.masteredAt !== undefined && next.masteredAt === at && prev?.masteredAt === undefined) events.push('mastered');
  if (next.lockedInAt !== undefined && next.lockedInAt === at) events.push('locked-in');
  if (prev && isCheckDue(prev, at) && next.masteredAt === undefined && prev.masteredAt !== undefined) events.push('check-failed');
  if (isPlateau(next) && (prev === null || !isPlateau(prev))) events.push('plateau');
  return events;
}

/** Player-facing line for a section event (informational, never guilt-based). */
export function sectionEventText(name: string, ev: SectionEvent): string {
  switch (ev) {
    case 'clean':
      return `${name}: clean run`;
    case 'mastered':
      return `${name} mastered! Next-day check from tomorrow 04:00.`;
    case 'locked-in':
      return `${name} locked in — next-day check passed.`;
    case 'check-failed':
      return `${name}: next-day check not clean yet — back to practising at 85%.`;
    case 'plateau':
      return PLATEAU_MESSAGE;
  }
}

/** Inputs for one section-progress application. */
export interface SectionRunFacts {
  sectionIdx: number;
  accuracy: number;
  clean: boolean;
  speed: number;
  at: number;
}

/** Context shared by every section update of one session. */
export interface SectionBookContext {
  songId: string;
  arrangement: number;
  sessionId: string;
  comfortTier: number;
  /** Section tier (difficulty report), else the song tier. */
  sectionTier(idx: number): number;
  sectionName(idx: number): string;
}

/**
 * Section progress for one arrangement, cached in memory and written through to storage in order.
 * `apply` is synchronous on the cache (so consecutive loop passes chain correctly) and queues the write.
 */
export class SectionProgressBook {
  private readonly cache = new Map<number, SectionProgress>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: Pick<StorageService, 'putSectionProgress'> | null,
    private readonly ctx: SectionBookContext,
    initial: readonly SectionProgress[],
  ) {
    for (const p of initial) this.cache.set(p.sectionIdx, p);
  }

  /** Current record of a section (null before its first run). */
  get(idx: number): SectionProgress | null {
    return this.cache.get(idx) ?? null;
  }

  /** Apply a run/pass to a section; returns the update (written to storage asynchronously). */
  apply(facts: SectionRunFacts): SectionUpdate {
    const prev = this.get(facts.sectionIdx);
    const next = applySectionRun(prev, {
      songId: this.ctx.songId,
      arrangement: this.ctx.arrangement,
      sectionIdx: facts.sectionIdx,
      accuracy: facts.accuracy,
      clean: facts.clean,
      speed: facts.speed,
      at: facts.at,
      sessionId: this.ctx.sessionId,
      sectionTier: this.ctx.sectionTier(facts.sectionIdx),
      comfortTier: this.ctx.comfortTier,
    });
    this.cache.set(facts.sectionIdx, next);
    const storage = this.storage;
    if (storage) {
      this.writes = this.writes
        .then(() => storage.putSectionProgress(next))
        .catch((err: unknown) => console.warn('Riffway: could not save section progress', err));
    }
    return {
      sectionIdx: facts.sectionIdx,
      name: this.ctx.sectionName(facts.sectionIdx),
      accuracy: facts.accuracy,
      speed: facts.speed,
      events: sectionEvents(prev, next, facts.clean, facts.at),
      cleanRuns: next.cleanRuns,
      sessionCleanAt100: next.session?.cleanRunsAt100 ?? 0,
      nextSpeed: next.trainer.speed,
      progress: next,
    };
  }

  /** Resolves once every queued write has finished. */
  flush(): Promise<void> {
    return this.writes;
  }
}

/**
 * Sections a non-loop run counts for: every section whose judge targets were all judged at least
 * once (a quit or a skipped stretch does not count as a run of that section).
 */
export function completedSections(song: Song, judgements: readonly Judgement[]): SectionPassStats[] {
  const coverage = sectionCoverage(song, judgements);
  return sectionStats(song, judgements).filter((s) => s.targetNotes > 0 && (coverage.get(s.idx) ?? 0) >= s.targetNotes);
}

/** Compact song-cache projection of an index entry (home screen without a server round trip). */
export function searchResultOf(entry: IndexEntry): SearchResult {
  const playable = entry.tracks.filter((t) => t.playable).length;
  return {
    id: entry.id,
    source: entry.source,
    title: entry.title,
    ...(entry.artist !== undefined ? { artist: entry.artist } : {}),
    ...(entry.composer !== undefined ? { composer: entry.composer } : {}),
    fileName: entry.fileName,
    tier: entry.difficulty?.tier ?? null,
    rating: entry.difficulty?.rating ?? null,
    ratingProvisional: entry.difficulty?.provisional ?? false,
    tuningId: entry.tuningId,
    tuningLabel: entry.tuningLabel,
    tags: entry.tags,
    rhythm: entry.rhythm,
    availability: entry.rhythm === 'needs-alignment' ? 'needs-rhythm' : 'playable',
    arrangements: playable,
    defaultArrangement: entry.defaultArrangement,
    durationSec: entry.durationSec,
    score: 0,
  };
}

/** Everything {@link persistRun} needs about a finished run. */
export interface RunToSave {
  songId: string;
  arrangement: number;
  mode: RunMode;
  summary: RunSummary;
  startedAt: number;
  endedAt: number;
  /** Speed the run counts at: the slowest speed played (a run is only as fast as its slowest part). */
  speed: number;
  loop: BarLoop | null;
  /** The run reached the song end without a loop: eligible for bests. */
  completed: boolean;
  inputSource: InputSource;
  activeSec: number;
  /** Target practice days per week (settings `goals.weeklyDays`). */
  weekTarget: number;
  /** Index entry for the song cache (`lastPlayedAt`), if known. */
  entry: IndexEntry | null;
}

/** What {@link persistRun} stored. */
export interface SavedRun {
  runId: number;
  /** The best for this run's speed bucket after the save (null when the run is not eligible). */
  best: BestRecord | null;
  /** True when this run set a new personal best for its speed bucket. */
  newBest: boolean;
  /** Score of the best this run replaced (null when there was none, or no new best). */
  previousBestScore: number | null;
}

/**
 * Persist a finished run: the run record, the best for its speed bucket (completed full-song runs
 * only), active time + run count for the local day, the weekly streak and the song cache. Section
 * progress is written by {@link SectionProgressBook}. Secondary writes never fail the save.
 */
export async function persistRun(storage: StorageService, run: RunToSave): Promise<SavedRun> {
  const { summary } = run;
  const record: Omit<RunRecord, 'id'> = {
    songId: run.songId,
    arrangement: run.arrangement,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    speed: run.speed,
    ...(run.loop ? { loop: run.loop } : {}),
    mode: run.mode,
    score: summary.score,
    accuracy: summary.accuracy,
    stars: summary.stars,
    maxCombo: summary.maxCombo,
    counts: { ...summary.counts },
    sections: summary.sections.map((s) => ({ idx: s.idx, notes: s.notes, hits: s.hits, accuracy: s.accuracy })),
    histogram: { ...summary.histogram, bins: [...summary.histogram.bins] },
    clean: summary.clean,
    inputSource: run.inputSource,
    activeSec: Math.round(run.activeSec * 10) / 10,
  };
  const runId = await storage.addRun(record);
  let best: BestRecord | null = null;
  let newBest = false;
  let previousBestScore: number | null = null;
  const bestOk = run.completed && !run.loop && summary.judgedNotes > 0;
  const secondary: Promise<unknown>[] = [];
  if (bestOk) {
    const bucket = speedBucket(run.speed);
    const candidate: BestRecord = {
      songId: run.songId,
      arrangement: run.arrangement,
      speedBucket: bucket,
      score: summary.score,
      accuracy: summary.accuracy,
      stars: summary.stars,
      runId,
      at: run.endedAt,
    };
    const before = (await storage.getBests(run.songId, run.arrangement)).find((b) => b.speedBucket === bucket) ?? null;
    newBest = await storage.putBestIfBetter(candidate);
    previousBestScore = newBest && before ? before.score : null;
    best = newBest ? candidate : before;
  }
  secondary.push(recordPracticeTime(storage, run.endedAt, run.activeSec, 1, run.weekTarget));
  secondary.push(touchSongCache(storage, run.songId, run.entry, run.endedAt));
  const results = await Promise.allSettled(secondary);
  for (const r of results) if (r.status === 'rejected') console.warn('Riffway: could not save run details', r.reason);
  return { runId, best, newBest, previousBestScore };
}

/** Add active seconds (and runs) to the local day of `at`, then re-evaluate the weekly streak. */
export async function recordPracticeTime(
  storage: Pick<StorageService, 'addPracticeTime' | 'listPracticeDays' | 'getStreak' | 'putStreak'>,
  at: number,
  activeSec: number,
  runs: number,
  weekTarget: number,
): Promise<void> {
  if (activeSec <= 0 && runs <= 0) return;
  const today = localDate(at);
  await storage.addPracticeTime(today, Math.max(0, activeSec), runs);
  // Enough history for every week since the last evaluation (streak evaluation applies them in order).
  const days = await storage.listPracticeDays(addDays(today, -7 * 60), today);
  const prev = await storage.getStreak();
  await storage.putStreak(evaluateStreak(prev, days, at, weekTarget));
}

/** Set `lastPlayedAt` on the song's cache entry (creating it from the index entry when missing). */
async function touchSongCache(
  storage: Pick<StorageService, 'getSongCache' | 'putSongCache'>,
  songId: string,
  entry: IndexEntry | null,
  at: number,
): Promise<void> {
  const existing = await storage.getSongCache(songId);
  if (existing) {
    await storage.putSongCache({ ...existing, lastPlayedAt: at });
    return;
  }
  if (!entry) return;
  await storage.putSongCache({ songId, meta: searchResultOf(entry), difficulty: entry.difficulty, lastPlayedAt: at, favourite: false });
}
