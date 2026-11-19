/**
 * Server config persisted in `<dataDir>/config.json` (DEC-20): library folder, enabled sources,
 * import subfolder. Validates updates (`PUT /api/config`) and notifies subscribers.
 * @module
 */
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import type { ConfigUpdate, ServerConfig } from '@shared/api';
import { SOURCE_IDS, type SourceId } from '@shared/song';
import { normalizeSubfolder } from './fs-safety';
import { isRecord, readJsonFile, writeJsonFile } from './json-file';
import { defaultLibraryDir } from './paths';
import type { ConfigStore } from './types';

/** Default server config. */
export function defaultConfig(libraryDir: string = defaultLibraryDir()): ServerConfig {
  return { schema: 1, libraryDir, enabledSources: [...SOURCE_IDS], importSubfolder: '' };
}

/** A rejected config update. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Expand a leading `~` and normalise; null unless the result is absolute. */
function normalizeLibraryDir(raw: string): string | null {
  const expanded = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
  if (!expanded.trim() || expanded.includes('\0') || !isAbsolute(expanded)) return null;
  return normalize(expanded).replace(/(.)[/\\]+$/, '$1');
}

/**
 * Validate an untrusted `PUT /api/config` body. Throws {@link ConfigError} on unknown keys or bad
 * values; returns a normalised patch.
 */
export function parseConfigUpdate(body: unknown): ConfigUpdate {
  if (!isRecord(body)) throw new ConfigError('Body must be a JSON object');
  const patch: ConfigUpdate = {};
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case 'libraryDir': {
        const dir = typeof value === 'string' ? normalizeLibraryDir(value) : null;
        if (!dir) throw new ConfigError('libraryDir must be an absolute path');
        patch.libraryDir = dir;
        break;
      }
      case 'enabledSources': {
        if (!Array.isArray(value) || !value.every((v): v is SourceId => typeof v === 'string' && SOURCE_IDS.includes(v as SourceId))) {
          throw new ConfigError(`enabledSources must be a list of: ${SOURCE_IDS.join(', ')}`);
        }
        patch.enabledSources = SOURCE_IDS.filter((id) => value.includes(id));
        break;
      }
      case 'importSubfolder': {
        const sub = typeof value === 'string' ? normalizeSubfolder(value) : null;
        if (sub === null) throw new ConfigError('importSubfolder must be a relative folder inside the library (no "..")');
        patch.importSubfolder = sub;
        break;
      }
      default:
        throw new ConfigError(`Unknown config key: ${key}`);
    }
  }
  return patch;
}

/** Read a stored config, keeping only valid fields on top of the defaults. */
function sanitizeStored(stored: unknown, defaults: ServerConfig): ServerConfig {
  if (!isRecord(stored)) return defaults;
  const config = { ...defaults };
  const { schema: _schema, ...fields } = stored;
  for (const [key, value] of Object.entries(fields)) {
    try {
      Object.assign(config, parseConfigUpdate({ [key]: value }));
    } catch {
      // Drop invalid or unknown fields from a hand-edited file; defaults stay.
    }
  }
  return config;
}

/**
 * Load the config store. `libraryDirOverride` (tests, `RIFFWAY_LIBRARY_DIR`) replaces the stored
 * library folder for this process only; it is persisted only if a later update sets `libraryDir`.
 */
export async function loadConfigStore(configFile: string, libraryDirOverride?: string): Promise<ConfigStore> {
  let persisted = sanitizeStored(await readJsonFile(configFile), defaultConfig());
  let config: ServerConfig = libraryDirOverride ? { ...persisted, libraryDir: libraryDirOverride } : persisted;
  const subs = new Set<(c: ServerConfig) => void>();
  let writes = Promise.resolve();
  return {
    get: () => config,
    async update(patch) {
      const clean = parseConfigUpdate(patch);
      persisted = { ...persisted, ...clean };
      config = { ...config, ...clean };
      const snapshot = persisted;
      // Serialise writes; a failed write does not poison later ones.
      writes = writes.catch(() => undefined).then(() => writeJsonFile(configFile, snapshot));
      await writes;
      subs.forEach((cb) => cb(config));
      return config;
    },
    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
