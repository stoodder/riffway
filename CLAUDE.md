# Riffway — agent guide

Riffway is a local-only guitar rhythm-game / tab trainer: Vite + TypeScript frontend and a small
Node companion server. Notes scroll right→left on six string lanes; a real guitar (USB input) is
pitch-tracked and scored. Spec: `docs/spec.md`. Player profile: `docs/user-profile.md`.

## Resume protocol (after a timeout or new session)
1. Read this file → `docs/README.md` → `TASKS.md` (source of truth for status).
2. `git log --oneline -20` to see what landed.
3. Continue the next `todo` / `in-progress` task. Update `TASKS.md` after every task.

## Commands
| Command | What |
|---|---|
| `npm install` | Install deps (Node ≥ 22.12; exact pins, see `docs/research/libraries.md`) |
| `npx playwright install chromium` | Once on a fresh machine (owner's Mac). **Not** in the agent container: Chromium is preinstalled at `/opt/pw-browsers/chromium` and the configs use it automatically |
| `npm run dev` | Vite on 127.0.0.1:5173 (`/api` proxied) + companion server (`tsx watch`) on 127.0.0.1:5174 |
| `npm run build` | Optimized build: `dist/` (web, Vite) + `dist-server/index.js` (server, esbuild bundle) |
| `npm start` | Run the built app: server serves `dist/` and `/api` on 5174 |
| `npm test` | Vitest, both projects: `node` (`tests/**/*.test.ts`) and `browser` (`tests/**/*.browser.test.ts`, headless Chromium) |
| `npm run test:node` / `npm run test:browser` | One Vitest project only (`npm run test:watch` for watch mode) |
| `npm run test:e2e` | Playwright e2e on the production build (keyboard input mode, fake mic; free port unless `RIFFWAY_E2E_PORT`), screenshots → `test-results/e2e-screenshots/` (git-ignored). `RIFFWAY_UPDATE_SCREENSHOTS=1 npm run test:e2e` refreshes the committed `e2e/screenshots/` instead |
| `npm run test:e2e:input` | Playwright fake-capture tests for the input/tuner panels (`tests/input/e2e`; own Vite on a random port 5200–5999 or `RIFFWAY_INPUT_E2E_PORT`) |
| `npm run typecheck` | `tsc` ×3: app/tests (DOM), `tsconfig.node.json` (server + `src/core`, no DOM), worklets (AudioWorklet scope) |
| `npm run lint` | ESLint (flat config; also guards `src/core` purity and the Songsterr API ban) |
| `npm run classtab:refresh` | Download/refresh the ClassTab zip and rebuild its index |

Env: `RIFFWAY_DATA_DIR` (default `~/.riffway`), `RIFFWAY_PORT` (5174), `RIFFWAY_LIBRARY_DIR` (override the configured library folder), `RIFFWAY_LOG_LEVEL` (`info`), `RIFFWAY_VITEST_BROWSER_PORT` (fixed Vitest browser-server port; default: free port on 127.0.0.1), `RIFFWAY_E2E_PORT` (Playwright e2e server port; default: a free port), `RIFFWAY_E2E_DATA_DIR` (e2e data dir; default: a new temp dir), `RIFFWAY_INPUT_E2E_PORT` (input/tuner fake-capture e2e Vite port; default: random 5200–5999), `RIFFWAY_UPDATE_SCREENSHOTS` (`1` writes the committed `e2e/screenshots/`; default off), `RIFFWAY_SONGSTERR_FIXTURES` (dir: opt-in Songsterr search answers from synthetic, already-mapped `<dir>/<query slug>.json` instead of the site; the e2e config sets `e2e/fixtures/songsterr-mapped`). (Exact scripts live in `package.json`; keep this table in sync.)

## Contracts and extension points (frozen by T-010)
- Types: `shared/*.ts` (`@shared/*`); DOM-free except `shared/ui.ts` and `shared/services.ts`. Aliases
  `@shared/*` and `@core/*` work in Vite, Vitest, tsx and esbuild.
- Stubs throw `NotImplementedError` (`@shared/errors`) naming the owning task; fill the body, keep the signature.
- Registries: screens `src/ui/screens/index.ts`, panels `src/ui/panels/index.ts`, services
  `src/app/services.ts` (`ctx.services.get('engine')`), routes `server/routes/index.ts`, sources
  `server/sources/registry.ts`, worklet URLs `src/audio/worklet-urls.ts`. Never edit a registry; file a
  contract change request in `TASKS.md`.
- Tests: DOM tests add `// @vitest-environment happy-dom`; Web Audio tests are `*.browser.test.ts`;
  server tests use `createApp({dataDir, staticDir: null, watch: false})` + `app.inject()`.

## Layout
- `src/` — browser app. `src/core/` pure TS (no DOM, no Web Audio): models, parsing, judging,
  difficulty, DSP. Everything in `core/` must be unit-testable in Node.
- `src/audio/` — AudioContext graph, AudioWorklet processors (`src/audio/worklets/`), clock.
- `src/game/` — game loop, highway renderer (canvas), input modes.
- `src/ui/` — screens and components.
- `src/app/` — `AppContext` + lazy service registry; `src/api/client.ts` — typed API client + SSE.
- `src/storage/` — IndexedDB (progress, scores, settings, audio links), export/import.
- `server/` — companion server (library indexer/watcher, source adapters, ClassTab, API).
- `shared/` — contracts shared by web and server (song model, sources, API DTOs, clock, judge, settings,
  storage, worklet messages; browser-only `ui.ts`/`services.ts`).
- `starter/` — committed starter library (public-domain songs + original exercises).
- `tests/` — Vitest tests + `tests/fixtures/` (recorded fixtures; never live network).
- `e2e/` — Playwright tests.
- `docs/` — progressive-disclosure docs; start at `docs/README.md`.

## Conventions
- TypeScript strict. ES modules. No `any` without a comment explaining why.
- **Timing:** all scheduling and judgement use the AudioContext clock (seconds). The renderer
  only reads the clock; it never advances game time. See `docs/timing.md`.
- **DSP** lives in pure TS in `src/core/dsp/` and is wrapped by worklets, so it can be tested in Node.
- **Sources:** every adapter implements `SourceAdapter` (`shared/sources.ts`) and has a doc in
  `docs/sources/`. Never call undocumented endpoints, bypass logins/paywalls, or contact
  `songsterr.com/api` (access declined — see `docs/sources/songsterr.md`).
- Song files live in the user's library folder (default `~/Music/Tabs`), never in git.
  Only `starter/` content and small test fixtures are committed.
- Tests: unit tests next to the domain in `tests/<area>/`; fixtures recorded, not fetched.
- Commits: one per completed task, message `<type>: <summary> (T-xxx)`.
- Docs: keep `docs/README.md` short; push detail into topic files. Update docs with behaviour changes.

## Docs map
`docs/README.md` (index) · `docs/architecture.md` · `docs/audio-input.md` · `docs/monitoring.md` ·
`docs/timing.md` · `docs/game-mechanics.md` · `docs/song-formats.md` · `docs/difficulty.md` ·
`docs/progress.md` ·
`docs/sources/` · `docs/research/` · `docs/reviews/` · `docs/manual-test-checklist.md`
