/**
 * Integration harness (T-029): the real companion server — real indexer, real `loadSong` importers
 * and real `analyzeDifficulty` (the default analyzer, no fakes) — over the committed `starter/`
 * folder and a temp library folder seeded with authored fixtures.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SearchResponse } from '@shared/api';
import type { SongBundle } from '@shared/song';
import type { IndexEntry } from '@shared/sources';
import { createApp } from '../../server/app';
import { createLocalAdapter } from '../../server/sources/local';
import { createStarterAdapter } from '../../server/sources/starter';
import type { ServerContext } from '../../server/types';

/** Repository root (this file lives in `tests/integration/`). */
export const REPO = new URL('../../', import.meta.url).pathname;
export const STARTER_DIR = join(REPO, 'starter');
export const FIXTURES_DIR = join(REPO, 'tests/fixtures');

/** A running app over a temp data dir and library folder; `close()` stops it and removes the temp dirs. */
export interface RealApp {
  app: FastifyInstance;
  ctx: ServerContext;
  libraryDir: string;
  close(): Promise<void>;
}

/**
 * Start the real app with the local adapter (over a temp library seeded with `libraryFiles`,
 * fixture-relative paths copied flat) and the starter adapter (over `starter/`), using the
 * default analyzer. Resolves after the initial scan.
 */
export async function startRealApp(libraryFiles: readonly string[] = []): Promise<RealApp> {
  const root = mkdtempSync(join(tmpdir(), 'riffway-integration-'));
  const dataDir = join(root, 'data');
  const libraryDir = join(root, 'lib');
  mkdirSync(dataDir);
  mkdirSync(libraryDir);
  for (const rel of libraryFiles) copyFileSync(join(FIXTURES_DIR, rel), join(libraryDir, basename(rel)));
  const { app, ctx } = await createApp({
    dataDir,
    libraryDir,
    staticDir: null,
    watch: false,
    sources: [() => createLocalAdapter(), () => createStarterAdapter({ dir: STARTER_DIR })],
  });
  await ctx.library.ready;
  return {
    app,
    ctx,
    libraryDir,
    async close() {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** `GET /api/search` with the given query string parameters. */
export async function search(app: FastifyInstance, params: Record<string, string>): Promise<SearchResponse> {
  const res = await app.inject({ method: 'GET', url: '/api/search', query: params, headers: { host: '127.0.0.1' } });
  if (res.statusCode !== 200) throw new Error(`search ${JSON.stringify(params)} → ${res.statusCode} ${res.body}`);
  return res.json<SearchResponse>();
}

/** `GET /api/songs/:id/file` as a bundle ready for `loadSong` (same file name as the index entry). */
export async function fetchSongBundle(app: FastifyInstance, entry: IndexEntry): Promise<SongBundle> {
  const res = await app.inject({ method: 'GET', url: `/api/songs/${encodeURIComponent(entry.id)}/file`, headers: { host: '127.0.0.1' } });
  if (res.statusCode !== 200) throw new Error(`file ${entry.id} → ${res.statusCode} ${res.body}`);
  return { fileName: entry.fileName, data: new Uint8Array(res.rawPayload), id: entry.id };
}

/** The index entry for a song id; throws when it is missing. */
export function entryOf(ctx: ServerContext, id: string): IndexEntry {
  const entry = ctx.library.get(id);
  if (!entry) throw new Error(`not indexed: ${id} (have ${ctx.library.all().map((e) => e.id).join(', ')})`);
  return entry;
}
