/**
 * Shared helpers for server tests: temp dirs, a fake song analyzer (so tests do not depend on the
 * real importers of T-011/T-013), app construction, multipart bodies and event waits.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@shared/api';
import type { DifficultyReport, SongBundle, Tier } from '@shared/song';
import type { SourceAdapterFactory, StarterManifest } from '@shared/sources';
import { ImportError } from '@core/import/errors';
import { createApp } from '../../server/app';
import type { AppOptions } from '../../server/context';
import type { SongAnalysis, SongAnalyzer } from '../../server/indexer/analyzer';
import { createLocalAdapter, type LocalAdapterOptions } from '../../server/sources/local';
import { createStarterAdapter } from '../../server/sources/starter';
import type { EventBus, ServerContext } from '../../server/types';

/** Temp layout: `<root>/data`, `<root>/lib`, `<root>/starter`. */
export interface TempDirs {
  root: string;
  dataDir: string;
  libraryDir: string;
  starterDir: string;
  cleanup(): void;
}

export function makeTempDirs(): TempDirs {
  const root = mkdtempSync(join(tmpdir(), 'riffway-server-'));
  const dirs = { root, dataDir: join(root, 'data'), libraryDir: join(root, 'lib'), starterDir: join(root, 'starter') };
  for (const d of [dirs.dataDir, dirs.libraryDir, dirs.starterDir]) mkdirSync(d, { recursive: true });
  return { ...dirs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Fake song file: `key: value` lines (`title`, `artist`, `composer`, `tier`, `tuning`, `rhythm`,
 * `genre`, `skills`, `tracks` = playable track count). `NOT A SONG` → unsupported (skipped),
 * `BROKEN` → syntax error, `UNPLAYABLE` → a parsed file without playable tracks.
 */
export function fakeSong(fields: Record<string, string | number>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

function fakeReport(tier: number, provisional: boolean): DifficultyReport {
  return { version: 1, rating: tier, tier: tier as Tier, tierName: 'Beginner', provisional, sections: [], skills: [], highlights: [] };
}

/** A deterministic analyzer for the fake format, counting calls. */
export function createFakeAnalyzer(): SongAnalyzer & { calls: string[]; difficultyCalls: number[] } {
  const calls: string[] = [];
  const difficultyCalls: number[] = [];
  const parse = (bundle: SongBundle): Record<string, string> => {
    const text = new TextDecoder().decode(bundle.data);
    if (text.startsWith('NOT A SONG')) throw new ImportError('unsupported', 'not a song');
    if (text.startsWith('BROKEN')) throw new ImportError('syntax', 'Bad syntax at line 1');
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const m = /^(\w+):\s*(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
    return out;
  };
  return {
    calls,
    difficultyCalls,
    analyze(bundle) {
      calls.push(bundle.fileName);
      const f = parse(bundle);
      const playableTracks = Number(f.tracks ?? 1);
      const tracks = Array.from({ length: Math.max(1, playableTracks) }, (_, i) => ({
        index: i,
        name: `Guitar ${i + 1}`,
        strings: 6,
        tuning: [64, 59, 55, 50, 45, 40],
        capo: 0,
        playable: playableTracks > 0,
      }));
      const rhythm = bundle.sidecar ? 'aligned' : ((f.rhythm as SongAnalysis['rhythm'] | undefined) ?? 'exact');
      const tuningId = f.tuning ?? 'standard';
      const analysis: SongAnalysis = {
        format: bundle.fileName.endsWith('.txt') ? 'ascii' : 'alphatex',
        title: f.title ?? '',
        tracks,
        defaultArrangement: playableTracks > 0 ? 0 : -1,
        tuning: tracks[0]!.tuning,
        tuningId,
        tuningLabel: tuningId === 'drop-d' ? 'Drop D' : 'Standard',
        capo: 0,
        bpm: 100,
        durationSec: 30,
        rhythm,
        difficulty: playableTracks > 0 && f.tier ? fakeReport(Number(f.tier), rhythm === 'needs-alignment') : null,
        tags: { style: [], genre: f.genre ? f.genre.split(',') : [], skills: f.skills ? f.skills.split(',') : [] },
      };
      if (playableTracks === 0) analysis.error = 'No playable 6-string guitar track';
      if (f.artist) analysis.artist = f.artist;
      if (f.composer) analysis.composer = f.composer;
      return analysis;
    },
    difficulty(bundle, arrangement) {
      difficultyCalls.push(arrangement);
      return fakeReport(Number(parse(bundle).tier ?? 1) + arrangement, false);
    },
  };
}

/** Write a starter folder with `manifest.json` and one `.atex` per item. */
export function writeStarter(dir: string, items: { slug: string; title: string; content: string; genre?: string[] }[]): void {
  const manifest: StarterManifest = {
    schema: 1,
    items: items.map((i) => ({
      slug: i.slug,
      title: i.title,
      credit: 'Arrangement original to Riffway',
      publicDomainNote: 'Test',
      tags: { style: ['pick'], genre: i.genre ?? [] },
      targetTier: 1,
      bpm: 100,
    })),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const i of items) writeFileSync(join(dir, `${i.slug}.atex`), i.content);
}

/** Options for {@link startApp}. */
export interface StartOptions extends Partial<AppOptions> {
  /** Extra adapter factories appended after local + starter. */
  extraSources?: SourceAdapterFactory[];
  local?: LocalAdapterOptions;
}

/** Started app plus helpers. `watcherReady` resolves once chokidar is watching (watch: true). */
export interface TestApp {
  app: FastifyInstance;
  ctx: ServerContext;
  analyzer: ReturnType<typeof createFakeAnalyzer>;
  watcherReady: Promise<void>;
}

/** Build an app over temp dirs with local + starter adapters and the fake analyzer; awaits the initial scan. */
export async function startApp(dirs: TempDirs, opts: StartOptions = {}): Promise<TestApp> {
  const analyzer = (opts.analyzer as ReturnType<typeof createFakeAnalyzer> | undefined) ?? createFakeAnalyzer();
  let markReady!: () => void;
  const watcherReady = new Promise<void>((r) => (markReady = r));
  const sources: SourceAdapterFactory[] = opts.sources
    ? [...opts.sources]
    : [
        () => createLocalAdapter({ ...opts.local, onReady: markReady }),
        () => createStarterAdapter({ dir: dirs.starterDir }),
        ...(opts.extraSources ?? []),
      ];
  const { app, ctx } = await createApp({
    dataDir: dirs.dataDir,
    libraryDir: dirs.libraryDir,
    staticDir: null,
    watch: false,
    ...opts,
    analyzer,
    sources,
  });
  await ctx.library.ready;
  return { app, ctx, analyzer, watcherReady };
}

/** Resolve with the first bus event matching `pred` (subscribe before triggering the change). */
export function waitForEvent<T extends ServerEvent>(bus: EventBus, pred: (e: ServerEvent) => e is T, timeoutMs?: number): Promise<T>;
export function waitForEvent(bus: EventBus, pred: (e: ServerEvent) => boolean, timeoutMs?: number): Promise<ServerEvent>;
export function waitForEvent(bus: EventBus, pred: (e: ServerEvent) => boolean, timeoutMs = 5000): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${timeoutMs} ms waiting for a server event`));
    }, timeoutMs);
    const unsubscribe = bus.subscribe((e) => {
      if (!pred(e)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(e);
    });
  });
}

/** Predicate for a `library.changed` event with a given reason (and optionally an id). */
export function libraryChanged(reason: 'added' | 'changed' | 'removed' | 'rescan', id?: string) {
  return (e: ServerEvent): e is Extract<ServerEvent, { type: 'library.changed' }> =>
    e.type === 'library.changed' && e.reason === reason && (id === undefined || e.ids.includes(id));
}

/** Encode files as a multipart body for `app.inject`. */
export async function multipart(files: { name: string; data: string | Uint8Array }[], field = 'files'): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  for (const f of files) form.append(field, new Blob([typeof f.data === 'string' ? f.data : new Uint8Array(f.data)]), f.name);
  const req = new Request('http://localhost/', { method: 'POST', body: form });
  return { payload: Buffer.from(await req.arrayBuffer()), headers: { 'content-type': req.headers.get('content-type') ?? '' } };
}
