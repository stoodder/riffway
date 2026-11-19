/**
 * Builds the `ServerContext` (T-017 owns): config store (`<dataDir>/config.json`), event bus,
 * library index (watchers, `loadSong` + `analyzeDifficulty`, `index.json` cache, MiniSearch),
 * adapters and the adapter context.
 *
 * **Stub (T-010):** in-memory config from defaults, a working event bus, an empty library; nothing
 * is written to disk.
 * @module
 */
import type { ServerConfig, ServerEvent } from '@shared/api';
import { SOURCE_IDS } from '@shared/song';
import type { AdapterContext, AdapterLogger } from '@shared/sources';
import { notImplemented } from '@shared/errors';
import { join } from 'node:path';
import { APP_VERSION, defaultDataDir, defaultLibraryDir, defaultStaticDir, resolvePaths } from './paths';
import { createAdapters } from './sources/registry';
import type { ConfigStore, EventBus, LibraryService, ServerContext, ServerOptions } from './types';

/** Default server config. */
export function defaultConfig(libraryDir: string = defaultLibraryDir()): ServerConfig {
  return { schema: 1, libraryDir, enabledSources: [...SOURCE_IDS], importSubfolder: '' };
}

/** A simple synchronous event bus. */
export function createEventBus(): EventBus {
  const subs = new Set<(e: ServerEvent) => void>();
  return {
    emit: (event) => subs.forEach((cb) => cb(event)),
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

/** Assemble the context. */
export async function createServerContext(opts: ServerOptions, log: AdapterLogger): Promise<ServerContext> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const paths = resolvePaths(dataDir, opts.staticDir === undefined ? defaultStaticDir() : opts.staticDir);
  let config = defaultConfig(opts.libraryDir);
  const configSubs = new Set<(c: ServerConfig) => void>();
  const configStore: ConfigStore = {
    get: () => config,
    async update(patch) {
      config = { ...config, ...patch };
      configSubs.forEach((cb) => cb(config));
      return config;
    },
    onChange(cb) {
      configSubs.add(cb);
      return () => configSubs.delete(cb);
    },
  };
  const events = createEventBus();
  const library: LibraryService = {
    ready: Promise.resolve(),
    all: () => [],
    get: () => undefined,
    search: () => ({ results: [], linkOuts: [], total: 0 }),
    filePath: (entry) => join(config.libraryDir, entry.path),
    midiPath: () => null,
    readBundle: async () => notImplemented('library.readBundle', 'T-017'),
    reindex: async () => null,
    rescan: async () => {},
    sidecarPath: (id) => join(paths.sidecarsDir, `${encodeURIComponent(id)}.json`),
    close: async () => {},
  };
  const adapterContext: AdapterContext = {
    dataDir,
    get libraryDir() {
      return config.libraryDir;
    },
    log,
    indexFiles: async () => notImplemented('adapterContext.indexFiles', 'T-017'),
    entries: () => library.all(),
    emit: (e) => events.emit(e),
  };
  const sources = createAdapters(opts.sources);
  return {
    version: APP_VERSION,
    paths,
    config: configStore,
    events,
    library,
    sources,
    adapterContext,
    log,
    close: () => library.close(),
  };
}
