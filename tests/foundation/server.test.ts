import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API_ROUTES, type ApiRouteName, type HealthResponse } from '@shared/api';
import { SOURCE_IDS } from '@shared/song';
import { createApp } from '../../server/app';
import { routeParts } from '../../server/http';
import { ROUTES } from '../../server/routes';
import { SOURCE_REGISTRY } from '../../server/sources/registry';
import type { ServerContext } from '../../server/types';

describe('companion server skeleton', () => {
  let dir: string;
  let app: FastifyInstance;
  let ctx: ServerContext;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'riffway-test-'));
    ({ app, ctx } = await createApp({ dataDir: dir, libraryDir: join(dir, 'lib'), staticDir: null, watch: false }));
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/health reports version and dirs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<HealthResponse>();
    expect(body).toMatchObject({ ok: true, dataDir: dir, libraryDir: join(dir, 'lib') });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('registers every API route (stubs answer 501 not-implemented)', async () => {
    for (const name of Object.keys(API_ROUTES) as ApiRouteName[]) {
      const { method, url } = routeParts(name);
      expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
      if (name === 'health') continue;
      const res = await app.inject({ method, url: url.replace(':id', 'local%3Aabc') });
      expect([200, 400, 404, 501]).toContain(res.statusCode);
    }
    expect(ROUTES.map((r) => r.name)).toContain('sidecars');
  });

  it('unknown API paths are JSON 404s', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not-found' });
  });

  it('registers one adapter per source id with a status', async () => {
    expect(SOURCE_REGISTRY.map((s) => s.id)).toEqual([...SOURCE_IDS]);
    for (const adapter of ctx.sources) {
      const status = await adapter.status(ctx.adapterContext);
      expect(status.id).toBe(adapter.id);
      if (adapter.kind === 'link-out') expect(adapter.scan).toBeUndefined();
    }
  });
});
