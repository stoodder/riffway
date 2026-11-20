/**
 * Source adapters, the library index and unified search (docs/sources/README.md, docs/architecture.md).
 *
 * Adapters run **only in the companion server** (`server/sources/<id>/`), registered in
 * `server/sources/registry.ts`. Link-out adapters (Songsterr, Ultimate Guitar, GP free pack) do no
 * network I/O at all: they build URLs and match already-indexed songs by normalised title/artist.
 * Never call undocumented endpoints or `songsterr.com/api` (D1).
 *
 * DOM-free.
 * @module
 */
import type { ServerEvent } from './api';
import type { Unsubscribe } from './clock';
import type { DifficultyReport, RhythmStatus, SongBundle, SongFormat, SongTags, SourceId, Tier, TrackInfo } from './song';

/** How an adapter gets songs. */
export type SourceKind =
  /** Files on disk that the indexer reads (local folder, starter). */
  | 'library'
  /** Downloads an official bundle, then indexes it locally (ClassTab). */
  | 'download'
  /** No I/O: link-out URL + local matching only (Songsterr, UG, GP pack). */
  | 'link-out';

/** One indexed song file (one entry per file; arrangements inside). Persisted in `<dataDir>/index.json`. */
export interface IndexEntry {
  /** DEC-14: `<source>:<sha1(content)[0..16]>`, sticky per path; starter `starter:<slug>`. */
  id: string;
  source: SourceId;
  /** Path relative to the source root, `/`-separated. */
  path: string;
  fileName: string;
  format: SongFormat;
  mtimeMs: number;
  size: number;
  /** Full hex sha1 of the content. */
  sha1: string;
  title: string;
  artist?: string;
  composer?: string;
  tracks: TrackInfo[];
  /** First playable track, or -1 if none. */
  defaultArrangement: number;
  /** MIDI tuning of the default arrangement, high → low. */
  tuning: number[];
  /** Tuning slug for filters: `'standard'`, `'drop-d'`, `'eb-standard'`, `'open-g'`, … or `'custom'`. */
  tuningId: string;
  /** Display label: `'Standard'`, `'Drop D'`, … or the note names. */
  tuningLabel: string;
  capo: number;
  /** Initial tempo (BPM). */
  bpm: number | null;
  durationSec: number;
  rhythm: RhythmStatus;
  /** Difficulty of the default arrangement (null if not playable or analysis failed). */
  difficulty: DifficultyReport | null;
  tags: SongTags;
  /** A paired MIDI exists (ClassTab / sibling `.mid`). */
  hasMidi: boolean;
  /** A rhythm sidecar exists (DEC-17). */
  hasSidecar: boolean;
  origin?: string;
  /** Web page for the song (ClassTab header URL, …). */
  url?: string;
  /** Set when import failed; the entry stays visible with this message. */
  error?: string;
}

/** Search/filter parameters (`GET /api/search`). */
export interface SearchFilters {
  /** Restrict to these sources. Empty/undefined = all enabled. */
  source?: SourceId[];
  tierMin?: number;
  tierMax?: number;
  /** Tuning slug (see `IndexEntry.tuningId`). */
  tuning?: string;
  /** true = only playable now; false = only not playable (needs rhythm). */
  playable?: boolean;
  /** Every tag must be present (style, genre or skill tags). */
  tags?: string[];
  /** Max results (default 50). */
  limit?: number;
}

/** Whether a result can be played right now. */
export type Availability = 'playable' | 'needs-rhythm' | 'needs-import';

/** One search result (compact projection of an {@link IndexEntry}). */
export interface SearchResult {
  id: string;
  source: SourceId;
  title: string;
  artist?: string;
  composer?: string;
  fileName: string;
  tier: Tier | null;
  rating: number | null;
  /** True when the rating is provisional (needs-alignment). */
  ratingProvisional: boolean;
  tuningId: string;
  tuningLabel: string;
  tags: SongTags;
  rhythm: RhythmStatus;
  availability: Availability;
  /** Playable arrangements count. */
  arrangements: number;
  defaultArrangement: number;
  durationSec: number;
  /** MiniSearch relevance (0 when listing without a query). */
  score: number;
  /** The entry's import error (`IndexEntry.error`): shown as "Failed to import" (availability `needs-import`). */
  error?: string;
  /** Badges contributed by link-out adapters, e.g. `{source:'songsterr', label:'In your library – playable'}`. */
  badges?: { source: SourceId; label: string }[];
}

/** A link-out action shown beside results ("Search on Songsterr"). Opened with `noopener` in a new tab. */
export interface LinkOut {
  source: SourceId;
  /** Button text, plain (nominative use; no logos). */
  label: string;
  url: string;
  /** Short help text (e.g. "Download the Guitar Pro file, then drop it here"). */
  hint?: string;
  /** Already-indexed songs this adapter matched locally for the query. */
  localMatchIds?: string[];
}

/**
 * One remote catalog hit (search metadata only; no tab content). Produced by an adapter's
 * {@link SourceAdapter.searchRemote} (opt-in, `ServerConfig.remoteSearch`; docs/guides/songsterr-search.md).
 */
export interface RemoteSearchHit {
  source: SourceId;
  /** The remote site's id for the song (stable; used to link imports back to hits). */
  remoteId: string;
  title: string;
  artist?: string;
  /** Song page on the remote site, opened in a new tab. */
  url: string;
  /** Guitar tracks only (6-string). Empty when the site lists none. */
  tracks: { name: string; tuning?: number[] }[];
  /** MIDI tuning of the first guitar track, string 1 = high e (same order as `IndexEntry.tuning`). */
  tuning?: number[];
  /** Filter slug and label from `describeTuning` (`'drop-d'`, `'Drop D'`, …). */
  tuningId?: string;
  tuningLabel?: string;
  /** Indexed songs that match this hit by normalized title + artist (playable now). */
  localMatchIds?: string[];
}

/** Adapter status (`GET /api/sources`). */
export interface SourceStatus {
  id: SourceId;
  displayName: string;
  kind: SourceKind;
  enabled: boolean;
  /** Indexed entries from this source. */
  indexed: number;
  /** Epoch ms of the last successful index/refresh, or null. */
  lastRefresh: number | null;
  /** `'idle' | 'indexing' | 'refreshing' | 'error' | 'not-downloaded'` style state. */
  state: 'idle' | 'indexing' | 'refreshing' | 'error' | 'not-downloaded';
  message?: string;
  /** Path of the terms doc, e.g. `docs/sources/songsterr.md`. */
  termsDoc: string;
}

/** Minimal logger handed to adapters (Fastify's logger satisfies it). */
export interface AdapterLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

/** A file an adapter wants indexed. */
export interface IndexCandidate {
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to the adapter's root (stored in the index). */
  relPath: string;
  mtimeMs: number;
  size: number;
  /** Optional paired MIDI absolute path (ClassTab). */
  midiPath?: string;
  /** Extra tags (ClassTab: `fingerstyle`, `classical`). */
  tags?: Partial<SongTags>;
  /** Fixed id (starter: `starter:<slug>`). Otherwise DEC-14 rules apply. */
  id?: string;
  url?: string;
  origin?: string;
}

/** Services the server hands to adapters (implemented by T-017). */
export interface AdapterContext {
  readonly dataDir: string;
  readonly libraryDir: string;
  readonly log: AdapterLogger;
  /**
   * Index files (cached by mtime + size): runs `loadSong` + `analyzeDifficulty` and stores the
   * entries under `source`. Removes entries of `source` that are not in `candidates` when
   * `replaceAll` is true.
   */
  indexFiles(source: SourceId, candidates: IndexCandidate[], opts?: { replaceAll?: boolean }): Promise<IndexEntry[]>;
  /** Read access to the unified index (link-out local matching). */
  entries(): readonly IndexEntry[];
  /** Emit a server event (`classtab.progress`, …) on `/api/events`. */
  emit(event: ServerEvent): void;
}

/** Options for a download refresh. */
export interface RefreshOptions {
  /** Ignore the once-per-day limit. */
  force?: boolean;
}

/** Result of a refresh. */
export interface RefreshResult {
  status: 'updated' | 'not-modified' | 'skipped' | 'error';
  message?: string;
}

/**
 * The shared adapter interface. Optional methods depend on {@link SourceKind}:
 * - `library` / `download`: `scan` (+ optional `watch`), `download` also `refresh`.
 * - `link-out`: `linkOuts` (+ optional `matchLocal`); no I/O, except the opt-in `searchRemote`
 *   (off by default; docs/guides/songsterr-search.md).
 */
export interface SourceAdapter {
  readonly id: SourceId;
  readonly displayName: string;
  readonly kind: SourceKind;
  /** `docs/sources/<file>.md` describing terms and approach. */
  readonly termsDoc: string;
  /** Called once at server start (after config is loaded). */
  init?(ctx: AdapterContext): Promise<void>;
  /** List the files this source wants indexed (the server indexes them via `ctx.indexFiles`). */
  scan?(ctx: AdapterContext): Promise<IndexCandidate[]>;
  /** Watch for changes; call `onChange` with changed absolute paths (debounced by the adapter). */
  watch?(ctx: AdapterContext, onChange: (paths: string[]) => void): Unsubscribe;
  /** Download / update the source's data (ClassTab zip). */
  refresh?(ctx: AdapterContext, opts: RefreshOptions): Promise<RefreshResult>;
  /** Link-out actions for a query. Pure: no I/O. */
  linkOuts?(query: string, filters: SearchFilters): LinkOut[];
  /** Ids of indexed entries this source considers a match for the query (normalised title/artist). Pure. */
  matchLocal?(query: string, entries: readonly IndexEntry[]): string[];
  /**
   * Remote catalog search (opt-in; `ServerConfig.remoteSearch`). Metadata only. Must honor `signal`,
   * rate-limit itself, throw {@link RemoteSearchRefused} on 403/429 and {@link RemoteSearchUnavailable}
   * while the request isn't set up (docs/guides/songsterr-search.md).
   */
  searchRemote?(query: string, ctx: AdapterContext, signal: AbortSignal): Promise<RemoteSearchHit[]>;
  /** Read a raw song bundle for an entry this adapter owns (default: the server reads `path`). */
  readBundle?(entry: IndexEntry, ctx: AdapterContext): Promise<SongBundle>;
  status(ctx: AdapterContext): Promise<SourceStatus>;
}

/** Factory registered in `server/sources/registry.ts`. */
export type SourceAdapterFactory = () => SourceAdapter;

/** One starter item in `starter/manifest.json` (authored by T-019, read by the starter adapter, T-017). */
export interface StarterItem {
  /** File is `starter/<slug>.atex`; song id is `starter:<slug>`. */
  slug: string;
  title: string;
  composer?: string;
  /** Arrangement credit, e.g. "Arrangement original to Riffway". */
  credit: string;
  /** Why the melody is public domain (or "Original exercise"). */
  publicDomainNote: string;
  tags: { style: ('pick' | 'fingerstyle')[]; genre: string[] };
  /** Intended difficulty tier (calibration target, T-029). */
  targetTier: number;
  bpm: number;
}

/** `starter/manifest.json`. */
export interface StarterManifest {
  schema: 1;
  items: StarterItem[];
}

/** The remote site refused the request (403/429). The adapter turns remote search off for the session. */
export class RemoteSearchRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteSearchRefused';
  }
}

/**
 * Remote search can't run because its request isn't set up (e.g. the owner hasn't written the
 * request URL yet, docs/guides/songsterr-search.md § 3c). No request is made; the route answers
 * `status: 'off'` with this message.
 */
export class RemoteSearchUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteSearchUnavailable';
  }
}
