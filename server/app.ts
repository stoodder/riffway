/**
 * Fastify app factory (T-017). Used by `server/index.ts` and by tests via `app.inject()` (no
 * sockets). Binds nothing itself; the bootstrap listens on 127.0.0.1 only (DEC-20).
 *
 * Every request must address a loopback host (`Host` header) and, when the browser sends an
 * `Origin`, come from a loopback origin. This blocks DNS-rebinding reads and cross-site form posts
 * to the local API even though the socket is only reachable from this machine.
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

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Host name of a `Host` header value (`'127.0.0.1:5174'` → `'127.0.0.1'`, `'[::1]:80'` → `'[::1]'`). */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : (h.split(':')[0] ?? '');
}

/** True when a `Host` header names this machine's loopback interface. */
export function isLoopbackHost(host: string | undefined): boolean {
  return !!host && LOOPBACK_HOSTNAMES.has(hostnameOf(host));
}

/** True when an `Origin` header is an http(s) loopback origin. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** Build the app + context. Call `app.close()` to stop watchers. */
export async function createApp(opts: ServerOptions = {}): Promise<{ app: FastifyInstance; ctx: ServerContext }> {
  const app = Fastify({
    logger: opts.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: LIMITS.importBytes + 1024 * 1024,
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!isLoopbackHost(req.headers.host)) return sendError(reply, 403, 'forbidden', 'Only requests to localhost are accepted');
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) return sendError(reply, 403, 'forbidden', 'Cross-origin requests are not accepted');
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
