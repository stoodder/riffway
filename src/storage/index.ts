/**
 * Persistence (T-020): IndexedDB `riffway` via `idb`, schema v1 per docs/progress.md, settings
 * store, export/import. Signature frozen by T-010: `openStorage()` resolves a `StorageService`.
 *
 * **Stub (T-010):** returns an in-memory service with working settings so the app boots; nothing
 * persists across reloads until T-020 replaces it.
 * @module
 */
import type { Unsubscribe } from '@shared/clock';
import { DEFAULT_SETTINGS, defaultSettings, type DeepPartial, type Settings, type SettingsStore } from '@shared/settings';
import type { ExportFile, ImportPreview, StorageService, StoreName } from '@shared/storage';
import { DB_NAME, DB_VERSION } from '@shared/storage';
import { notImplemented } from '@shared/errors';

/** Options for {@link openStorage}. */
export interface OpenStorageOptions {
  /** Database name (tests use a unique name with `fake-indexeddb`). Default `riffway`. */
  dbName?: string;
}

/** Open (and migrate) the database and load settings. */
export async function openStorage(opts: OpenStorageOptions = {}): Promise<StorageService> {
  return createMemoryStorage(opts.dbName ?? DB_NAME);
}

/** Deep-merge `patch` into `base` (arrays replaced). Exported for T-020 and tests. */
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

function createMemoryStorage(name: string): StorageService {
  let settings = defaultSettings();
  const settingsSubs = new Set<(s: Settings) => void>();
  const changeSubs = new Set<(s: StoreName) => void>();
  const changed = (store: StoreName): void => changeSubs.forEach((cb) => cb(store));
  const settingsStore: SettingsStore = {
    get: () => settings,
    async update(patch) {
      settings = mergeSettings(settings, patch);
      settingsSubs.forEach((cb) => cb(settings));
      changed('settings');
      return settings;
    },
    async replace(next) {
      settings = mergeSettings(defaultSettings(), next);
      settingsSubs.forEach((cb) => cb(settings));
      changed('settings');
    },
    subscribe(cb): Unsubscribe {
      settingsSubs.add(cb);
      return () => settingsSubs.delete(cb);
    },
  };
  const todo = (feature: string): never => notImplemented(`storage.${feature} (${name})`, 'T-020');
  return {
    settings: settingsStore,
    addRun: async () => todo('addRun'),
    listRuns: async () => [],
    getBests: async () => [],
    putBestIfBetter: async () => todo('putBestIfBetter'),
    getSectionProgress: async () => [],
    putSectionProgress: async () => todo('putSectionProgress'),
    listDueChecks: async () => [],
    addPracticeTime: async () => todo('addPracticeTime'),
    listPracticeDays: async () => [],
    getStreak: async () => null,
    putStreak: async () => todo('putStreak'),
    getAudioLink: async () => null,
    putAudioLink: async () => todo('putAudioLink'),
    deleteAudioLink: async () => todo('deleteAudioLink'),
    getSongCache: async () => null,
    putSongCache: async () => todo('putSongCache'),
    listRecentSongs: async () => [],
    exportAll: async (): Promise<ExportFile> => todo('exportAll'),
    previewImport: (): ImportPreview => todo('previewImport'),
    importAll: async () => todo('importAll'),
    async clearAll() {
      settings = defaultSettings();
      settingsSubs.forEach((cb) => cb(settings));
    },
    onChange(cb): Unsubscribe {
      changeSubs.add(cb);
      return () => changeSubs.delete(cb);
    },
  };
}

export { DB_NAME, DB_VERSION, DEFAULT_SETTINGS };
