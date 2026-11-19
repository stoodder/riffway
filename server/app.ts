/**
 * Fastify app factory (T-017 owns; working skeleton since T-010). Used by `server/index.ts` and by
 * tests via `app.inject()` (no sockets). Binds nothing itself; the bootstrap listens on 127.0.0.1.
 * @module
 */
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { LIMITS } from '@shared/api';
import { sendError } from './http';
import { createServerContext } from './context';
import { registerRoutes } from './routes';
import type { ServerContext, ServerOptions } from './types';

/** Build the app + context. Call `app.close()` to stop watchers. */
export async function createApp(opts: ServerOptions = {}): Promise<{ app: FastifyInstance; ctx: ServerContext }> {
  const app = Fastify({
    logger: opts.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: LIMITS.importBytes + 1024 * 1024,
  });
  const ctx = await createServerContext(opts, app.log);
  await app.register(fastifyMultipart, { limits: { fileSize: LIMITS.audioBytes, files: 100 } });
  await registerRoutes(app, ctx);
  if (ctx.paths.staticDir) {
    await app.register(fastifyStatic, { root: ctx.paths.staticDir, prefix: '/' });
  }
  app.setNotFoundHandler((req, reply) => sendError(reply, 404, 'not-found', `${req.method} ${req.url} not found`));
  app.addHook('onClose', async () => ctx.close());
  return { app, ctx };
}
