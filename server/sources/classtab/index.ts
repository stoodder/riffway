/**
 * ClassTab source adapter (T-025); terms and approach in `docs/sources/classtab.md` (D2).
 *
 * `refresh` downloads the whole-site zip with a conditional GET (once per day unless forced),
 * extracts only `.txt` / `.mid` safely into `<dataDir>/classtab/files/`, and indexes the tabs with
 * their paired MIDI (T-012 pairing) through `ctx.indexFiles`. `scan` re-lists the extracted files at
 * server start; `watch` notices a refresh done by `npm run classtab:refresh` in another process.
 * Every entry is tagged `fingerstyle` + `classical` (filterable, never hidden). Nothing from
 * ClassTab is committed or redistributed.
 * @module
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, watch as fsWatch } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClassTabStatus, ServerEvent } from '@shared/api';
import type { AdapterContext, IndexEntry, RefreshOptions, RefreshResult, SourceAdapter, SourceStatus } from '@shared/sources';
import { downloadZip } from './download';
import { extractClassTabZip } from './extract';
import {
  CLASSTAB_LIMITS,
  CLASSTAB_ZIP_URL,
  DOWNLOAD_ATTEMPTS,
  DOWNLOAD_TIMEOUT_MS,
  MIN_RETRY_DELAY_MS,
  REFRESH_INTERVAL_MS,
  classTabLayout,
} from './layout';
import { scanClassTab } from './scan';
import { readClassTabState, writeClassTabState, type ClassTabState } from './state';

export { CLASSTAB_TAGS, CLASSTAB_USER_AGENT, CLASSTAB_ZIP_URL, classTabLayout } from './layout';

/** Options (tests point `url` at a local server and inject `sleep`). */
export interface ClassTabAdapterOptions {
  /** Zip URL. Default {@link CLASSTAB_ZIP_URL}. */
  url?: string;
  /** `fetch` implementation. Default the global `fetch`. */
  fetch?: typeof fetch;
  /** Wait between retries. Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock (epoch ms). Default `Date.now`. */
  now?: () => number;
  /** Download attempts. Default 3. */
  attempts?: number;
  /** First retry delay (never below 10 s). */
  retryDelayMs?: number;
  /** Size limits (defaults: `CLASSTAB_LIMITS`). */
  limits?: Partial<typeof CLASSTAB_LIMITS>;
  /** Quiet period of the `state.json` watcher (ms). Default 500. */
  debounceMs?: number;
}

/** The ClassTab adapter: a download `SourceAdapter` plus what the ClassTab routes need. */
export interface ClassTabAdapter extends SourceAdapter {
  refresh(ctx: AdapterContext, opts: RefreshOptions): Promise<RefreshResult>;
  /** Why a refresh would not start now (already running, checked within a day), or null. */
  refreshBlocker(ctx: AdapterContext, opts: RefreshOptions): Promise<string | null>;
  isRefreshing(): boolean;
  /** `GET /api/classtab/status`. */
  classtabStatus(ctx: AdapterContext): Promise<ClassTabStatus>;
}

/** True for the adapter created by {@link createClassTabAdapter}. */
export function isClassTabAdapter(adapter: SourceAdapter): adapter is ClassTabAdapter {
  const a = adapter as Partial<ClassTabAdapter>;
  return adapter.id === 'classtab' && typeof a.classtabStatus === 'function' && typeof a.refreshBlocker === 'function';
}

/** Tabs per rhythm status (`ClassTabStatus.rhythm`); user-aligned tabs count in none of them. */
export function rhythmCounts(entries: readonly IndexEntry[]): ClassTabStatus['rhythm'] {
  const out = { midi: 0, ruler: 0, needsAlignment: 0 };
  for (const e of entries) {
    if (e.source !== 'classtab') continue;
    if (e.rhythm === 'midi') out.midi++;
    else if (e.rhythm === 'ruler') out.ruler++;
    else if (e.rhythm === 'needs-alignment') out.needsAlignment++;
  }
  return out;
}

const isDir = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Emit progress at most every this many downloaded bytes. */
const PROGRESS_BYTES = 512 * 1024;
/** Unsafe/skipped entry names quoted in the log. */
const LOG_NAMES = 5;

/** Create the ClassTab adapter. */
export function createClassTabAdapter(opts: ClassTabAdapterOptions = {}): ClassTabAdapter {
  const url = opts.url ?? CLASSTAB_ZIP_URL;
  const now = opts.now ?? Date.now;
  const limits = { ...CLASSTAB_LIMITS, ...opts.limits };
  let running: Promise<RefreshResult> | null = null;
  /** `lastDownload` of the corpus this process has indexed (watcher de-duplication). */
  let knownDownload: number | null = null;

  /** Reason to skip under the once-per-day rule, or null. */
  const dueBlocker = (state: ClassTabState, haveFiles: boolean, force: boolean): string | null => {
    if (force || !haveFiles || state.lastRefresh === null) return null;
    const age = now() - state.lastRefresh;
    if (age < 0 || age >= REFRESH_INTERVAL_MS) return null;
    const hours = Math.max(1, Math.round(age / 3_600_000));
    return `Checked ${hours} h ago; ClassTab updates monthly, so refresh is limited to once a day (force to check again)`;
  };

  const run = async (ctx: AdapterContext, force: boolean): Promise<RefreshResult> => {
    const layout = classTabLayout(ctx.dataDir);
    const emit = (phase: Extract<ServerEvent, { type: 'classtab.progress' }>['phase'], extra: { bytes?: number; totalBytes?: number; message?: string } = {}): void =>
      ctx.emit({ type: 'classtab.progress', phase, ...extra });
    const state = await readClassTabState(layout.state);
    const haveFiles = await isDir(layout.files);
    const blocked = dueBlocker(state, haveFiles, force);
    if (blocked) {
      emit('done', { message: blocked });
      return { status: 'skipped', message: blocked };
    }
    emit('checking');
    try {
      await mkdir(layout.root, { recursive: true });
      let lastEmitted = 0;
      const dl = await downloadZip({
        url,
        dest: layout.zip,
        conditional: haveFiles && (state.etag || state.lastModified) ? { etag: state.etag, lastModified: state.lastModified } : null,
        fetch: opts.fetch ?? fetch,
        sleep: opts.sleep ?? ((ms) => delay(ms)),
        attempts: opts.attempts ?? DOWNLOAD_ATTEMPTS,
        retryDelayMs: opts.retryDelayMs ?? MIN_RETRY_DELAY_MS,
        maxBytes: limits.zipBytes,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        onProgress: (bytes, totalBytes) => {
          if (bytes - lastEmitted < PROGRESS_BYTES && bytes !== totalBytes) return;
          lastEmitted = bytes;
          emit('downloading', totalBytes === undefined ? { bytes } : { bytes, totalBytes });
        },
        onRetry: (attempt, waitMs, reason) => ctx.log.warn(`classtab: attempt ${attempt} failed (${reason}); retrying in ${Math.round(waitMs / 1000)} s`),
      });
      const checkedAt = now();
      if (dl.status === 'not-modified') {
        const next: ClassTabState = { ...state, lastRefresh: checkedAt };
        delete next.error;
        await writeClassTabState(layout.state, next);
        const message = 'ClassTab has not changed since the last download';
        emit('not-modified', { message });
        return { status: 'not-modified', message };
      }

      emit('extracting');
      const tmp = join(layout.root, `files.tmp-${randomBytes(4).toString('hex')}`);
      await mkdir(tmp);
      let extracted;
      try {
        extracted = await extractClassTabZip(layout.zip, tmp, limits);
        if (extracted.tabs === 0) throw new Error('The download holds no tabs; keeping the previous files');
      } catch (err) {
        await rm(tmp, { recursive: true, force: true });
        throw err;
      }
      if (extracted.rejected.length) {
        ctx.log.warn(`classtab: refused ${extracted.rejected.length} unsafe zip entries: ${extracted.rejected.slice(0, LOG_NAMES).join(', ')}`);
      }
      if (extracted.skipped.length) {
        ctx.log.info(`classtab: skipped ${extracted.skipped.length} zip entries: ${extracted.skipped.slice(0, LOG_NAMES).join(', ')}`);
      }
      const old = join(layout.root, `files.old-${randomBytes(4).toString('hex')}`);
      if (haveFiles) await rename(layout.files, old);
      await rename(tmp, layout.files);
      if (haveFiles) await rm(old, { recursive: true, force: true });

      const next: ClassTabState = {
        schema: 1,
        etag: dl.etag,
        lastModified: dl.lastModified,
        lastRefresh: checkedAt,
        lastDownload: checkedAt,
        zipBytes: dl.bytes,
        tabs: extracted.tabs,
        midis: extracted.midis,
      };
      knownDownload = checkedAt;
      await writeClassTabState(layout.state, next);

      emit('indexing');
      const scanned = await scanClassTab(layout.files, layout.pairs);
      const entries = await ctx.indexFiles('classtab', scanned.candidates, { replaceAll: true });
      const r = rhythmCounts(entries);
      const message =
        `${scanned.tabs} tabs, ${scanned.midis} MIDI files: ${scanned.paired} paired with MIDI; ` +
        `rhythm from MIDI ${r.midi}, beat ruler ${r.ruler}, needs alignment ${r.needsAlignment}`;
      ctx.log.info(`classtab: ${message}`);
      emit('done', { message });
      return { status: 'updated', message };
    } catch (err) {
      const message = errorMessage(err);
      ctx.log.error(`classtab refresh failed: ${message}`);
      await writeClassTabState(layout.state, { ...(await readClassTabState(layout.state)), error: message }).catch(() => undefined);
      emit('error', { message });
      return { status: 'error', message };
    }
  };

  const adapter: ClassTabAdapter = {
    id: 'classtab',
    displayName: 'ClassTab',
    kind: 'download',
    termsDoc: 'docs/sources/classtab.md',

    async init(ctx) {
      knownDownload = (await readClassTabState(classTabLayout(ctx.dataDir).state)).lastDownload;
    },

    async scan(ctx) {
      const layout = classTabLayout(ctx.dataDir);
      return (await scanClassTab(layout.files, layout.pairs)).candidates;
    },

    watch(ctx, onChange) {
      const layout = classTabLayout(ctx.dataDir);
      mkdirSync(layout.root, { recursive: true });
      let timer: NodeJS.Timeout | undefined;
      const check = async (): Promise<void> => {
        timer = undefined;
        const { lastDownload } = await readClassTabState(layout.state);
        if (lastDownload === knownDownload || running) return;
        knownDownload = lastDownload;
        onChange([layout.files]);
      };
      const watcher = fsWatch(layout.root, (_event, file) => {
        if (file !== 'state.json') return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void check(), opts.debounceMs ?? 500);
      });
      watcher.on('error', (err) => ctx.log.warn(`classtab watcher: ${String(err)}`));
      return () => {
        if (timer) clearTimeout(timer);
        watcher.close();
      };
    },

    refresh(ctx, refreshOpts) {
      if (running) return Promise.resolve({ status: 'skipped', message: 'A ClassTab refresh is already running' });
      const current = run(ctx, !!refreshOpts.force).finally(() => {
        running = null;
      });
      running = current;
      return current;
    },

    async refreshBlocker(ctx, refreshOpts) {
      if (running) return 'A ClassTab refresh is already running';
      const layout = classTabLayout(ctx.dataDir);
      return dueBlocker(await readClassTabState(layout.state), await isDir(layout.files), !!refreshOpts.force);
    },

    isRefreshing: () => running !== null,

    async classtabStatus(ctx) {
      const layout = classTabLayout(ctx.dataDir);
      const state = await readClassTabState(layout.state);
      const haveFiles = await isDir(layout.files);
      const status: ClassTabStatus = {
        state: running ? 'refreshing' : state.error ? 'error' : haveFiles ? 'ready' : 'not-downloaded',
        lastRefresh: state.lastRefresh,
        etag: state.etag,
        lastModified: state.lastModified,
        tabs: haveFiles ? state.tabs : 0,
        midis: haveFiles ? state.midis : 0,
        rhythm: rhythmCounts(ctx.entries()),
      };
      if (state.error) status.error = state.error;
      return status;
    },

    async status(ctx) {
      const s = await adapter.classtabStatus(ctx);
      const out: SourceStatus = {
        id: adapter.id,
        displayName: adapter.displayName,
        kind: adapter.kind,
        enabled: true,
        indexed: 0,
        lastRefresh: s.lastRefresh,
        state: s.state === 'ready' ? 'idle' : s.state,
        termsDoc: adapter.termsDoc,
      };
      if (s.state === 'error') out.message = s.error ?? 'The last refresh failed';
      else if (s.state === 'not-downloaded') out.message = 'Not downloaded yet: run `npm run classtab:refresh` or refresh in Settings';
      else if (s.state === 'ready') out.message = `${s.tabs} tabs, ${s.midis} MIDI files`;
      return out;
    },
  };
  return adapter;
}
