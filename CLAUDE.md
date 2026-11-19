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
| `npm install` | Install deps (Node ≥ 20) |
| `npm run dev` | Start Vite (5173) + companion server (5174) together |
| `npm run build` | Optimized build: `dist/` (web) + `dist-server/` (server) |
| `npm start` | Run the built app (server serves `dist/` on 5174) |
| `npm test` | Vitest unit + audio-pipeline tests |
| `npm run test:e2e` | Playwright end-to-end (keyboard input mode), screenshots → `e2e/screenshots/` |
| `npm run typecheck` | `tsc --noEmit` for web + server |
| `npm run lint` | ESLint |
| `npm run classtab:refresh` | Download/refresh the ClassTab zip and rebuild its index |

(Exact scripts live in `package.json`; keep this table in sync.)

## Layout
- `src/` — browser app. `src/core/` pure TS (no DOM, no Web Audio): models, parsing, judging,
  difficulty, DSP. Everything in `core/` must be unit-testable in Node.
- `src/audio/` — AudioContext graph, AudioWorklet processors (`src/audio/worklets/`), clock.
- `src/game/` — game loop, highway renderer (canvas), input modes.
- `src/ui/` — screens and components.
- `src/storage/` — IndexedDB (progress, scores, settings, audio links), export/import.
- `server/` — companion server (library indexer/watcher, source adapters, ClassTab, API).
- `shared/` — types shared by web and server (song model, source adapter interface, API DTOs).
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
