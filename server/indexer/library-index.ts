/**
 * The unified library index (T-017): adapters' scans → `loadSong` + `analyzeDifficulty` (through a
 * {@link SongAnalyzer}) → `IndexEntry`s, cached in `<dataDir>/index.json` (mtime + size), searchable
 * through MiniSearch, kept live by adapter watchers, with `library.changed` / `index.progress`
 * events on the bus.
 *
 * Identity (DEC-14): `<source>:<sha1(content)[0..16]>` at first index, sticky per path; a file that
 * moves with identical content keeps its id; adapters may fix ids (starter `starter:<slug>`). Two
 * live files with identical content in one source get a path-salted id instead of colliding.
 * @module
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { LIMITS, type SearchQuery, type SearchResponse } from '@shared/api';
import type { DifficultyReport, RhythmSidecar, SongBundle, SongFormat, SourceId, SourceRef } from '@shared/song';
import type {
  AdapterContext,
  AdapterLogger,
  IndexCandidate,
  IndexEntry,
  LinkOut,
  SearchFilters,
  SourceAdapter,
  SourceStatus,
} from '@shared/sources';
import type { Unsubscribe } from '@shared/clock';
import { lowerExt } from '../fs-safety';
import { isRecord, readJsonFile, writeJsonFile } from '../json-file';
import { APP_VERSION } from '../paths';
import type { ConfigStore, EventBus, LibraryService, ServerPaths, SongAnalyzer, SourceIndexState } from '../types';
import { isSkippableImportError, mergeTags } from './analyzer';
import { SearchIndex } from './search';

/** Bump when the cached record shape or indexing rules change (the cache is then rebuilt). */
const INDEX_SCHEMA = 1;
/** Cache validity key: a new app version re-indexes everything once. */
const INDEX_VERSION = `${APP_VERSION}/${INDEX_SCHEMA}`;
/** Remembered ids of removed files (moved-file identity), bounded. */
const REMOVED_ID_MEMORY = 2000;
/** Emit `index.progress` every this many files. */
const PROGRESS_EVERY = 25;

/** Extension → format, used when a file fails to import (the analyzer reports it otherwise). */
const FORMAT_BY_EXT: Readonly<Record<string, SongFormat>> = {
  '.gp': 'gp',
  '.gpx': 'gpx',
  '.gp5': 'gp5',
  '.gp4': 'gp4',
  '.gp3': 'gp3',
  '.musicxml': 'musicxml',
  '.xml': 'musicxml',
  '.mxl': 'mxl',
  '.atex': 'alphatex',
  '.txt': 'ascii',
  '.tab': 'ascii',
};

/** One cached file (persisted in `index.json`). */
interface CacheRecord {
  source: SourceId;
  candidate: IndexCandidate;
  /** mtime of the paired MIDI when indexed (null = none). */
  midiMtimeMs: number | null;
  /** mtime of the rhythm sidecar when indexed (null = none). */
  sidecarMtimeMs: number | null;
  /** null = not a song (skipped silently, cached so it is not re-parsed). */
  entry: IndexEntry | null;
  /** Lazily computed difficulty of non-default arrangements. */
  arrangementDifficulty: Record<number, DifficultyReport>;
}

/** `index.json`. */
interface CacheFile {
  schema: typeof INDEX_SCHEMA;
  version: string;
  records: CacheRecord[];
}

/** Ids touched by one indexing pass. */
interface IndexDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

/** Thrown by {@link LibraryIndex.readBundle} for unknown ids. */
export class SongNotFoundError extends Error {
  constructor(id: string) {
    super(`Song not found: ${id}`);
    this.name = 'SongNotFoundError';
  }
}

/** Dependencies of {@link LibraryIndex}. */
export interface LibraryDeps {
  paths: ServerPaths;
  config: ConfigStore;
  events: EventBus;
  adapters: readonly SourceAdapter[];
  analyzer: SongAnalyzer;
  log: AdapterLogger;
  /** Start adapter watchers after the initial scan. */
  watch: boolean;
}

const keyOf = (source: SourceId, absPath: string): string => `${source}\u0000${absPath}`;
const sha1Hex = (data: Uint8Array): string => createHash('sha1').update(data).digest('hex');
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

async function mtimeOrNull(path: string | undefined): Promise<number | null> {
  if (!path) return null;
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** Parse a sidecar file; null when missing or malformed. */
function asSidecar(value: unknown): RhythmSidecar | null {
  if (!isRecord(value) || value.schema !== 1) return null;
  if (typeof value.bpm !== 'number' || !Array.isArray(value.onsets) || !Array.isArray(value.timeSig)) return null;
  return value as unknown as RhythmSidecar;
}

/** A cached entry needs re-analysis even when the file is unchanged (earlier failure). */
function isStale(entry: IndexEntry | null): boolean {
  return !!entry && (!!entry.error || (entry.defaultArrangement >= 0 && entry.difficulty === null));
}

/** The library index ({@link LibraryService}). */
export class LibraryIndex implements LibraryService {
  readonly ready: Promise<void>;
  /** Context handed to adapters. */
  readonly adapterContext: AdapterContext;

  private readonly records = new Map<string, CacheRecord>();
  private readonly keyById = new Map<string, string>();
  private readonly entriesById = new Map<string, IndexEntry>();
  private readonly removedIds = new Map<string, string>();
  private readonly search_ = new SearchIndex();
  private readonly states = new Map<SourceId, SourceIndexState>();
  private readonly watchers = new Map<SourceId, Unsubscribe>();
  /** Pending/in-flight scans per source (coalesced). */
  private readonly scans = new Map<SourceId, { running: Promise<void>; again: boolean }>();
  private lock: Promise<unknown> = Promise.resolve();
  private cacheWrite: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly unsubscribeConfig: Unsubscribe;

  constructor(private readonly deps: LibraryDeps) {
    this.adapterContext = {
      dataDir: deps.paths.dataDir,
      get libraryDir() {
        return deps.config.get().libraryDir;
      },
      log: deps.log,
      indexFiles: (source, candidates, opts) => this.indexFiles(source, candidates, opts),
      entries: () => this.all(),
      emit: (e) => deps.events.emit(e),
    };
    let previous = deps.config.get();
    this.unsubscribeConfig = deps.config.onChange((next) => {
      const prev = previous;
      previous = next;
      if (prev.libraryDir !== next.libraryDir || prev.enabledSources.join() !== next.enabledSources.join()) {
        void this.restart();
      }
    });
    this.ready = this.start();
  }

  // ---------------------------------------------------------------------------------------------
  // LibraryService
  // ---------------------------------------------------------------------------------------------

  all(): readonly IndexEntry[] {
    return [...this.entriesById.values()];
  }

  get(id: string): IndexEntry | undefined {
    return this.entriesById.get(id);
  }

  search(query: SearchQuery): SearchResponse {
    const enabled = this.enabledSources();
    const sources = query.source?.length ? query.source.filter((s) => enabled.has(s)) : [...enabled];
    const filters: SearchFilters = { ...query, source: sources };
    const q = query.q ?? '';
    const { results, total } = sources.length ? this.search_.query(q, this.entriesById, filters) : { results: [], total: 0 };
    const linkOuts: LinkOut[] = [];
    if (q.trim()) {
      const visible = this.all().filter((e) => enabled.has(e.source));
      const rows = new Map(results.map((r) => [r.id, r]));
      for (const adapter of this.deps.adapters) {
        if (adapter.kind !== 'link-out' || !enabled.has(adapter.id)) continue;
        try {
          const matched = adapter.matchLocal?.(q, visible) ?? [];
          for (const out of adapter.linkOuts?.(q, filters) ?? []) {
            linkOuts.push(matched.length ? { ...out, localMatchIds: matched } : out);
          }
          for (const id of matched) {
            const row = rows.get(id);
            if (!row) continue;
            const label = row.availability === 'playable' ? 'In your library – playable' : 'In your library';
            (row.badges ??= []).push({ source: adapter.id, label });
          }
        } catch (err) {
          this.deps.log.warn(`link-out adapter ${adapter.id} failed: ${String(err)}`);
        }
      }
    }
    return { results, linkOuts, total };
  }

  filePath(entry: IndexEntry): string {
    return this.recordOf(entry.id)?.candidate.absPath ?? entry.path;
  }

  midiPath(entry: IndexEntry): string | null {
    return this.recordOf(entry.id)?.candidate.midiPath ?? null;
  }

  async readBundle(id: string): Promise<SongBundle> {
    const record = this.recordOf(id);
    const entry = record?.entry;
    if (!record || !entry) throw new SongNotFoundError(id);
    const adapter = this.deps.adapters.find((a) => a.id === entry.source);
    if (adapter?.readBundle) return adapter.readBundle(entry, this.adapterContext);
    const data = new Uint8Array(await readFile(record.candidate.absPath));
    return this.bundleFor(record.source, record.candidate, id, data);
  }

  async reindex(id: string): Promise<IndexEntry | null> {
    const record = this.recordOf(id);
    if (!record) return null;
    const { source, candidate } = record;
    return this.exclusive(async () => {
      let fresh: IndexCandidate;
      try {
        const st = await stat(candidate.absPath);
        fresh = { ...candidate, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        const removed = this.removeRecord(keyOf(source, candidate.absPath));
        this.emitDiff({ added: [], changed: [], removed: removed ? [removed] : [] });
        await this.saveCache();
        return null;
      }
      const result = await this.processCandidate(source, fresh, true);
      const diff: IndexDiff = { added: [], changed: [], removed: [] };
      this.recordResult(result, diff);
      this.emitDiff(diff);
      await this.saveCache();
      return result.record.entry;
    });
  }

  async rescan(): Promise<void> {
    await this.ready;
    const results = await Promise.all(this.scannableAdapters().map((a) => this.scanSource(a)));
    const ids = [...new Set(results.flatMap((d) => [...d.added, ...d.changed, ...d.removed]))];
    this.deps.events.emit({ type: 'library.changed', ids, reason: 'rescan' });
  }

  sidecarPath(id: string): string {
    return join(this.deps.paths.sidecarsDir, `${encodeURIComponent(id)}.json`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribeConfig();
    await this.ready.catch(() => undefined);
    await this.stopWatchers();
    await Promise.all([...this.scans.values()].map((slot) => slot.running.catch(() => undefined)));
    await this.lock.catch(() => undefined);
    await this.cacheWrite.catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------
  // Extras for routes
  // ---------------------------------------------------------------------------------------------

  /** Indexing state of one source (merged into its `SourceStatus`). */
  sourceState(source: SourceId): SourceIndexState {
    return this.states.get(source) ?? { state: 'idle', lastRefresh: null };
  }

  /** Merge library-side facts (indexed count, enabled flag, indexing state) into an adapter status. */
  decorateStatus(status: SourceStatus): SourceStatus {
    const out: SourceStatus = { ...status, enabled: this.enabledSources().has(status.id) };
    if (status.kind === 'link-out') return out;
    out.indexed = this.all().filter((e) => e.source === status.id).length;
    const tracked = this.sourceState(status.id);
    out.lastRefresh = status.lastRefresh ?? tracked.lastRefresh;
    if (tracked.state !== 'idle' && (status.state === 'idle' || tracked.state === 'error')) {
      out.state = tracked.state;
      if (tracked.message) out.message = tracked.message;
    }
    return out;
  }

  /**
   * Difficulty of every playable arrangement (`SongMeta.difficulty`). The default arrangement comes
   * from the index; others are analysed on first request and cached.
   */
  async arrangementDifficulties(id: string): Promise<Record<number, DifficultyReport>> {
    const record = this.recordOf(id);
    const entry = record?.entry;
    if (!record || !entry) throw new SongNotFoundError(id);
    const out: Record<number, DifficultyReport> = {};
    if (entry.difficulty && entry.defaultArrangement >= 0) out[entry.defaultArrangement] = entry.difficulty;
    const missing = entry.tracks.filter((t) => t.playable && t.index !== entry.defaultArrangement && !record.arrangementDifficulty[t.index]);
    if (missing.length) {
      const bundle = await this.readBundle(id);
      for (const track of missing) {
        try {
          record.arrangementDifficulty[track.index] = await this.deps.analyzer.difficulty(bundle, track.index);
        } catch (err) {
          this.deps.log.warn(`difficulty of ${id} arrangement ${track.index} failed: ${String(err)}`);
        }
      }
      await this.saveCache();
    }
    return { ...record.arrangementDifficulty, ...out };
  }

  // ---------------------------------------------------------------------------------------------
  // Scanning and indexing
  // ---------------------------------------------------------------------------------------------

  /** Index candidates for a source (adapters call this through `AdapterContext.indexFiles`). */
  async indexFiles(source: SourceId, candidates: IndexCandidate[], opts: { replaceAll?: boolean } = {}): Promise<IndexEntry[]> {
    const { diff, entries } = await this.exclusive(() => this.applyCandidates(source, candidates, !!opts.replaceAll));
    this.emitDiff(diff);
    return entries;
  }

  private async start(): Promise<void> {
    await this.loadCache();
    for (const adapter of this.deps.adapters) {
      try {
        await adapter.init?.(this.adapterContext);
      } catch (err) {
        this.setState(adapter.id, { state: 'error', lastRefresh: null, message: `init failed: ${String(err)}` });
      }
    }
    const diffs = await Promise.all(this.scannableAdapters().map((a) => this.scanSource(a)));
    const ids = diffs.flatMap((d) => [...d.added, ...d.changed, ...d.removed]);
    if (ids.length) this.deps.events.emit({ type: 'library.changed', ids, reason: 'rescan' });
    if (this.deps.watch && !this.closed) this.startWatchers();
  }

  /** Re-apply config: stop watchers, rescan enabled sources, restart watchers. */
  private async restart(): Promise<void> {
    await this.ready;
    if (this.closed) return;
    await this.stopWatchers();
    await this.rescan();
    if (this.deps.watch && !this.closed) this.startWatchers();
  }

  private enabledSources(): Set<SourceId> {
    return new Set(this.deps.config.get().enabledSources);
  }

  private scannableAdapters(): SourceAdapter[] {
    const enabled = this.enabledSources();
    return this.deps.adapters.filter((a) => a.kind !== 'link-out' && a.scan && enabled.has(a.id));
  }

  private startWatchers(): void {
    for (const adapter of this.scannableAdapters()) {
      if (!adapter.watch || this.watchers.has(adapter.id)) continue;
      try {
        this.watchers.set(adapter.id, adapter.watch(this.adapterContext, () => void this.queueScan(adapter)));
      } catch (err) {
        this.deps.log.error(`watching ${adapter.id} failed: ${String(err)}`);
      }
    }
  }

  private async stopWatchers(): Promise<void> {
    const stops = [...this.watchers.values()];
    this.watchers.clear();
    // Watch unsubscribers may return a promise (chokidar's close); wait for it.
    await Promise.all(stops.map((stop) => Promise.resolve(stop() as unknown)));
  }

  /** Coalesce watcher-triggered scans: at most one running and one queued per source. */
  private queueScan(adapter: SourceAdapter): Promise<void> {
    const pending = this.scans.get(adapter.id);
    if (pending) {
      pending.again = true;
      return pending.running;
    }
    const slot = { running: Promise.resolve(), again: false };
    slot.running = (async () => {
      do {
        slot.again = false;
        if (this.closed) break;
        const diff = await this.scanSource(adapter);
        this.emitDiff(diff);
      } while (slot.again);
      this.scans.delete(adapter.id);
    })();
    this.scans.set(adapter.id, slot);
    return slot.running;
  }

  /** Scan one adapter and index its candidates (replacing the source's entries). */
  private async scanSource(adapter: SourceAdapter): Promise<IndexDiff> {
    const empty: IndexDiff = { added: [], changed: [], removed: [] };
    if (!adapter.scan) return empty;
    const previous = this.sourceState(adapter.id);
    this.setState(adapter.id, { state: 'indexing', lastRefresh: previous.lastRefresh });
    try {
      const candidates = await adapter.scan(this.adapterContext);
      const { diff } = await this.exclusive(() => this.applyCandidates(adapter.id, candidates, true));
      this.setState(adapter.id, { state: 'idle', lastRefresh: Date.now() });
      return diff;
    } catch (err) {
      this.deps.log.error(`scanning ${adapter.id} failed: ${String(err)}`);
      this.setState(adapter.id, { state: 'error', lastRefresh: previous.lastRefresh, message: String(err) });
      return empty;
    }
  }

  private setState(source: SourceId, state: SourceIndexState): void {
    this.states.set(source, state);
  }

  /** Run `fn` while holding the index lock (one indexing pass at a time). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.catch(() => undefined).then(fn);
    this.lock = run;
    return run;
  }

  private async applyCandidates(
    source: SourceId,
    candidates: IndexCandidate[],
    replaceAll: boolean,
  ): Promise<{ diff: IndexDiff; entries: IndexEntry[] }> {
    const diff: IndexDiff = { added: [], changed: [], removed: [] };
    if (replaceAll) {
      const keep = new Set(candidates.map((c) => keyOf(source, c.absPath)));
      for (const [key, record] of [...this.records]) {
        if (record.source !== source || keep.has(key)) continue;
        const removed = this.removeRecord(key);
        if (removed) diff.removed.push(removed);
      }
    }
    const entries: IndexEntry[] = [];
    const total = candidates.length;
    this.deps.events.emit({ type: 'index.progress', source, done: 0, total });
    for (let i = 0; i < total; i++) {
      const result = await this.processCandidate(source, candidates[i]!, false);
      this.recordResult(result, diff);
      if (result.record.entry) entries.push(result.record.entry);
      if (result.status !== 'unchanged') await yieldToLoop();
      if ((i + 1) % PROGRESS_EVERY === 0 && i + 1 < total) {
        this.deps.events.emit({ type: 'index.progress', source, done: i + 1, total });
      }
    }
    if (total) this.deps.events.emit({ type: 'index.progress', source, done: total, total });
    if (diff.added.length || diff.changed.length || diff.removed.length) await this.saveCache();
    return { diff, entries };
  }

  /** Fold one processed candidate into the diff (an entry that became a non-song is a removal). */
  private recordResult(result: { record: CacheRecord; status: 'added' | 'changed' | 'unchanged'; previousId?: string }, diff: IndexDiff): void {
    const id = result.record.entry?.id;
    if (result.status === 'unchanged') return;
    if (id) (result.status === 'added' ? diff.added : diff.changed).push(id);
    else if (result.previousId) diff.removed.push(result.previousId);
  }

  private async processCandidate(
    source: SourceId,
    candidate: IndexCandidate,
    force: boolean,
  ): Promise<{ record: CacheRecord; status: 'added' | 'changed' | 'unchanged'; previousId?: string }> {
    const key = keyOf(source, candidate.absPath);
    const existing = this.records.get(key);
    const previousId = existing?.entry?.id;
    const midiMtimeMs = await mtimeOrNull(candidate.midiPath);
    const knownId = candidate.id ?? previousId;
    const sidecarMtimeMs = knownId ? await mtimeOrNull(this.sidecarPath(knownId)) : null;
    if (
      !force &&
      existing &&
      existing.candidate.mtimeMs === candidate.mtimeMs &&
      existing.candidate.size === candidate.size &&
      existing.midiMtimeMs === midiMtimeMs &&
      existing.sidecarMtimeMs === sidecarMtimeMs &&
      !isStale(existing.entry)
    ) {
      existing.candidate = candidate;
      return { record: existing, status: 'unchanged' };
    }

    const record: CacheRecord = { source, candidate, midiMtimeMs, sidecarMtimeMs, entry: null, arrangementDifficulty: {} };
    const fileName = basename(candidate.relPath);
    if (candidate.size > LIMITS.importBytes) {
      record.entry = this.errorEntry(source, candidate, knownId ?? `${source}:${sha1Hex(Buffer.from(key)).slice(0, 16)}`, '', 'File is larger than 20 MB');
    } else {
      let data: Uint8Array;
      try {
        data = new Uint8Array(await readFile(candidate.absPath));
      } catch (err) {
        // Vanished between scan and read: drop it; the watcher reports the unlink.
        if (existing) this.removeRecord(key);
        this.deps.log.debug(`skipping unreadable ${candidate.absPath}: ${String(err)}`);
        return { record, status: previousId ? 'changed' : 'unchanged', ...(previousId ? { previousId } : {}) };
      }
      const sha1 = sha1Hex(data);
      const id = this.assignId(source, key, sha1, candidate.id ?? previousId);
      const sidecarMtime = id === knownId ? sidecarMtimeMs : await mtimeOrNull(this.sidecarPath(id));
      record.sidecarMtimeMs = sidecarMtime;
      const bundle = await this.bundleFor(source, candidate, id, data);
      try {
        const a = await this.deps.analyzer.analyze(bundle);
        const entry: IndexEntry = {
          id,
          source,
          path: candidate.relPath,
          fileName,
          format: a.format,
          mtimeMs: candidate.mtimeMs,
          size: candidate.size,
          sha1,
          title: a.title.trim() || fileName.replace(/\.[^.]+$/, ''),
          tracks: a.tracks,
          defaultArrangement: a.defaultArrangement,
          tuning: a.tuning,
          tuningId: a.tuningId,
          tuningLabel: a.tuningLabel,
          capo: a.capo,
          bpm: a.bpm,
          durationSec: a.durationSec,
          rhythm: a.rhythm,
          difficulty: a.difficulty,
          tags: mergeTags(a.tags, candidate.tags),
          hasMidi: !!bundle.midi,
          hasSidecar: !!bundle.sidecar,
        };
        if (a.artist) entry.artist = a.artist;
        if (a.composer) entry.composer = a.composer;
        if (candidate.origin) entry.origin = candidate.origin;
        if (candidate.url) entry.url = candidate.url;
        if (a.error) entry.error = a.error;
        record.entry = entry;
      } catch (err) {
        if (!isSkippableImportError(err, fileName)) {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.log.warn(`indexing ${candidate.absPath} failed: ${message}`);
          record.entry = this.errorEntry(source, candidate, id, sha1, message);
        }
      }
    }

    if (existing) this.removeRecord(key, false);
    this.records.set(key, record);
    if (record.entry) {
      this.keyById.set(record.entry.id, key);
      this.entriesById.set(record.entry.id, record.entry);
      this.search_.upsert(record.entry);
    }
    const status = previousId ? 'changed' : record.entry ? 'added' : 'unchanged';
    return { record, status, ...(previousId ? { previousId } : {}) };
  }

  /** DEC-14 id for new content at `key` (fixed, sticky, moved-file, hash, or path-salted on collision). */
  private assignId(source: SourceId, key: string, sha1: string, sticky: string | undefined): string {
    if (sticky) return sticky;
    const moved = this.removedIds.get(`${source}:${sha1}`);
    const free = (id: string): boolean => {
      const owner = this.keyById.get(id);
      return owner === undefined || owner === key;
    };
    if (moved && free(moved)) return moved;
    const id = `${source}:${sha1.slice(0, 16)}`;
    if (free(id)) return id;
    return `${source}:${createHash('sha1').update(sha1).update('\u0000').update(key).digest('hex').slice(0, 16)}`;
  }

  /** Remove a record; returns the removed entry id. `remember` keeps the id for a moved file. */
  private removeRecord(key: string, remember = true): string | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    this.records.delete(key);
    const entry = record.entry;
    if (!entry) return undefined;
    if (this.keyById.get(entry.id) === key) {
      this.keyById.delete(entry.id);
      this.entriesById.delete(entry.id);
      this.search_.remove(entry.id);
    }
    if (remember && entry.sha1) {
      this.removedIds.set(`${record.source}:${entry.sha1}`, entry.id);
      if (this.removedIds.size > REMOVED_ID_MEMORY) this.removedIds.delete(this.removedIds.keys().next().value!);
    }
    return entry.id;
  }

  private recordOf(id: string): CacheRecord | undefined {
    const key = this.keyById.get(id);
    return key === undefined ? undefined : this.records.get(key);
  }

  private async readSidecar(id: string): Promise<RhythmSidecar | null> {
    return asSidecar(await readJsonFile(this.sidecarPath(id)));
  }

  private async bundleFor(source: SourceId, candidate: IndexCandidate, id: string, data: Uint8Array): Promise<SongBundle> {
    const ref: SourceRef = { source, path: candidate.relPath };
    if (candidate.url) ref.url = candidate.url;
    if (candidate.origin) ref.origin = candidate.origin;
    const bundle: SongBundle = { fileName: basename(candidate.relPath), data, id, source: ref };
    if (candidate.tags) bundle.tags = candidate.tags;
    if (candidate.midiPath) {
      try {
        bundle.midi = { fileName: basename(candidate.midiPath), data: new Uint8Array(await readFile(candidate.midiPath)) };
      } catch {
        // Paired MIDI vanished: index without it.
      }
    }
    const sidecar = await this.readSidecar(id);
    if (sidecar) bundle.sidecar = sidecar;
    return bundle;
  }

  private errorEntry(source: SourceId, candidate: IndexCandidate, id: string, sha1: string, message: string): IndexEntry {
    const fileName = basename(candidate.relPath);
    const format = FORMAT_BY_EXT[lowerExt(fileName)] ?? 'alphatex';
    const entry: IndexEntry = {
      id,
      source,
      path: candidate.relPath,
      fileName,
      format,
      mtimeMs: candidate.mtimeMs,
      size: candidate.size,
      sha1,
      title: fileName.replace(/\.[^.]+$/, ''),
      tracks: [],
      defaultArrangement: -1,
      tuning: [],
      tuningId: 'unknown',
      tuningLabel: 'Unknown',
      capo: 0,
      bpm: null,
      durationSec: 0,
      rhythm: format === 'ascii' ? 'needs-alignment' : 'exact',
      difficulty: null,
      tags: mergeTags(candidate.tags),
      hasMidi: !!candidate.midiPath,
      hasSidecar: false,
      error: message,
    };
    if (candidate.origin) entry.origin = candidate.origin;
    if (candidate.url) entry.url = candidate.url;
    return entry;
  }

  private emitDiff(diff: IndexDiff): void {
    const reasons = [
      ['added', diff.added],
      ['changed', diff.changed],
      ['removed', diff.removed],
    ] as const;
    for (const [reason, ids] of reasons) {
      if (ids.length) this.deps.events.emit({ type: 'library.changed', ids: [...ids], reason });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Cache
  // ---------------------------------------------------------------------------------------------

  private async loadCache(): Promise<void> {
    const raw = await readJsonFile(this.deps.paths.indexFile);
    if (!isRecord(raw) || raw.schema !== INDEX_SCHEMA || raw.version !== INDEX_VERSION || !Array.isArray(raw.records)) return;
    for (const r of raw.records as CacheRecord[]) {
      if (!isRecord(r) || typeof r.source !== 'string' || !isRecord(r.candidate) || typeof r.candidate.absPath !== 'string') continue;
      const key = keyOf(r.source, r.candidate.absPath);
      const record: CacheRecord = { ...r, arrangementDifficulty: r.arrangementDifficulty ?? {} };
      this.records.set(key, record);
      if (record.entry) {
        this.keyById.set(record.entry.id, key);
        this.entriesById.set(record.entry.id, record.entry);
        this.search_.upsert(record.entry);
      }
    }
  }

  /** Persist the cache (writes are serialised; the latest state wins). */
  private saveCache(): Promise<void> {
    const file: CacheFile = { schema: INDEX_SCHEMA, version: INDEX_VERSION, records: [...this.records.values()] };
    this.cacheWrite = this.cacheWrite
      .catch(() => undefined)
      .then(() => writeJsonFile(this.deps.paths.indexFile, file))
      .catch((err: unknown) => this.deps.log.error(`writing ${this.deps.paths.indexFile} failed: ${String(err)}`));
    return this.cacheWrite;
  }
}
