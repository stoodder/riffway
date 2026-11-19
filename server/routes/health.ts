/**
 * `GET /api/health` (T-017 owns; working since T-010).
 * @module
 */
import type { HealthResponse } from '@shared/api';
import type { RouteModule } from '../types';

export const register: RouteModule = async (app, ctx) => {
  app.get('/api/health', async (): Promise<HealthResponse> => ({
    ok: true,
    version: ctx.version,
    dataDir: ctx.paths.dataDir,
    libraryDir: ctx.config.get().libraryDir,
  }));
};
