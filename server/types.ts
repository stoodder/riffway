/**
 * Server-internal contracts (frozen by T-010): the `ServerContext` every route module receives, the
 * route registry row, and the services behind it. Implemented by T-017 (`server/context.ts`).
 * @module
 */
import type { FastifyInstance } from 'fastify';
import type { ConfigUpdate, SearchQuery, SearchResponse, ServerConfig, ServerEvent } from '@shared/api';
import type { Unsubscribe } from '@shared/clock';
import type { DifficultyReport, RhythmStatus, SongBundle, SongFormat, SongTags, SourceId, TrackInfo } from '@shared/song';
import type { AdapterContext, AdapterLogger, IndexEntry, SourceAdapter, SourceAdapterFactory, SourceStatus } from '@shared/sources';

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
  /** Song analysis for the indexer (default: real `loadSong` + `analyzeDifficulty`, `server/indexer/analyzer.ts`). */
  analyzer?: SongAnalyzer;
}

/** Everything the indexer needs from one parsed file (default arrangement). */
export interface SongAnalysis {
  format: SongFormat;
  title: string;
  artist?: string;
  composer?: string;
  /** Every track of the file, playable or not. */
  tracks: TrackInfo[];
  /** First playable track, or -1 when none is playable. */
  defaultArrangement: number;
  /** MIDI tuning of the default arrangement, high → low. */
  tuning: number[];
  tuningId: string;
  tuningLabel: string;
  capo: number;
  /** Initial tempo (BPM), or null when unknown. */
  bpm: number | null;
  durationSec: number;
  rhythm: RhythmStatus;
  /** Difficulty of the default arrangement; null when unplayable or analysis failed. */
  difficulty: DifficultyReport | null;
  /** Song tags from the file plus the difficulty's skill tags. */
  tags: SongTags;
  /** Set when the file parsed but cannot be played (e.g. no 6-string guitar track). */
  error?: string;
}

/**
 * The indexer's view of the song importers. Both methods may throw; an `ImportError` with code
 * `unsupported` (or `empty` for ASCII text) means "not a song file" and the file is skipped silently.
 */
export interface SongAnalyzer {
  /** Parse a bundle's default arrangement into index metadata. */
  analyze(bundle: SongBundle): SongAnalysis | Promise<SongAnalysis>;
  /** Difficulty of one arrangement (song page, `SongMeta.difficulty`). */
  difficulty(bundle: SongBundle, arrangement: number): DifficultyReport | Promise<DifficultyReport>;
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

/** Indexing state of one source (merged into its `SourceStatus` by {@link LibraryService.decorateStatus}). */
export interface SourceIndexState {
  state: 'idle' | 'indexing' | 'error';
  lastRefresh: number | null;
  message?: string;
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
  /**
   * Difficulty of every playable arrangement (`SongMeta.difficulty`): the default arrangement's comes
   * from the index, others are analysed on first request and cached. Rejects for unknown ids.
   */
  arrangementDifficulties(id: string): Promise<Record<number, DifficultyReport>>;
  /** Indexing state of one source (`idle` with `lastRefresh: null` before its first scan). */
  sourceState(source: SourceId): SourceIndexState;
  /** Merge library-side facts (enabled flag, indexed count, indexing state) into an adapter's status. */
  decorateStatus(status: SourceStatus): SourceStatus;
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
