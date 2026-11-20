# Guide: in-app Songsterr search (owner-implemented)

Status: **plan for the owner to implement.** Riffway currently ships Songsterr as a link-out only
(TASKS.md D1, `docs/sources/songsterr.md`). This guide adds opt-in, search-only results from a remote
catalog without changing anything else. Every Riffway-side file, type, route, UI piece, guard change
and test is spelled out below. The two Songsterr-specific pieces are yours to write: the request URL
in `client.ts` and the response mapping in `map.ts`. Both are marked `OWNER:`.

Design rules this guide follows:
- **Opt-in.** Off by default; turned on in Settings › Library & sources. Stored in the server config.
- **Search metadata only.** Title, artist, tracks, tuning and a link to the song page. No tab content
  is fetched. Getting the song stays manual: download the Guitar Pro file, drop it into Riffway.
- **Polite.** One request per typed query, at most 1 per second, 24 h cache, honest User-Agent, 4 s
  timeout. On 403 or 429 the feature turns itself off for the session and the link-out takes over.
  No retries, no header changes.
- **Never blocks local search.** A separate endpoint, so library results render first and remote
  results arrive after.
- **Tested offline.** Recorded fixtures only; no test touches the network.

Work in this order. Run `npm run typecheck` after each step.

| Step | What | Files |
|---|---|---|
| 1 | Types and contracts | `shared/sources.ts`, `shared/api.ts` |
| 2 | Server config flag | `server/config-store.ts` |
| 3 | Adapter: limiter, cache, client, map, index | `server/sources/songsterr/*` (new), `server/sources/registry.ts` |
| 4 | Route | `server/routes/search-remote.ts` (new), `server/routes/index.ts` |
| 5 | API client | `src/api/client.ts` |
| 6 | Guards | `eslint.config.js`, `tests/server/network-guard.test.ts`, `tests/foundation/lint-guards.test.ts` |
| 7 | Library UI | `src/ui/screens/library/remote-results.ts` (new), `index.ts`, `library.css` |
| 8 | Settings toggle | `src/ui/screens/settings/library.ts` |
| 9 | Tests | `tests/fixtures/songsterr/`, `tests/songsterr/` (new) |
| 10 | Docs and decision record | `TASKS.md`, `CLAUDE.md`, `docs/sources/*`, `docs/architecture.md` |

---

## 1. Types and contracts

### `shared/sources.ts`

Add after the `LinkOut` interface (around line 127):

```ts
/** One remote catalog hit (search metadata only; no tab content). */
export interface RemoteSearchHit {
  source: SourceId;
  /** The remote site's id for the song (stable; used to link imports back to hits). */
  remoteId: string;
  title: string;
  artist?: string;
  /** Song page on the remote site, opened in a new tab. */
  url: string;
  /** Guitar tracks only (6-string). Empty when the site lists none. */
  tracks: { name: string; tuning?: number[] }[];
  /** MIDI tuning of the first guitar track, string 1 = high e (same order as `IndexEntry.tuning`). */
  tuning?: number[];
  /** Filter slug and label from `describeTuning` (`'drop-d'`, `'Drop D'`, …). */
  tuningId?: string;
  tuningLabel?: string;
  /** Indexed songs that match this hit by normalized title + artist (playable now). */
  localMatchIds?: string[];
}
```

Add one optional method to `SourceAdapter` (after `matchLocal?`, around line 223):

```ts
  /**
   * Remote catalog search (opt-in; `ServerConfig.remoteSearch`). Metadata only. Must honor `signal`,
   * rate-limit itself and throw {@link RemoteSearchRefused} on 403/429.
   */
  searchRemote?(query: string, ctx: AdapterContext, signal: AbortSignal): Promise<RemoteSearchHit[]>;
```

And an error class at the end of the file:

```ts
/** The remote site refused the request (403/429). The adapter turns remote search off for the session. */
export class RemoteSearchRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'RemoteSearchRefused';
  }
}
```

### `shared/api.ts`

1. In `API_ROUTES` (line 33), add a line:
   ```ts
   searchRemote: 'GET /api/search/remote',
   ```
2. In `ServerConfig` (line 75), add a field:
   ```ts
   /** Sources allowed to search their remote catalog (opt-in; default none). */
   remoteSearch: SourceId[];
   ```
3. Add the response type next to `SearchResponse`:
   ```ts
   /** `GET /api/search/remote?q=&source=`. */
   export interface RemoteSearchResponse {
     source: SourceId;
     /** `'off'`: not enabled in settings. `'refused'`: the site said no (403/429), off until restart. */
     status: 'ok' | 'off' | 'refused' | 'error';
     message?: string;
     hits: RemoteSearchHit[];
   }
   ```
   Import `RemoteSearchHit` from `./sources` at the top.
4. In the `ApiClient` interface (line 216), add:
   ```ts
   searchRemote(query: string, source: SourceId, signal?: AbortSignal): Promise<RemoteSearchResponse>;
   ```

---

## 2. Server config flag: `server/config-store.ts`

1. `defaultConfig` (line 17): add `remoteSearch: []`.
2. `parseConfigUpdate`: add a case next to `enabledSources`:
   ```ts
   case 'remoteSearch': {
     if (!Array.isArray(value) || !value.every((v): v is SourceId => typeof v === 'string' && SOURCE_IDS.includes(v as SourceId))) {
       throw new ConfigError(`remoteSearch must be a list of: ${SOURCE_IDS.join(', ')}`);
     }
     patch.remoteSearch = SOURCE_IDS.filter((id) => value.includes(id));
     break;
   }
   ```
`sanitizeStored` reuses `parseConfigUpdate`, so existing `config.json` files pick up the default.
Update any test that compares a whole default config object (`grep -rn "importSubfolder: ''" tests`).

---

## 3. Adapter: `server/sources/songsterr/` (new folder)

Five files. Keep `server/sources/linkout/songsterr.ts` as it is: the new adapter reuses its link-out.

### 3a. `limiter.ts` (complete)

```ts
/** At most one request per `intervalMs`; a newer call supersedes a waiting one. */
export function createLimiter(intervalMs = 1000, now: () => number = Date.now) {
  let last = -Infinity;
  let waiting: { cancel: () => void } | null = null;
  return async function slot(signal: AbortSignal): Promise<void> {
    waiting?.cancel();
    const wait = Math.max(0, last + intervalMs - now());
    if (wait > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, wait);
        function done() { waiting = null; resolve(); }
        function cancel() { clearTimeout(timer); waiting = null; reject(new DOMException('Superseded', 'AbortError')); }
        waiting = { cancel };
        signal.addEventListener('abort', cancel, { once: true });
      });
    }
    signal.throwIfAborted();
    last = now();
  };
}
```

### 3b. `cache.ts` (complete)

```ts
import type { RemoteSearchHit } from '@shared/sources';

interface Entry { at: number; hits: RemoteSearchHit[] }

/** Small LRU cache of query → hits (without `localMatchIds`, which are recomputed per request). */
export function createSearchCache(max = 200, ttlMs = 24 * 3600_000, now: () => number = Date.now) {
  const map = new Map<string, Entry>();
  const key = (q: string) => q.trim().toLowerCase().replace(/\s+/g, ' ');
  return {
    get(q: string): RemoteSearchHit[] | undefined {
      const k = key(q);
      const e = map.get(k);
      if (!e) return undefined;
      if (now() - e.at > ttlMs) { map.delete(k); return undefined; }
      map.delete(k); map.set(k, e); // refresh LRU order
      return e.hits;
    },
    set(q: string, hits: RemoteSearchHit[]): void {
      map.set(key(q), { at: now(), hits });
      while (map.size > max) map.delete(map.keys().next().value as string);
    },
  };
}
```

You can persist it to `<dataDir>/songsterr-cache.json` later with `server/json-file.ts`
(`readJsonFile` / `writeJsonFile`); in memory is fine to start.

### 3c. `client.ts` (you fill in the request)

This is the only file that talks to the remote site, and the only one the guards will allow (step 6).

```ts
import { RemoteSearchRefused } from '@shared/sources';

/** Honest identification; no personal info. */
export const USER_AGENT = 'Riffway/0.1 (personal local practice app)';
export const TIMEOUT_MS = 4000;

/** OWNER: build the search request URL for `query`. */
export function buildSearchUrl(query: string): string {
  throw new Error('OWNER: implement buildSearchUrl');
}

/** Injected in tests; defaults to global fetch. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** GET the search URL; returns parsed JSON. Throws RemoteSearchRefused on 403/429, Error otherwise. */
export async function fetchSearch(query: string, signal: AbortSignal, fetchImpl: FetchLike = fetch): Promise<unknown> {
  const res = await fetchImpl(buildSearchUrl(query), {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (res.status === 403 || res.status === 429) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new RemoteSearchRefused(res.status, text || `HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  return res.json();
}
```

### 3d. `map.ts` (pure; you fill in the response shape)

```ts
import type { RemoteSearchHit } from '@shared/sources';
import { describeTuning } from '@core/model/tuning';

/** OWNER: the shape of one item in the search response (only the fields you use). */
export interface RawSong {
  // e.g. id, title, artist name, tracks with instrument + tuning …
}

/** OWNER: song page URL for a raw item. */
export function songUrl(raw: RawSong): string {
  throw new Error('OWNER: implement songUrl');
}

/**
 * OWNER: return the raw tuning as MIDI note numbers, or undefined.
 * Riffway order is string 1 = high e. If the site lists low → high, reverse it.
 */
export function rawTuning(track: unknown): number[] | undefined {
  return undefined;
}

/** Keep 6-string guitar tracks only. OWNER: decide from the track's instrument fields. */
export function isSixStringGuitar(track: unknown): boolean {
  return false;
}

/** Response JSON → hits. Never throws on odd items: skips them. */
export function mapSearchResponse(json: unknown): RemoteSearchHit[] {
  if (!Array.isArray(json)) return [];
  const out: RemoteSearchHit[] = [];
  for (const raw of json as RawSong[]) {
    // OWNER: read id/title/artist/tracks from `raw`; skip the item if id or title is missing.
    const remoteId = ''; const title = ''; const artist: string | undefined = undefined;
    const rawTracks: unknown[] = [];
    if (!remoteId || !title) continue;
    const tracks = rawTracks.filter(isSixStringGuitar).map((t) => ({ name: '', tuning: rawTuning(t) }));
    const tuning = tracks.find((t) => t.tuning?.length === 6)?.tuning;
    const described = tuning ? describeTuning(tuning) : undefined;
    out.push({
      source: 'songsterr', remoteId, title, artist, url: songUrl(raw), tracks,
      tuning, tuningId: described?.id, tuningLabel: described?.label,
    });
  }
  return out;
}
```

`describeTuning` (`src/core/model/tuning.ts:31`) expects high → low order and gives you the same
`tuningId` slugs the Library's tuning filter uses, so remote rows filter like local ones.

### 3e. `index.ts` (complete)

```ts
import { RemoteSearchRefused, type RemoteSearchHit, type SourceAdapter } from '@shared/sources';
import { createSongsterrAdapter as createLinkOut } from '../linkout/songsterr';
import { matchLocalEntries } from '../linkout/match';
import { idleStatus } from '../stub';
import { createSearchCache } from './cache';
import { fetchSearch, type FetchLike } from './client';
import { createLimiter } from './limiter';
import { mapSearchResponse } from './map';

const MIN_QUERY = 3;
const MAX_HITS = 20;

/** Songsterr: link-out (always) + opt-in remote search (this guide). */
export function createSongsterrAdapter(deps: { fetchImpl?: FetchLike } = {}): SourceAdapter {
  const base = createLinkOut();
  const cache = createSearchCache();
  const slot = createLimiter(1000);
  let refused: string | null = null;

  const adapter: SourceAdapter = {
    ...base,
    kind: 'link-out',
    async searchRemote(query, ctx, signal): Promise<RemoteSearchHit[]> {
      const q = query.trim();
      if (q.length < MIN_QUERY) return [];
      if (refused) throw new RemoteSearchRefused(403, refused);
      let hits = cache.get(q);
      if (!hits) {
        await slot(signal);
        try {
          hits = mapSearchResponse(await fetchSearch(q, signal, deps.fetchImpl)).slice(0, MAX_HITS);
        } catch (err) {
          if (err instanceof RemoteSearchRefused) {
            refused = err.message;
            ctx.log.warn('Songsterr refused remote search; off until restart', err.status);
          }
          throw err;
        }
        cache.set(q, hits);
      }
      const entries = ctx.entries();
      return hits.map((h) => {
        const ids = matchLocalEntries(`${h.title} ${h.artist ?? ''}`, entries);
        return ids.length ? { ...h, localMatchIds: ids } : h;
      });
    },
    status: async () =>
      idleStatus(adapter, refused ? `Remote search refused by the site (${refused.slice(0, 80)}). Link-out still works.` : 'Link-out, plus remote search when enabled in Settings.'),
  };
  return adapter;
}
```

### 3f. `server/sources/registry.ts`

Change the import on line 10 and update the header comment on line 3:

```ts
import { createSongsterrAdapter } from './songsterr';
```

Line 3 currently says link-out adapters do no network I/O and that `songsterr.com/api` is
forbidden. Change it to say remote search lives only in `server/sources/songsterr/client.ts`, opt-in
(see `docs/guides/songsterr-search.md`).

---

## 4. Route: `server/routes/search-remote.ts` (new, complete)

```ts
import type { RemoteSearchResponse } from '@shared/api';
import { SOURCE_IDS, type SourceId } from '@shared/song';
import { RemoteSearchRefused } from '@shared/sources';
import { sendError } from '../http';
import type { RouteModule } from '../types';

export const register: RouteModule = async (app, ctx) => {
  app.get('/api/search/remote', async (req, reply) => {
    const { q, source } = req.query as { q?: string; source?: string };
    const id = (source ?? 'songsterr') as SourceId;
    if (!SOURCE_IDS.includes(id)) return sendError(reply, 400, 'bad-request', `Unknown source: ${source}`);
    const adapter = ctx.sources.find((s) => s.id === id);
    if (!adapter?.searchRemote) return sendError(reply, 404, 'not-found', `${id} has no remote search`);
    const empty = (status: RemoteSearchResponse['status'], message?: string): RemoteSearchResponse => ({ source: id, status, message, hits: [] });
    const cfg = ctx.config.get();
    if (!cfg.remoteSearch.includes(id) || !cfg.enabledSources.includes(id)) return empty('off');

    const ac = new AbortController();
    req.raw.on('close', () => ac.abort()); // the browser moved on to a newer query
    try {
      const hits = await adapter.searchRemote((q ?? '').slice(0, 200), ctx.adapterContext, ac.signal);
      return { source: id, status: 'ok', hits } satisfies RemoteSearchResponse;
    } catch (err) {
      if (err instanceof RemoteSearchRefused) return empty('refused', err.message);
      if (ac.signal.aborted) return empty('error', 'Cancelled');
      ctx.log.warn('remote search failed', err);
      return empty('error', 'The site didn’t answer. Use “Search on Songsterr” instead.');
    }
  });
};
```

`server/routes/index.ts`: import it and add a row to `ROUTES`:

```ts
import { register as searchRemote } from './search-remote';
// …
  { name: 'search-remote', owner: 'owner', register: searchRemote },
```

---

## 5. API client: `src/api/client.ts`

Next to `search:` (line 153), add:

```ts
searchRemote: (q: string, source: SourceId, signal?: AbortSignal) =>
  request('GET', `/api/search/remote?q=${encodeURIComponent(q)}&source=${source}`, undefined, {}, signal)
    .then((r) => r.json() as Promise<RemoteSearchResponse>),
```

`request` (line 85) doesn't take a signal yet. Add an optional `signal?: AbortSignal` parameter
and pass it to `fetch(…, { signal })`. Import `RemoteSearchResponse` and `SourceId`.

---

## 6. Guards (narrow them; don't delete them)

### `eslint.config.js`

The ban (lines 7–10) is applied twice: globally (line 42) and for shipped code (line 49). Add an
allow-list block **after** the shipped-code block (around line 50), so this one file is exempt and
everything else stays banned:

```js
  {
    // Owner decision (docs/guides/songsterr-search.md): the only module allowed to call the remote search.
    files: ['server/sources/songsterr/client.ts'],
    rules: { 'no-restricted-syntax': ['error', ...ultimateGuitarUrls] },
  },
```

Update the comment on line 6 to match.

### `tests/server/network-guard.test.ts`

Line 73 (`never names the Songsterr API`): exclude the client file.

```ts
const ALLOWED = 'server/sources/songsterr/client.ts';
const hits = codeLines().filter(({ where, text }) => !where.startsWith(ALLOWED) && /songsterr\.com\/api/i.test(text)).map(({ where }) => where);
```

Check how `where` is formatted in `codeLines()` (path plus line number) and match on the path part.

### `tests/foundation/lint-guards.test.ts`

Add one case: the restricted literal in `server/sources/songsterr/client.ts` gives no error, and the
same literal in `server/sources/linkout/x.ts` still does. Follow the existing
`restricted(code, path)` pattern (line 26).

---

## 7. Library UI

### `src/ui/screens/library/remote-results.ts` (new, complete)

```ts
import type { RemoteSearchResponse } from '@shared/api';
import { h } from '../../components';
import { openLinkOut } from './link-outs';

export interface RemoteResults {
  el: HTMLElement;
  loading(): void;
  render(res: RemoteSearchResponse | null, onPlay: (id: string) => void): void;
}

/** "On Songsterr" group under the link-outs. Hidden when remote search is off. */
export function remoteResults(win: Window = window): RemoteResults {
  const list = h('ul', { class: 'lib-remote__list' });
  const note = h('p', { class: 'lib-remote__note rw-muted' });
  const el = h('section', { class: 'lib-remote', 'aria-label': 'Songsterr results', hidden: true },
    h('h2', { class: 'lib-remote__title' }, 'On Songsterr'), note, list);
  return {
    el,
    loading() { el.hidden = false; el.setAttribute('aria-busy', 'true'); note.textContent = 'Searching Songsterr…'; },
    render(res, onPlay) {
      el.removeAttribute('aria-busy');
      if (!res || res.status === 'off') { el.hidden = true; return; }
      el.hidden = false;
      if (res.status !== 'ok') {
        note.textContent = res.status === 'refused'
          ? 'Songsterr declined the search, so it’s off until Riffway restarts. “Search on Songsterr” still works.'
          : res.message ?? 'Couldn’t reach Songsterr.';
        list.replaceChildren();
        return;
      }
      note.textContent = res.hits.length ? 'Opens on Songsterr. Download the Guitar Pro file, then drop it here.' : 'No matches on Songsterr.';
      list.replaceChildren(...res.hits.map((hit) => {
        const local = hit.localMatchIds?.[0];
        return h('li', { class: 'lib-remote__row' },
          h('div', { class: 'lib-remote__meta' },
            h('strong', null, hit.title),
            hit.artist ? h('span', { class: 'rw-muted' }, ` — ${hit.artist}`) : null,
            hit.tuningLabel ? h('span', { class: 'lib-remote__tuning' }, hit.tuningLabel) : null),
          local
            ? h('button', { type: 'button', class: 'rw-btn rw-btn--primary rw-btn--sm', on: { click: () => onPlay(local) } }, 'Play (in your library)')
            : h('button', { type: 'button', class: 'rw-btn rw-btn--secondary rw-btn--sm',
                'aria-label': `Open ${hit.title} on Songsterr (new tab)`, on: { click: () => openLinkOut(hit.url, win) } }, 'Open on Songsterr ↗'));
      }));
    },
  };
}
```

### `src/ui/screens/library/index.ts`

1. Import `remoteResults` and create it next to `linkOutSection` (line 183):
   `const remote = remoteResults(win);` then append `remote.el` after `linkOuts.el` (around line 197).
2. Add `let remoteSeq = 0; let remoteAbort: AbortController | null = null;` near `searchSeq`.
3. At the end of `runSearch()` (line 274), **after** `render()`, start the remote search without
   awaiting it in the local path:
   ```ts
   void runRemote(query.q.trim());
   ```
4. Add the function:
   ```ts
   async function runRemote(q: string): Promise<void> {
     remoteAbort?.abort();
     const my = ++remoteSeq;
     if (q.length < 3 || !config?.remoteSearch.includes('songsterr')) { remote.render(null, play); return; }
     remoteAbort = new AbortController();
     remote.loading();
     try {
       const res = await ctx.api.searchRemote(q, 'songsterr', remoteAbort.signal);
       if (my === remoteSeq && !destroyed) remote.render(res, play);
     } catch {
       if (my === remoteSeq && !destroyed) remote.render({ source: 'songsterr', status: 'error', hits: [] }, play);
     }
   }
   ```
   `play(id)` should open the song the way a result row does. Reuse what the result list's click
   handler calls (it goes through `pickArrangement` to `#/song/:id`).
5. In the screen's cleanup (`destroy`), call `remoteAbort?.abort()`.
6. The library search debounce is 150 ms (line 30). If that sends too many remote requests while
   you type, give `runRemote` its own 400–600 ms debounce. The server limiter and cache protect the
   site either way.

### `src/ui/screens/library/library.css`

Style `.lib-remote*` like `.lib-linkouts*` (same card, spacing and muted text tokens), so the group
reads as part of "Find more tabs".

---

## 8. Settings toggle: `src/ui/screens/settings/library.ts`

In `renderSources()` (line 217), for `s.id === 'songsterr'` append a second toggle under the
source's own switch:

```ts
const remoteOn = config?.remoteSearch.includes('songsterr') ?? false;
const remoteSw = toggle({
  label: 'Show Songsterr results in Library search',
  description: 'Sends what you type to Songsterr (titles and artists come back; no tabs). Off by default.',
  checked: remoteOn,
  onChange: (on) => void setRemote(on, remoteSw.set),
});
```

and a `setRemote` like `setSource` (line 233) that calls
`ctx.api.putConfig({ remoteSearch: on ? ['songsterr'] : [] })` and reverts the switch on error.

---

## 9. Tests (offline)

**Fixtures.** Save 3–5 real responses from your own browser into `tests/fixtures/songsterr/`:
`basic.json`, `drop-d.json`, `no-guitar.json` (a song with only bass or drums), `empty.json`. Trim
each to a few items.

**`tests/songsterr/map.test.ts`.** For each fixture: hit count, title and artist, guitar tracks
only, `tuning` high → low (Drop D = `[64, 59, 55, 50, 45, 38]`), `tuningId` `'drop-d'`, and odd
items skipped rather than throwing.

**`tests/songsterr/limiter.test.ts`.** Fake `now` plus `vi.useFakeTimers()`: the second call waits
until 1 s after the first; a newer call aborts a waiting one with `AbortError`.

**`tests/songsterr/cache.test.ts`.** Hit and miss, TTL expiry, LRU eviction at `max`, and keys that
ignore case and spacing.

**`tests/songsterr/adapter.test.ts`.** `createSongsterrAdapter({ fetchImpl })` with a fake fetch:
- 200 + fixture → hits; the second identical query makes **no** second fetch (cache).
- 403 → throws `RemoteSearchRefused`; the next query throws **without calling fetch**.
- 429 → same as 403.
- Timeout or 500 → plain `Error`, feature stays on.
- `localMatchIds` filled when a fake `ctx.entries()` contains a song with the same title and artist.
- Queries shorter than 3 characters → `[]` with no fetch.

**`tests/songsterr/route.test.ts`.** `createApp({ dataDir, staticDir: null, watch: false })` with an
adapter whose `fetchImpl` returns a fixture (pass a custom adapter list the way `tests/server/`
helpers do), then `app.inject({ url: '/api/search/remote?q=enter+sandman' })`:
- config `remoteSearch: []` → `status: 'off'` and fetch never called;
- after `PUT /api/config {remoteSearch:['songsterr']}` → `status: 'ok'` with hits;
- refusal → `status: 'refused'`.

**e2e.** Leave the feature off in `e2e/` (the network guard blocks every non-loopback request from
the browser, and the server must not call out during tests either). To cover the UI, add an env var
`RIFFWAY_SONGSTERR_FIXTURES=<dir>` that makes `client.ts` read `<dir>/<query>.json` instead of
fetching. Set it in `playwright.config.ts` and add one spec: enable in Settings, search, see the
"On Songsterr" group with a working **Open on Songsterr** button (check the URL through the
existing `window.open` stub).

Run before committing: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`.

---

## 10. Docs and decision record

- **`TASKS.md`:** change D1 to: "Songsterr: link-out by default; owner-implemented opt-in
  remote search (metadata only, rate-limited, cached, turns off on refusal). See
  `docs/guides/songsterr-search.md`." Add a task row with the files above.
- **`CLAUDE.md` § Conventions:** replace "never … contact `songsterr.com/api`" with "remote Songsterr
  search only in `server/sources/songsterr/client.ts`, opt-in; nothing else may contact it." If you
  add `RIFFWAY_SONGSTERR_FIXTURES`, add it to the Env line.
- **`docs/sources/songsterr.md`:** what is sent (only the query), rate limit, cache, behavior on
  refusal, and that getting the song is still a manual download.
- **`docs/sources/README.md`:** change Songsterr's status from "link-out only" to "link-out +
  opt-in remote search".
- **`docs/architecture.md`:** add `GET /api/search/remote` to the API list.

## Rollback

To remove the feature: set `remoteSearch: []` (Settings), or revert the registry import in step 3f
and the route row in step 4. Nothing else depends on it, and the link-out keeps working throughout.
