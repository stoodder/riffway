/**
 * Backup file (docs/progress.md § Export / import): one versioned JSON file
 * `riffway-backup-YYYY-MM-DD.json`. Pure helpers — checking (identify, reject newer, migrate forward
 * with the {@link SCHEMA_STEPS} the database uses, validate), preview counts, and the merge rules.
 * Reading and writing the stores is `src/storage/index.ts`.
 * @module
 */
import type { Settings } from '@shared/settings';
import type { ExportFile, ExportStores, ImportPreview, RunRecord, SectionProgress, StreakState } from '@shared/storage';
import { DB_VERSION } from '@shared/storage';
import { localDate } from '@core/progress';
import { SCHEMA_STEPS, stepsBetween, type RawExport, type SchemaStep } from './schema';
import {
  arrayOf,
  audioLink,
  bestRecord,
  ErrorList,
  isRecord,
  nullable,
  practiceDay,
  recordOf,
  rhythmSidecar,
  runRecord,
  sectionProgress,
  settingsShape,
  songCacheEntry,
  streakState,
  type Check,
} from './validate';

/** `app` marker of every backup file. */
export const BACKUP_APP = 'riffway';

/** Store lists carried by the file, with their record check. `streak` is a single record. */
const STORE_CHECKS: Record<keyof ExportStores, Check> = {
  runs: arrayOf(runRecord),
  bests: arrayOf(bestRecord),
  sectionProgress: arrayOf(sectionProgress),
  practiceDays: arrayOf(practiceDay),
  streak: nullable(streakState),
  audioLinks: arrayOf(audioLink),
  songCache: arrayOf(songCacheEntry),
};

const STORE_KEYS = Object.keys(STORE_CHECKS) as (keyof ExportStores)[];

/** Primary key of a record as a string, per list store (for duplicate detection). */
const RECORD_KEYS: Partial<Record<keyof ExportStores, (r: Record<string, unknown>) => string | null>> = {
  runs: (r) => (r.id === undefined ? null : String(r.id)),
  bests: (r) => JSON.stringify([r.songId, r.arrangement, r.speedBucket]),
  sectionProgress: (r) => JSON.stringify([r.songId, r.arrangement, r.sectionIdx]),
  practiceDays: (r) => String(r.date),
  audioLinks: (r) => JSON.stringify([r.songId, r.arrangement]),
  songCache: (r) => String(r.songId),
};

/** Thrown by `importAll` for a file that does not pass {@link checkBackup}. */
export class ImportValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`The backup cannot be imported: ${errors[0] ?? 'unknown problem'}`);
    this.name = 'ImportValidationError';
    this.errors = errors;
  }
}

/** Result of checking a backup: the preview, and the migrated file when it is valid. */
export interface CheckedBackup {
  preview: ImportPreview;
  /** Migrated to the current schema; null when `preview.ok` is false. */
  file: ExportFile | null;
}

/** Backup file name for a timestamp (local date). */
export function backupFileName(at: number): string {
  return `riffway-backup-${localDate(at)}.json`;
}

/** Serialise a backup (pretty-printed, stable field order as built). */
export function serializeBackup(file: ExportFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Parse backup text (from a file input) and check it. Invalid JSON is reported, not thrown. */
export function parseBackup(text: string): CheckedBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return failed([`This file is not valid JSON (${err instanceof Error ? err.message : String(err)}).`], raw);
  }
  return checkBackup(raw);
}

/**
 * Check a parsed backup: it must be a Riffway file (`app: "riffway"`) whose `schemaVersion` is not
 * newer than this app's; older files are migrated forward step by step, then every record is
 * validated (types, ranges, duplicate keys). Never throws.
 */
export function checkBackup(raw: unknown, steps: readonly SchemaStep[] = SCHEMA_STEPS, currentVersion: number = DB_VERSION): CheckedBackup {
  if (!isRecord(raw)) return failed(['This file is not a Riffway backup (expected a JSON object).'], raw);
  if (raw.app !== BACKUP_APP) {
    const app = raw.app === undefined ? 'no "app" field' : `"app" is ${JSON.stringify(raw.app)}`;
    return failed([`This file is not a Riffway backup (${app}).`], raw);
  }
  const version = raw.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return failed(['schemaVersion: expected a positive integer.'], raw);
  }
  if (version > currentVersion) {
    return failed(
      [`This backup was made by a newer version of Riffway (schema ${version}); this version reads schema ${currentVersion} and older. Update Riffway to import it.`],
      raw,
    );
  }

  let file: RawExport = raw;
  const needed = stepsBetween(version, currentVersion, steps);
  if (needed.length !== currentVersion - version) {
    return failed([`No migration path from schema ${version} to ${currentVersion}.`], raw);
  }
  for (const step of needed) {
    try {
      file = { ...step.migrateExport(file), schemaVersion: step.version };
    } catch (err) {
      return failed([`Migrating the backup to schema ${step.version} failed: ${err instanceof Error ? err.message : String(err)}`], raw);
    }
  }

  const errs = new ErrorList();
  if (typeof file.exportedAt !== 'string' || Number.isNaN(Date.parse(file.exportedAt))) {
    errs.add('exportedAt: expected an ISO 8601 timestamp');
  }
  settingsShape(file.settings, 'settings', errs);
  const stores = file.stores;
  if (!isRecord(stores)) {
    errs.add('stores: expected an object');
  } else {
    for (const key of STORE_KEYS) {
      if (!(key in stores)) errs.add(`stores.${key}: missing`);
      else STORE_CHECKS[key](stores[key], `stores.${key}`, errs);
    }
    if (errs.ok) checkDuplicates(stores, errs);
  }
  const server = file.server;
  if (!isRecord(server)) errs.add('server: expected an object');
  else recordOf(rhythmSidecar)(server.sidecars, 'server.sidecars', errs);

  if (!errs.ok) return failed(errs.list(), raw);
  return { preview: { ...previewBase(raw, file), ok: true, errors: [] }, file: file as unknown as ExportFile };
}

function checkDuplicates(stores: Record<string, unknown>, errs: ErrorList): void {
  for (const [store, keyOf] of Object.entries(RECORD_KEYS)) {
    const seen = new Set<string>();
    (stores[store] as Record<string, unknown>[]).forEach((record, i) => {
      const key = keyOf(record);
      if (key === null) return;
      if (seen.has(key)) errs.add(`stores.${store}[${i}]: duplicate key ${key}`);
      seen.add(key);
    });
  }
}

function failed(errors: string[], raw: unknown): CheckedBackup {
  return { preview: { ...previewBase(raw, raw), ok: false, errors }, file: null };
}

/** Version, date and counts, as far as the (possibly invalid) file allows. */
function previewBase(original: unknown, file: unknown): Omit<ImportPreview, 'ok' | 'errors'> {
  const o = isRecord(original) ? original : {};
  const f = isRecord(file) ? file : {};
  const stores = isRecord(f.stores) ? f.stores : {};
  const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  const server = isRecord(f.server) ? f.server : {};
  return {
    schemaVersion: typeof o.schemaVersion === 'number' ? o.schemaVersion : 0,
    exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : null,
    counts: {
      runs: len(stores.runs),
      bests: len(stores.bests),
      sectionProgress: len(stores.sectionProgress),
      practiceDays: len(stores.practiceDays),
      streak: isRecord(stores.streak) ? 1 : 0,
      audioLinks: len(stores.audioLinks),
      songCache: len(stores.songCache),
      sidecars: isRecord(server.sidecars) ? Object.keys(server.sidecars).length : 0,
    },
  };
}

/** Empty store contents. */
export function emptyStores(): ExportStores {
  return { runs: [], bests: [], sectionProgress: [], practiceDays: [], streak: null, audioLinks: [], songCache: [] };
}

/** Build the export file from store contents and settings (`server.sidecars` empty; the caller adds them). */
export function buildExport(settings: Settings, stores: ExportStores, now: number): ExportFile {
  return {
    app: BACKUP_APP,
    schemaVersion: DB_VERSION,
    exportedAt: new Date(now).toISOString(),
    settings,
    stores,
    server: { sidecars: {} },
  };
}

/**
 * Merge imported store contents into local ones (pure; neither input is mutated). Records are matched
 * by key; on a conflict:
 * - **runs** are matched by `(songId, arrangement, startedAt)` and are immutable, so the local copy is
 *   kept. New runs keep their id unless it is taken locally, else get a fresh one; imported bests'
 *   `runId` follows the renumbering.
 * - **bests**: the higher score wins (tie: local).
 * - **sectionProgress**: the record with more progress wins — more clean runs, then more clean runs
 *   at 100%, then the later mastery/lock-in time (the counters only grow, so this is the newer one;
 *   tie: local).
 * - **practiceDays**: the record with more active time wins (tie: local), so importing twice never
 *   double-counts.
 * - **streak**: the later `lastEvaluatedWeek` wins (tie: local); `best` is the higher of both.
 * - **audioLinks**: local wins (its `audioId` refers to audio on this machine's server).
 * - **songCache**: the later `lastPlayedAt` wins (tie: local).
 * Merging the same file again changes nothing. Replace is `mergeStores(emptyStores(), incoming)`.
 */
export function mergeStores(local: ExportStores, incoming: ExportStores): ExportStores {
  const { runs, idMap } = mergeRuns(local.runs, incoming.runs);
  return {
    runs,
    bests: mergeByKey(
      local.bests,
      incoming.bests.map((b) => ({ ...b, runId: idMap.get(b.runId) ?? b.runId })),
      (b) => JSON.stringify([b.songId, b.arrangement, b.speedBucket]),
      (inc, loc) => inc.score > loc.score,
    ),
    sectionProgress: mergeByKey(
      local.sectionProgress as SectionProgress[],
      incoming.sectionProgress as SectionProgress[],
      (p) => JSON.stringify([p.songId, p.arrangement, p.sectionIdx]),
      (inc, loc) => compareProgress(inc, loc) > 0,
    ),
    practiceDays: mergeByKey(
      local.practiceDays,
      incoming.practiceDays,
      (d) => d.date,
      (inc, loc) => inc.activeSec > loc.activeSec || (inc.activeSec === loc.activeSec && inc.runs > loc.runs),
    ),
    streak: mergeStreak(local.streak, incoming.streak),
    audioLinks: mergeByKey(local.audioLinks, incoming.audioLinks, (l) => JSON.stringify([l.songId, l.arrangement]), () => false),
    songCache: mergeByKey(
      local.songCache,
      incoming.songCache,
      (e) => e.songId,
      (inc, loc) => (inc.lastPlayedAt ?? -Infinity) > (loc.lastPlayedAt ?? -Infinity),
    ),
  };
}

function mergeByKey<T>(local: readonly T[], incoming: readonly T[], key: (r: T) => string, incomingWins: (inc: T, loc: T) => boolean): T[] {
  const out = new Map<string, T>();
  for (const r of local) out.set(key(r), r);
  for (const r of incoming) {
    const k = key(r);
    const existing = out.get(k);
    if (existing === undefined || incomingWins(r, existing)) out.set(k, r);
  }
  return [...out.values()];
}

function mergeRuns(local: readonly RunRecord[], incoming: readonly RunRecord[]): { runs: RunRecord[]; idMap: Map<number, number> } {
  const naturalKey = (r: RunRecord): string => JSON.stringify([r.songId, r.arrangement, r.startedAt]);
  const byKey = new Map<string, RunRecord>(local.map((r) => [naturalKey(r), r]));
  const usedIds = new Set<number>();
  for (const r of local) if (r.id !== undefined) usedIds.add(r.id);
  let nextId = Math.max(0, ...usedIds, ...incoming.map((r) => r.id ?? 0)) + 1;
  const idMap = new Map<number, number>();
  const runs = [...local];
  for (const r of incoming) {
    const existing = byKey.get(naturalKey(r));
    if (existing) {
      if (r.id !== undefined && existing.id !== undefined) idMap.set(r.id, existing.id);
      continue;
    }
    const id = r.id !== undefined && !usedIds.has(r.id) ? r.id : nextId++;
    usedIds.add(id);
    if (r.id !== undefined) idMap.set(r.id, id);
    const merged = { ...r, id };
    runs.push(merged);
    byKey.set(naturalKey(r), merged);
  }
  return { runs, idMap };
}

function compareProgress(a: SectionProgress, b: SectionProgress): number {
  const latest = (p: SectionProgress): number => Math.max(p.masteredAt ?? 0, p.lockedInAt ?? 0);
  return a.cleanRuns - b.cleanRuns || a.cleanRunsAt100 - b.cleanRunsAt100 || latest(a) - latest(b);
}

function mergeStreak(local: StreakState | null, incoming: StreakState | null): StreakState | null {
  if (!local || !incoming) return local ?? incoming;
  const week = (s: StreakState): string => s.lastEvaluatedWeek ?? '';
  const winner = week(incoming) > week(local) ? incoming : local;
  return { ...winner, best: Math.max(local.best, incoming.best, winner.current) };
}
