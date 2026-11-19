/**
 * Test helpers for T-025: an in-test zip writer (so hostile entry names can be crafted), a local
 * HTTP server that serves a zip with ETag / Last-Modified and honours conditional requests, and the
 * synthetic ClassTab-style fixtures (D2: authored by us; nothing from classtab.org).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/** One zip entry. `data: null` makes a directory entry. */
export interface ZipEntrySpec {
  name: string;
  data: Uint8Array | string | null;
  /** Store instead of deflate. */
  store?: boolean;
  /** Modification time (DOS precision: 2 s). Default 2026-11-01 20:06:34 local. */
  mtime?: Date;
  /** Unix mode in the external attributes (e.g. `0o120777` for a symlink). */
  unixMode?: number;
  /** Declare this uncompressed size instead of the real one (lying headers). */
  declaredSize?: number;
}

const DEFAULT_MTIME = new Date(2026, 10, 1, 20, 6, 34);

function dosDateTime(d: Date): { date: number; time: number } {
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

/** Build a zip archive (no zip64, no encryption) from entry specs. */
export function buildZip(entries: readonly ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = e.data === null ? Buffer.alloc(0) : Buffer.from(typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data);
    const method = e.data === null || e.store ? 0 : 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw) >>> 0;
    const size = e.declaredSize ?? raw.length;
    const { date, time } = dosDateTime(e.mtime ?? DEFAULT_MTIME);
    const flags = 0x800; // UTF-8 names

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.unixMode ?? (e.data === null ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Folder of the synthetic ClassTab-style fixtures (T-012). */
export const SYNTHETIC_DIR = join(import.meta.dirname, '..', 'fixtures', 'classtab-synthetic');

/** The synthetic `.txt` / `.mid` files as zip entries under `classtab/` (like the real zip). */
export function syntheticEntries(): ZipEntrySpec[] {
  return readdirSync(SYNTHETIC_DIR)
    .filter((n) => /\.(txt|mid)$/.test(n))
    .sort()
    .map((n) => ({ name: `classtab/${n}`, data: readFileSync(join(SYNTHETIC_DIR, n)) }));
}

/** One request seen by {@link startZipServer}. */
export interface SeenRequest {
  method: string;
  headers: IncomingHttpHeaders;
  status: number;
}

/** A local zip server. */
export interface ZipServer {
  url: string;
  requests: SeenRequest[];
  /** Replace the served zip (new ETag / Last-Modified). */
  setZip(zip: Buffer, lastModified?: Date): void;
  /** Answer the next `n` requests with `status` (e.g. 503) before serving normally. */
  failNext(n: number, status: number, headers?: Record<string, string>): void;
  close(): Promise<void>;
}

/** Start an HTTP server on 127.0.0.1 serving one zip at `/zip/classtab.zip`, Apache-style validators. */
export async function startZipServer(zip: Buffer, lastModified = new Date('2026-11-01T20:06:35Z')): Promise<ZipServer> {
  let body = zip;
  let modified = lastModified;
  let version = 1;
  let failures: { n: number; status: number; headers: Record<string, string> } = { n: 0, status: 0, headers: {} };
  const requests: SeenRequest[] = [];
  const etag = (): string => `"${body.length.toString(16)}-${version}"`;
  const server: Server = createServer((req, res) => {
    const record = (status: number): void => void requests.push({ method: req.method ?? '', headers: req.headers, status });
    if (req.url !== '/zip/classtab.zip') {
      record(404);
      res.writeHead(404).end();
      return;
    }
    if (failures.n > 0) {
      failures.n--;
      record(failures.status);
      res.writeHead(failures.status, failures.headers).end();
      return;
    }
    const lm = modified.toUTCString();
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    const notModified = inm !== undefined ? inm === etag() : ims !== undefined && Date.parse(ims) >= Math.floor(modified.getTime() / 1000) * 1000;
    if (notModified) {
      record(304);
      res.writeHead(304, { etag: etag(), 'last-modified': lm }).end();
      return;
    }
    record(200);
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length, etag: etag(), 'last-modified': lm });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/zip/classtab.zip`,
    requests,
    setZip(zipNext, lm = new Date(modified.getTime() + 86_400_000)) {
      body = zipNext;
      modified = lm;
      version++;
    },
    failNext(n, status, headers = {}) {
      failures = { n, status, headers };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A temp folder with cleanup. */
export function tempDir(prefix = 'riffway-classtab-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A `sleep` that records the requested delays and resolves at once. */
export function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: (ms) => (delays.push(ms), Promise.resolve()) };
}
