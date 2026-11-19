/**
 * `GET /api/events`: SSE (`data: <JSON ServerEvent>`, `: ping` every 15 s) (T-017). **Stub (T-010):** every route answers 501 until T-017 lands.
 * @module
 */
import { stubRoutes } from '../http';
import type { RouteModule } from '../types';

export const register: RouteModule = async (app) => {
  stubRoutes(app, 'T-017', ['events']);
};
