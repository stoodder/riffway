/**
 * Builds the `ServerContext` (T-017): config store (`<dataDir>/config.json`), event bus, adapters
 * and the library index (scans, watchers, `index.json` cache, MiniSearch).
 * @module
 */
import type { ServerEvent } from '@shared/api';
import type { AdapterLogger } from '@shared/sources';
import { loadConfigStore } from './config-store';
import { defaultAnalyzer, type SongAnalyzer } from './indexer/analyzer';
import { LibraryIndex } from './indexer/library-index';
import { APP_VERSION, defaultDataDir, defaultStaticDir, resolvePaths } from './paths';
import { createAdapters } from './sources/registry';
import type { EventBus, ServerContext, ServerOptions } from './types';

/** `createApp` options: the frozen {@link ServerOptions} plus server-local test seams. */
export interface AppOptions extends ServerOptions {
  /** Song analysis for the indexer (default: real `loadSong` + `analyzeDifficulty`). */
  analyzer?: SongAnalyzer;
}

/** A synchronous event bus; a throwing subscriber does not affect the others. */
export function createEventBus(): EventBus {
  const subs = new Set<(e: ServerEvent) => void>();
  return {
    emit(event) {
      for (const cb of [...subs]) {
        try {
          cb(event);
        } catch {
          // A broken subscriber (e.g. a closed SSE socket) must not stop delivery.
        }
      }
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

/** Assemble the context. The initial scan starts immediately; await `ctx.library.ready` for it. */
export async function createServerContext(opts: AppOptions, log: AdapterLogger): Promise<ServerContext> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const paths = resolvePaths(dataDir, opts.staticDir === undefined ? defaultStaticDir() : opts.staticDir);
  const config = await loadConfigStore(paths.configFile, opts.libraryDir);
  const events = createEventBus();
  const sources = createAdapters(opts.sources);
  const library = new LibraryIndex({
    paths,
    config,
    events,
    adapters: sources,
    analyzer: opts.analyzer ?? defaultAnalyzer,
    log,
    watch: opts.watch ?? true,
  });
  return {
    version: APP_VERSION,
    paths,
    config,
    events,
    library,
    sources,
    adapterContext: library.adapterContext,
    log,
    close: () => library.close(),
  };
}
