/**
 * Conditional, size-capped, retried download of the ClassTab zip (docs/sources/classtab.md § Access).
 * One file, one request per attempt; `304 Not Modified` means nothing changed. Network errors, `429`
 * and `5xx` are retried after at least {@link MIN_RETRY_DELAY_MS} (the site's crawl delay), doubling,
 * honouring a longer `Retry-After` up to five minutes.
 * @module
 */
import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { CLASSTAB_USER_AGENT, MIN_RETRY_DELAY_MS } from './layout';

/** A server asking us to wait longer than this (`Retry-After`) ends the refresh instead. */
const MAX_RETRY_WAIT_MS = 5 * 60 * 1000;

/** Validators from the previous download (null when there is none, or the files are gone). */
export interface ConditionalHeaders {
  etag: string | null;
  lastModified: string | null;
}

/** Options for {@link downloadZip}. */
export interface DownloadOptions {
  url: string;
  /** Final zip path; written through a temp file in the same folder and renamed on success. */
  dest: string;
  conditional: ConditionalHeaders | null;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Total attempts (≥ 1). */
  attempts: number;
  /** Delay before the first retry; raised to {@link MIN_RETRY_DELAY_MS} if lower. */
  retryDelayMs: number;
  /** Abort when the body exceeds this many bytes. */
  maxBytes: number;
  timeoutMs: number;
  onProgress?: (bytes: number, totalBytes: number | undefined) => void;
  /** Called before each retry (logging). */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

/** Outcome of {@link downloadZip}. */
export type DownloadResult =
  | { status: 'not-modified' }
  | { status: 'downloaded'; bytes: number; etag: string | null; lastModified: string | null };

/** A download failure; `retryable` failures are retried by {@link downloadZip}. */
export class DownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** Server-requested delay (`Retry-After`, ms), if any. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** Parse `Retry-After` (seconds or an HTTP date) into ms; undefined when absent or invalid. */
function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** One attempt: request, then stream the body to `tmp`. */
async function attempt(opts: DownloadOptions, tmp: string): Promise<DownloadResult> {
  const headers: Record<string, string> = { 'user-agent': CLASSTAB_USER_AGENT, accept: 'application/zip, */*;q=0.1' };
  if (opts.conditional?.etag) headers['if-none-match'] = opts.conditional.etag;
  if (opts.conditional?.lastModified) headers['if-modified-since'] = opts.conditional.lastModified;
  let res: Response;
  try {
    res = await opts.fetch(opts.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (err) {
    throw new DownloadError(`Request failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  if (res.status === 304) {
    await res.body?.cancel();
    return { status: 'not-modified' };
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    const retryable = res.status === 429 || res.status >= 500;
    throw new DownloadError(`HTTP ${res.status} from ${opts.url}`, retryable, retryAfterMs(res.headers.get('retry-after')));
  }
  const declared = Number(res.headers.get('content-length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;
  if (total !== undefined && total > opts.maxBytes) {
    await res.body?.cancel();
    throw new DownloadError(`The zip is ${total} bytes, above the ${opts.maxBytes}-byte limit`, false);
  }
  if (!res.body) throw new DownloadError('Empty response body', true);

  let bytes = 0;
  const file = await open(tmp, 'w');
  try {
    for await (const chunk of res.body) {
      bytes += chunk.byteLength;
      if (bytes > opts.maxBytes) {
        await res.body.cancel().catch(() => undefined);
        throw new DownloadError(`The zip exceeds the ${opts.maxBytes}-byte limit`, false);
      }
      await file.write(chunk);
      opts.onProgress?.(bytes, total);
    }
  } catch (err) {
    if (err instanceof DownloadError) throw err;
    throw new DownloadError(`Download interrupted: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    await file.close();
  }
  // `fetch` decodes a content-encoding, so the declared length only applies to an identity body.
  if (total !== undefined && !res.headers.get('content-encoding') && bytes !== total) throw new DownloadError(`Download truncated (${bytes} of ${total} bytes)`, true);
  return { status: 'downloaded', bytes, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
}

/**
 * Download `opts.url` to `opts.dest` with a conditional GET (`If-None-Match` / `If-Modified-Since`
 * from `opts.conditional`). Returns `not-modified` on `304` (nothing written). Retries retryable
 * failures with a doubling delay of at least {@link MIN_RETRY_DELAY_MS}; throws the last
 * {@link DownloadError} when every attempt fails. `dest` is replaced only after a complete body.
 */
export async function downloadZip(opts: DownloadOptions): Promise<DownloadResult> {
  const tmp = `${opts.dest}.${process.pid}.${randomBytes(4).toString('hex')}.part`;
  let delay = Math.max(MIN_RETRY_DELAY_MS, opts.retryDelayMs);
  try {
    for (let i = 1; ; i++) {
      try {
        const result = await attempt(opts, tmp);
        if (result.status === 'downloaded') await rename(tmp, opts.dest);
        return result;
      } catch (err) {
        const failure = err instanceof DownloadError ? err : new DownloadError(String(err), false);
        const wait = Math.max(delay, failure.retryAfterMs ?? 0);
        if (!failure.retryable || i >= opts.attempts || wait > MAX_RETRY_WAIT_MS) throw failure;
        opts.onRetry?.(i, wait, failure.message);
        await opts.sleep(wait);
        delay *= 2;
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
}
