import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadError, downloadZip, type DownloadOptions } from '../../server/sources/classtab/download';
import { CLASSTAB_USER_AGENT, MIN_RETRY_DELAY_MS } from '../../server/sources/classtab/layout';
import { buildZip, fakeSleep, startZipServer, tempDir, type ZipServer } from './helpers';

describe('downloadZip', () => {
  let tmp: ReturnType<typeof tempDir>;
  let server: ZipServer;
  let sleeper: ReturnType<typeof fakeSleep>;
  const zip = buildZip([{ name: 'classtab/a.txt', data: 'tab' }]);

  beforeEach(async () => {
    tmp = tempDir();
    server = await startZipServer(zip);
    sleeper = fakeSleep();
  });
  afterEach(async () => {
    await server.close();
    tmp.cleanup();
  });

  const opts = (over: Partial<DownloadOptions> = {}): DownloadOptions => ({
    url: server.url,
    dest: join(tmp.dir, 'classtab.zip'),
    conditional: null,
    fetch,
    sleep: sleeper.sleep,
    attempts: 3,
    retryDelayMs: MIN_RETRY_DELAY_MS,
    maxBytes: 1024 * 1024,
    timeoutMs: 10_000,
    ...over,
  });

  it('downloads with the polite User-Agent, then a conditional GET answers 304 and writes nothing', async () => {
    const first = await downloadZip(opts());
    expect(first).toMatchObject({ status: 'downloaded', bytes: zip.length });
    if (first.status !== 'downloaded') throw new Error('unreachable');
    expect(first.etag).toMatch(/^".+"$/);
    expect(first.lastModified).toBe('Sun, 01 Nov 2026 20:06:35 GMT');
    expect(Buffer.compare(readFileSync(join(tmp.dir, 'classtab.zip')), zip)).toBe(0);
    expect(server.requests[0]!.headers['user-agent']).toBe(CLASSTAB_USER_AGENT);
    expect(server.requests[0]!.headers['if-none-match']).toBeUndefined();

    const second = await downloadZip(opts({ dest: join(tmp.dir, 'second.zip'), conditional: { etag: first.etag, lastModified: first.lastModified } }));
    expect(second).toEqual({ status: 'not-modified' });
    expect(server.requests[1]).toMatchObject({ status: 304 });
    expect(server.requests[1]!.headers['if-none-match']).toBe(first.etag);
    expect(server.requests[1]!.headers['if-modified-since']).toBe(first.lastModified);
    expect(existsSync(join(tmp.dir, 'second.zip'))).toBe(false);
    expect(readdirSync(tmp.dir)).toEqual(['classtab.zip']); // no temp file left behind
  });

  it('honours If-Modified-Since alone (no ETag stored)', async () => {
    const res = await downloadZip(opts({ conditional: { etag: null, lastModified: 'Sun, 01 Nov 2026 20:06:35 GMT' } }));
    expect(res.status).toBe('not-modified');
  });

  it('retries 503 and network errors after at least 10 s, doubling', async () => {
    server.failNext(2, 503);
    const res = await downloadZip(opts({ retryDelayMs: 1 }));
    expect(res.status).toBe('downloaded');
    expect(server.requests.map((r) => r.status)).toEqual([503, 503, 200]);
    expect(sleeper.delays).toEqual([10_000, 20_000]);

    let calls = 0;
    const flaky: typeof fetch = (input, init) => (++calls === 1 ? Promise.reject(new TypeError('ECONNRESET')) : fetch(input, init));
    const again = await downloadZip(opts({ fetch: flaky, dest: join(tmp.dir, 'b.zip') }));
    expect(again.status).toBe('downloaded');
    expect(calls).toBe(2);
  });

  it('waits for a longer Retry-After and gives up after the last attempt', async () => {
    server.failNext(1, 429, { 'retry-after': '30' });
    await downloadZip(opts());
    expect(sleeper.delays).toEqual([30_000]);

    server.failNext(5, 500);
    await expect(downloadZip(opts())).rejects.toThrow(/HTTP 500/);
    expect(sleeper.delays).toEqual([30_000, 10_000, 20_000]);
  });

  it('does not retry client errors and never writes the destination on failure', async () => {
    await expect(downloadZip(opts({ url: server.url.replace('classtab.zip', 'missing.zip') }))).rejects.toMatchObject({
      name: 'DownloadError',
      retryable: false,
    });
    expect(sleeper.delays).toEqual([]);
    expect(readdirSync(tmp.dir)).toEqual([]);
  });

  it('refuses bodies over the size cap (declared or streamed)', async () => {
    await expect(downloadZip(opts({ maxBytes: 10 }))).rejects.toThrow(DownloadError);
    const noLength: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      return new Response(res.body, { status: 200, headers: { etag: '"x"' } });
    };
    await expect(downloadZip(opts({ fetch: noLength, maxBytes: 10 }))).rejects.toThrow(/exceeds/);
    expect(readdirSync(tmp.dir)).toEqual([]);
  });
});
