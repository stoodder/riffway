/**
 * ClassTab routes (T-025): `GET /api/classtab/status`, `POST /api/classtab/refresh` (progress as
 * `classtab.progress` events on `GET /api/events`) and `GET /api/songs/:id/rhythm` (the paired MIDI
 * of a ClassTab tab or of a local tab with a sibling `.mid`). Ids are looked up in the index;
 * request data never becomes a path.
 * @module
 */
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { ClassTabRefreshRequest, ClassTabRefreshResponse } from '@shared/api';
import type { IndexEntry } from '@shared/sources';
import { isInside } from '../fs-safety';
import { sendError } from '../http';
import { isRecord } from '../json-file';
import { classTabLayout, isClassTabAdapter } from '../sources/classtab';
import type { RouteModule, ServerContext } from '../types';

/** The folder an entry's paired MIDI must lie in, or null when the source has no such rule. */
function midiRoot(ctx: ServerContext, entry: IndexEntry): string | null {
  if (entry.source === 'classtab') return classTabLayout(ctx.paths.dataDir).files;
  if (entry.source === 'local') return ctx.config.get().libraryDir;
  return null;
}

/** Absolute path of the entry's paired MIDI if it exists and stays inside its source folder. */
async function servableMidi(ctx: ServerContext, entry: IndexEntry): Promise<string | null> {
  const path = ctx.library.midiPath(entry);
  if (!path) return null;
  try {
    const real = await realpath(path);
    const root = midiRoot(ctx, entry);
    if (root !== null && !isInside(await realpath(root), real)) return null;
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

export const register: RouteModule = async (app, ctx) => {
  const adapter = ctx.sources.find(isClassTabAdapter);

  app.get('/api/classtab/status', async (_req, reply) => {
    if (!adapter) return sendError(reply, 404, 'not-found', 'The ClassTab source is not available');
    return adapter.classtabStatus(ctx.adapterContext);
  });

  app.post<{ Body: ClassTabRefreshRequest | undefined }>('/api/classtab/refresh', async (req, reply) => {
    if (!adapter) return sendError(reply, 404, 'not-found', 'The ClassTab source is not available');
    const body = req.body;
    if (!isRecord(body) || (body.force !== undefined && typeof body.force !== 'boolean')) {
      return sendError(reply, 400, 'bad-request', 'Body must be a JSON object: {} or {"force": true}');
    }
    const force = body.force === true;
    const blocker = await adapter.refreshBlocker(ctx.adapterContext, { force });
    if (blocker) {
      const res: ClassTabRefreshResponse = { started: false, reason: blocker };
      return res;
    }
    // Runs in the background; progress and the outcome arrive as `classtab.progress` events.
    void adapter.refresh(ctx.adapterContext, { force });
    const res: ClassTabRefreshResponse = { started: true };
    return reply.code(202).send(res);
  });

  app.get<{ Params: { id: string } }>('/api/songs/:id/rhythm', async (req, reply) => {
    const entry = ctx.library.get(req.params.id);
    if (!entry) return sendError(reply, 404, 'not-found', `Song not found: ${req.params.id}`);
    const path = await servableMidi(ctx, entry);
    if (!path) return sendError(reply, 404, 'not-found', `No paired MIDI for ${entry.id}`);
    return reply
      .header('content-type', 'audio/midi')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-cache')
      .send(createReadStream(path));
  });
};
