/**
 * `GET /api/classtab/status`, `POST /api/classtab/refresh`, `GET /api/songs/:id/rhythm` (paired MIDI) (T-025). **Stub (T-010):** every route answers 501 until T-025 lands.
 * @module
 */
import { stubRoutes } from '../http';
import type { RouteModule } from '../types';

export const register: RouteModule = async (app) => {
  stubRoutes(app, 'T-025', ['classtabStatus', 'classtabRefresh', 'songRhythm']);
};
