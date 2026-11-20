/**
 * Typed client for every companion-server endpoint (`shared/api.ts`) plus SSE subscribe.
 * Same-origin by default: Vite proxies `/api` to the server in dev (D7); the server serves the page
 * in production. Frozen by T-010; an endpoint change goes through a contract change request.
 * @module
 */
import type {
  ApiClient,
  ApiErrorBody,
  AudioUploadResponse,
  ClassTabRefreshRequest,
  ClassTabRefreshResponse,
  ClassTabStatus,
  ConfigUpdate,
  FileListLike,
  HealthResponse,
  ImportResponse,
  PasteRequest,
  PasteResponse,
  RemoteSearchResponse,
  RescanResponse,
  SearchQuery,
  SearchResponse,
  ServerConfig,
  ServerEvent,
  SidecarsBundle,
  SidecarsImportResponse,
  SongMeta,
  SourcesResponse,
} from '@shared/api';
import type { Unsubscribe } from '@shared/clock';
import type { RhythmSidecar, SongBundle, SourceId, SourceRef } from '@shared/song';

/** A non-2xx response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, body: Partial<ApiErrorBody>, fallback: string) {
    super(body.error ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
  }
}

/** Client options (tests inject `fetch` / `EventSource`). */
export interface ApiClientOptions {
  /** Prefix for every path (default `''` = same origin). */
  baseUrl?: string;
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
}

/** Encode a song id (contains `:`) for a path segment. */
export const encodeId = (id: string): string => encodeURIComponent(id);

/** Build the query string for `GET /api/search` (arrays comma-separated, undefined skipped). */
export function searchQueryString(query: SearchQuery): string {
  const params = new URLSearchParams();
  const put = (key: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  };
  put('q', query.q);
  put('source', query.source);
  put('tierMin', query.tierMin);
  put('tierMax', query.tierMax);
  put('tuning', query.tuning);
  put('playable', query.playable);
  put('tags', query.tags);
  put('limit', query.limit);
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** Create the client. */
export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const base = opts.baseUrl ?? '';
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request(
    method: string,
    path: string,
    body?: BodyInit | object,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (signal) init.signal = signal;
    if (body !== undefined) {
      if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || typeof body === 'string') {
        init.body = body as BodyInit;
      } else {
        init.body = JSON.stringify(body);
        (init.headers as Record<string, string>)['content-type'] = 'application/json';
      }
    }
    const res = await doFetch(base + path, init);
    if (!res.ok) {
      let parsed: Partial<ApiErrorBody> = {};
      try {
        parsed = (await res.json()) as Partial<ApiErrorBody>;
      } catch {
        // non-JSON error body
      }
      throw new ApiError(res.status, parsed, `${method} ${path} failed with ${res.status}`);
    }
    return res;
  }

  const json = async <T>(method: string, path: string, body?: object): Promise<T> =>
    (await request(method, path, body)).json() as Promise<T>;
  const bytes = async (path: string): Promise<Uint8Array> => new Uint8Array(await (await request('GET', path)).arrayBuffer());

  async function getSidecar(id: string): Promise<RhythmSidecar | null> {
    try {
      return await json<RhythmSidecar>('GET', `/api/songs/${encodeId(id)}/sidecar`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Multipart upload with progress (XHR when available and progress is requested). */
  async function upload<T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
    if (!onProgress || typeof XMLHttpRequest === 'undefined' || opts.fetch) {
      const res = await request('POST', path, form);
      onProgress?.(1);
      return (await res.json()) as T;
    }
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', base + path);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(1);
          resolve(xhr.response as T);
        } else {
          reject(new ApiError(xhr.status, (xhr.response ?? {}) as Partial<ApiErrorBody>, `POST ${path} failed with ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, {}, `POST ${path} failed (network)`));
      xhr.send(form);
    });
  }

  const client: ApiClient = {
    health: () => json<HealthResponse>('GET', '/api/health'),
    getConfig: () => json<ServerConfig>('GET', '/api/config'),
    putConfig: (update: ConfigUpdate) => json<ServerConfig>('PUT', '/api/config', update),
    sources: () => json<SourcesResponse>('GET', '/api/sources'),
    search: (query: SearchQuery) => json<SearchResponse>('GET', `/api/search${searchQueryString(query)}`),
    searchRemote: async (q: string, source: SourceId, signal?: AbortSignal) =>
      (await request('GET', `/api/search/remote?q=${encodeURIComponent(q)}&source=${encodeURIComponent(source)}`, undefined, {}, signal)).json() as Promise<RemoteSearchResponse>,
    song: (id) => json<SongMeta>('GET', `/api/songs/${encodeId(id)}`),
    songFile: (id) => bytes(`/api/songs/${encodeId(id)}/file`),
    songRhythm: (id) => bytes(`/api/songs/${encodeId(id)}/rhythm`),
    getSidecar,
    putSidecar: (id, sidecar) => json<RhythmSidecar>('PUT', `/api/songs/${encodeId(id)}/sidecar`, sidecar),
    async songBundle(id): Promise<SongBundle> {
      const meta = await client.song(id);
      const [data, midi, sidecar] = await Promise.all([
        bytes(meta.files.main),
        meta.files.rhythm ? bytes(meta.files.rhythm) : Promise.resolve(undefined),
        meta.files.sidecar ? getSidecar(id) : Promise.resolve(null),
      ]);
      const source: SourceRef = { source: meta.entry.source, path: meta.entry.path };
      if (meta.entry.url) source.url = meta.entry.url;
      const bundle: SongBundle = { fileName: meta.entry.fileName, data, id, source };
      if (meta.entry.tags) bundle.tags = meta.entry.tags;
      if (midi) bundle.midi = { fileName: meta.entry.fileName.replace(/\.[^.]+$/, '.mid'), data: midi };
      if (sidecar) bundle.sidecar = sidecar;
      return bundle;
    },
    importFiles(files: readonly Blob[] | FileListLike, onProgress?: (fraction: number) => void): Promise<ImportResponse> {
      const form = new FormData();
      const list: Blob[] = Array.isArray(files)
        ? [...(files as readonly Blob[])]
        : Array.from({ length: (files as FileListLike).length }, (_, i) => (files as FileListLike).item(i)).filter((f): f is Blob => f !== null);
      for (const f of list) form.append('files', f, (f as File).name ?? 'upload');
      return upload<ImportResponse>('/api/library/import', form, onProgress);
    },
    paste: (req: PasteRequest) => json<PasteResponse>('POST', '/api/library/paste', req),
    rescan: () => json<RescanResponse>('POST', '/api/library/rescan', {}),
    classtabStatus: () => json<ClassTabStatus>('GET', '/api/classtab/status'),
    classtabRefresh: (req: ClassTabRefreshRequest = {}) => json<ClassTabRefreshResponse>('POST', '/api/classtab/refresh', req),
    uploadAudio(file: Blob, fileName: string): Promise<AudioUploadResponse> {
      const form = new FormData();
      form.append('file', file, fileName);
      return upload<AudioUploadResponse>('/api/audio', form);
    },
    getAudio: async (audioId) => (await request('GET', `/api/audio/${encodeId(audioId)}`)).arrayBuffer(),
    audioUrl: (audioId) => `${base}/api/audio/${encodeId(audioId)}`,
    deleteAudio: async (audioId) => {
      await request('DELETE', `/api/audio/${encodeId(audioId)}`);
    },
    getSidecars: () => json<SidecarsBundle>('GET', '/api/sidecars'),
    postSidecars: (bundle: SidecarsBundle) => json<SidecarsImportResponse>('POST', '/api/sidecars', bundle),
    subscribe(onEvent: (event: ServerEvent) => void): Unsubscribe {
      const ES = opts.EventSource ?? (typeof EventSource === 'undefined' ? undefined : EventSource);
      if (!ES) return () => {};
      const source = new ES(`${base}/api/events`);
      source.onmessage = (e: MessageEvent<string>) => {
        try {
          onEvent(JSON.parse(e.data) as ServerEvent);
        } catch {
          // ignore malformed events
        }
      };
      return () => source.close();
    },
  };
  return client;
}
