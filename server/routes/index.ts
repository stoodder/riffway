/**
 * Route registry (frozen by T-010). One file per area; each exports `register: RouteModule`.
 * Owners fill in their file; nobody edits this list (contract change request instead).
 * @module
 */
import type { FastifyInstance } from 'fastify';
import type { RouteRegistration, ServerContext } from '../types';
import { register as audio } from './audio';
import { register as classtab } from './classtab';
import { register as config } from './config';
import { register as events } from './events';
import { register as health } from './health';
import { register as library } from './library';
import { register as search } from './search';
import { register as sidecars } from './sidecars';
import { register as songs } from './songs';
import { register as sources } from './sources';

export const ROUTES: readonly RouteRegistration[] = [
  { name: 'health', owner: 'T-017', register: health },
  { name: 'config', owner: 'T-017', register: config },
  { name: 'sources', owner: 'T-017', register: sources },
  { name: 'search', owner: 'T-017', register: search },
  { name: 'songs', owner: 'T-017', register: songs },
  { name: 'library', owner: 'T-017', register: library },
  { name: 'events', owner: 'T-017', register: events },
  { name: 'classtab', owner: 'T-025', register: classtab },
  { name: 'audio', owner: 'T-027', register: audio },
  { name: 'sidecars', owner: 'T-028', register: sidecars },
];

/** Register every route module in its own encapsulated scope. */
export async function registerRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  for (const route of ROUTES) {
    await app.register(async (scope) => route.register(scope, ctx));
  }
}
