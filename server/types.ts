/**
 * Server-internal contracts (frozen by T-010): the `ServerContext` every route module receives, the
 * route registry row, and the services behind it. Implemented by T-017 (`server/context.ts`).
 * @module
 */
import type { FastifyInstance } from 'fastify';
import type { ConfigUpdate, SearchQuery, SearchResponse, ServerConfig, ServerEvent } from '@shared/api';
import type { Unsubscribe } from '@shared/clock';
import type { SongBundle } from '@shared/song';
import type { AdapterContext, AdapterLogger, IndexEntry, SourceAdapter, SourceAdapterFactory } from '@shared/sources';

/** Absolute paths used by the server (DEC-20). */
export interface ServerPaths {
  /** Repository root (contains `starter/`, `dist/`). */
  repoRoot: string;
  /** `~/.riffway` or `RIFFWAY_DATA_DIR`. */
  dataDir: string;
  /** `<dataDir>/config.json`. */
  configFile: string;
  /** `<dataDir>/index.json` (index cache). */
  indexFile: string;
  /** `<dataDir>/classtab/` (zip, extracted files, ETag state). */
  classtabDir: string;
  /** `<dataDir>/sidecars/` (`<encoded songId>.json`, DEC-17). */
  sidecarsDir: string;
  /** `<dataDir>/audio/` (`<sha1>.<ext>`, DEC-13). */
  audioDir: string;
  /** `<repoRoot>/starter/`. */
  starterDir: string;
  /** Built web app served in production (`<repoRoot>/dist`), or null to serve none. */
  staticDir: string | null;
}

/** Options for `createApp()` (tests pass temp dirs and `watch: false`). */
export interface ServerOptions {
  /** Default `RIFFWAY_DATA_DIR` or `~/.riffway`. */
  dataDir?: string;
  /** Overrides the configured library folder (tests). */
  libraryDir?: string;
  /** Default `<repoRoot>/dist` when it contains `index.html`; null disables static serving. */
  staticDir?: string | null;
  /** Fastify logger option (default false). */
  logger?: boolean | { level: string };
  /** Start file watchers (default true; tests use false). */
  watch?: boolean;
  /** Adapter factories (default: `server/sources/registry.ts`). */
  sources?: readonly SourceAdapterFactory[];
}

/** Server config with persistence (`<dataDir>/config.json`). */
export interface ConfigStore {
  get(): ServerConfig;
  update(patch: ConfigUpdate): Promise<ServerConfig>;
  onChange(cb: (config: ServerConfig) => void): Unsubscribe;
}

/** In-process event bus feeding `GET /api/events` (SSE). */
export interface EventBus {
  emit(event: ServerEvent): void;
  subscribe(cb: (event: ServerEvent) => void): Unsubscribe;
}

/** The unified library index (T-017). */
export interface LibraryService {
  /** Resolves after the initial scan of every enabled source. */
  readonly ready: Promise<void>;
  all(): readonly IndexEntry[];
  get(id: string): IndexEntry | undefined;
  /** MiniSearch (fuzzy, prefix) + filters, merged with adapters' `linkOuts`. */
  search(query: SearchQuery): SearchResponse;
  /** Absolute path of the entry's main file. */
  filePath(entry: IndexEntry): string;
  /** Absolute path of the paired MIDI, or null. */
  midiPath(entry: IndexEntry): string | null;
  /** Main file + MIDI + sidecar for `loadSong`. */
  readBundle(id: string): Promise<SongBundle>;
  /** Re-index one song (after a sidecar change, T-028). */
  reindex(id: string): Promise<IndexEntry | null>;
  /** Full rescan of every enabled source. */
  rescan(): Promise<void>;
  /** Sidecar path for a song id (`<dataDir>/sidecars/<encodeURIComponent(id)>.json`). */
  sidecarPath(id: string): string;
  close(): Promise<void>;
}

/** Everything a route module gets. */
export interface ServerContext {
  readonly version: string;
  readonly paths: ServerPaths;
  readonly config: ConfigStore;
  readonly events: EventBus;
  readonly library: LibraryService;
  readonly sources: readonly SourceAdapter[];
  /** Context handed to adapters (`indexFiles`, `entries`, `emit`). */
  readonly adapterContext: AdapterContext;
  readonly log: AdapterLogger;
  close(): Promise<void>;
}

/**
 * A route file's export: registers its routes on an encapsulated Fastify scope.
 * `@fastify/multipart` is registered globally by `createApp` (use `req.file()` / `req.files()`).
 */
export type RouteModule = (app: FastifyInstance, ctx: ServerContext) => Promise<void>;

/** One row of `server/routes/index.ts`. */
export interface RouteRegistration {
  name: string;
  owner: string;
  register: RouteModule;
}
