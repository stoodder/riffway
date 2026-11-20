/**
 * `GET /api/search/remote?q=&source=`: opt-in remote catalog search (docs/guides/songsterr-search.md).
 * A separate endpoint so local search never waits for it. Answers 200 with a
 * {@link RemoteSearchResponse} whose `status` says what happened:
 * - `off`: the source isn't enabled for remote search in Settings (no request), or its request isn't
 *   set up yet ({@link RemoteSearchUnavailable}; `message` says so);
 * - `refused`: the site answered 403/429 (off until restart); `error`: timeout or failure; `ok`: hits.
 * @module
 */
import type { RemoteSearchResponse } from '@shared/api';
import { SOURCE_IDS, type SourceId } from '@shared/song';
import { RemoteSearchRefused, RemoteSearchUnavailable } from '@shared/sources';
import { sendError } from '../http';
import type { RouteModule } from '../types';

/** Longest query passed to an adapter. */
const MAX_QUERY = 200;

export const register: RouteModule = async (app, ctx) => {
  app.get('/api/search/remote', async (req, reply) => {
    const { q, source } = req.query as { q?: unknown; source?: unknown };
    const id = (typeof source === 'string' && source ? source : 'songsterr') as SourceId;
    if (!SOURCE_IDS.includes(id)) return sendError(reply, 400, 'bad-request', `Unknown source: ${String(source)}`);
    const adapter = ctx.sources.find((s) => s.id === id);
    if (!adapter?.searchRemote) return sendError(reply, 404, 'not-found', `${id} has no remote search`);
    const empty = (status: RemoteSearchResponse['status'], message?: string): RemoteSearchResponse =>
      message === undefined ? { source: id, status, hits: [] } : { source: id, status, message, hits: [] };
    const cfg = ctx.config.get();
    if (!cfg.remoteSearch.includes(id) || !cfg.enabledSources.includes(id)) return empty('off');

    const ac = new AbortController();
    // The browser moved on to a newer query (or left): stop waiting for the site.
    const onClose = (): void => {
      if (!reply.raw.writableFinished) ac.abort();
    };
    reply.raw.on('close', onClose);
    try {
      const query = (typeof q === 'string' ? q : '').slice(0, MAX_QUERY);
      const hits = await adapter.searchRemote(query, ctx.adapterContext, ac.signal);
      return { source: id, status: 'ok', hits } satisfies RemoteSearchResponse;
    } catch (err) {
      if (err instanceof RemoteSearchUnavailable) return empty('off', err.message);
      if (err instanceof RemoteSearchRefused) return empty('refused', err.message);
      if (ac.signal.aborted) return empty('error', 'Cancelled');
      ctx.log.warn(`remote search failed: ${err instanceof Error ? err.message : String(err)}`);
      return empty('error', 'Songsterr didn’t answer. Use “Search on Songsterr” instead.');
    } finally {
      reply.raw.off('close', onClose);
    }
  });
};
