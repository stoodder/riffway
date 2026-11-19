/**
 * IndexedDB schema (docs/progress.md § IndexedDB stores) and the versioned migration steps shared by
 * the database `upgrade()` and export-file import.
 *
 * Adding schema version N: bump `DB_VERSION` in `shared/storage.ts` (contract change) and append a
 * {@link SchemaStep} with `version: N` to {@link SCHEMA_STEPS}. `upgradeDb` changes the stores of a
 * version N−1 database; `migrateExport` makes the same change to a version N−1 export file. Steps
 * fall through: a database at version 1 opened at version 3 runs steps 2 and 3 in order.
 * @module
 */
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { Settings } from '@shared/settings';
import type { AudioLink, BestRecord, PracticeDay, RunRecord, SongCacheEntry, StoreName, StreakState } from '@shared/storage';
import { DB_VERSION } from '@shared/storage';
import type { SectionProgressRecord } from '@core/progress';

/** Fixed key of the single record in the `settings` store. */
export const SETTINGS_KEY = 'settings';
/** Fixed key of the single record in the `streak` store. */
export const STREAK_KEY = 'streak';

/** Index names. */
export const RUNS_BY_SONG = 'songId_arrangement_startedAt';
export const RUNS_BY_START = 'startedAt';
export const PROGRESS_BY_CHECK = 'nextCheckAt';
export const CACHE_BY_PLAYED = 'lastPlayedAt';

/** Typed schema v1 for `idb`. */
export interface RiffwayDB extends DBSchema {
  settings: { key: string; value: Settings };
  runs: {
    key: number;
    value: RunRecord;
    indexes: { [RUNS_BY_SONG]: [string, number, number]; [RUNS_BY_START]: number };
  };
  bests: { key: [string, number, number]; value: BestRecord };
  sectionProgress: {
    key: [string, number, number];
    value: SectionProgressRecord;
    indexes: { [PROGRESS_BY_CHECK]: number };
  };
  practiceDays: { key: string; value: PracticeDay };
  streak: { key: string; value: StreakState };
  audioLinks: { key: [string, number]; value: AudioLink };
  songCache: { key: string; value: SongCacheEntry; indexes: { [CACHE_BY_PLAYED]: number } };
}

/** Every object store, in a fixed order (transactions, export, clear). */
export const STORE_NAMES: readonly StoreName[] = [
  'settings',
  'runs',
  'bests',
  'sectionProgress',
  'practiceDays',
  'streak',
  'audioLinks',
  'songCache',
];

/** An untyped database handle: steps also run against schemas newer or older than {@link RiffwayDB}. */
export type AnyDB = IDBPDatabase<unknown>;
/** The `versionchange` transaction handed to `upgrade()`. */
export type UpgradeTx = IDBPTransaction<unknown, string[], 'versionchange'>;

/** Plain JSON export file (before validation). */
export type RawExport = Record<string, unknown>;

/** One schema version: its database change and the matching export-file change. */
export interface SchemaStep {
  version: number;
  /** Bring a database from `version − 1` to `version` (store/index changes; may issue requests on `tx`). */
  upgradeDb(db: AnyDB, tx: UpgradeTx): void;
  /** Bring an export file from `version − 1` to `version` (returns a new object; `schemaVersion` is set by the caller). */
  migrateExport(file: RawExport): RawExport;
}

/** Schema v1: the stores and indexes of docs/progress.md. */
const V1: SchemaStep = {
  version: 1,
  upgradeDb(db) {
    db.createObjectStore('settings');
    const runs = db.createObjectStore('runs', { keyPath: 'id', autoIncrement: true });
    runs.createIndex(RUNS_BY_SONG, ['songId', 'arrangement', 'startedAt']);
    runs.createIndex(RUNS_BY_START, 'startedAt');
    db.createObjectStore('bests', { keyPath: ['songId', 'arrangement', 'speedBucket'] });
    const progress = db.createObjectStore('sectionProgress', { keyPath: ['songId', 'arrangement', 'sectionIdx'] });
    progress.createIndex(PROGRESS_BY_CHECK, 'nextCheckAt');
    db.createObjectStore('practiceDays', { keyPath: 'date' });
    db.createObjectStore('streak');
    db.createObjectStore('audioLinks', { keyPath: ['songId', 'arrangement'] });
    const cache = db.createObjectStore('songCache', { keyPath: 'songId' });
    cache.createIndex(CACHE_BY_PLAYED, 'lastPlayedAt');
  },
  // Export files start at version 1, so this step never runs on a file.
  migrateExport: (file) => file,
};

/** All schema steps in version order; the last one is {@link DB_VERSION}. */
export const SCHEMA_STEPS: readonly SchemaStep[] = [V1];

/** Steps needed to go from `from` to `to` (exclusive, inclusive), in order. */
export function stepsBetween(from: number, to: number, steps: readonly SchemaStep[] = SCHEMA_STEPS): SchemaStep[] {
  return steps.filter((s) => s.version > from && s.version <= to).sort((a, b) => a.version - b.version);
}

/** Run the fall-through upgrade from `oldVersion` to `newVersion`. */
export function runUpgrades(db: AnyDB, oldVersion: number, newVersion: number, tx: UpgradeTx, steps: readonly SchemaStep[] = SCHEMA_STEPS): void {
  const needed = stepsBetween(oldVersion, newVersion, steps);
  const expected = newVersion - oldVersion;
  if (needed.length !== expected) {
    throw new Error(`No complete migration path from schema ${oldVersion} to ${newVersion}`);
  }
  for (const step of needed) step.upgradeDb(db, tx);
}

/** Options for {@link openRiffwayDb}. */
export interface OpenDbOptions {
  /** Target version (default {@link DB_VERSION}). Tests open older/newer versions with custom steps. */
  version?: number;
  steps?: readonly SchemaStep[];
}

/**
 * Open (creating or upgrading) the database. Another tab asking for a newer version closes this
 * connection rather than blocking it.
 */
export async function openRiffwayDb(name: string, opts: OpenDbOptions = {}): Promise<IDBPDatabase<RiffwayDB>> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available, so Riffway cannot save progress in this browser.');
  }
  const version = opts.version ?? DB_VERSION;
  const steps = opts.steps ?? SCHEMA_STEPS;
  const db = await openDB<RiffwayDB>(name, version, {
    upgrade(database, oldVersion, newVersion, tx) {
      // The steps are schema-agnostic (they also describe versions other than RiffwayDB).
      runUpgrades(database as unknown as AnyDB, oldVersion, newVersion ?? version, tx as unknown as UpgradeTx, steps);
    },
    blocking() {
      db.close();
    },
  });
  return db;
}
