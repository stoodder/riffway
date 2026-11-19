/**
 * Persistence (T-020): IndexedDB `riffway` via `idb`, schema per docs/progress.md (`./schema`),
 * the reactive settings store, and backup export/import (`./export`).
 *
 * Records are written without `undefined`-valued fields so that what is stored equals what a JSON
 * backup restores. Every write fires {@link StorageService.onChange} with the store name after the
 * transaction commits.
 * @module
 */
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import type { Unsubscribe } from '@shared/clock';
import { DEFAULT_SETTINGS, defaultSettings, type DeepPartial, type Settings, type SettingsStore } from '@shared/settings';
import type {
  AudioLink,
  BestRecord,
  ExportFile,
  ExportStores,
  ImportMode,
  ImportPreview,
  PracticeDay,
  RunRecord,
  SectionProgress,
  SongCacheEntry,
  StorageService,
  StoreName,
  StreakState,
} from '@shared/storage';
import { DB_NAME, DB_VERSION } from '@shared/storage';
import {
  CACHE_BY_PLAYED,
  openRiffwayDb,
  PROGRESS_BY_CHECK,
  RUNS_BY_SONG,
  RUNS_BY_START,
  SETTINGS_KEY,
  STORE_NAMES,
  STREAK_KEY,
  type RiffwayDB,
} from './schema';
import { buildExport, checkBackup, emptyStores, ImportValidationError, mergeStores } from './export';

export { backupFileName, checkBackup, ImportValidationError, mergeStores, parseBackup, serializeBackup } from './export';

/** Options for {@link openStorage}. */
export interface OpenStorageOptions {
  /** Database name (tests use a unique name with `fake-indexeddb`). Default `riffway`. */
  dbName?: string;
  /** Clock for `exportedAt` (tests). Default `Date.now`. */
  now?: () => number;
}

/** The storage service plus `close()` (tests, page teardown). */
export interface RiffwayStorage extends StorageService {
  /** Close the database connection. The service must not be used afterwards. */
  close(): void;
}

/** Open (and migrate) the database and load settings. */
export async function openStorage(opts: OpenStorageOptions = {}): Promise<RiffwayStorage> {
  const db = await openRiffwayDb(opts.dbName ?? DB_NAME);
  const stored = await db.get('settings', SETTINGS_KEY);
  return new IdbStorage(db, stored ? mergeSettings(defaultSettings(), stored) : defaultSettings(), opts.now ?? Date.now);
}

/** Deep-merge `patch` into `base` (arrays replaced). */
export function mergeSettings(base: Settings, patch: DeepPartial<Settings>): Settings {
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  const walk = (target: Record<string, unknown>, src: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      const cur = target[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
        walk(cur as Record<string, unknown>, v as Record<string, unknown>);
      } else {
        target[k] = structuredClone(v);
      }
    }
  };
  walk(out, patch as Record<string, unknown>);
  return out as unknown as Settings;
}

/** Deep copy without `undefined`-valued object fields (what a JSON round trip would keep). */
function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = compact(v);
    return out as T;
  }
  return value;
}

type DB = IDBPDatabase<RiffwayDB>;
type AllStoresTx = IDBPTransaction<RiffwayDB, StoreName[], IDBTransactionMode>;

/** Read every record store (not settings) within `tx`. */
async function readStores(tx: AllStoresTx): Promise<ExportStores> {
  const [runs, bests, sectionProgress, practiceDays, streak, audioLinks, songCache] = await Promise.all([
    tx.objectStore('runs').getAll(),
    tx.objectStore('bests').getAll(),
    tx.objectStore('sectionProgress').getAll(),
    tx.objectStore('practiceDays').getAll(),
    tx.objectStore('streak').get(STREAK_KEY),
    tx.objectStore('audioLinks').getAll(),
    tx.objectStore('songCache').getAll(),
  ]);
  return { runs, bests, sectionProgress, practiceDays, streak: streak ?? null, audioLinks, songCache };
}

class IdbStorage implements RiffwayStorage {
  readonly settings: SettingsStore;
  private current: Settings;
  private readonly settingsSubs = new Set<(s: Settings) => void>();
  private readonly changeSubs = new Set<(store: StoreName) => void>();

  constructor(
    private readonly db: DB,
    initial: Settings,
    private readonly now: () => number,
  ) {
    this.current = initial;
    this.settings = {
      get: () => this.current,
      update: async (patch) => {
        await this.writeSettings(mergeSettings(this.current, patch));
        return this.current;
      },
      replace: (next) => this.writeSettings(mergeSettings(defaultSettings(), next)),
      subscribe: (cb): Unsubscribe => {
        this.settingsSubs.add(cb);
        return () => this.settingsSubs.delete(cb);
      },
    };
  }

  close(): void {
    this.db.close();
  }

  private async writeSettings(next: Settings): Promise<void> {
    this.current = next;
    await this.db.put('settings', compact(next), SETTINGS_KEY);
    this.emitSettings();
    this.emit('settings');
  }

  private emitSettings(): void {
    for (const cb of this.settingsSubs) cb(this.current);
  }

  private emit(...stores: StoreName[]): void {
    for (const store of stores) for (const cb of this.changeSubs) cb(store);
  }

  // ---- runs ----------------------------------------------------------------------------------

  async addRun(run: Omit<RunRecord, 'id'>): Promise<number> {
    const record = compact(run) as RunRecord;
    delete record.id;
    const id = await this.db.add('runs', record);
    this.emit('runs');
    return id;
  }

  /** Newest first (by `startedAt`). `since` is inclusive. */
  async listRuns(query: { songId?: string; arrangement?: number; since?: number; limit?: number } = {}): Promise<RunRecord[]> {
    const { songId, arrangement, since = -Infinity, limit = Infinity } = query;
    const tx = this.db.transaction('runs');
    const out: RunRecord[] = [];
    if (songId !== undefined && arrangement !== undefined) {
      const range = IDBKeyRange.bound([songId, arrangement, since], [songId, arrangement, Infinity]);
      for (let c = await tx.store.index(RUNS_BY_SONG).openCursor(range, 'prev'); c && out.length < limit; c = await c.continue()) {
        out.push(c.value);
      }
    } else if (songId !== undefined) {
      const range = IDBKeyRange.bound([songId, -Infinity, -Infinity], [songId, Infinity, Infinity]);
      const all = await tx.store.index(RUNS_BY_SONG).getAll(range);
      out.push(...all.filter((r) => r.startedAt >= since).sort((a, b) => b.startedAt - a.startedAt || (b.id ?? 0) - (a.id ?? 0)).slice(0, limit));
    } else {
      const range = since === -Infinity ? null : IDBKeyRange.lowerBound(since);
      for (let c = await tx.store.index(RUNS_BY_START).openCursor(range, 'prev'); c && out.length < limit; c = await c.continue()) {
        if (arrangement === undefined || c.value.arrangement === arrangement) out.push(c.value);
      }
    }
    await tx.done;
    return out;
  }

  // ---- bests ---------------------------------------------------------------------------------

  async getBests(songId: string, arrangement: number): Promise<BestRecord[]> {
    return this.db.getAll('bests', IDBKeyRange.bound([songId, arrangement, -Infinity], [songId, arrangement, Infinity]));
  }

  /** Higher score wins; an equal score keeps the stored (earlier) best. */
  async putBestIfBetter(best: BestRecord): Promise<boolean> {
    const tx = this.db.transaction('bests', 'readwrite');
    const existing = await tx.store.get([best.songId, best.arrangement, best.speedBucket]);
    const better = !existing || best.score > existing.score;
    if (better) await tx.store.put(compact(best));
    await tx.done;
    if (better) this.emit('bests');
    return better;
  }

  // ---- section progress ----------------------------------------------------------------------

  async getSectionProgress(songId: string, arrangement: number): Promise<SectionProgress[]> {
    return this.db.getAll('sectionProgress', IDBKeyRange.bound([songId, arrangement, -Infinity], [songId, arrangement, Infinity]));
  }

  async putSectionProgress(progress: SectionProgress): Promise<void> {
    await this.db.put('sectionProgress', compact(progress));
    this.emit('sectionProgress');
  }

  /** Earliest due first. */
  async listDueChecks(now: number): Promise<SectionProgress[]> {
    return this.db.getAllFromIndex('sectionProgress', PROGRESS_BY_CHECK, IDBKeyRange.upperBound(now));
  }

  // ---- practice days and streak --------------------------------------------------------------

  async addPracticeTime(date: string, activeSec: number, runs = 0): Promise<PracticeDay> {
    const tx = this.db.transaction('practiceDays', 'readwrite');
    const prev = await tx.store.get(date);
    const next: PracticeDay = { date, activeSec: (prev?.activeSec ?? 0) + activeSec, runs: (prev?.runs ?? 0) + runs };
    await tx.store.put(next);
    await tx.done;
    this.emit('practiceDays');
    return next;
  }

  /** Oldest first; bounds inclusive. */
  async listPracticeDays(fromDate?: string, toDate?: string): Promise<PracticeDay[]> {
    let range: IDBKeyRange | null = null;
    if (fromDate !== undefined && toDate !== undefined) range = IDBKeyRange.bound(fromDate, toDate);
    else if (fromDate !== undefined) range = IDBKeyRange.lowerBound(fromDate);
    else if (toDate !== undefined) range = IDBKeyRange.upperBound(toDate);
    return this.db.getAll('practiceDays', range);
  }

  async getStreak(): Promise<StreakState | null> {
    return (await this.db.get('streak', STREAK_KEY)) ?? null;
  }

  async putStreak(state: StreakState): Promise<void> {
    await this.db.put('streak', compact(state), STREAK_KEY);
    this.emit('streak');
  }

  // ---- audio links and song cache ------------------------------------------------------------

  async getAudioLink(songId: string, arrangement: number): Promise<AudioLink | null> {
    return (await this.db.get('audioLinks', [songId, arrangement])) ?? null;
  }

  async putAudioLink(link: AudioLink): Promise<void> {
    await this.db.put('audioLinks', compact(link));
    this.emit('audioLinks');
  }

  async deleteAudioLink(songId: string, arrangement: number): Promise<void> {
    await this.db.delete('audioLinks', [songId, arrangement]);
    this.emit('audioLinks');
  }

  async getSongCache(songId: string): Promise<SongCacheEntry | null> {
    return (await this.db.get('songCache', songId)) ?? null;
  }

  async putSongCache(entry: SongCacheEntry): Promise<void> {
    await this.db.put('songCache', compact(entry));
    this.emit('songCache');
  }

  /** Most recently played first; never-played entries are not listed. */
  async listRecentSongs(limit: number): Promise<SongCacheEntry[]> {
    const out: SongCacheEntry[] = [];
    const tx = this.db.transaction('songCache');
    for (let c = await tx.store.index(CACHE_BY_PLAYED).openCursor(null, 'prev'); c && out.length < limit; c = await c.continue()) {
      out.push(c.value);
    }
    await tx.done;
    return out;
  }

  // ---- export / import -----------------------------------------------------------------------

  async exportAll(): Promise<ExportFile> {
    const tx = this.db.transaction(STORE_NAMES as StoreName[]);
    const [stores] = await Promise.all([readStores(tx), tx.done]);
    return buildExport(structuredClone(this.current), stores, this.now());
  }

  previewImport(file: unknown): ImportPreview {
    return checkBackup(file).preview;
  }

  /**
   * Validate and migrate `file`, then apply it in one transaction (all or nothing).
   * `replace`: local data is wiped and the file's settings are used. `merge`: local settings are kept
   * (device, calibration) and records are merged per {@link mergeStores}.
   * @throws {ImportValidationError} when the file does not pass {@link checkBackup}.
   */
  async importAll(file: ExportFile, mode: ImportMode): Promise<void> {
    const { preview, file: checked } = checkBackup(file);
    if (!checked) throw new ImportValidationError(preview.errors);
    const incoming = compact(checked.stores);
    const tx = this.db.transaction(STORE_NAMES as StoreName[], 'readwrite');
    const local = mode === 'merge' ? await readStores(tx) : emptyStores();
    const merged = mergeStores(local, incoming);
    const settings = mode === 'replace' ? mergeSettings(defaultSettings(), checked.settings) : this.current;
    // Requests run in the order they are queued: clear first, then write everything.
    const writes: Promise<unknown>[] = STORE_NAMES.map((name) => tx.objectStore(name).clear());
    writes.push(tx.objectStore('settings').put(compact(settings), SETTINGS_KEY));
    for (const r of merged.runs) writes.push(tx.objectStore('runs').put(r));
    for (const r of merged.bests) writes.push(tx.objectStore('bests').put(r));
    for (const r of merged.sectionProgress) writes.push(tx.objectStore('sectionProgress').put(r));
    for (const r of merged.practiceDays) writes.push(tx.objectStore('practiceDays').put(r));
    if (merged.streak) writes.push(tx.objectStore('streak').put(merged.streak, STREAK_KEY));
    for (const r of merged.audioLinks) writes.push(tx.objectStore('audioLinks').put(r));
    for (const r of merged.songCache) writes.push(tx.objectStore('songCache').put(r));
    await Promise.all([...writes, tx.done]);
    if (settings !== this.current) {
      this.current = settings;
      this.emitSettings();
    }
    this.emit(...STORE_NAMES);
  }

  async clearAll(): Promise<void> {
    const tx = this.db.transaction(STORE_NAMES as StoreName[], 'readwrite');
    await Promise.all([...STORE_NAMES.map((name) => tx.objectStore(name).clear()), tx.done]);
    this.current = defaultSettings();
    this.emitSettings();
    this.emit(...STORE_NAMES);
  }

  onChange(cb: (store: StoreName) => void): Unsubscribe {
    this.changeSubs.add(cb);
    return () => this.changeSubs.delete(cb);
  }
}

export { DB_NAME, DB_VERSION, DEFAULT_SETTINGS };
