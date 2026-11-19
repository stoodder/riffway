/**
 * Rhythm-alignment sidecars and pasted tabs (T-028; DEC-17, docs/song-formats.md § Rhythm alignment UX):
 *
 * - `GET /api/songs/:id/sidecar` → the saved `RhythmSidecar` (404 when there is none).
 * - `PUT /api/songs/:id/sidecar` → validate against the song (ASCII only; the onset count must match
 *   the tab's onset groups), write `<dataDir>/sidecars/<encoded id>.json`, re-index the song.
 * - `POST /api/library/paste` → write a pasted tab as `<artist> - <title>.txt` into the library's
 *   import folder (+ its sidecar) and index it right away.
 * - `GET /api/sidecars` / `POST /api/sidecars` → every sidecar, for export/import.
 *
 * Request data never becomes a path except through `sanitizeUploadName` (paste) and
 * `LibraryService.sidecarPath` (which URL-encodes the id).
 * @module
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  LIMITS,
  type PasteRequest,
  type PasteResponse,
  type SidecarsBundle,
  type SidecarsImportResponse,
} from '@shared/api';
import type { RhythmSidecar, SongBundle } from '@shared/song';
import type { IndexEntry } from '@shared/sources';
import { asciiToSong } from '@core/import/ascii';
import { ImportError } from '@core/import/errors';
import { isInside, normalizeSubfolder, sanitizeUploadName, toPosix } from '../fs-safety';
import { sendError } from '../http';
import { isRecord, readJsonFile, writeJsonFile } from '../json-file';
import type { RouteModule, ServerContext } from '../types';

/** Longest title/artist accepted by the paste route (characters). */
export const MAX_NAME_CHARS = 200;
/** Most onsets in one sidecar. */
export const MAX_ONSETS = 200_000;
/** Longest song id accepted in a bulk import. */
const MAX_ID_CHARS = 512;
/** Give up on ` (n)` suffixes after this many name collisions. */
const MAX_COLLISIONS = 999;
/** JSON body cap: a pasted tab can be `LIMITS.importBytes`, escaped (≤ 6 bytes per byte). */
const PASTE_BODY_LIMIT = LIMITS.importBytes * 6 + 64 * 1024;
/** JSON body cap for one sidecar and for the bulk import. */
const SIDECAR_BODY_LIMIT = 16 * 1024 * 1024;
const BULK_BODY_LIMIT = 64 * 1024 * 1024;

const GRIDS: readonly number[] = [8, 12, 16];
const METHODS: readonly string[] = ['snap', 'tap', 'manual'];
const DENOMINATORS: readonly number[] = [1, 2, 4, 8, 16, 32];

/**
 * Validate an untrusted value as a `RhythmSidecar`. Returns the normalised sidecar (only known
 * fields) or an error message. Onsets must be finite, ≥ 0 and non-decreasing.
 */
export function parseSidecar(value: unknown): { ok: true; sidecar: RhythmSidecar } | { ok: false; error: string } {
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (!isRecord(value)) return fail('Sidecar must be an object');
  if (value.schema !== 1) return fail('Sidecar schema must be 1');
  const { bpm, timeSig, grid, onsets, method, savedAt } = value;
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 20 || bpm > 400) return fail('bpm must be a number from 20 to 400');
  if (
    !Array.isArray(timeSig) ||
    timeSig.length !== 2 ||
    !Number.isInteger(timeSig[0]) ||
    (timeSig[0] as number) < 1 ||
    (timeSig[0] as number) > 32 ||
    !DENOMINATORS.includes(timeSig[1] as number)
  ) {
    return fail('timeSig must be [1–32, 1|2|4|8|16|32]');
  }
  if (typeof grid !== 'number' || !GRIDS.includes(grid)) return fail('grid must be 8, 12 or 16');
  if (typeof method !== 'string' || !METHODS.includes(method)) return fail('method must be snap, tap or manual');
  if (!Array.isArray(onsets) || onsets.length === 0 || onsets.length > MAX_ONSETS) return fail(`onsets must hold 1–${MAX_ONSETS} times`);
  let prev = 0;
  for (const t of onsets) {
    if (typeof t !== 'number' || !Number.isFinite(t) || t < prev) return fail('onsets must be finite, non-negative and in order');
    prev = t;
  }
  if (savedAt !== undefined && (typeof savedAt !== 'number' || !Number.isFinite(savedAt))) return fail('savedAt must be epoch ms');
  return {
    ok: true,
    sidecar: {
      schema: 1,
      bpm,
      timeSig: [timeSig[0] as number, timeSig[1] as number],
      grid: grid as RhythmSidecar['grid'],
      onsets: onsets as number[],
      method: method as RhythmSidecar['method'],
      savedAt: typeof savedAt === 'number' ? savedAt : Date.now(),
    },
  };
}

/** Outcome of checking a sidecar against a tab with the real importer. */
type CheckResult = { ok: true } | { ok: false; status: number; code: string; error: string };

/**
 * Import `bundle` (ASCII) with its sidecar the way the indexer will and confirm the sidecar applies
 * (`rhythm: 'aligned'`). Without a sidecar, only checks that the tab has notes.
 */
function checkTab(bundle: SongBundle): CheckResult {
  try {
    const song = asciiToSong(bundle);
    if (bundle.sidecar && song.meta.rhythm !== 'aligned') {
      const groups = new Set(song.notes.map((n) => n.time)).size;
      return {
        ok: false,
        status: 400,
        code: 'sidecar-mismatch',
        error: `The rhythm has ${bundle.sidecar.onsets.length} onsets but the tab has ${groups}; re-align the song`,
      };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof ImportError) return { ok: false, status: 400, code: err.code === 'no-playable-track' ? 'unsupported' : 'empty', error: err.message };
    return { ok: false, status: 400, code: 'bad-request', error: `The tab could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Read every valid sidecar in the sidecars folder, keyed by song id. */
async function readAllSidecars(dir: string): Promise<Record<string, RhythmSidecar>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return {};
  }
  const out: Record<string, RhythmSidecar> = {};
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    let id: string;
    try {
      id = decodeURIComponent(name.slice(0, -'.json'.length));
    } catch {
      continue;
    }
    const parsed = parseSidecar(await readJsonFile(join(dir, name)));
    if (parsed.ok) out[id] = parsed.sidecar;
  }
  return out;
}

/** `Artist - Title.txt` (or `Title.txt`), cleaned for the file system. Slashes become dashes. */
export function pasteFileName(title: string, artist?: string): string | null {
  const stem = (artist ? `${artist} - ${title}` : title).replace(/[/\\]/g, '-');
  const checked = sanitizeUploadName(`${stem}.txt`);
  return checked.ok ? checked.name : null;
}

/** Write `data` as `name` (or `name (n)`) in `dir` without ever replacing a file. Returns the path. */
async function writeExclusive(dir: string, name: string, data: Uint8Array): Promise<string> {
  const ext = '.txt';
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n <= MAX_COLLISIONS; n++) {
    const dest = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      await writeFile(dest, data, { flag: 'wx' });
      return dest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Too many files with this name');
}

/** Write a song's sidecar file (atomic). */
async function placeSidecar(ctx: ServerContext, id: string, sidecar: RhythmSidecar): Promise<void> {
  await writeJsonFile(ctx.library.sidecarPath(id), sidecar);
}

/** Index one freshly written local file now (instead of waiting for the watcher). */
async function indexNow(ctx: ServerContext, abs: string, libraryDir: string): Promise<IndexEntry | null> {
  if (!ctx.config.get().enabledSources.includes('local')) return null;
  const st = await stat(abs);
  const entries = await ctx.adapterContext.indexFiles('local', [
    { absPath: abs, relPath: toPosix(relative(libraryDir, abs)), mtimeMs: st.mtimeMs, size: st.size },
  ]);
  return entries[0] ?? null;
}

export const register: RouteModule = async (app, ctx) => {
  app.get<{ Params: { id: string } }>('/api/songs/:id/sidecar', async (req, reply) => {
    const id = req.params.id;
    if (!ctx.library.get(id)) return sendError(reply, 404, 'not-found', `Song not found: ${id}`);
    const parsed = parseSidecar(await readJsonFile(ctx.library.sidecarPath(id)));
    if (!parsed.ok) return sendError(reply, 404, 'no-sidecar', `No rhythm alignment saved for ${id}`);
    return parsed.sidecar;
  });

  app.put<{ Params: { id: string } }>('/api/songs/:id/sidecar', { bodyLimit: SIDECAR_BODY_LIMIT }, async (req, reply) => {
    const id = req.params.id;
    const entry = ctx.library.get(id);
    if (!entry) return sendError(reply, 404, 'not-found', `Song not found: ${id}`);
    if (entry.format !== 'ascii') return sendError(reply, 400, 'unsupported', 'Only ASCII tabs take a rhythm alignment');
    const parsed = parseSidecar(req.body);
    if (!parsed.ok) return sendError(reply, 400, 'bad-request', parsed.error);
    const bundle = await ctx.library.readBundle(id);
    const check = checkTab({ ...bundle, sidecar: parsed.sidecar });
    if (!check.ok) return sendError(reply, check.status, check.code, check.error);
    await placeSidecar(ctx, id, parsed.sidecar);
    await ctx.library.reindex(id);
    return parsed.sidecar;
  });

  app.post('/api/library/paste', { bodyLimit: PASTE_BODY_LIMIT }, async (req, reply) => {
    const body = req.body as Partial<PasteRequest> | null;
    if (!isRecord(body)) return sendError(reply, 400, 'bad-request', 'Expected a JSON body {title, artist?, text, sidecar?}');
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
    const artist = typeof body.artist === 'string' ? body.artist.replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > MAX_NAME_CHARS) return sendError(reply, 400, 'bad-request', `title must be 1–${MAX_NAME_CHARS} characters`);
    if (artist.length > MAX_NAME_CHARS) return sendError(reply, 400, 'bad-request', `artist must be at most ${MAX_NAME_CHARS} characters`);
    if (typeof body.text !== 'string' || !body.text.trim()) return sendError(reply, 400, 'bad-request', 'text must hold the tab');
    const text = body.text.endsWith('\n') ? body.text : `${body.text}\n`;
    const data = new TextEncoder().encode(text);
    if (data.byteLength > LIMITS.importBytes) return sendError(reply, 413, 'too-large', `The tab is larger than ${LIMITS.importBytes / 1024 / 1024} MB`);
    let sidecar: RhythmSidecar | undefined;
    if (body.sidecar !== undefined) {
      const parsed = parseSidecar(body.sidecar);
      if (!parsed.ok) return sendError(reply, 400, 'bad-request', parsed.error);
      sidecar = parsed.sidecar;
    }
    const name = pasteFileName(title, artist || undefined);
    if (!name) return sendError(reply, 400, 'bad-request', 'title cannot be used as a file name');
    const check = checkTab({ fileName: name, data, source: { source: 'local', path: name }, ...(sidecar ? { sidecar } : {}) });
    if (!check.ok) return sendError(reply, check.status, check.code, check.error);

    const { libraryDir, importSubfolder } = ctx.config.get();
    const sub = normalizeSubfolder(importSubfolder);
    const dir = resolve(libraryDir, sub ?? '');
    if (sub === null || !isInside(libraryDir, dir)) return sendError(reply, 500, 'bad-config', 'The import subfolder is outside the library');

    const sha1 = createHash('sha1').update(data).digest('hex');
    const duplicate = ctx.library.all().find((e) => e.source === 'local' && e.sha1 === sha1);
    if (duplicate) {
      if (sidecar) {
        await placeSidecar(ctx, duplicate.id, sidecar);
        await ctx.library.reindex(duplicate.id);
      }
      const response: PasteResponse = { id: duplicate.id, path: duplicate.path };
      return response;
    }

    // The sidecar goes first so that whoever indexes the file (us or the watcher) sees it.
    const predicted = `local:${sha1.slice(0, 16)}`;
    if (sidecar) await placeSidecar(ctx, predicted, sidecar);
    await mkdir(dir, { recursive: true });
    let abs: string;
    try {
      abs = await writeExclusive(dir, name, data);
    } catch (err) {
      if (sidecar) await rm(ctx.library.sidecarPath(predicted), { force: true });
      return sendError(reply, 500, 'write-failed', `Could not save the tab: ${err instanceof Error ? err.message : String(err)}`);
    }
    const entry = await indexNow(ctx, abs, libraryDir);
    const id = entry?.id ?? predicted;
    if (sidecar && id !== predicted) {
      await placeSidecar(ctx, id, sidecar);
      await rm(ctx.library.sidecarPath(predicted), { force: true });
      await ctx.library.reindex(id);
    }
    const response: PasteResponse = { id, path: toPosix(relative(libraryDir, abs)) };
    return response;
  });

  app.get('/api/sidecars', async (): Promise<SidecarsBundle> => ({ sidecars: await readAllSidecars(ctx.paths.sidecarsDir) }));

  app.post('/api/sidecars', { bodyLimit: BULK_BODY_LIMIT }, async (req, reply) => {
    const body = req.body as Partial<SidecarsBundle> | null;
    if (!isRecord(body) || !isRecord(body.sidecars)) return sendError(reply, 400, 'bad-request', 'Expected {sidecars: {<songId>: RhythmSidecar}}');
    let written = 0;
    for (const [id, value] of Object.entries(body.sidecars)) {
      if (!id || id.length > MAX_ID_CHARS) continue;
      const parsed = parseSidecar(value);
      if (!parsed.ok) continue;
      await placeSidecar(ctx, id, parsed.sidecar);
      written++;
      if (ctx.library.get(id)) await ctx.library.reindex(id);
    }
    const response: SidecarsImportResponse = { written };
    return response;
  });
};
