/**
 * In-memory stand-in for the companion server behind the REAL typed API client (`createApiClient`
 * with an injected `fetch` and `EventSource`), plus a minimal AppContext for mounting the library
 * screen in happy-dom. Every request URL is recorded so tests can prove no third-party host is hit.
 */
import { vi } from 'vitest';
import type { ClassTabStatus, ImportFileResult, RemoteSearchResponse, SearchResponse, ServerConfig, ServerEvent, SongMeta, SourcesResponse } from '@shared/api';
import type { SearchResult } from '@shared/sources';
import { SOURCE_IDS, type TrackInfo } from '@shared/song';
import type { AppContext, RouteParams, ScreenId, ToastKind } from '@shared/ui';
import { createApiClient } from '../../src/api/client';
import { buildPath } from '../../src/ui/screens';

export function result(id: string, title: string, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    source: 'starter',
    title,
    fileName: `${title}.atex`,
    tier: 3,
    rating: 3.2,
    ratingProvisional: false,
    tuningId: 'standard',
    tuningLabel: 'Standard',
    tags: { style: ['pick'], genre: ['rock'], skills: [] },
    rhythm: 'exact',
    availability: 'playable',
    arrangements: 1,
    defaultArrangement: 0,
    durationSec: 75,
    score: 0,
    ...extra,
  };
}

const TRACK = (index: number, name: string): TrackInfo => ({ index, name, strings: 6, tuning: [64, 59, 55, 50, 45, 40], capo: 0, playable: true, noteCount: 40 });

/** A fake `EventSource` whose last instance can push server events. */
export class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  emit(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
  }
  close(): void {
    this.closed = true;
  }
}

/** Mutable fake server state. */
export interface FakeServer {
  songs: SearchResult[];
  config: ServerConfig;
  /** Requests as `METHOD path?query`. */
  requests: string[];
  /** Search queries received (parsed). */
  searches: URLSearchParams[];
  /** Song metas by id (`GET /api/songs/:id`). */
  metas: Map<string, SongMeta>;
  /** Respond to import uploads (default: everything imported into the library root). */
  importResult: (names: string[]) => ImportFileResult[];
  /** Make every request fail like an unreachable server. */
  down: boolean;
  /** Reject `PUT /api/config` with a 400 and this message. */
  configError: string | null;
  /** `GET /api/classtab/status` (null = 404, like a server without the route). */
  classtab: ClassTabStatus | null;
  /** `POST /api/classtab/refresh` bodies received. */
  classtabRefreshes: unknown[];
  /** `GET /api/search/remote` answer for a query (default: `off`). */
  remote: (q: string) => RemoteSearchResponse;
  /** Remote search queries received, and how many were aborted by the client. */
  remoteQueries: string[];
  remoteAborted: number;
  /** Delay before the remote answer (ms, fake timers), so tests can cancel a request in flight. */
  remoteDelayMs: number;
  fetch: typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function search(server: FakeServer, params: URLSearchParams): SearchResponse {
  const q = (params.get('q') ?? '').toLowerCase();
  const tags = (params.get('tags') ?? '').split(',').filter(Boolean);
  const sources = (params.get('source') ?? '').split(',').filter(Boolean);
  const tierMin = Number(params.get('tierMin') ?? 1);
  const tierMax = Number(params.get('tierMax') ?? 10);
  const playable = params.get('playable');
  const rows = server.songs.filter((s) => {
    if (q && !q.split(' ').every((w) => s.title.toLowerCase().includes(w))) return false;
    if (sources.length && !sources.includes(s.source)) return false;
    if ((params.has('tierMin') || params.has('tierMax')) && (s.tier === null || s.tier < tierMin || s.tier > tierMax)) return false;
    if (params.get('tuning') && s.tuningId !== params.get('tuning')) return false;
    if (playable !== null && (s.availability === 'playable') !== (playable === 'true')) return false;
    const have = [...s.tags.style, ...s.tags.genre, ...s.tags.skills];
    return tags.every((t) => have.includes(t));
  });
  const limit = Number(params.get('limit') ?? 50);
  const linkOuts = q
    ? [
        { source: 'songsterr' as const, label: 'Search on Songsterr', url: `https://www.songsterr.com/?pattern=${encodeURIComponent(q)}`, hint: 'Songsterr hint', localMatchIds: rows.map((r) => r.id) },
        { source: 'ultimate-guitar' as const, label: 'Search on Ultimate Guitar', url: `https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(q)}` },
      ]
    : [];
  return { results: rows.slice(0, limit), linkOuts, total: rows.length };
}

/** Create the fake server. */
export function createFakeServer(songs: SearchResult[]): FakeServer {
  const server: FakeServer = {
    songs,
    config: { schema: 1, libraryDir: '/Users/me/Music/Tabs', enabledSources: [...SOURCE_IDS], importSubfolder: '', remoteSearch: [] },
    requests: [],
    searches: [],
    metas: new Map(),
    importResult: (names) => names.map((name) => ({ name, status: 'imported', path: name })),
    down: false,
    configError: null,
    classtab: null,
    classtabRefreshes: [],
    remote: () => ({ source: 'songsterr', status: 'off', hits: [] }),
    remoteQueries: [],
    remoteAborted: 0,
    remoteDelayMs: 0,
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://127.0.0.1:5174');
      const method = init?.method ?? 'GET';
      server.requests.push(`${method} ${url.host}${url.pathname}${url.search}`);
      if (url.host !== '127.0.0.1:5174') throw new Error(`third-party request: ${url.href}`);
      if (server.down) throw new TypeError('Failed to fetch');
      const path = url.pathname;
      if (path === '/api/search/remote') {
        const q = url.searchParams.get('q') ?? '';
        server.remoteQueries.push(q);
        const signal = init?.signal;
        if (server.remoteDelayMs) await new Promise((r) => setTimeout(r, server.remoteDelayMs));
        if (signal?.aborted) {
          server.remoteAborted += 1;
          throw new DOMException('Aborted', 'AbortError');
        }
        return json(server.remote(q));
      }
      if (path === '/api/search') {
        server.searches.push(url.searchParams);
        return json(search(server, url.searchParams));
      }
      if (path === '/api/sources') {
        const count = (id: string): number => server.songs.filter((s) => s.source === id).length;
        const body: SourcesResponse = {
          sources: SOURCE_IDS.map((id) => ({
            id,
            displayName: id,
            kind: ['songsterr', 'ultimate-guitar', 'gp-pack'].includes(id) ? 'link-out' : 'library',
            enabled: server.config.enabledSources.includes(id),
            indexed: count(id),
            lastRefresh: null,
            state: 'idle',
            termsDoc: 'docs/sources/README.md',
          })),
        };
        return json(body);
      }
      if (path === '/api/config' && method === 'GET') return json(server.config);
      if (path === '/api/config' && method === 'PUT') {
        if (server.configError) return json({ error: server.configError, code: 'bad-request' }, 400);
        server.config = { ...server.config, ...(JSON.parse(String(init?.body)) as Partial<ServerConfig>) };
        return json(server.config);
      }
      if (path === '/api/library/rescan') return json({ started: true });
      if (path === '/api/classtab/status' && server.classtab) return json(server.classtab);
      if (path === '/api/classtab/refresh' && method === 'POST') {
        server.classtabRefreshes.push(JSON.parse(String(init?.body ?? '{}')));
        return json({ started: true });
      }
      if (path === '/api/library/import') {
        const form = init?.body as FormData;
        const names = form.getAll('files').map((f) => (f as File).name);
        return json({ files: server.importResult(names) });
      }
      const song = /^\/api\/songs\/([^/]+)$/.exec(path);
      if (song) {
        const meta = server.metas.get(decodeURIComponent(song[1]!));
        return meta ? json(meta) : json({ error: 'Song not found', code: 'not-found' }, 404);
      }
      return json({ error: 'not found', code: 'not-found' }, 404);
    }) as typeof fetch,
  };
  return server;
}

/** A ClassTab status (default: not downloaded). */
export function classtabStatus(extra: Partial<ClassTabStatus> = {}): ClassTabStatus {
  return { state: 'not-downloaded', lastRefresh: null, etag: null, lastModified: null, tabs: 0, midis: 0, rhythm: { midi: 0, ruler: 0, needsAlignment: 0 }, ...extra };
}

/** A song meta with the given tracks. */
export function meta(r: SearchResult, trackNames: string[], error?: string): SongMeta {
  const tracks = trackNames.map((n, i) => TRACK(i, n));
  return {
    entry: { ...(r as unknown as SongMeta['entry']), tracks, defaultArrangement: 0, ...(error ? { error } : {}) },
    arrangements: tracks,
    difficulty: { 0: { version: 1, rating: 3, tier: 3, tierName: 'Developing', provisional: false, sections: [], skills: [], highlights: [] } },
    files: { main: `/api/songs/${encodeURIComponent(r.id)}/file` },
  };
}

/** Recorded UI effects. */
export interface FakeCtx {
  ctx: AppContext;
  toasts: { message: string; kind: ToastKind | undefined }[];
  navigations: string[];
}

/** Minimal AppContext over the fake server (real API client, recording router and toasts). */
export function fakeContext(server: FakeServer): FakeCtx {
  const toasts: FakeCtx['toasts'] = [];
  const navigations: string[] = [];
  const api = createApiClient({ fetch: server.fetch, EventSource: FakeEventSource as unknown as typeof EventSource });
  const ctx = {
    api,
    router: {
      href: (screen: ScreenId, params?: RouteParams) => `#${buildPath(screen, params)}`,
      navigate: (path: string) => void navigations.push(path),
      current: () => null,
      back: () => {},
      onChange: () => () => {},
    },
    ui: {
      toast: (message: string, opts?: { kind?: ToastKind }) => void toasts.push({ message, kind: opts?.kind }),
      confirm: async () => true,
      requireAudioGesture: async () => {},
    },
    flags: { e2e: false, dev: false },
  } as unknown as AppContext;
  return { ctx, toasts, navigations };
}
