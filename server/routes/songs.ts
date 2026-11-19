/**
 * `GET /api/songs/:id` (`SongMeta`) and `GET /api/songs/:id/file` (raw bytes) (T-017). Ids are
 * looked up in the index; request data never becomes a path. Local files are additionally
 * re-checked (after resolving symlinks) to lie inside the library folder.
 * @module
 */
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { SongMeta } from '@shared/api';
import type { IndexEntry } from '@shared/sources';
import { isInside } from '../fs-safety';
import { sendError } from '../http';
import type { RouteModule, ServerContext } from '../types';

const songUrl = (id: string, suffix: string): string => `/api/songs/${encodeURIComponent(id)}/${suffix}`;

/** Absolute path of an entry's file, or null if it is missing or (local) escapes the library. */
async function servablePath(ctx: ServerContext, entry: IndexEntry): Promise<string | null> {
  try {
    const real = await realpath(ctx.library.filePath(entry));
    if (entry.source === 'local' && !isInside(await realpath(ctx.config.get().libraryDir), real)) return null;
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

export const register: RouteModule = async (app, ctx) => {
  app.get<{ Params: { id: string } }>('/api/songs/:id', async (req, reply) => {
    const entry = ctx.library.get(req.params.id);
    if (!entry) return sendError(reply, 404, 'not-found', `Song not found: ${req.params.id}`);
    const meta: SongMeta = {
      entry,
      arrangements: entry.tracks,
      difficulty: await ctx.library.arrangementDifficulties(entry.id),
      files: { main: songUrl(entry.id, 'file') },
    };
    if (entry.hasMidi) meta.files.rhythm = songUrl(entry.id, 'rhythm');
    if (entry.hasSidecar) meta.files.sidecar = songUrl(entry.id, 'sidecar');
    return meta;
  });

  app.get<{ Params: { id: string } }>('/api/songs/:id/file', async (req, reply) => {
    const entry = ctx.library.get(req.params.id);
    if (!entry) return sendError(reply, 404, 'not-found', `Song not found: ${req.params.id}`);
    const path = await servablePath(ctx, entry);
    if (!path) return sendError(reply, 404, 'not-found', `File missing for ${entry.id}`);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-cache')
      .send(createReadStream(path));
  });
};
