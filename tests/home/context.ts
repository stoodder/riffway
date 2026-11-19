/**
 * A test `AppContext` for the home and song screens: real IndexedDB storage (fake-indexeddb), a fake
 * API with just the calls these screens make, a recording router/toaster and fake services.
 */
import 'fake-indexeddb/auto';
import type { ApiClient, SongMeta } from '@shared/api';
import type { Song } from '@shared/song';
import type { SearchResult } from '@shared/sources';
import type { AppContext, RouteParams, ScreenId, ToastKind } from '@shared/ui';
import { ApiError } from '../../src/api/client';
import { openStorage, type RiffwayStorage } from '../../src/storage';
import { buildPath } from '../../src/ui/screens';

export interface TestCtx {
  ctx: AppContext;
  storage: RiffwayStorage;
  toasts: { message: string; kind: ToastKind | undefined }[];
  navigations: { path: string; replace: boolean }[];
  /** Server state the fake API reads. */
  server: { songs: SearchResult[]; metas: Map<string, SongMeta>; down: boolean; searches: number };
  /** Songs the fake song loader returns by id. */
  songs: Map<string, Song>;
  /** Transport state the engine peek reports (null = no engine created). */
  transport: { state: 'stopped' | 'playing' | 'count-in' | 'paused' } | null;
  emitLibraryChanged(): void;
}

let n = 0;

export async function testContext(songs: SearchResult[] = []): Promise<TestCtx> {
  n += 1;
  const storage = await openStorage({ dbName: `riffway-home-${n}-${Math.random().toString(36).slice(2)}` });
  const toasts: TestCtx['toasts'] = [];
  const navigations: TestCtx['navigations'] = [];
  const listeners = new Set<(e: { type: 'library.changed'; ids: string[]; reason: 'rescan' }) => void>();
  const t: TestCtx = {
    ctx: null as unknown as AppContext,
    storage,
    toasts,
    navigations,
    server: { songs, metas: new Map(), down: false, searches: 0 },
    songs: new Map(),
    transport: null,
    emitLibraryChanged: () => listeners.forEach((cb) => cb({ type: 'library.changed', ids: [], reason: 'rescan' })),
  };
  const offline = (): never => {
    throw new TypeError('Failed to fetch');
  };
  const meta = async (id: string): Promise<SongMeta> => {
    if (t.server.down) offline();
    const m = t.server.metas.get(id);
    if (!m) throw new ApiError(404, { error: 'Song not found', code: 'not-found' }, 'Not found');
    return m;
  };
  const api: Partial<ApiClient> = {
    search: async () => {
      t.server.searches += 1;
      if (t.server.down) offline();
      return { results: t.server.songs, linkOuts: [], total: t.server.songs.length };
    },
    song: meta,
    songBundle: async (id) => {
      await meta(id);
      return { fileName: 'x.atex', data: new Uint8Array(), id };
    },
    subscribe: (cb) => {
      listeners.add(cb as never);
      return () => listeners.delete(cb as never);
    },
  };
  t.ctx = {
    api: api as ApiClient,
    settings: storage.settings,
    storage,
    services: {
      get: async (id: string) => {
        if (id === 'songLoader') {
          return {
            load: async (bundle: { id?: string }) => {
              const song = t.songs.get(bundle.id ?? '');
              if (!song) throw new Error('cannot load');
              return song;
            },
          };
        }
        throw new Error(`service ${id} not available in tests`);
      },
      peek: (id: string) => (id === 'engine' && t.transport ? { transport: t.transport } : null),
    },
    router: {
      href: (screen: ScreenId, params?: RouteParams) => `#${buildPath(screen, params)}`,
      navigate: (path: string, opts?: { replace?: boolean }) => void navigations.push({ path, replace: opts?.replace === true }),
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
  return t;
}

/** Poll until `check` stops throwing (or 2 s pass). */
export async function eventually(check: () => void, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
