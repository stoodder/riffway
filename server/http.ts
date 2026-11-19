/**
 * Small HTTP helpers shared by route files (T-010).
 * @module
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { API_ROUTES, type ApiErrorBody, type ApiRouteName } from '@shared/api';

/** Send an `ApiErrorBody`. */
export function sendError(reply: FastifyReply, status: number, code: string, error: string): FastifyReply {
  const body: ApiErrorBody = { error, code };
  return reply.code(status).send(body);
}

/** Split `'GET /api/songs/:id'` into method + url. */
export function routeParts(name: ApiRouteName): { method: 'GET' | 'PUT' | 'POST' | 'DELETE'; url: string } {
  const [method, url] = API_ROUTES[name].split(' ') as ['GET' | 'PUT' | 'POST' | 'DELETE', string];
  return { method, url };
}

/** Register 501 handlers for routes whose owning task has not landed yet. */
export function stubRoutes(app: FastifyInstance, task: string, names: readonly ApiRouteName[]): void {
  for (const name of names) {
    const { method, url } = routeParts(name);
    app.route({
      method,
      url,
      handler: (_req, reply) => sendError(reply, 501, 'not-implemented', `${API_ROUTES[name]} is not implemented yet (${task})`),
    });
  }
}
