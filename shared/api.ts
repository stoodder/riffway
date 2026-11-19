/**
 * Companion-server HTTP API: paths, request/response DTOs, SSE events and the typed client
 * interface (docs/architecture.md § Companion server API).
 *
 * - Server: one route file per area in `server/routes/`, registered by `server/routes/index.ts`.
 * - Browser: `src/api/client.ts` implements {@link ApiClient} with `fetch` + `EventSource`.
 * - Errors: non-2xx responses carry {@link ApiErrorBody}; unimplemented routes answer 501.
 * - Song ids contain `:` and are URL-encoded in paths (`/api/songs/local%3Aab12…`).
 *
 * DOM-free.
 * @module
 */
import type { Unsubscribe } from './clock';
import type { DifficultyReport, RhythmSidecar, SongBundle, SourceId, TrackInfo } from './song';
import type { IndexEntry, LinkOut, SearchFilters, SearchResult, SourceStatus } from './sources';

/** Default ports (D7). */
export const DEV_WEB_PORT = 5173;
export const SERVER_PORT = 5174;

/** Upload limits enforced by the server. */
export const LIMITS = {
  /** Song file import cap (bytes). */
  importBytes: 20 * 1024 * 1024,
  /** Backing audio cap (bytes). */
  audioBytes: 200 * 1024 * 1024,
} as const;

/** Allowed backing-audio extensions. */
export const AUDIO_EXTENSIONS: readonly string[] = ['.mp3', '.wav', '.m4a'];

/** Every route, as `METHOD path` with `:param`s. Used by the server registry test and the client. */
export const API_ROUTES = {
  health: 'GET /api/health',
  getConfig: 'GET /api/config',
  putConfig: 'PUT /api/config',
  sources: 'GET /api/sources',
  search: 'GET /api/search',
  song: 'GET /api/songs/:id',
  songFile: 'GET /api/songs/:id/file',
  songRhythm: 'GET /api/songs/:id/rhythm',
  getSidecar: 'GET /api/songs/:id/sidecar',
  putSidecar: 'PUT /api/songs/:id/sidecar',
  importFiles: 'POST /api/library/import',
  paste: 'POST /api/library/paste',
  rescan: 'POST /api/library/rescan',
  events: 'GET /api/events',
  classtabStatus: 'GET /api/classtab/status',
  classtabRefresh: 'POST /api/classtab/refresh',
  uploadAudio: 'POST /api/audio',
  getAudio: 'GET /api/audio/:id',
  deleteAudio: 'DELETE /api/audio/:id',
  getSidecars: 'GET /api/sidecars',
  postSidecars: 'POST /api/sidecars',
} as const;

export type ApiRouteName = keyof typeof API_ROUTES;

/** Error body for every non-2xx response. */
export interface ApiErrorBody {
  error: string;
  /** Machine code: `'not-implemented'`, `'not-found'`, `'bad-request'`, `'too-large'`, `'unsupported'`, … */
  code?: string;
}

/** `GET /api/health`. */
export interface HealthResponse {
  ok: true;
  version: string;
  dataDir: string;
  libraryDir: string;
}

/** Server config persisted in `<dataDir>/config.json` (DEC-20). */
export interface ServerConfig {
  schema: 1;
  /** Absolute library folder (default `~/Music/Tabs`). */
  libraryDir: string;
  enabledSources: SourceId[];
  /** Drag-drop imports go here, relative to `libraryDir` (`''` = root). */
  importSubfolder: string;
}

/** `PUT /api/config` body. */
export type ConfigUpdate = Partial<Omit<ServerConfig, 'schema'>>;

/** `GET /api/sources`. */
export interface SourcesResponse {
  sources: SourceStatus[];
}

/** `GET /api/search` query (all optional; arrays are comma-separated in the URL). */
export interface SearchQuery extends SearchFilters {
  q?: string;
}

/** `GET /api/search`. */
export interface SearchResponse {
  results: SearchResult[];
  linkOuts: LinkOut[];
  /** Total matches before `limit`. */
  total: number;
}

/** `GET /api/songs/:id`: entry + arrangements + difficulty + file URLs. */
export interface SongMeta {
  entry: IndexEntry;
  arrangements: TrackInfo[];
  /** Difficulty per playable arrangement index. */
  difficulty: Record<number, DifficultyReport>;
  files: {
    /** `GET /api/songs/:id/file`. */
    main: string;
    /** `GET /api/songs/:id/rhythm`, when a paired MIDI exists. */
    rhythm?: string;
    /** `GET /api/songs/:id/sidecar`, when a sidecar exists. */
    sidecar?: string;
  };
}

/** Per-file result of `POST /api/library/import` (multipart, field `files`). */
export interface ImportFileResult {
  name: string;
  status: 'imported' | 'duplicate' | 'rejected';
  /** Library-relative path written (imported) or matched (duplicate). */
  path?: string;
  reason?: string;
}

/** `POST /api/library/import`. Indexing happens via the watcher (`library.changed` follows). */
export interface ImportResponse {
  files: ImportFileResult[];
}

/** `POST /api/library/paste`: writes `<artist> - <title>.txt` (+ sidecar) into the library. */
export interface PasteRequest {
  title: string;
  artist?: string;
  text: string;
  sidecar?: RhythmSidecar;
}

/** `POST /api/library/paste` response. */
export interface PasteResponse {
  /** Id the song will get once indexed (computed from content). */
  id: string;
  path: string;
}

/** `POST /api/library/rescan`. */
export interface RescanResponse {
  started: boolean;
}

/** `GET /api/classtab/status`. */
export interface ClassTabStatus {
  state: 'not-downloaded' | 'ready' | 'refreshing' | 'error';
  /** Epoch ms of the last successful download or 304. */
  lastRefresh: number | null;
  etag: string | null;
  lastModified: string | null;
  tabs: number;
  midis: number;
  /** Tabs per rhythm status. */
  rhythm: { midi: number; ruler: number; needsAlignment: number };
  error?: string;
}

/** `POST /api/classtab/refresh` body. */
export interface ClassTabRefreshRequest {
  force?: boolean;
}

/** `POST /api/classtab/refresh` response (progress arrives as `classtab.progress` events). */
export interface ClassTabRefreshResponse {
  started: boolean;
  reason?: string;
}

/** `POST /api/audio` (multipart, field `file`) response. Stored as `<dataDir>/audio/<sha1>.<ext>`. */
export interface AudioUploadResponse {
  audioId: string;
  fileName: string;
  ext: string;
  bytes: number;
}

/** `GET/POST /api/sidecars` (export/import). */
export interface SidecarsBundle {
  sidecars: Record<string, RhythmSidecar>;
}

/** `POST /api/sidecars` response. */
export interface SidecarsImportResponse {
  written: number;
}

/**
 * SSE events on `GET /api/events`. Each message is `data: <JSON ServerEvent>` on the default
 * `message` event (no named events); the server sends `: ping` comments every 15 s.
 */
export type ServerEvent =
  | { type: 'library.changed'; ids: string[]; reason: 'added' | 'changed' | 'removed' | 'rescan' }
  | { type: 'index.progress'; source: SourceId; done: number; total: number }
  | {
      type: 'classtab.progress';
      phase: 'checking' | 'downloading' | 'extracting' | 'indexing' | 'done' | 'not-modified' | 'error';
      bytes?: number;
      totalBytes?: number;
      message?: string;
    };

export type ServerEventType = ServerEvent['type'];

/** The typed browser client (`src/api/client.ts`). All methods reject with `ApiError` on non-2xx. */
export interface ApiClient {
  health(): Promise<HealthResponse>;
  getConfig(): Promise<ServerConfig>;
  putConfig(update: ConfigUpdate): Promise<ServerConfig>;
  sources(): Promise<SourcesResponse>;
  search(query: SearchQuery): Promise<SearchResponse>;
  song(id: string): Promise<SongMeta>;
  songFile(id: string): Promise<Uint8Array>;
  songRhythm(id: string): Promise<Uint8Array>;
  getSidecar(id: string): Promise<RhythmSidecar | null>;
  putSidecar(id: string, sidecar: RhythmSidecar): Promise<RhythmSidecar>;
  /** Fetch main file + paired MIDI + sidecar for `loadSong`. */
  songBundle(id: string): Promise<SongBundle>;
  importFiles(files: readonly Blob[] | FileListLike, onProgress?: (fraction: number) => void): Promise<ImportResponse>;
  paste(req: PasteRequest): Promise<PasteResponse>;
  rescan(): Promise<RescanResponse>;
  classtabStatus(): Promise<ClassTabStatus>;
  classtabRefresh(req?: ClassTabRefreshRequest): Promise<ClassTabRefreshResponse>;
  uploadAudio(file: Blob, fileName: string): Promise<AudioUploadResponse>;
  getAudio(audioId: string): Promise<ArrayBuffer>;
  /** URL for streaming/decoding (`GET /api/audio/:id`). */
  audioUrl(audioId: string): string;
  deleteAudio(audioId: string): Promise<void>;
  getSidecars(): Promise<SidecarsBundle>;
  postSidecars(bundle: SidecarsBundle): Promise<SidecarsImportResponse>;
  /** Subscribe to SSE; reconnects automatically. */
  subscribe(onEvent: (event: ServerEvent) => void): Unsubscribe;
}

/** Structural stand-in for `FileList` (keeps this file DOM-free). */
export interface FileListLike {
  readonly length: number;
  item(index: number): Blob | null;
}
