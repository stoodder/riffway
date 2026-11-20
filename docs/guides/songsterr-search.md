# Guide: in-app Songsterr search (owner-implemented)

Status: **Riffway side done (T-130); Songsterr-specific parts left for the owner.** Riffway ships
Songsterr as a link-out (TASKS.md D1, `docs/sources/songsterr.md`). This guide adds opt-in,
search-only results from a remote catalog without changing anything else. All site-agnostic pieces
(types, config, limiter, cache, generic request, adapter, route, client, UI, settings, offline tests,
e2e in fixture mode) are in place. The two Songsterr-specific pieces are yours to write: the request
URL in `client.ts` and the response mapping in `map.ts`. Both are marked `OWNER:` in the code. Until
`buildSearchUrl()` returns a URL, turning the feature on shows "Songsterr search isn't set up yet."
in the Library and sends nothing.

### Status

| Step | Item | Status |
|---|---|---|
| 1 | `RemoteSearchHit`, `SourceAdapter.searchRemote?`, `RemoteSearchRefused`, `RemoteSearchUnavailable`, `RemoteSearchResponse`, `API_ROUTES.searchRemote`, `ServerConfig.remoteSearch`, `ApiClient.searchRemote` | ✅ Done |
| 2 | Config flag `remoteSearch` (default `[]`, validation, tests updated) | ✅ Done |
| 3a, 3b | `limiter.ts`, `cache.ts` | ✅ Done |
| 3c | `client.ts`: generic `fetchSearch` (UA, timeout, 403/429, unavailable) | ✅ Done |
| 3c | `client.ts`: `buildSearchUrl()` | ⬜ OWNER |
| 3d | `map.ts`: skeleton, `mapSearchResponse` signature, `tuningFields` | ✅ Done |
| 3d | `map.ts`: `RawSong`, `songUrl`, `rawTuning`, `isSixStringGuitar`, `readItem`, `trackName` | ⬜ OWNER |
| 3e | `index.ts` adapter (injectable `fetchImpl`/`buildUrl`/`mapResponse`, fixture mode) | ✅ Done |
| 3f | Registry import + header comment | ✅ Done |
| 4 | Route `GET /api/search/remote` + `ROUTES` row | ✅ Done |
| 5 | API client `searchRemote` + `AbortSignal` in `request` | ✅ Done |
| 6 | Narrow the guards (`eslint.config.js`, `network-guard.test.ts`, `lint-guards.test.ts`) | ⬜ OWNER |
| 7 | Library UI (`remote-results.ts`, wiring, CSS) | ✅ Done |
| 8 | Settings toggle | ✅ Done |
| 9 | Offline tests: limiter, cache, adapter, route, config, UI, Settings, e2e (fixture mode) | ✅ Done |
| 9 | Fixtures from real responses + `tests/songsterr/map.test.ts` | ⬜ OWNER |
| 10 | `docs/architecture.md`, TASKS.md T-130, `CLAUDE.md` Env line | ✅ Done |
| 10 | Wording of TASKS.md D1, CLAUDE.md § Conventions, `docs/sources/songsterr.md`, `docs/sources/README.md` | ⬜ OWNER |

Your order: 3c `buildSearchUrl` → 3d mapping + 9 fixtures/`map.test.ts` → 6 guards → 10 wording. Run
`npm run typecheck` after each step.

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

Original plan (all steps):

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

## 1. Types and contracts  ✅ Done in this PR

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

And two error classes at the end of the file (`RemoteSearchUnavailable` was added in T-130 for the
"not set up yet" state):

```ts
/** The remote site refused the request (403/429). The adapter turns remote search off for the session. */
export class RemoteSearchRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'RemoteSearchRefused';
  }
}

/** The request isn't set up yet (`buildSearchUrl` returns null). No request is made; the route answers `off`. */
export class RemoteSearchUnavailable extends Error { /* name = 'RemoteSearchUnavailable' */ }
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
     /** `'off'`: not enabled in settings, or not set up yet (then `message` says so). `'refused'`: 403/429, off until restart. */
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

## 2. Server config flag: `server/config-store.ts`  ✅ Done in this PR

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

## 3. Adapter: `server/sources/songsterr/` (new folder)  ✅ Done except 3c `buildSearchUrl` and 3d mapping (⬜ Owner)

Five files. Keep `server/sources/linkout/songsterr.ts` as it is: the new adapter reuses its link-out.

### 3a. `limiter.ts` (complete)  ✅ Done in this PR

As built, a waiting call also removes its abort listener when it resolves, so an earlier call's
abort can't cancel a later waiter. Tests: `tests/songsterr/limiter.test.ts`.

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

### 3b. `cache.ts` (complete)  ✅ Done in this PR

Tests: `tests/songsterr/cache.test.ts`.

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

### 3c. `client.ts`  ✅ Generic part done · ⬜ Owner: `buildSearchUrl()`

This is the only file that talks to the remote site, and the only one the guards will allow (step 6).
As built, `buildSearchUrl` returns `null` until you implement it; `fetchSearch` then throws
`RemoteSearchUnavailable` **without any request** and the route answers
`{status: 'off', message: 'Songsterr search isn’t set up yet.'}`.

```ts
export const USER_AGENT = 'Riffway/0.1 (personal local practice app)';
export const TIMEOUT_MS = 4000;
export const NOT_SET_UP_MESSAGE = 'Songsterr search isn’t set up yet.';

/** OWNER: build the search request URL for `query`. Returns null while not implemented. */
export function buildSearchUrl(query: string): string | null {
  void query;
  return null; // OWNER: return the request URL
}

export async function fetchSearch(query: string, signal: AbortSignal, opts: FetchSearchOptions = {}): Promise<unknown> {
  const url = (opts.buildUrl ?? buildSearchUrl)(query);
  if (url === null) throw new RemoteSearchUnavailable(NOT_SET_UP_MESSAGE);
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const res = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (res.status === 403 || res.status === 429) { /* … */ throw new RemoteSearchRefused(res.status, text || `HTTP ${res.status}`); }
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  return res.json();
}
```

`query` arrives trimmed, 3–200 characters. Your part: replace `return null` with the URL. The
tests inject their own URL builder, so they don't change when you do.

### 3d. `map.ts` (pure)  ✅ Skeleton done · ⬜ Owner: the response shape

As built, `map.ts` type-checks and maps everything to `[]`. The format-specific reads are split into
small `OWNER:` functions: `RawSong` (fields), `songUrl`, `rawTuning`, `isSixStringGuitar`, plus
`readItem(raw)` (id, title, artist, tracks) and `trackName(track)`. `mapSearchResponse` keeps the
signature below, skips odd items (including ones that throw) and fills tuning fields through the
generic `tuningFields(tracks)` (first 6-string tuning → `describeTuning`; tested in
`tests/songsterr/map-generic.test.ts`). The original sketch:

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

### 3e. `index.ts`  ✅ Done in this PR

As built, the factory takes injectable deps so it is testable without your mapper:
`createSongsterrAdapter({ fetchImpl?, buildUrl?, mapResponse?, fixturesDir?, now?, intervalMs? })`.
Fixture mode: with `RIFFWAY_SONGSTERR_FIXTURES=<dir>` (or `fixturesDir`), hits come from
`<dir>/<fixtureSlug(query)>.json` as **already-mapped** `RemoteSearchHit[]` (synthetic; the e2e suite
uses `e2e/fixtures/songsterr-mapped/`), with no limiter, cache or request. `status()` also says when
remote search isn't set up. Tests: `tests/songsterr/adapter.test.ts`. The original sketch:

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

### 3f. `server/sources/registry.ts`  ✅ Done in this PR

Change the import on line 10 and update the header comment on line 3:

```ts
import { createSongsterrAdapter } from './songsterr';
```

Line 3 currently says link-out adapters do no network I/O and that `songsterr.com/api` is
forbidden. Change it to say remote search lives only in `server/sources/songsterr/client.ts`, opt-in
(see `docs/guides/songsterr-search.md`).

---

## 4. Route: `server/routes/search-remote.ts` (new, complete)  ✅ Done in this PR

As built, it also catches `RemoteSearchUnavailable` → `empty('off', err.message)`, and cancels on
`reply.raw` `close` before the response finished (on recent Node versions `req.raw` can emit `close`
once the request body has been read, which would cancel every search). Registered as `{ name: 'search-remote', owner:
'T-130' }`. Tests: `tests/songsterr/route.test.ts`. The original sketch:

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

## 5. API client: `src/api/client.ts`  ✅ Done in this PR

Next to `search:` (line 153), add:

```ts
searchRemote: (q: string, source: SourceId, signal?: AbortSignal) =>
  request('GET', `/api/search/remote?q=${encodeURIComponent(q)}&source=${source}`, undefined, {}, signal)
    .then((r) => r.json() as Promise<RemoteSearchResponse>),
```

`request` (line 85) doesn't take a signal yet. Add an optional `signal?: AbortSignal` parameter
and pass it to `fetch(…, { signal })`. Import `RemoteSearchResponse` and `SourceId`.

---

## 6. Guards (narrow them; don't delete them)  ⬜ Owner

Not done in T-130 on purpose: nothing in the tree names the remote endpoint yet, so the guards pass
unchanged. Narrow them in the same commit as `buildSearchUrl`.

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

## 7. Library UI  ✅ Done in this PR

- `src/ui/screens/library/remote-results.ts`: the "On Songsterr" card (an `h3` region inside "Find
  more tabs", above the ClassTab card). Rows show title, artist and tuning label; a hit with
  `localMatchIds` gets **Play (in your library)** (`aria-label` "Play <title> (in your library)"),
  others **Open on Songsterr ↗** ("Open <title> on Songsterr (opens a new tab)", via `openLinkOut`,
  `noopener,noreferrer`). Hidden for `null` and for `off` without a message; `off` with a message
  ("isn't set up yet"), `refused` and `error` show a note instead of rows.
- `src/ui/screens/library/index.ts`: `scheduleRemote()` runs after every local search and once the
  config loads. Remote search runs only when `config.remoteSearch` and `enabledSources` include
  `songsterr` and the query has ≥ 3 characters; it has its own `REMOTE_DEBOUNCE_MS = 500`, a newer
  query aborts the pending/in-flight one (`AbortSignal` through `ctx.api.searchRemote`), the same query
  (filter or sort changes) doesn't re-request, and unmount aborts. **Play** opens the matching row
  when it is in the current results, else builds the same input from `GET /api/songs/:id`
  (`openableFromMeta`) and goes through `pickArrangement` to `#/song/:id`.
- `library.css`: `.lib-remote*` uses the `.lib-linkout` card tokens (border, radius, surface, muted
  `--text-sm` notes).
- Tests: `tests/library-ui/remote-results.test.ts`, `tests/library-ui/screen-remote.test.ts`.

## 8. Settings toggle: `src/ui/screens/settings/library.ts`  ✅ Done in this PR

As built, the toggle sits under Songsterr's own switch (`.set-source__sub`), toasts on change and
reverts on error. Test: `tests/settings/screen.test.ts`.

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

## 9. Tests (offline)  ✅ Done except real-response fixtures and `map.test.ts` (⬜ Owner)

Done in T-130, all offline with injected fakes and synthetic data (invented titles, `*.invalid`
hosts, a pass-through fake mapper): `tests/songsterr/{limiter,cache,adapter,route,map-generic}.test.ts`
(adapter/route cover 200 + cache, 403/429 refused without further requests, 500/timeout, < 3 chars,
`localMatchIds`, unavailable → `off` + message, fixture mode, config validation), the UI tests above,
and `e2e/songsterr-search.spec.ts` (fixture mode; enable in Settings, search, Open through the
`window.open` stub, Play a library match; resets the config afterwards; the network guard is
unchanged). Yours: the fixtures and `map.test.ts` below.

**Fixtures.** Save 3–5 real responses from your own browser into `tests/fixtures/songsterr/`:
`basic.json`, `drop-d.json`, `no-guitar.json` (a song with only bass or drums), `empty.json`. Trim
each to a few items.

**`tests/songsterr/map.test.ts`.** For each fixture: hit count, title and artist, guitar tracks
only, `tuning` high → low (Drop D = `[64, 59, 55, 50, 45, 38]`), `tuningId` `'drop-d'`, and odd
items skipped rather than throwing.

The rest of this section is the original plan, kept for reference.

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
`RIFFWAY_SONGSTERR_FIXTURES=<dir>` that makes the adapter read `<dir>/<query slug>.json` (as built:
already-mapped hits, so it doesn't depend on `map.ts`) instead of fetching. Set it in `playwright.config.ts` and add one spec: enable in Settings, search, see the
"On Songsterr" group with a working **Open on Songsterr** button (check the URL through the
existing `window.open` stub).

Run before committing: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`.

---

## 10. Docs and decision record  ✅ architecture.md, TASKS.md T-130, CLAUDE.md Env line · ⬜ Owner: wording below

Done in T-130: `docs/architecture.md` API row, TASKS.md T-130 (sub-items) and contract change row,
`RIFFWAY_SONGSTERR_FIXTURES` on CLAUDE.md's Env line. Yours: D1, CLAUDE.md § Conventions,
`docs/sources/songsterr.md`, `docs/sources/README.md`.

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
