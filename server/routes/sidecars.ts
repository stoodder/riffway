/**
 * `GET, PUT /api/songs/:id/sidecar`, `POST /api/library/paste`, `GET, POST /api/sidecars` (T-028). **Stub (T-010):** every route answers 501 until T-028 lands.
 * @module
 */
import { stubRoutes } from '../http';
import type { RouteModule } from '../types';

export const register: RouteModule = async (app) => {
  stubRoutes(app, 'T-028', ['getSidecar', 'putSidecar', 'paste', 'getSidecars', 'postSidecars']);
};
