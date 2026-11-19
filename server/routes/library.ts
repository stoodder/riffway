/**
 * `POST /api/library/import` (multipart, field `files`) and `POST /api/library/rescan` (T-017).
 *
 * Import (docs/sources/local-folder.md § Drag-and-drop import): per file, the name is validated
 * (names carrying a path are rejected) and sanitised, the extension must be allowlisted, the size is
 * capped at `LIMITS.importBytes`, identical content (sha1) already in the library is reported as a
 * duplicate, and a name collision gets ` (2)`, ` (3)`, …. Files stream to a hidden temp file in the
 * target folder and are renamed into place; indexing is left to the watcher.
 * @module
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { LIMITS, type ImportFileResult, type ImportResponse, type RescanResponse } from '@shared/api';
import { isInside, normalizeSubfolder, sanitizeUploadName, toPosix } from '../fs-safety';
import { sendError } from '../http';
import type { RouteModule } from '../types';

/** Most files accepted in one import request. */
export const MAX_IMPORT_FILES = 100;
/** Give up on ` (n)` suffixes after this many collisions. */
const MAX_COLLISIONS = 999;

const sha1Of = (data: Uint8Array): string => createHash('sha1').update(data).digest('hex');

/** Discard the rest of a part we are not keeping (the multipart parser needs it consumed). */
function drain(part: MultipartFile): Promise<void> {
  return pipeline(part.file, new Writable({ write: (_chunk, _enc, cb) => cb() }));
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const st = await stat(path);
    return st.isFile() ? st.size : -1;
  } catch {
    return null;
  }
}

/** Import state shared by the parts of one request. */
interface ImportTarget {
  libraryDir: string;
  dir: string;
  /** sha1 → library-relative path of content already in the library (or this request). */
  known: Map<string, string>;
}

/** Store one uploaded part; never throws for per-file problems. */
async function importPart(part: MultipartFile, target: ImportTarget): Promise<ImportFileResult> {
  const original = part.filename ?? '';
  const checked = sanitizeUploadName(original);
  if (!checked.ok) {
    await drain(part);
    return { name: original, status: 'rejected', reason: checked.reason };
  }
  const tmp = join(target.dir, `.riffway-upload-${randomBytes(6).toString('hex')}.part`);
  try {
    const hash = createHash('sha1');
    let bytes = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(part.file, tap, createWriteStream(tmp, { flags: 'wx' }));
    if (part.file.truncated) return { name: original, status: 'rejected', reason: `File is larger than ${LIMITS.importBytes / 1024 / 1024} MB` };
    if (bytes === 0) return { name: original, status: 'rejected', reason: 'File is empty' };
    const sha1 = hash.digest('hex');
    const known = target.known.get(sha1);
    if (known !== undefined) return { name: original, status: 'duplicate', path: known };

    const ext = extname(checked.name);
    const stem = checked.name.slice(0, checked.name.length - ext.length);
    for (let n = 1; n <= MAX_COLLISIONS; n++) {
      const fileName = n === 1 ? checked.name : `${stem} (${n})${ext}`;
      const dest = join(target.dir, fileName);
      const rel = toPosix(relative(target.libraryDir, dest));
      const existing = await fileSize(dest);
      if (existing === null) {
        await rename(tmp, dest);
        target.known.set(sha1, rel);
        return { name: original, status: 'imported', path: rel };
      }
      if (existing === bytes && sha1Of(await readFile(dest)) === sha1) {
        return { name: original, status: 'duplicate', path: rel };
      }
    }
    return { name: original, status: 'rejected', reason: 'Too many files with this name' };
  } catch (err) {
    return { name: original, status: 'rejected', reason: `Could not save the file: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await rm(tmp, { force: true });
  }
}

export const register: RouteModule = async (app, ctx) => {
  app.post('/api/library/import', async (req, reply) => {
    if (!req.isMultipart()) return sendError(reply, 400, 'bad-request', 'Expected multipart/form-data with field "files"');
    const { libraryDir, importSubfolder } = ctx.config.get();
    const sub = normalizeSubfolder(importSubfolder);
    const dir = resolve(libraryDir, sub ?? '');
    if (sub === null || !isInside(libraryDir, dir)) return sendError(reply, 500, 'bad-config', 'The import subfolder is outside the library');
    await mkdir(dir, { recursive: true });
    const known = new Map<string, string>();
    for (const entry of ctx.library.all()) if (entry.source === 'local' && entry.sha1) known.set(entry.sha1, entry.path);
    const target: ImportTarget = { libraryDir, dir, known };

    const files: ImportFileResult[] = [];
    try {
      // preservePath: see the raw client name so path-carrying names are rejected, not silently trimmed.
      const parts = req.files({ limits: { fileSize: LIMITS.importBytes, files: MAX_IMPORT_FILES }, preservePath: true, throwFileSizeLimit: false });
      for await (const part of parts) {
        files.push(await importPart(part, target));
      }
    } catch (err) {
      if (err instanceof app.multipartErrors.FilesLimitError) {
        return sendError(reply, 413, 'too-many-files', `At most ${MAX_IMPORT_FILES} files per import`);
      }
      throw err;
    }
    if (!files.length) return sendError(reply, 400, 'bad-request', 'No files in the request');
    const response: ImportResponse = { files };
    return response;
  });

  app.post('/api/library/rescan', async (): Promise<RescanResponse> => {
    ctx.library.rescan().catch((err: unknown) => ctx.log.error(`rescan failed: ${String(err)}`));
    return { started: true };
  });
};
