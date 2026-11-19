/**
 * Test doubles for the settings and audio-setup screens: an in-memory companion server behind the
 * real API client (config, sources, ClassTab, sidecars, rescan), a fake `EventSource`, real storage
 * on fake-indexeddb, and a recording AppContext.
 */
import 'fake-indexeddb/auto';
import { vi } from 'vitest';
import type { ClassTabRefreshResponse, ClassTabStatus, ServerConfig, ServerEvent, SourcesResponse } from '@shared/api';
import { SOURCE_IDS, type RhythmSidecar } from '@shared/song';
import type { AppContext, RouteParams, ScreenId, ToastKind } from '@shared/ui';
import { createApiClient } from '../../src/api/client';
import { openStorage, type RiffwayStorage } from '../../src/storage';
import { buildPath } from '../../src/ui/screens';

/** A fake `EventSource`; the last instance can push server events. */
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

/** Mutable fake server. */
export interface FakeServer {
  config: ServerConfig;
  classtab: ClassTabStatus;
  /** Answer of `POST /api/classtab/refresh` (non-forced). */
  refreshAnswer: ClassTabRefreshResponse;
  sidecars: Record<string, RhythmSidecar>;
  /** Bodies received by `POST /api/sidecars`. */
  postedSidecars: Record<string, RhythmSidecar>[];
  /** Requests as `METHOD path` (+ JSON body when present). */
  requests: string[];
  down: boolean;
  configError: string | null;
  fetch: typeof fetch;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** ClassTab after a real run (counts from docs/sources/classtab.md). */
export function readyClassTab(): ClassTabStatus {
  return {
    state: 'ready',
    lastRefresh: Date.UTC(2026, 10, 19, 20, 0),
    etag: '"d9d168-65f3c90fbc18b"',
    lastModified: 'Sun, 01 Nov 2026 20:06:35 GMT',
    tabs: 3976,
    midis: 2341,
    rhythm: { midi: 1921, ruler: 432, needsAlignment: 1616 },
  };
}

/** Create the fake server. */
export function createFakeServer(): FakeServer {
  const server: FakeServer = {
    config: { schema: 1, libraryDir: '/Users/me/Music/Tabs', enabledSources: [...SOURCE_IDS], importSubfolder: '' },
    classtab: readyClassTab(),
    refreshAnswer: { started: true },
    sidecars: {},
    postedSidecars: [],
    requests: [],
    down: false,
    configError: null,
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://127.0.0.1:5174');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : '';
      server.requests.push(`${method} ${url.pathname}${body ? ` ${body}` : ''}`);
      if (server.down) throw new TypeError('Failed to fetch');
      const path = url.pathname;
      if (path === '/api/config' && method === 'GET') return json(server.config);
      if (path === '/api/config' && method === 'PUT') {
        if (server.configError) return json({ error: server.configError, code: 'bad-request' }, 400);
        server.config = { ...server.config, ...(JSON.parse(body) as Partial<ServerConfig>) };
        return json(server.config);
      }
      if (path === '/api/sources') {
        const kinds: Record<string, 'library' | 'download' | 'link-out'> = { local: 'library', starter: 'library', classtab: 'download' };
        const names: Record<string, string> = { local: 'Local library', starter: 'Starter library', classtab: 'ClassTab' };
        const res: SourcesResponse = {
          sources: SOURCE_IDS.map((id) => ({
            id,
            displayName: names[id] ?? id,
            kind: kinds[id] ?? 'link-out',
            enabled: server.config.enabledSources.includes(id),
            indexed: id === 'starter' ? 14 : id === 'classtab' ? 3976 : id === 'local' ? 12 : 0,
            lastRefresh: null,
            state: 'idle',
            termsDoc: `docs/sources/${id}.md`,
          })),
        };
        return json(res);
      }
      if (path === '/api/classtab/status') return json(server.classtab);
      if (path === '/api/classtab/refresh') {
        const force = (JSON.parse(body || '{}') as { force?: boolean }).force === true;
        return json(force ? { started: true } : server.refreshAnswer, force || server.refreshAnswer.started ? 202 : 200);
      }
      if (path === '/api/library/rescan') return json({ started: true });
      if (path === '/api/sidecars' && method === 'GET') return json({ sidecars: server.sidecars });
      if (path === '/api/sidecars' && method === 'POST') {
        const posted = (JSON.parse(body) as { sidecars: Record<string, RhythmSidecar> }).sidecars;
        server.postedSidecars.push(posted);
        Object.assign(server.sidecars, posted);
        return json({ written: Object.keys(posted).length });
      }
      return json({ error: 'not found', code: 'not-found' }, 404);
    }) as typeof fetch,
  };
  return server;
}

/** Recorded UI effects and the context. */
export interface FakeCtx {
  ctx: AppContext;
  storage: RiffwayStorage;
  dbName: string;
  toasts: { message: string; kind: ToastKind | undefined }[];
  navigations: string[];
  confirms: { message: string; title?: string; danger?: boolean }[];
  /** Answer for the next `ui.confirm` calls. */
  confirmAnswer: boolean;
}

let n = 0;

/** A context over the fake server and a fresh (or named) fake-indexeddb database. */
export async function fakeContext(server: FakeServer, dbName?: string): Promise<FakeCtx> {
  n += 1;
  const name = dbName ?? `riffway-settings-${n}-${Math.random().toString(36).slice(2)}`;
  const storage = await openStorage({ dbName: name });
  const api = createApiClient({ fetch: server.fetch, EventSource: FakeEventSource as unknown as typeof EventSource });
  const fake: FakeCtx = {
    storage,
    dbName: name,
    toasts: [],
    navigations: [],
    confirms: [],
    confirmAnswer: true,
    ctx: null as unknown as AppContext,
  };
  fake.ctx = {
    api,
    storage,
    settings: storage.settings,
    services: {
      get: () => Promise.reject(new Error('no services in settings tests')),
      peek: () => null,
    },
    router: {
      href: (screen: ScreenId, params?: RouteParams) => `#${buildPath(screen, params)}`,
      navigate: (path: string) => void fake.navigations.push(path),
      current: () => null,
      back: () => {},
      onChange: () => () => {},
    },
    ui: {
      toast: (message: string, opts?: { kind?: ToastKind }) => void fake.toasts.push({ message, kind: opts?.kind }),
      confirm: async (message: string, opts?: { title?: string; danger?: boolean }) => {
        fake.confirms.push({ message, title: opts?.title, danger: opts?.danger });
        return fake.confirmAnswer;
      },
      requireAudioGesture: async () => {},
    },
    flags: { e2e: false, dev: false },
  };
  return fake;
}

/** Let promises, fake-indexeddb and timers settle (real timers). */
export async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}
