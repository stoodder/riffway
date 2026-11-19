/**
 * IndexedDB records, the storage service and the export file (docs/progress.md).
 * Persistence is `src/storage/` (T-020); pure progress logic is `src/core/progress/` (T-020).
 *
 * All timestamps are epoch milliseconds; local calendar days are `'YYYY-MM-DD'` strings.
 * DOM-free (the service interface is async and storage-agnostic).
 * @module
 */
import type { Unsubscribe } from './clock';
import type { InputSource, OutcomeCounts, Stars, TimingHistogram, TrainerState, BarLoop } from './judge';
import type { DifficultyReport, RhythmSidecar, Tier } from './song';
import type { SearchResult } from './sources';
import type { Settings, SettingsStore } from './settings';

/** IndexedDB database name. */
export const DB_NAME = 'riffway';
/** Current schema version (fall-through `upgrade()` steps; export files carry it too). */
export const DB_VERSION = 1;

/** Object store names (schema v1). */
export type StoreName =
  | 'settings'
  | 'runs'
  | 'bests'
  | 'sectionProgress'
  | 'practiceDays'
  | 'streak'
  | 'audioLinks'
  | 'songCache';

/** Play (full song, scored for bests) or practice (loops / speed trainer). */
export type RunMode = 'play' | 'practice';

/** One finished run (store `runs`, auto key; indexes `[songId+arrangement, startedAt]`, `startedAt`). */
export interface RunRecord {
  /** Auto-increment key; absent before insert. */
  id?: number;
  songId: string;
  arrangement: number;
  startedAt: number;
  endedAt: number;
  /** Speed fraction (0.7 = 70%). */
  speed: number;
  loop?: BarLoop;
  mode: RunMode;
  score: number;
  /** % (DEC-15). */
  accuracy: number;
  stars: Stars;
  maxCombo: number;
  counts: OutcomeCounts;
  sections: { idx: number; notes: number; hits: number; accuracy: number }[];
  histogram: TimingHistogram;
  clean: boolean;
  inputSource: InputSource;
  /** Transport-playing seconds during this run (active time). */
  activeSec: number;
}

/** Speed bucket: speed rounded to 5% as an integer percent (100 = full speed). */
export type SpeedBucket = number;

/** Best result per arrangement and speed bucket (store `bests`, key `[songId, arrangement, speedBucket]`). */
export interface BestRecord {
  songId: string;
  arrangement: number;
  speedBucket: SpeedBucket;
  score: number;
  accuracy: number;
  stars: Stars;
  runId: number;
  at: number;
}

/**
 * The practice session of a section's latest run. Mastery needs 2 clean runs at 100% **in one
 * session**, so the counter resets when a run arrives with another `sessionId`.
 */
export interface SectionSession {
  /** The `sessionId` of the last run on this section. */
  id: string;
  /** Clean runs at 100% in that session. */
  cleanRunsAt100: number;
}

/** Per-section progress (store `sectionProgress`, key `[songId, arrangement, sectionIdx]`; index `nextCheckAt`). */
export interface SectionProgress {
  songId: string;
  arrangement: number;
  sectionIdx: number;
  cleanRuns: number;
  cleanRunsAt100: number;
  /** Speed of the last run on this section. */
  lastSpeed: number;
  trainer: TrainerState;
  /** Set on 2 clean runs at 100% in one session. */
  masteredAt?: number;
  /** Set on a clean run at 100% when the next-day check was due. */
  lockedInAt?: number;
  /** Next-day check due time (next local day 04:00). */
  nextCheckAt?: number;
  bestAccuracy: number;
  /** Passes since `bestAccuracy` last improved (plateau nudge after 6). */
  passesSinceGain: number;
  /** Session of the latest run (absent before the first run with a session id). */
  session?: SectionSession;
}

/** Active practice per local day (store `practiceDays`, key `date`). A practice day = ≥ 5 min active. */
export interface PracticeDay {
  /** `'YYYY-MM-DD'`, local time. */
  date: string;
  activeSec: number;
  runs: number;
}

/** Weekly streak (store `streak`, key `'streak'`). Weeks are ISO weeks `'YYYY-Www'`, local time. */
export interface StreakState {
  /** Target practice days per week (2–7). */
  weekTarget: number;
  /** Consecutive weeks meeting the target. */
  current: number;
  best: number;
  /** Held freezes (0–2), applied automatically to a missed week. */
  freezes: number;
  /** Completed weeks since the last freeze was earned (earn 1 per 2). */
  weeksTowardFreeze: number;
  /** Last ISO week evaluated (`'2026-W47'`), or null before the first evaluation. */
  lastEvaluatedWeek: string | null;
  /** A missed week (no freeze) that 2 extra practice days next week can repair. */
  repairWeek?: string;
}

/** One alignment anchor: song time ↔ audio-file time (seconds). */
export interface WarpAnchor {
  songTime: number;
  audioTime: number;
}

/** Backing-audio link (store `audioLinks`, key `[songId, arrangement]`). Bytes live on the server (DEC-13). */
export interface AudioLink {
  songId: string;
  arrangement: number;
  /** Server audio id (sha1) for `GET /api/audio/:id`. */
  audioId: string;
  fileName: string;
  /** 1 anchor = offset; 2+ = piecewise-linear warp. */
  anchors: WarpAnchor[];
  gainDb: number;
  /** Backing audible (guide auto-mutes while on, if the setting says so). */
  enabled: boolean;
}

/** Cached song info for the home screen without a server round trip (store `songCache`, key `songId`; index `lastPlayedAt`). */
export interface SongCacheEntry {
  songId: string;
  meta: SearchResult;
  difficulty: DifficultyReport | null;
  lastPlayedAt: number | null;
  favourite: boolean;
}

/** Recommendation slot kinds (6 stretch / 3 comfort-or-review / 1 reach). */
export type RecommendationKind = 'stretch' | 'comfort' | 'review' | 'reach';

/** One recommendation (`src/core/progress/recommend.ts`). */
export interface Recommendation {
  songId: string;
  arrangement: number;
  kind: RecommendationKind;
  tier: Tier;
  score: number;
  /** Reach items suggest a single section. */
  sectionIdx?: number;
  /** Short informational reason ("One tier above your comfort zone"). */
  reason: string;
}

/** Session goal kinds (process goals; the player picks one of 3). */
export type SessionGoalKind = 'next-day-check' | 'weakest-section' | 'new-stretch';

/** A suggested process goal ("Get Verse 2 clean at 80%"). */
export interface SessionGoal {
  kind: SessionGoalKind;
  label: string;
  songId: string;
  arrangement: number;
  sectionIdx?: number;
  /** Target speed fraction. */
  targetSpeed?: number;
}

/** Stores carried by the export file. */
export interface ExportStores {
  runs: RunRecord[];
  bests: BestRecord[];
  sectionProgress: SectionProgress[];
  practiceDays: PracticeDay[];
  streak: StreakState | null;
  audioLinks: AudioLink[];
  songCache: SongCacheEntry[];
}

/** Backup file `riffway-backup-YYYY-MM-DD.json`. Backing-audio bytes are not included. */
export interface ExportFile {
  app: 'riffway';
  schemaVersion: number;
  /** ISO 8601 timestamp. */
  exportedAt: string;
  settings: Settings;
  stores: ExportStores;
  /** Server-side data; `sidecars` from `GET /api/sidecars`, posted back to `POST /api/sidecars`. */
  server: { sidecars: Record<string, RhythmSidecar> };
}

/** Counts shown before an import is applied. */
export interface ImportPreview {
  ok: boolean;
  /** Validation errors (wrong `app`, newer `schemaVersion`, malformed records). */
  errors: string[];
  schemaVersion: number;
  exportedAt: string | null;
  counts: Record<keyof ExportStores, number> & { sidecars: number };
}

/** Replace wipes local data first; merge unions by key keeping the newer record (bests: higher score). */
export type ImportMode = 'merge' | 'replace';

/** Persistence API (T-020). All methods are async and safe to call concurrently. */
export interface StorageService {
  readonly settings: SettingsStore;

  /** Insert a run; returns its id. Does not update bests/progress (callers use the progress logic). */
  addRun(run: Omit<RunRecord, 'id'>): Promise<number>;
  listRuns(query?: { songId?: string; arrangement?: number; since?: number; limit?: number }): Promise<RunRecord[]>;

  getBests(songId: string, arrangement: number): Promise<BestRecord[]>;
  /** Write if better than the stored best for that bucket; returns true when it replaced it. */
  putBestIfBetter(best: BestRecord): Promise<boolean>;

  getSectionProgress(songId: string, arrangement: number): Promise<SectionProgress[]>;
  putSectionProgress(progress: SectionProgress): Promise<void>;
  /** Sections whose `nextCheckAt ≤ now`. */
  listDueChecks(now: number): Promise<SectionProgress[]>;

  /** Add active seconds (and optionally runs) to a local day. */
  addPracticeTime(date: string, activeSec: number, runs?: number): Promise<PracticeDay>;
  listPracticeDays(fromDate?: string, toDate?: string): Promise<PracticeDay[]>;

  getStreak(): Promise<StreakState | null>;
  putStreak(state: StreakState): Promise<void>;

  getAudioLink(songId: string, arrangement: number): Promise<AudioLink | null>;
  putAudioLink(link: AudioLink): Promise<void>;
  deleteAudioLink(songId: string, arrangement: number): Promise<void>;

  getSongCache(songId: string): Promise<SongCacheEntry | null>;
  putSongCache(entry: SongCacheEntry): Promise<void>;
  /** Most recently played first. */
  listRecentSongs(limit: number): Promise<SongCacheEntry[]>;

  /** Everything except `server.sidecars` (the caller adds them from the API). */
  exportAll(): Promise<ExportFile>;
  previewImport(file: unknown): ImportPreview;
  /** Validates and migrates forward before applying. Sidecars are handled by the caller. */
  importAll(file: ExportFile, mode: ImportMode): Promise<void>;
  /** Delete all data (settings reset to defaults). */
  clearAll(): Promise<void>;

  /** Fired after any write: store name changed. */
  onChange(cb: (store: StoreName) => void): Unsubscribe;
}
