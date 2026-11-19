/**
 * Safe streaming extraction of the ClassTab zip with yauzl (docs/sources/classtab.md § Layout).
 *
 * Guards: entry names are validated by us (absolute paths, drive letters, `..` segments, NUL and
 * control characters are **rejected** and reported, never written); only `.txt` / `.mid` files are
 * kept, flattened to their base name inside the destination; symlinks, encrypted and
 * undecodable entries are skipped; entry count, per-entry size and total size are capped (yauzl
 * also verifies every entry's actual size against its header). Files are created with `wx`
 * (never follow or overwrite) and keep the zip's modification time, so unchanged files stay
 * cached in the library index across monthly updates. Nothing is ever executed.
 * @module
 */
import { createWriteStream } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { isInside, lowerExt } from '../../fs-safety';
import { KEPT_EXTENSIONS, README_NAME } from './layout';

/** Extraction limits (see `CLASSTAB_LIMITS`). */
export interface ExtractLimits {
  entries: number;
  entryBytes: number;
  totalBytes: number;
}

/** What {@link extractClassTabZip} did. */
export interface ExtractResult {
  /** `.txt` files written (the readme excluded). */
  tabs: number;
  midis: number;
  /** Uncompressed bytes written. */
  bytes: number;
  /** Entries with a kept extension that were skipped (too big, duplicate name, encrypted, symlink…). */
  skipped: string[];
  /** Entry names refused as unsafe (zip-slip and friends). */
  rejected: string[];
}

/** Thrown when the archive as a whole is unacceptable (too many entries, too large, corrupt). */
export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

/** Longest base name we write (bytes of UTF-8). */
const MAX_NAME_BYTES = 200;
/** Unix file-type bits of an entry's external attributes, and the symlink type. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Why an entry name is unsafe, or null when it is acceptable (the name is `/`-separated). */
export function unsafeEntryReason(name: string): string | null {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we refuse
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control character in name';
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return 'absolute path';
  if (name.split('/').includes('..')) return 'parent-directory segment';
  return null;
}

/** Counts bytes through a stream and fails once they exceed `max`. */
function sizeGuard(max: number, onBytes: (n: number) => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      seen += chunk.length;
      if (seen > max) return cb(new ExtractError(`entry exceeds ${max} bytes`));
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
}

/**
 * Extract the kept files of `zipPath` into the existing, empty folder `destDir` (flat). Unsafe
 * entries are refused (listed in `rejected`); oversize or odd entries are skipped (listed in
 * `skipped`); an archive over the entry or total-size limits throws {@link ExtractError}.
 */
export async function extractClassTabZip(
  zipPath: string,
  destDir: string,
  limits: ExtractLimits,
  onProgress?: (done: number, total: number) => void,
): Promise<ExtractResult> {
  let zip: yauzl.ZipFile;
  try {
    // decodeStrings: false so a hostile name is reported per entry instead of aborting the archive.
    zip = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true });
  } catch (err) {
    throw new ExtractError(`Not a readable zip: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result: ExtractResult = { tabs: 0, midis: 0, bytes: 0, skipped: [], rejected: [] };
  const seen = new Set<string>();
  let declaredTotal = 0;
  let done = 0;
  try {
    if (zip.entryCount > limits.entries) throw new ExtractError(`The zip has ${zip.entryCount} entries (limit ${limits.entries})`);
    for await (const entry of zip.eachEntry()) {
      done++;
      if (done % 250 === 0) onProgress?.(done, zip.entryCount);
      const name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false);
      if (name.endsWith('/')) continue; // directory
      const unsafe = unsafeEntryReason(name);
      if (unsafe) {
        result.rejected.push(`${name} (${unsafe})`);
        continue;
      }
      const base = name.slice(name.lastIndexOf('/') + 1);
      const ext = lowerExt(base);
      if (!KEPT_EXTENSIONS.includes(ext)) continue;
      if (base.startsWith('.') || Buffer.byteLength(base) > MAX_NAME_BYTES || /[<>:"|?*]/.test(base)) {
        result.rejected.push(`${name} (unsupported file name)`);
        continue;
      }
      const skip = (why: string): void => void result.skipped.push(`${name} (${why})`);
      if (((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) {
        skip('symlink');
        continue;
      }
      if (entry.isEncrypted() || !entry.canDecodeFileData()) {
        skip('encrypted or unsupported compression');
        continue;
      }
      if (entry.uncompressedSize > limits.entryBytes) {
        skip(`larger than ${limits.entryBytes} bytes`);
        continue;
      }
      const key = base.toLowerCase(); // case-insensitive file systems (macOS) would collide
      if (seen.has(key)) {
        skip('duplicate name');
        continue;
      }
      declaredTotal += entry.uncompressedSize;
      if (declaredTotal > limits.totalBytes) throw new ExtractError(`The zip unpacks to more than ${limits.totalBytes} bytes`);
      const target = join(destDir, base);
      if (!isInside(destDir, target)) {
        result.rejected.push(`${name} (escapes the destination)`);
        continue;
      }
      seen.add(key);
      const stream = await zip.openReadStreamPromise(entry);
      await pipeline(
        stream,
        sizeGuard(limits.entryBytes, (n) => (result.bytes += n)),
        createWriteStream(target, { flags: 'wx', mode: 0o644 }),
      );
      const mtime = entry.getLastModDate();
      if (Number.isFinite(mtime.getTime())) await utimes(target, mtime, mtime);
      if (ext === '.mid') result.midis++;
      else if (key !== README_NAME) result.tabs++;
    }
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError(`Extraction failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    zip.close();
  }
  onProgress?.(done, zip.entryCount);
  return result;
}
