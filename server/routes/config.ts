/**
 * `GET, PUT /api/config`: server config (library folder, enabled sources, import subfolder) (T-017).
 * A change of library folder or enabled sources triggers a rescan and restarts the watchers.
 * @module
 */
import type { ServerConfig } from '@shared/api';
import { ConfigError, parseConfigUpdate } from '../config-store';
import { sendError } from '../http';
import type { RouteModule } from '../types';

export const register: RouteModule = async (app, ctx) => {
  app.get('/api/config', async (): Promise<ServerConfig> => ctx.config.get());

  app.put('/api/config', async (req, reply) => {
    try {
      return await ctx.config.update(parseConfigUpdate(req.body));
    } catch (err) {
      if (err instanceof ConfigError) return sendError(reply, 400, 'bad-request', err.message);
      throw err;
    }
  });
};
