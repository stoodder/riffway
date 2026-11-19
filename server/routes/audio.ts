/**
 * `POST /api/audio` (multipart `file`), `GET /api/audio/:id`, `DELETE /api/audio/:id` (T-027). **Stub (T-010):** every route answers 501 until T-027 lands.
 * @module
 */
import { stubRoutes } from '../http';
import type { RouteModule } from '../types';

export const register: RouteModule = async (app) => {
  stubRoutes(app, 'T-027', ['uploadAudio', 'getAudio', 'deleteAudio']);
};
