/**
 * `GET /api/events`: Server-Sent Events (T-017). Each event is `data: <JSON ServerEvent>` on the
 * default `message` event; a `: ping` comment every 15 s keeps proxies from timing out. Open
 * streams are ended when the server closes. Requests must accept `text/event-stream`.
 * @module
 */
import type { ServerResponse } from 'node:http';
import { sendError } from '../http';
import type { RouteModule } from '../types';

/** Keep-alive comment interval (ms). */
export const SSE_PING_MS = 15_000;

export const register: RouteModule = async (app, ctx) => {
  const open = new Set<ServerResponse>();

  app.get('/api/events', (req, reply) => {
    // EventSource always sends this; anything else (a plain fetch, a probe) gets a quick 400
    // instead of a stream that never ends.
    if (!/\btext\/event-stream\b/.test(req.headers.accept ?? '')) {
      return sendError(reply, 400, 'bad-request', 'GET /api/events is a Server-Sent Events stream (Accept: text/event-stream)');
    }
    reply.hijack();
    const res = reply.raw;
    // Subscribe before the first byte goes out: a client that sees the response misses no event.
    const unsubscribe = ctx.events.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
    ping.unref();
    open.add(res);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      open.delete(res);
    });
  });

  app.addHook('preClose', async () => {
    for (const res of open) res.end();
  });
};
