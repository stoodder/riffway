import { describe, expect, it } from 'vitest';
import { API_ROUTES, type ApiClient, type SongMeta } from '@shared/api';
import { ApiError, createApiClient, searchQueryString } from '../../src/api/client';

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe('API client', () => {
  it('has a method for every endpoint', () => {
    const client = createApiClient({ fetch: fakeFetch(() => new Response('{}')).fetch });
    const names = Object.keys(API_ROUTES).map((n) => (n === 'events' ? 'subscribe' : n)) as (keyof ApiClient)[];
    for (const name of names) expect(typeof client[name], name).toBe('function');
  });

  it('builds search query strings (arrays comma-separated, empties skipped)', () => {
    expect(searchQueryString({ q: 'mountain king', source: ['local', 'starter'], tierMin: 2, playable: true, tags: [] })).toBe(
      '?q=mountain+king&source=local%2Cstarter&tierMin=2&playable=true',
    );
    expect(searchQueryString({})).toBe('');
  });

  it('encodes song ids and raises ApiError with the server code', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(JSON.stringify({ error: 'nope', code: 'not-implemented' }), { status: 501 }));
    const client = createApiClient({ fetch });
    await expect(client.song('local:ab12')).rejects.toMatchObject({ status: 501, code: 'not-implemented' });
    await expect(client.song('local:ab12')).rejects.toBeInstanceOf(ApiError);
    expect(calls[0]).toBe('GET /api/songs/local%3Aab12');
  });

  it('assembles a song bundle from meta, file, MIDI and sidecar', async () => {
    const meta = {
      entry: { fileName: 'bach.txt', source: 'classtab', path: 'bach.txt', tags: { style: ['fingerstyle'], genre: [], skills: [] } },
      files: { main: '/api/songs/x/file', rhythm: '/api/songs/x/rhythm', sidecar: '/api/songs/x/sidecar' },
    } as unknown as SongMeta;
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith('/file')) return new Response(new Uint8Array([1, 2, 3]));
      if (url.endsWith('/rhythm')) return new Response(new Uint8Array([9]));
      if (url.endsWith('/sidecar')) return new Response(JSON.stringify({ schema: 1, bpm: 90 }));
      return new Response(JSON.stringify(meta));
    });
    const bundle = await createApiClient({ fetch }).songBundle('classtab:x');
    expect(Array.from(bundle.data)).toEqual([1, 2, 3]);
    expect(bundle.midi?.fileName).toBe('bach.mid');
    expect(bundle.sidecar?.bpm).toBe(90);
    expect(bundle.source).toEqual({ source: 'classtab', path: 'bach.txt' });
  });
});
