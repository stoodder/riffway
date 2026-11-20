# Finishing opt-in Songsterr search: owner steps

Everything site-agnostic is already built and tested on branch `claude/songsterr-remote-search`
([PR #1](https://github.com/stoodder/riffway/pull/1)): types, config flag, rate limiter, cache, request
wrapper, adapter, route, API client, Library "On Songsterr" group, Settings switch, offline tests and
e2e. **Don't change any of that.** What's left is below, in order. Each step says exactly which file to
edit, what to write, and how to check it.

| # | Step | File(s) | Check |
|---|---|---|---|
| 0 | Get the branch, confirm green | — | `npm test` passes |
| 1 | Save sample responses | `tests/fixtures/songsterr/*.json` (new) | 4 files exist |
| 2 | Write the response mapping | `server/sources/songsterr/map.ts` | `npm run typecheck` |
| 3 | Test the mapping | `tests/songsterr/map.test.ts` (new) | `npx vitest run tests/songsterr` |
| 4 | Narrow the guards | `eslint.config.js`, two test files | lint + guard tests pass |
| 5 | Write the request URL | `server/sources/songsterr/client.ts` | lint passes |
| 6 | Update docs and task board | `TASKS.md`, `CLAUDE.md`, `docs/sources/*` | — |
| 7 | Run everything, try it | — | all gates + manual check |
| 8 | Commit, push, ask for review | — | PR updated |

Do step 4 before step 5: the lint guard fails the moment the API URL appears in code.

---

## Step 0 · Get the branch

```bash
git fetch origin
```
```bash
git checkout claude/songsterr-remote-search
```
```bash
npm install
```
```bash
npm test
```

Everything should pass before you start (one test is marked expected-fail; that's normal).

---

## Step 1 · Save sample responses (fixtures)

Using your browser, make the **same search request you'll put in `buildSearchUrl()`** (step 5) and
save the raw JSON responses into a new folder `tests/fixtures/songsterr/`:

| File | Search for | Must contain |
|---|---|---|
| `basic.json` | a well-known rock song | 2–3 results; at least one with a 6-string guitar track in standard tuning |
| `drop-d.json` | a song you know is in Drop D | a result whose guitar track is Drop D |
| `no-guitar.json` | something that returns a result without a guitar track (e.g. bass or drums only) | one such result |
| `empty.json` | nonsense like `zzqqxx` | zero results |

Rules for these files:
- Keep the JSON exactly as the site returned it. Only **delete whole results** to keep each file small
  (2–3 results each). Don't hand-edit fields.
- Pretty-print them (your editor's "Format document", or `node -e "const f=process.argv[1];require('fs').writeFileSync(f, JSON.stringify(JSON.parse(require('fs').readFileSync(f,'utf8')), null, 2)+'\\n')" <file>`) so diffs are readable.
- Write down, for each kept result, its id, title, artist and the guitar track's tuning. You'll assert
  them in step 3.

These are the only real responses committed. Tests never fetch anything.

---

## Step 2 · Write the response mapping (`server/sources/songsterr/map.ts`)

Only the functions marked `OWNER:` change. Keep `tuningFields` and the structure of
`mapSearchResponse`.

### 2a. Top-level shape

`mapSearchResponse` currently starts with:

```ts
if (!Array.isArray(json)) return [];
...
for (const raw of json as RawSong[]) {
```

- If the response **is** a JSON array of results: leave it.
- If the results are **inside an object** (e.g. `{ <listField>: [...] }`): replace those lines with

  ```ts
  const list = Array.isArray(json) ? json : (json as { <listField>?: unknown } | null)?.<listField>;
  if (!Array.isArray(list)) return [];
  ...
  for (const raw of list as RawSong[]) {
  ```

  replacing `<listField>` with the real property name.

### 2b. `RawSong`

Replace

```ts
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- OWNER fills in the fields
export interface RawSong {}
```

with an interface listing **only the fields you read**, all optional (the site may omit any), e.g.

```ts
export interface RawSong {
  <idField>?: number | string;
  <titleField>?: string;
  <artistField>?: string | { <nameField>?: string };
  <tracksField>?: unknown[];
}
```

Delete the `eslint-disable` line.

### 2c. `readItem(raw)`

Return the four values; return `undefined` id or title when missing (the item is then skipped):

```ts
function readItem(raw: RawSong): { remoteId?: string; title?: string; artist?: string; tracks: unknown[] } {
  const id = raw.<idField>;
  return {
    remoteId: id === undefined || id === null ? undefined : String(id),
    title: typeof raw.<titleField> === 'string' ? raw.<titleField>.trim() || undefined : undefined,
    artist: /* the artist name as a string, or undefined */,
    tracks: Array.isArray(raw.<tracksField>) ? raw.<tracksField> : [],
  };
}
```

### 2d. `trackName(track)`

Return the track's display name as a string (`''` if none). Read it defensively:

```ts
function trackName(track: unknown): string {
  const name = (track as { <nameField>?: unknown } | null)?.<nameField>;
  return typeof name === 'string' ? name : '';
}
```

### 2e. `isSixStringGuitar(track)`

Return `true` **only** for 6-string guitar tracks. Return `false` for bass, drums, vocals, keys, and
7- or 8-string guitars. Prefer an explicit string count or tuning length if the track has one
(`=== 6`), plus the instrument field to exclude bass. Return `false` for anything you can't read.

### 2f. `rawTuning(track)`

Return the tuning as **MIDI note numbers, string 1 = high e first**, or `undefined`.
Required results:

| Tuning | Must return |
|---|---|
| Standard | `[64, 59, 55, 50, 45, 40]` |
| Drop D | `[64, 59, 55, 50, 45, 38]` |
| Eb standard | `[63, 58, 54, 49, 44, 39]` |

Depending on what the site gives you:
- **MIDI numbers, low string first** (`[40, 45, …, 64]`): return `[...values].reverse()`.
- **MIDI numbers, high string first:** return a copy as is.
- **Note names** (`"E2"`, `"Eb4"`): convert with this helper (add it to `map.ts`), then fix the order:

  ```ts
  const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  /** "E2" → 40, "Eb4" → 63, "F#3" → 54; undefined if unreadable. */
  function nameToMidi(name: string): number | undefined {
    const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name.trim());
    if (!m) return undefined;
    const pc = PITCH[m[1]!.toUpperCase()]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return (Number(m[3]) + 1) * 12 + pc;
  }
  ```

Return `undefined` if any string can't be read or the count isn't 6.

### 2g. `songUrl(raw)`

Return the **absolute `https://www.songsterr.com/...` URL of the song's page**: the page you'd open
in the browser, not an API URL. It's only ever opened in your browser tab.

It must never be empty. Add this line in `mapSearchResponse` right after `if (!remoteId || !title) continue;`:

```ts
const url = songUrl(raw);
if (!url.startsWith('https://www.songsterr.com/')) continue;
```

and use `url` instead of `songUrl(raw)` when building `hit`.

Check: `npm run typecheck`.

---

## Step 3 · Test the mapping (`tests/songsterr/map.test.ts`, new)

Copy this file and fill in the `«…»` values from your notes in step 1:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapSearchResponse } from '../../server/sources/songsterr/map';

const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/songsterr', name), 'utf8'));

describe('Songsterr response mapping', () => {
  it('maps a basic response', () => {
    const hits = mapSearchResponse(load('basic.json'));
    expect(hits).toHaveLength(«number of results kept»);
    expect(hits[0]).toMatchObject({
      source: 'songsterr',
      remoteId: '«id»',
      title: '«title»',
      artist: '«artist»',
      tuning: [64, 59, 55, 50, 45, 40],
      tuningId: 'standard',
      tuningLabel: 'Standard',
    });
    expect(hits[0]!.url).toMatch(/^https:\/\/www\.songsterr\.com\//);
    expect(hits[0]!.tracks.length).toBeGreaterThan(0);
    expect(hits[0]!.tracks.every((t) => t.name.length > 0)).toBe(true);
  });

  it('reads Drop D', () => {
    const hit = mapSearchResponse(load('drop-d.json')).find((h) => h.remoteId === '«id of the Drop D result»');
    expect(hit?.tuning).toEqual([64, 59, 55, 50, 45, 38]);
    expect(hit?.tuningId).toBe('drop-d');
  });

  it('keeps a result without a guitar track, with no tracks and no tuning', () => {
    const hit = mapSearchResponse(load('no-guitar.json')).find((h) => h.remoteId === '«id»');
    expect(hit).toBeDefined();
    expect(hit!.tracks).toEqual([]);
    expect(hit!.tuning).toBeUndefined();
  });

  it('maps an empty response to no hits', () => {
    expect(mapSearchResponse(load('empty.json'))).toEqual([]);
  });

  it('skips odd items instead of throwing', () => {
    const basic = load('basic.json');
    const good = mapSearchResponse(basic).length;
    // If your response wraps the list in an object (step 2a), insert the odd items into that list instead.
    const withJunk = Array.isArray(basic) ? [...basic, null, 42, 'x', {}] : basic;
    expect(mapSearchResponse(withJunk)).toHaveLength(good);
  });
});
```

Check: `npx vitest run tests/songsterr`. All files there must pass, including the existing ones.

---

## Step 4 · Narrow the guards

The guards keep the API URL out of the codebase. Narrow them so it's allowed in exactly one file,
`server/sources/songsterr/client.ts`, and still banned everywhere else.

### 4a. `eslint.config.js`

1. Change the comment above `const songsterrApi = [` (line 6) to:
   ```js
   /** The Songsterr API: allowed only in server/sources/songsterr/client.ts (owner decision, T-130). */
   ```
2. Add this block **directly after** the block that has `ignores: ULTIMATE_GUITAR_LINKOUT_BUILDERS`
   (the one whose comment starts "Shipped code"):
   ```js
   {
     // The opt-in remote search request (T-130) is the one place the Songsterr API may appear.
     files: ['server/sources/songsterr/client.ts'],
     rules: { 'no-restricted-syntax': ['error', ...ultimateGuitarUrls] },
   },
   ```
   Order matters: a later block overrides an earlier one, so it must come after the shipped-code block.

### 4b. `tests/server/network-guard.test.ts`

Replace the test `'never names the Songsterr API'` (around line 72) with:

```ts
  it('names the Songsterr API only in the remote-search client', () => {
    const ALLOWED = 'server/sources/songsterr/client.ts';
    const hits = codeLines()
      .filter(({ where, text }) => where.split(':')[0] !== ALLOWED && /songsterr\.com\/api/i.test(text))
      .map(({ where }) => where);
    expect(hits).toEqual([]);
  });
```

(`where` is `path:line`, so `split(':')[0]` is the path.) In the file's header comment, change "ESLint
bans `songsterr.com/api`" to "ESLint bans `songsterr.com/api` outside `server/sources/songsterr/client.ts`".

### 4c. `tests/foundation/lint-guards.test.ts`

1. Change the header comment's first sentence to: "`songsterr.com/api` is banned everywhere except
   `server/sources/songsterr/client.ts` (T-130)".
2. Add this test inside `describe('lint guards', …)`:
   ```ts
   it('allows the Songsterr API only in the remote-search client', async () => {
     const code = `export const u = (q: string): string => \`https://www.${SONGSTERR_API}/x?q=\${q}\`;\n`;
     expect(await restricted(code, 'server/sources/songsterr/client.ts')).toEqual([]);
     for (const file of ['server/sources/songsterr/index.ts', 'server/sources/songsterr/map.ts', 'src/app/x.ts']) {
       expect(await restricted(code, file)).toHaveLength(1);
     }
   });
   ```

Check:
```bash
npm run lint
```
```bash
npx vitest run tests/foundation/lint-guards.test.ts tests/server/network-guard.test.ts
```

---

## Step 5 · Write the request URL (`server/sources/songsterr/client.ts`)

Replace the body of `buildSearchUrl`:

```ts
export function buildSearchUrl(query: string): string | null {
  return `https://«host»/«path»?«queryParam»=${encodeURIComponent(query)}`;
}
```

- Keep it one template literal, with the query passed through `encodeURIComponent`.
- Add no other query parameters (no paging, no limits): one request per search.
- Add **no** API keys, cookies or extra headers. The User-Agent, `accept`, timeout and abort are
  already handled by `fetchSearch`; don't change that function.
- Don't add retries. A 403/429 turns the feature off until restart, and that's the intended behavior.

Check: `npm run lint` and `npm run typecheck`.

Nothing else needs to change: no test calls the real URL. Every test injects its own URL builder,
and e2e runs in fixture mode.

---

## Step 6 · Update docs and the task board

Paste these in. Adjust the wording if you like, but keep the facts.

### `TASKS.md`

1. Replace the text of the **D1** row (second column) with:
   > **Songsterr: link-out by default; opt-in remote search (owner decision, T-130).** The search API refused automated access (403 `ERR_ACCESS_POLICY`, robots `Disallow: /api/`). The owner chose to add search-only results, off by default: one request per typed query, ≤ 1/s, cached 24 h, honest User-Agent, no tab content. On a 403/429 it turns itself off until restart, with no retries. Getting a song stays manual (Plus GP download → drop into Riffway). The only module that may contact the API is `server/sources/songsterr/client.ts`. See `docs/sources/songsterr.md`.
2. In the **T-130** block, change `**Status:** in-progress (…)` to `**Status:** done`, and tick the five
   `**Owner:**` boxes (`- [ ]` → `- [x]`).

### `CLAUDE.md` › Conventions

Replace

> Never call undocumented endpoints, bypass logins/paywalls, or contact `songsterr.com/api` (access declined — see `docs/sources/songsterr.md`).

with

> Never call undocumented endpoints or bypass logins/paywalls. The Songsterr API may be contacted only by the opt-in remote search in `server/sources/songsterr/client.ts` (owner decision, T-130; see `docs/sources/songsterr.md`); nothing else, including tests, may contact it.

### `docs/sources/README.md`

Replace the Songsterr row (line 25) with:

```
| Songsterr | link-out + opt-in remote search (T-026, T-130) | Opens `songsterr.com/?pattern=` in a browser tab; optional search-only results in the Library (off by default). Matches imported GP files locally | API refuses automated clients (403); `/api/` disallowed. Owner opted in to search-only, rate-limited use. GP download is Plus-only | S | [songsterr.md](songsterr.md) |
```

### `docs/sources/songsterr.md`

1. Change the status line (line 3) to:
   `Last verified: 2026-11-19 · Status: **link-out by default, plus opt-in remote search (owner decision, T-130)**`
2. In **Compliant design**, change point 4 from "hit `/api/`" to "hit `/api/` (except the owner's opt-in search, below)".
3. Append this section at the end:

   ```markdown
   ## Opt-in remote search (T-130, owner decision)
   The owner chose to add search-only results to the Library, knowing the API refuses automated
   clients. Behavior:
   - **Off by default.** Settings › Library & sources › "Show Songsterr results in Library search".
   - **What's sent:** only the typed query, one request per search (500 ms after typing stops),
     at most 1 per second, 4 s timeout, User-Agent `Riffway/0.1 (personal local practice app)`.
     Results cached 24 h per query.
   - **What comes back:** title, artist, guitar tracks, tuning and the song page URL. No tab content.
   - **On refusal (403/429):** remote search turns off until the server restarts. The Library says
     so and falls back to "Search on Songsterr". No retries, no header changes.
   - **Getting the song** is unchanged: open the page, download the Guitar Pro file (Plus), drop it
     into Riffway. **Play** appears on a result once that song is in the library.
   - **Code:** request URL in `server/sources/songsterr/client.ts` (the only file allowed to name the
     API), mapping in `map.ts`, adapter `index.ts`, route `GET /api/search/remote`.
   - **Tests:** recorded fixtures in `tests/fixtures/songsterr/` (`map.test.ts`); everything else
     uses injected fakes or `RIFFWAY_SONGSTERR_FIXTURES`. Nothing in tests contacts the site.
   ```

### This guide

Once everything above is done, replace this whole file with one line:
`Done in T-130. Behavior and constraints: docs/sources/songsterr.md § Opt-in remote search.`
(Or delete it and remove the reference in the T-130 block of `TASKS.md`.)

---

## Step 7 · Run everything, then try it

```bash
npm run typecheck
```
```bash
npm run lint
```
```bash
npm test
```
```bash
npm run test:e2e
```

All four must pass. `test:e2e` doesn't change `e2e/screenshots/`; if `git status` shows them
changed, don't commit them.

Then try it for real:

```bash
npm run dev
```

1. Open http://localhost:5173 → **Settings › Library & sources** → turn on **Show Songsterr results
   in Library search**.
2. **Library:** type a song you know. Local results appear immediately; about half a second after you
   stop typing, an **On Songsterr** group appears with title, artist and tuning.
3. **Open on Songsterr ↗** opens that song's page in a new tab.
4. Download that song's Guitar Pro file, drop it on Riffway, and search again: the same result now
   shows **Play (in your library)**, and Play opens the song.
5. Open Chrome DevTools › Network, filter on `search/remote`, and type quickly: the Library sends one
   request about half a second after you stop typing (a request still in flight when you type again shows as cancelled). (The server's
   1-per-second limit and cache sit behind that route and are covered by tests.) The terminal running
   `npm run dev` should show no `remote search failed` or `refused` warnings.
6. Turn the setting off: the group disappears and nothing more is sent.
7. If the group ever says **"Songsterr declined the search"**, that's the site refusing (403/429).
   Leave it off; don't retry with other headers or addresses.

---

## Step 8 · Commit, push, review

Commit on the same branch (messages ending in `(T-130)`), then push:

```bash
git push
```

Then ask me to review PR #1. I'll check the mapping against your fixtures, the guard changes, the
docs, and run all the gates.
