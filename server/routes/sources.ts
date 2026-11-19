/**
 * `GET /api/sources`: every adapter's status (T-017), with the enabled flag, indexed count and
 * indexing state merged in from the library.
 * @module
 */
import type { SourcesResponse } from '@shared/api';
import type { SourceStatus } from '@shared/sources';
import { LibraryIndex } from '../indexer/library-index';
import { idleStatus } from '../sources/stub';
import type { RouteModule } from '../types';

export const register: RouteModule = async (app, ctx) => {
  app.get('/api/sources', async (): Promise<SourcesResponse> => {
    const sources = await Promise.all(
      ctx.sources.map(async (adapter): Promise<SourceStatus> => {
        let status: SourceStatus;
        try {
          status = await adapter.status(ctx.adapterContext);
        } catch (err) {
          status = { ...idleStatus(adapter, `status failed: ${String(err)}`), state: 'error' };
        }
        return ctx.library instanceof LibraryIndex ? ctx.library.decorateStatus(status) : status;
      }),
    );
    return { sources };
  });
};
