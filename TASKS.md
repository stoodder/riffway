# Riffway task board

Source of truth for status and resume. Scope comes from `docs/spec.md`; design from `docs/`.

## How to use this file
- **Statuses:** `todo` · `in-progress` · `blocked` (say why in Notes) · `done`.
- Update this file after **every** task: status, a one-line outcome in Notes, and any new tasks.
  Commit it with the task (`<type>: <summary> (T-xxx)`; the orchestrator commits).
- **Resume protocol:** see `CLAUDE.md` § Resume protocol (CLAUDE.md → docs/README.md → this file →
  `git log`), then continue the first `in-progress`, else the next `todo` whose dependencies are `done`.
- **Parallel safety (D9):** a task may only create or edit files under its **Owns** list. Anything in
  `shared/`, `package.json`, configs or registries is frozen after T-010. If a task needs a contract
  change, it stops that part, adds a row to *Contract change requests* below, and continues with the
  rest; the orchestrator applies the change between waves.
- Each doc has exactly one owner per wave (listed in the task's Owns). `docs/README.md`,
  `docs/architecture.md` and this file are orchestrator-owned after T-010.
- Unit tests live with the task (`tests/<area>/`); fixtures are authored or recorded, never fetched live.

## Decisions
| ID | Decision |
|---|---|
| D1 | **Songsterr = link-out only (spec deviation).** API access declined (403 `ERR_ACCESS_POLICY`, robots `Disallow: /api/`). "Search on Songsterr" opens `songsterr.com/?pattern=` in a new tab; already-imported songs match locally by normalised title/artist and show as playable. No requests to songsterr.com from app or tests. Owner to accept the deviation from the DoD line "search … the Songsterr catalog". See `docs/sources/songsterr.md`. |
| D2 | **ClassTab:** no licence → never commit or redistribute its content. `npm run classtab:refresh` downloads the zip (ETag/Last-Modified aware) into `~/.riffway/classtab/`; the server indexes it. Pairing: basename + suffix rules + header URL; rhythm from MIDI, else beat ruler, else "needs rhythm alignment". **Unit-test fixtures are synthetic files we author** in ClassTab's style. |
| D3 | alphaTab 1.9.0 (pinned) is used as **importer** (+ `MidiFileGenerator`) in server and browser worker only. Its player/AudioContext is not used. Guide audio = offline alphaSynth render in a Web Worker → AudioBuffer on our context; re-render on speed change. Backing audio speed via signalsmith-stretch worklet. |
| D4 | One shared song model in `shared/song.ts` (all importers → it): absolute seconds at 100%, string 1 = high e, techniques, chords, tempo map + bar/beat grid, sections, tuning, capo, tags, source ref. |
| D5 | AudioContext clock only. `songTime = (ctx.currentTime − anchorCtxTime) × speed + anchorSongTime`. Worklet-timestamped onsets minus calibrated latency. Windows in real seconds: Perfect ±35, Great ±70, Good ±120 ms. Outcomes Perfect/Great/Good (early/late), WrongNote, Miss. Chords lenient with a UI note. Early/late labels only outside Great. |
| D6 | Keyboard mode: keys `1`–`6` (1 = high e), Shift = deliberately wrong pitch; same judge path. Used by Playwright (+ `?e2e=1` test hook). |
| D7 | Vite dev 5173 proxies `/api` → server 5174; production server serves `dist/` on 5174; `npm run dev` runs both (concurrently + tsx watch). |
| D8 | Learning parameters from `docs/research/learning.md`: speed trainer 70% start, +5% after clean run (≥ 90%), −5% after 2 failed (< 70%), cap 100%; weekly streak with automatic freezes, no loss alerts; loops snap to bars/sections, 1-bar pre-roll; next-day check. Stage mode later. |
| D9 | Parallel implementation in one working tree with disjoint file ownership. T-010 installs all deps and freezes contracts. |
| D10 | Starter library in `starter/` as alphaTex we author: 14 items, tiers 1–6, original exercises + recognisable public-domain melodies in rock/metal-flavoured arrangements. |
| D11 | Extra sources: only the Guitar Pro free pack (link-out + "drop into library" instructions) this iteration; others are candidate tasks below. |
| DEC-12 | **Isomorphic core:** the server imports `src/core/` (pure TS). The same `loadSong()` runs for indexing (server) and playing (browser worker). |
| DEC-13 | Backing audio is copied by the server to `~/.riffway/audio/<sha1>.<ext>`; IndexedDB `audioLinks` holds the link + alignment anchors. Export carries links, not bytes. |
| DEC-14 | Song id = `<source>:<sha1(content)[0..16]>`, sticky per path; starter = `starter:<slug>`. Arrangement = (songId, trackIndex); only 6-string guitar tracks are playable. |
| DEC-15 | Accuracy % = notes hit (Good or better, correct pitch) / judged notes — the same metric as clean runs and mastery. Timing score shown separately. Bests keyed per speed bucket; "best" means 100%. |
| DEC-16 | Contract freeze: T-010 writes all `shared/*` contracts, stub modules with final signatures, and registries (routes, sources, screens, panels). |
| DEC-17 | Rhythm-alignment sidecars live in `~/.riffway/sidecars/<songId>.json` (server); included in export via `/api/sidecars`. |
| DEC-18 | Pitch match tolerates octave errors (±12) by default; "Strict octave" setting turns it off. Dead notes match any onset. |
| DEC-19 | Stray onsets (no candidate note) are shown but neither penalised nor combo-breaking. |
| DEC-20 | Data dir `~/.riffway/` (`RIFFWAY_DATA_DIR` overrides); library default `~/Music/Tabs` (server config). Server binds `127.0.0.1` only. |
| DEC-21 | Guide audio for non-alphaTab songs (ASCII, ClassTab): build an alphaTab `MidiFile` from `Song` notes. Fallback if that API proves impractical: quantise `Song` → alphaTex → alphaTab. Flag in T-021 notes. |
| DEC-22 | Recorded test audio: slices from Univ. of Iowa MIS (unrestricted) and GuitarSet (CC BY 4.0), ≤ 2 MB total, with `ATTRIBUTION.md`. IDMT (ND) rejected, Wikimedia BY-SA avoided. Synthetic Karplus-Strong plucks as fallback. |
| DEC-23 | Deferred despite research marking some "this iteration": Stage mode and performance-ready (D8), Wait mode, Mixed practice, Memory mode, full spaced-review queue (next-day check stays). |
| DEC-24 | The Session (thesession.org) is not implemented: its licence forbids LLM processing, which covers agent-built code and fixtures. Owner decision needed. |

## Contract change requests
| Date | From task | Contract | Change | Status |
|---|---|---|---|---|
| — | — | — | — | — |

## Waves
| Wave | Tasks (parallel within a wave) | Gate after |
|---|---|---|
| 0 | T-010 foundation & contracts | all scripts green |
| 1 | T-011 model+alphaTab · T-012 ASCII+rhythm · T-013 difficulty+handpos · T-014 judge+practice logic · T-015 DSP · T-016 audio engine · T-017 server core · T-018 shell+design · T-019 starter content · T-020 storage+progress | **R1 (T-090)** |
| 2 | T-021 guide synth · T-022 input+tuner · T-023 monitoring+amp · T-024 highway · T-025 ClassTab · T-026 library UI+link-outs · T-027 backing audio · T-028 ASCII import UI · T-029 integration+calibration | tests green |
| 3 | T-031 game+results+keyboard · T-032 practice+mixer UI · T-033 latency calibration · T-034 home+song page · T-035 settings+audio setup · T-036 audio-pipeline tests | **R2 (T-091)** + fixes |
| 4 | T-041 e2e + manual checklist → **R3 (T-092)** + fixes → T-099 wrap-up | merged to main |

## Done
| ID | Title | Agent | Notes |
|---|---|---|---|
| T-000 | Init repo, verbatim spec, player profile | orchestrator | done |
| T-001 | `CLAUDE.md` agent guide | orchestrator | done |
| T-002 | Learning research → `docs/research/learning.md` | research | done |
| T-003 | Sources research → `docs/sources/` | research | done; ClassTab files removed from fixtures (D2) |
| T-004 | Library survey → `docs/research/libraries.md` | research | done |
| T-005 | Architecture docs + this plan | architect | done: `docs/README.md`, `architecture.md`, `timing.md`, `game-mechanics.md`, `audio-input.md`, `monitoring.md`, `song-formats.md`, `difficulty.md`, `progress.md`, `TASKS.md` |
| T-010 | Foundation, configs, shared contracts, stubs | impl-foundation | done 07019f4: 25 tests, all scripts green |

| T-013 | Difficulty + hand-position analysis | impl | done 4bc1e80: 41 tests; worked example changed (old example contradicted window rule) |
| T-020 | Storage and progress core | impl | done dd18d75: 88 tests; CCR: SectionProgress.session (stored locally for now) |
| T-017 | Server core, local+starter adapters, search | impl | done 122d16a: 40 tests; loopback Host/Origin guard; CCRs: ServerOptions.analyzer, LibraryService difficulty/indexing state |
| T-011 | Song model helpers + alphaTab importer | impl | done 3efcc30: 142 tests; golden files; GP7 exports round-trip; triplet feel not applied |
| T-014 | Judge, scoring and practice logic | impl | done 2d337d8: 159 tests incl. window-edge tables at 40-110% speed; bias-corrected matching |
| T-018 | App shell, design system, navigation | impl | done 43884ab: 52 tests; gallery at #/dev/components; reduced motion in e2e |
| T-016 | Audio engine: clock, scheduler, metronome, mixer | impl | done b438eea: 40 node + 9 OfflineAudioContext tests (clicks within 1 sample); limiter = waveshaper (compressor added 6ms) |
| T-015 | DSP core: pitch, onset, level, tuner | impl | done d81438e: 86 tests; MPM <=2 cents E2-E6, no octave errors; onsets ±5ms; tuned on synthetic only |
| T-019 | Starter library content | impl | done 8747edd: 14 alphaTex items tiers 1-6; 147 tests; Rising Sun is an arpeggio study (melody unverified) |
| T-012 | ASCII tab parser + ClassTab rhythm derivation | impl | done d4aba88: 159 tests; synthetic fixtures; ref check 7/7 paired 97-100%; |* *| repeats not expanded |
| T-089 | Wave 1 integration | impl | done db3b2ce: CCRs applied, 988 tests green; .gitignore fix surfaced uncommitted library screen stub |
| T-025 | ClassTab adapter + refresh | impl | done 0f7c9da: 28 tests; real run: 3976 tabs, rhythm MIDI 1921 / ruler 432 / needs-align 1616 |
| T-029 | Integration + difficulty calibration | impl | done b101151: 59 integration tests; all 14 starter items within ±1 tier; worked example now 4.6 |
| T-026 | Library & search UI + link-outs + drag-drop | impl | done e934f25: 80 tests; no external requests verified; 12 screenshots |
| T-102 | R1 platform fixes | impl | done bdb1b54: R1-P-02..12 fixed w/ regression tests; P-01 open for owner |
| T-028 | ASCII paste import + rhythm-alignment UI | impl | done 2ca0d10: 43 tests; snap-to-grid + tap-along + preview; UG link-out only |
| T-101 | R1 core fixes (judge <-> transport) | impl | done 6e58f87: 7 fixed, C-06 rejected, C-08 -> T-022, C-09 provisional; judge driven through real TransportCore |
| T-022 | Input device, analysis worklet, meter, tuner | impl | done 9d805c6: 69 node + 4 browser + 2 fake-mic e2e; flags verified via getSettings |
| T-023 | Monitoring + amp/cab sim + latency display + feedback guard | impl | done 8f8ee10: 48 node + 22 browser; amp+cab adds <0.5 ms; feedback guard |
| T-027 | Backing audio: attach, align, time-stretch | impl | done cafef53: 47 node + 7 browser; clicks within 2.3 ms at 100/70% through wrap/seek/speed |
| T-021 | Guide synth renderer + song worker | impl | done 3ddb919: 27 node + 20 browser; notes ±10 ms; 3-min song renders in 449 ms; DEC-21 resolved (MIDI from Song works) |
| T-024 | Highway renderer (canvas) | impl | done 6734ee6: 23 node + 13 browser; 19.2k notes draw p95 ~0.6 ms |
| T-103 | ClassTab rhythm recall, composer, failed files | impl | done 13762f1: playable 2353->2581; ruler-readable 2087 (~survey 2127); composer 3956/3976; failed files visible |
| T-032 | Practice panel + mixer UI | impl | done eec3689: 57 tests; speed 40-100% (110% overspeed) per transport clamp; A/B strip, trainer ladder, mixer |
| T-030 | Wave 2 integration | impl | done a7b70ef: additive CCRs, Crunch preset, UG/Songsterr lint guard, graceful mounts, vitest port fix |
| T-035 | Settings + audio setup + export/import UI | impl | done 5ab9b1d: 43 tests; guided audio setup; data export/import with preview + merge/replace |
| T-033 | Latency calibration wizard | impl | done c4c1a0b: 41 node + 16 browser; recovers synthetic 37 ms as 37.02 ms through real worklet; per device pair |
| T-034 | Home dashboard + song page | impl | done 19f6603: 49 tests; first-run checklist, recommendations w/ reasons, streak w/o loss copy, song page w/ mastery map |
| T-031 | Game session, keyboard mode, game + results screens | impl | done 5c6cd88: full song driven in real Chromium via keyboard mode; results rebuilt from storage |
| T-036 | Audio-pipeline tests (tones + recorded guitar) | impl | done a820972: 18 tests + 2 it.fails; Iowa 93% recall/100% pitch; GuitarSet below target (pre-attack onsets, octave-down) -> T-104; input lag ~75-83 ms, keep 0.110 s |
| T-040 | Wave 3 integration | impl | done 239cf93: CCRs, app-wide calibration profiles, rewire event, chord note once, failed-import label; built app walk-through clean |
| T-041 | Playwright e2e + screenshots + manual checklist | impl | done 21567a6: 10/10 e2e on prod build, network guard, exact 94P/3W/4M results; 10 screenshots; 12-section manual checklist |
| T-104 | DSP robustness on recorded guitar | impl | done 7a39e09: pickup clip 100/100/100 (was 94/89/94), Iowa 100%, mic 96/85/96; held onsets add <=73 ms event delay (within budget) |
| T-112 | R2 UI/docs/storage fixes | impl | done 086b938: badge removed, ClassTab download card in library, tier-consistent recs, setup flow fixes, e2e deterministic 10/10 |
| T-111 | R2 game runtime + game UX fixes | impl | done 432cef0: I-01..09 fixed; outcome display in gutter, distinct outcome colours, earlier hand cues; held-onset worst 74.1 vs 74.3 ms budget (thin) |
| T-121 | R3 correctness fixes | impl | done 817e710: delivery margin 60 ms; no silent mic fallback; pitch windows scale to 88.2/96/192 kHz; e2e screenshots only with RIFFWAY_UPDATE_SCREENSHOTS=1 |
| T-122 | R3 UX/copy fixes + US spelling sweep | impl | done 98febd4: all R3-U fixed; 1969 tests, e2e 10/10 |

---

## Wave 0

### T-010 · Foundation: dependencies, configs, skeleton, contracts
- **Status:** done · **Deps:** T-005 · **Parallel:** n · **Agent:** `impl-foundation`
- **Owns:** `package.json`, `package-lock.json`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`,
  `playwright.config.ts`, `eslint.config.js`, `index.html`, `.gitignore`, `shared/**`, all stub files and
  registries listed in `docs/architecture.md` (`server/routes/index.ts`, `server/sources/registry.ts`,
  `src/ui/screens/index.ts`, `src/ui/panels/index.ts`), `src/api/client.ts`, `server/index.ts` (bootstrap),
  `tests/foundation/`, `e2e/smoke.spec.ts`, `CLAUDE.md` (commands table), `docs/research/libraries.md` (versions).
- **Acceptance:**
  - Exact pins (no `^`/`~`) from `docs/research/libraries.md`; `engines.node >=22.12`. Packages not in the
    survey (`@fastify/multipart`, `eslint`, `@types/*`, `@vitest/browser-playwright`) pinned to versions
    compatible with the surveyed ones, recorded in libraries.md. `npm ls` clean.
  - Scripts work: `dev` (Vite 5173 + server 5174; `curl :5173/api/health` → ok through proxy), `build`
    (`dist/` + `dist-server/`), `start` (serves page + `/api/health` on 5174), `test` (Vitest node +
    browser projects, one smoke test each incl. an `OfflineAudioContext` render), `test:e2e` (smoke spec
    loads the app with fake-media + autoplay flags), `typecheck`, `lint`, `classtab:refresh` (stub exits 0).
  - `shared/` contracts complete with TSDoc: `song.ts`, `sources.ts`, `api.ts`, `audio-events.ts`,
    `clock.ts`, `judge.ts`, `settings.ts` (+ `DEFAULT_SETTINGS`), `storage.ts` (+ `ExportFile`), `ui.ts`
    (screen/panel mount contract, `AppContext` service registry). Names match the docs or the docs are fixed.
  - Every cross-task module exists as a stub with its final exported signature (throws `NotImplemented`
    or returns safe defaults) so `typecheck` passes; screens/panels/routes/adapters are registered.
  - Path aliases `@shared/*`, `@core/*` work in Vite, Vitest, tsx and esbuild. Worklet loading via
    `?worker&url` proven by a no-op worklet in a browser test. alphaTab `loadAlphaTex` smoke test in Node.
  - `src/api/client.ts`: typed fetch wrapper for every endpoint in architecture.md + SSE subscribe.
  - `?e2e=1` registers `window.__riffwayTest` (stubbed methods; T-031 fills).
- **Notes:** No feature logic. Do NOT run `playwright install` in the agent container (Chromium is pre-installed; if the pinned @playwright/test differs from the preinstalled one, `playwright.config.ts` uses `executablePath: '/opt/pw-browsers/chromium'` when that path exists). Document `npx playwright install chromium` in CLAUDE.md for the owner's Mac.

## Wave 1 (parallel)

### T-011 · Song model helpers + alphaTab importer
- **Status:** done · **Deps:** T-010 · **Parallel:** y · **Agent:** `impl-core`
- **Owns:** `src/core/model/`, `src/core/import/alphatab/`, `src/core/import/load-song.ts`,
  `src/core/import/fret-assign.ts`, `tests/model/`, `tests/import/`, `tests/fixtures/import/`, `docs/song-formats.md` (W1)
- **Acceptance:**
  - `loadSong(bundle, {arrangement})` returns a valid `Song` for `.gp/.gpx/.gp5/.gp4/.gp3`, `.musicxml/.xml/.mxl`,
    `.atex`, and dispatches `.txt/.tab` to T-012's `asciiToSong` (contract). Typed `ImportError`s
    (unsupported, no playable track, alphaTex diagnostics with line/column).
  - String flip golden test (alphaTab string 1 → our 6), tuning high-first, Drop D detected; `midi`
    invariant incl. capo holds.
  - Repeats/voltas expanded; the libraries.md example reproduces 21 notes and bar times 0 / 2000 / 4666.7 /
    6666.7 / 9333.3 ms (±1 ms); times agree with `generateSyncPoints`.
  - One fixture per technique flag (h, p, legatoDest, each slide type, bend semitones incl. release, PM,
    let ring, vibrato, harmonic, dead, tie); chord groups; tied notes not targets.
  - Track listing marks bass/drums/7-string unsupported. MusicXML without tab data → `fret-assign`
    output obeys the span rule.
  - Helpers: `notesInRange` (binary search), `barAt`, `sectionAt`, beats list, auto-sections, `validateSong`.
  - Fixtures are authored (alphaTex → `Gp7Exporter`, hand-written MusicXML); none copied from third parties.
  - No DOM imports (runs in Node and in a worker).

### T-012 · ASCII tab parser + ClassTab rhythm derivation
- **Status:** done · **Deps:** T-010 · **Parallel:** y · **Agent:** `impl-core`
- **Owns:** `src/core/import/ascii/`, `src/core/import/align/`, `src/core/import/midi/`, `tests/ascii/`,
  `tests/align/`, `tests/fixtures/ascii/`, `tests/fixtures/classtab-synthetic/`
- **Acceptance:**
  - `asciiToSong(bundle)` per `docs/song-formats.md`: labelled/unlabelled blocks, multi-digit frets,
    `h p / \ b r ~ x`, `<n>`, `(n)`, `PM` lines, bar lines, `=`/`*` ignored, CRLF, windows-1252 fallback;
    tuning from labels and header prose (`6=D`, `Tuning: D A D G B E`); unparsed lines reported with numbers.
  - Header parse: title/composer, tuning, key, time, `tempo: Q=`, capo, `MIDI:` URL.
  - Beat ruler → `rhythm: 'ruler'` on synthetic 6/8-with-pickup, 3/4 and 4/4 files.
  - MIDI (`@tonejs/midi`) → onset groups; Needleman–Wunsch alignment; ≥ 80% rule; interpolation →
    `rhythm: 'midi'`. Synthetic MIDI built in test setup.
  - `pairClassTab(fileList)` pure: basename, suffixes, header URL, multi-version; tests for each rule and failures.
  - Pure helpers for T-028: `snapToGrid(columns, bpm, timeSig, subdivision)`, `mapTapsToOnsets(taps, groups)`.
  - Sidecar applied → `rhythm: 'aligned'`. Fixture README states every file is authored by us (D2).

### T-013 · Difficulty + hand-position analysis
- **Status:** done · **Deps:** T-010 · **Parallel:** y · **Agent:** `impl-core`
- **Owns:** `src/core/difficulty/`, `src/core/handpos/`, `tests/difficulty/`, `tests/handpos/`, `docs/difficulty.md` (W1)
- **Acceptance:**
  - `analyzeDifficulty(song)` → `DifficultyReport` (per section + song, every factor's measure and `c`)
    exactly per `docs/difficulty.md`; worked example golden 4.1 ± 0.05; Ode-to-Joy-like fixture 1.5 ± 0.2.
  - Monotonicity: higher tempo / more shifts / more techniques never lower the rating.
  - `computePositions(song)` → positions + cues (|Δlo| ≥ 2, lead ≥ 1.5 beats and ≥ 0.75 s); open strings
    never shift; span 5 at lo ≥ 7.
  - Skill-tag derivation (bends, legato, chords, string-skipping, position-shifts).
  - 5,000-note song analysed in < 20 ms (Node).

### T-014 · Judge, scoring and practice logic
- **Status:** done · **Deps:** T-010 · **Parallel:** y · **Agent:** `impl-game`
- **Owns:** `src/core/judge/`, `src/core/practice/`, `tests/judge/`, `tests/practice/`, `docs/game-mechanics.md` (W1)
- **Acceptance:**
  - `createJudge(song, config)` implements every step of the algorithm in `docs/game-mechanics.md`;
    tests for window edges (35/36, 70/71, 120/121 ms), early/late sign, WrongNote, provisional upgrade,
    Miss on close, chord leniency, octave tolerance on/off, dead notes, legato `pitch-change`, retrigger
    guard, strays, pre-roll/count-in unjudged, loop-region-only judging.
  - Scoring: multiplier tiers, score, accuracy (DEC-15), timing score, stars; `RunSummary` with
    histogram, per-section stats, clean flag.
  - `speedTrainer` state machine (D8 parameters incl. 60% start for hard sections, floor 40%) and loop
    math (snap to sections then bars, min 1 bar, pre-roll 1 bar / 2 bars below 60%).
  - Deterministic; 10k events judged in < 50 ms.

### T-015 · DSP core: pitch, onset, level, tuner
- **Status:** done · **Deps:** T-010 · **Parallel:** y · **Agent:** `impl-audio`
- **Owns:** `src/core/dsp/` (except `amp/`), `tests/dsp/`, `tests/helpers/` (signal generators; others may import)
- **Acceptance:**
  - Radix-2 FFT, MPM pitch (allocation-free after init), onset detector, pitch-change detector, level
    meter, tuner smoother per `docs/audio-input.md`.
  - Generated tones E2–E6 (harmonics + noise + pluck envelope): pitch ±10 cents, agreement with `pitchy`
    within 5 cents; onsets ±5 ms; no double onsets over a 2 s decay; synthetic hammer-on → one `pitch-change`.
  - Budget in Node: onset step < 0.1 ms per 128-sample hop; MPM N=2048 < 0.5 ms.

### T-016 · Audio engine: context, clock, scheduler, metronome, mixer
- **Status:** done · **Deps:** T-010 · **Parallel:** y · **Agent:** `impl-audio`
- **Owns:** `src/audio/engine/`, `tests/engine/`, `docs/timing.md` (W1)
- **Acceptance:**
  - `createEngine()`: context (`latencyHint: 0`, sample rate parameter), resume on gesture, `setSinkId`,
    mixer buses `monitor/backing/guide/metronome → master` + safety limiter, levels from settings.
  - Clock per D5 with `songTimeAt`, `ctxTimeAt`, `heardSongTime` (output timestamp); transport
    play/pause/seek/setSpeed/setLoop/count-in; look-ahead scheduler (25 ms / 120 ms); metronome from the
    beat grid with downbeat accent; `registerScheduledSource()` hook re-issued on seek/speed/loop wrap.
  - Tests: clock round trip ≤ 1 µs across speed changes and wraps (Node); `OfflineAudioContext`: clicks
    at exact sample positions across a tempo change, seamless loop wrap (no gap/duplicate click),
    count-in click count, speed change continuity.

### T-017 · Companion server core, local + starter adapters, unified search
- **Status:** done · **Deps:** T-010 · **Parallel:** y · **Agent:** `impl-server`
- **Owns:** `server/` except `server/routes/{classtab,audio,sidecars}.ts` and `server/sources/{classtab,linkout}/`;
  `tests/server/`, `docs/sources/local-folder.md`
- **Acceptance:**
  - Fastify on `127.0.0.1:5174`; config in `~/.riffway/config.json` (DEC-20); routes owned per
    architecture.md; `dist/` static in production; SSE `/api/events`.
  - chokidar 5 watcher (`awaitWriteFinish`, 300 ms debounce); indexer via `loadSong` + `analyzeDifficulty`
    (injectable for tests); `index.json` cache reuses unchanged files (mtime+size); identity per DEC-14;
    sidecars read from `<dataDir>/sidecars/` (DEC-17); `reindex(id)` API for T-028.
  - Local + starter adapters; MiniSearch unified search (fuzzy, prefix) with filters source / tier range /
    tuning / playable / style tags, merging adapters' `linkOuts`.
  - Import: multipart, extension allowlist, 20 MB cap, sanitised names, traversal blocked, ` (2)` on
    collision, sha1 dedupe; indexing left to the watcher.
  - `app.inject` tests with temp dirs: import → indexed → searchable within 2 s; restart reuses cache;
    traversal rejected; each filter; SSE event on change; starter items appear as `starter`.

### T-018 · App shell, design system, navigation
- **Status:** done · **Deps:** T-010 · **Parallel:** y · **Agent:** `impl-ui`
- **Owns:** `src/main.ts`, `src/ui/shell/`, `src/ui/design/`, `src/ui/components/`, `src/ui/router.ts`,
  `src/ui/screens/dev/`, `public/`, `tests/ui-shell/`
- **Acceptance:**
  - Dark Rocksmith-like theme (CSS custom-property tokens), type scale, motion tokens with
    `prefers-reduced-motion`; components: button, slider, toggle, select, card, meter, modal, toast, tabs,
    tier chip, star rating, badge, empty state.
  - Hash router driven by the screens registry; top nav (Home, Library, Import, Audio setup, Settings);
    menu keyboard navigation (arrows / Enter / Esc, visible focus); "Click to enable audio" gesture overlay.
  - Component gallery at `#/dev/components` for screenshots. Layout works from 1024 px wide.
  - happy-dom tests for router and keyboard navigation.

### T-019 · Starter library content
- **Status:** done · **Deps:** T-010 · **Parallel:** y · **Agent:** `impl-content`
- **Owns:** `starter/`, `tests/starter/`
- **Acceptance:**
  - 14 alphaTex files + `starter/manifest.json` (`slug, title, credit, publicDomainNote, tags, targetTier, bpm`)
    + `starter/README.md` (PD statement per melody, "arrangements original to Riffway").
  - Items (target tier): Open Strings & First Frets (1) · Ode to Joy (2) · Power Chord Drive (3) ·
    Greensleeves (3, 3/4, hammer-ons) · Scarborough Fair (3, slides) · Drop-D Palm-Mute Chug (4, Drop D) ·
    House of the Rising Sun, trad. (4, 6/8 arpeggios) · In the Hall of the Mountain King (4–5, accelerating
    tempo map, PM) · Pentatonic Box Lick (5, bends/hammer/pull/vibrato) · Alternate Picking Builder (5) ·
    Carol of the Bells (5, metal ostinato) · Für Elise theme (5, position shifts) · Spanish Romance, anon.
    (6, fingerstyle, harmonics) · Bourrée in E minor BWV 996 (6, fingerstyle).
  - Each loads via alphaTab with zero diagnostics, has ≥ 2 sections and tags; every technique glyph
    appears in at least one item; melody note names written in a comment and checked by a test.
- **Notes:** Calibration against computed difficulty happens in T-029.

### T-020 · Storage and progress core
- **Status:** done · **Deps:** T-010 · **Parallel:** y · **Agent:** `impl-storage`
- **Owns:** `src/storage/`, `src/core/progress/`, `tests/storage/`, `tests/progress/`, `docs/progress.md` (W1)
- **Acceptance:**
  - `idb` schema v1 exactly per `docs/progress.md`, fall-through migrations harness; settings store
    (get/set/subscribe, defaults merged); APIs for runs, bests, sectionProgress, practiceDays, streak,
    audioLinks, songCache.
  - Pure `mastery`, `streak`, `recommend` modules with the tests listed in progress.md (freeze earn/apply,
    grace, year boundary, DST, recommendation mix 6/3/1 and determinism).
  - Export/import: validate, migrate, preview, merge/replace; round trip yields identical stores
    (`fake-indexeddb`).

### T-089 · Wave 1 integration: contract changes, doc fixes, stale tests
- **Status:** done · **Deps:** T-011…T-020 · **Parallel:** y (with T-090 review, read-only) · **Agent:** `impl-integration`
- **Owns:** `shared/**`, `src/app/services.ts`, `tests/foundation/`, `.gitignore`, `src/ui/design/tokens.ts`, `docs/game-mechanics.md`, `docs/song-formats.md`, `src/core/import/` (small fixes only), `server/` (CCR wiring only)
- **Acceptance:** CCRs applied (SectionProgress.session; ServerOptions.analyzer; LibraryService difficulty + per-source indexing state, removing `instanceof LibraryIndex`; EngineOptions.settings + services.ts passes ctx.settings); foundation tests assert real behaviour instead of NotImplemented; `.gitignore` `/library/` root-only; tokens.ts uses core `tierName`; docs fixed (hand-position rules from T-013; alphaTex `{h}` for hammer/pull and `//` tags comment; rhythm precedence sidecar>MIDI>ruler>proportional; `version` option); `loadSong` passes `version`; alphaTab console noise on corrupt files silenced; `|*`…`*|` ASCII repeats expanded. Full `npm test`, typecheck, lint green.

### T-090 · Review round R1 (contracts + core logic)
- **Status:** done · **Deps:** T-011…T-020 · **Parallel:** n · **Agent:** `review`
- **Owns:** `docs/reviews/R1.md`; adds fix tasks `T-1xx` to this file
- **Acceptance:** full test/typecheck/lint run; contracts vs docs; core logic vs docs (judge, difficulty,
  timing math, model invariants); forbidden-network grep (`songsterr.com/api`, UG fetches, classtab in
  tests); findings ranked with fix tasks assigned to the owning agent.

### T-101 · R1 fixes: judge ↔ transport integration (core)
- **Status:** done · **Deps:** T-090 · **Parallel:** y (with Wave 2) · **Agent:** `impl-fix-core`
- **Owns:** `src/core/judge/`, `src/core/practice/`, `src/audio/engine/`, `src/core/dsp/` (except `amp/`), `src/core/difficulty/` (except `constants.ts`), `src/core/handpos/`, their tests, `docs/timing.md`, `docs/game-mechanics.md`, `docs/reviews/R1-core.md` (status column)
- **Acceptance:** every R1-C finding fixed or explicitly rejected with reasoning in R1-core.md; new tests drive the judge through the REAL `TransportCore` (multi-anchor, loops of 1–2 bars at 40–100% speed, hidden-tab horizon, pause/resume, seek fwd/back, setSpeed/setLoop near B) and fail on the old code; docs/timing.md and game-mechanics.md agree on paused-clock semantics. Full suite green.

### T-102 · R1 fixes: importers, progress (platform)
- **Status:** done · **Deps:** T-090 · **Parallel:** y (with Wave 2) · **Agent:** `impl-fix-platform`
- **Owns:** `src/core/import/` , `src/core/progress/`, `src/storage/`, `src/core/model/`, `server/` except Wave 2-owned files (`server/sources/{classtab,linkout}/`, `server/routes/{classtab,audio,sidecars}.ts`), `src/ui/{shell,design,components}/`, `starter/`, their tests, `docs/progress.md`, `docs/reviews/R1-platform.md` (status column)
- **Acceptance:** every R1-P finding except R1-P-01 fixed or explicitly rejected with reasoning; regression test per fix; doc changes for docs/song-formats.md (owned by T-028 this wave) listed in the report instead of edited. R1-P-01 stays open for the owner (wrap-up). Full suite green.

### T-103 · ClassTab rhythm recall + composer fallback + failed-file visibility
- **Status:** done · **Deps:** T-025, T-102 · **Parallel:** y · **Agent:** `impl-fix-platform`
- **Owns:** `src/core/import/ascii/`, `src/core/import/align/`, `src/core/import/midi/`, `server/indexer/`, `tests/ascii/`, `tests/align/`, `tests/server/`, `tests/fixtures/classtab-synthetic/`
- **Acceptance:** beat-ruler detection recall raised toward the survey estimate (~2,127 tabs with rulers vs 432 detected) measured on the scratch reference set + one real-refresh run (no ClassTab content committed); investigate the 354 paired tabs failing strict MIDI match (true negatives vs fixable); composer fallback from ClassTab filename (`composer_title` convention); unparsable files in the library listed with a visible "failed to import" state instead of silently skipped. Report before/after counts. Full suite green for owned areas.

## Wave 2 (parallel)

### T-021 · Guide synth renderer + song worker
- **Status:** done · **Deps:** T-011, T-016 · **Parallel:** y · **Agent:** `impl-audio`
- **Orchestrator notes (from W1):** Guide source contract: each `schedule(seg)` replaces everything previously scheduled from `seg.ctxStart` on (docs/timing.md). Two starter items use `\voice` (multi-voice) and natural-harmonic realValue is the sounding pitch.
- **Owns:** `src/audio/guide/`, `tests/guide/`
- **Acceptance:**
  - `song.worker.ts` (alphaTab main entry, not `/worker`): bundle → `loadSong` → `Song`; `MidiFile` via
    `MidiFileGenerator` (alphaTab sources) or built from `Song` notes (DEC-21); `sonivox.sf2` via Vite `?url`;
    offline render in 5 s chunks, PCM transferred; re-render at speed s (tempo × s, no pitch shift).
  - Guide player schedules buffers on the guide bus through `registerScheduledSource`; seek, loop slices
    and bar-aligned speed changes work; mute toggle.
  - Tests: rendered onsets within ±10 ms of model times at 100% and 50%; rendered pitch (MPM) equals the
    note's MIDI at 50% speed; browser scheduling test against the clock.
  - 3-minute song renders in < 2 s in a Chrome worker (browser test or logged measurement).

### T-022 · Input device, analysis worklet, level meter, tuner
- **Status:** done · **Deps:** T-015, T-016, T-018 · **Parallel:** y · **Agent:** `impl-audio`
- **Orchestrator notes (from W1):** Also own the docs/audio-input.md update to match T-015's DSP (no spectral flux; 2nd-diff+energy onset; octave check +0.03; 1-semitone range margin; -120 dB floor). Pass the window-centre frame to the pitch-change detector (`changeFrame`). Synthetic test notes must fade out (abrupt cut reads as onset). Thresholds were tuned on synthetic signals only; T-036 validates on recordings.
- **Owns:** `src/audio/input/`, `src/audio/worklets/analysis.worklet.ts`, `src/ui/panels/input/`,
  `src/ui/panels/tuner/`, `tests/input/`, `docs/audio-input.md` (W2)
- **Acceptance:**
  - Device listing, USB-label preselect, persistence and re-matching by id then label, `devicechange`,
    output select via `setSinkId`; constraints exactly per audio-input.md with read-back warnings.
  - Analysis worklet wraps T-015 DSP; bridge converts frames → context seconds, applies `inputOffsetMs`,
    emits `InputEvent`s; `expect` hints API.
  - Level meter panel (zones, peak hold, clip, "No signal"); tuner panel (song tuning aware, ±3 cents
    in-tune, A4 setting).
  - Browser test: `AudioBufferSource` of generated plucks → worklet → events with correct frames (±5 ms)
    and pitches; unit tests for device matching.

### T-023 · Monitoring + amp/cab sim + latency display + feedback guard
- **Status:** done · **Deps:** T-016 · **Parallel:** y · **Agent:** `impl-audio`
- **Orchestrator notes (from W1):** docs/monitoring.md: engine limiter is a zero-latency WaveShaper soft clipper (DynamicsCompressor added ~6 ms), update the doc. Screens calling requireAudioGesture() must handle AudioGestureDismissedError.
- **Owns:** `src/core/dsp/amp/`, `src/audio/monitor/`, `src/audio/worklets/amp.worklet.ts`,
  `src/ui/panels/monitor/`, `tests/monitor/`, `docs/monitoring.md` (W2)
- **Acceptance:** everything in `docs/monitoring.md`: Clean / Overdrive / DI presets, oversampled clipper,
  tone stack, biquad cab, latency estimate display with bands and tips, headphone card, speaker guard,
  runaway guard, safety limiter respected; all tests listed there pass (incl. < 1 ms added delay).
- **Notes:** Takes the input node from T-022's `getInputNode()` contract.

### T-024 · Highway renderer (canvas)
- **Status:** done · **Deps:** T-011, T-013, T-016 · **Parallel:** y · **Agent:** `impl-game`
- **Owns:** `src/game/highway/`, `src/ui/screens/dev-highway/`, `tests/highway/`
- **Acceptance:**
  - `createHighway(canvas, song, clock, opts)`: six lanes (high e on top), fret-number gems, sustains,
    bar/section lines, every technique glyph in game-mechanics.md, hand-position cue brackets, hit feedback
    (flash, pooled particles, outcome text, "played G3", Miss grey), combo flame and chord-note hooks.
  - Reads `heardSongTime` only; x per game-mechanics.md (constant real-time velocity); DPR scaling;
    pre-rendered lanes + sprite atlas; binary-search culling; no per-frame allocation in the draw loop.
  - Perf: synthetic 20-min, 16 notes/s song: draw time p95 < 4 ms in headless Chrome.
  - `#/dev/highway` renders a fixture song with all glyphs for screenshots.

### T-025 · ClassTab adapter + refresh command
- **Status:** done · **Deps:** T-012, T-017 · **Parallel:** y · **Agent:** `impl-server`
- **Owns:** `server/sources/classtab/`, `server/routes/classtab.ts`, `scripts/classtab-refresh.ts`,
  `tests/classtab/`, `docs/sources/classtab.md`
- **Acceptance:**
  - Conditional GET with stored ETag/Last-Modified; `304` → no-op; once-per-day limit unless `--force`;
    retry with ≥ 10 s backoff; yauzl streaming extract into `<dataDir>/classtab/` with zip-slip guard;
    only `.txt`/`.mid` kept; nothing executed.
  - Index via T-012 (pairing, MIDI alignment, ruler) with `fingerstyle`/`classical` tags and composer;
    rhythm status per song; `GET /api/songs/:id/rhythm`; status/refresh routes with SSE progress.
  - Tests run a local HTTP server serving a zip built in-test from synthetic files: 200 then 304, zip-slip
    entry rejected, index counts and rhythm statuses. No request to classtab.org from tests.

### T-026 · Library & search UI + link-out adapters + drag-drop import
- **Status:** done · **Deps:** T-017, T-018 · **Parallel:** y · **Agent:** `impl-ui`
- **Owns:** `server/sources/linkout/`, `src/ui/screens/library/`, `tests/linkout/`, `tests/library-ui/`,
  `docs/sources/{README,songsterr,ultimate-guitar,candidates}.md`
- **Acceptance:**
  - Songsterr, Ultimate Guitar and GP-free-pack adapters: URL builders per their docs, Songsterr
    title/artist normaliser + local matching (D1); tests stub `fetch` to throw, proving no network I/O.
  - Library screen: one search box (150 ms debounce), result rows with source badge, tier chip, tuning,
    style tags, rhythm status, "playable now" vs "needs import" vs "needs rhythm"; filters source /
    difficulty range / tuning / playable / style; link-out row opening new tabs (`noopener`); whole-window
    drop zone → import with progress and toasts; live SSE refresh; arrangement picker → song page.

### T-027 · Backing audio: attach, align, time-stretch
- **Status:** done · **Deps:** T-016, T-017, T-020 · **Parallel:** y · **Agent:** `impl-audio`
- **Orchestrator notes (from W1):** Backing source contract: each `schedule(seg)` replaces everything previously scheduled from `seg.ctxStart` on (docs/timing.md).
- **Owns:** `server/routes/audio.ts`, `src/audio/backing/`, `src/ui/panels/backing/`, `tests/backing/`
- **Acceptance:**
  - `POST/GET/DELETE /api/audio` (sha1 store, mp3/wav/m4a allowlist, 200 MB cap); `audioLinks` via storage.
  - Warp model (anchors, piecewise linear, extrapolation) as pure functions with tests; signalsmith-stretch
    worklet scheduling (`rate = speed × slope`, ≥ `latency()` ahead, rate change at anchor boundaries).
  - Alignment panel: waveform + beat grid, drag offset, ±10 ms nudge, tap-beat anchors, play-check with click;
    guide auto-muted when backing is on (toggle).
  - Browser test: aligned backing onset lands within ±10 ms of the clock's beat at 100% and 75%.

### T-028 · ASCII paste import + rhythm-alignment UI
- **Status:** done · **Deps:** T-012, T-016, T-017; T-021 contract · **Parallel:** y · **Agent:** `impl-ui`
- **Owns:** `src/ui/screens/import/`, `server/routes/sidecars.ts`, `tests/ascii-ui/`, `docs/song-formats.md` (W2)
- **Acceptance:**
  - Import screen per song-formats.md § Rhythm alignment UX: paste or open file, preview with unparsed lines
    highlighted, meta/tuning fields, BPM + time signature + tap tempo, snap-to-grid preview with guide audio,
    tap-along with metronome (undo, restart from bar), confirm.
  - Routes: `POST /api/library/paste`, `GET/PUT /api/songs/:id/sidecar` (triggers `reindex`),
    `GET/POST /api/sidecars`. Any `needs-alignment` song opens here via "Align rhythm".
  - Tests: route tests via `app.inject`; UI flow test (happy-dom) from paste to saved sidecar.

### T-029 · Integration: indexer ↔ importers ↔ difficulty calibration
- **Status:** done · **Deps:** T-011, T-013, T-017, T-019 · **Parallel:** y · **Agent:** `impl-core`
- **Orchestrator notes (from W1):** Two starter items use `\voice`; ensure both voices import as playable notes. Run the real analyzer end to end (T-017 tests use a fake analyzer).
- **Owns:** `tests/integration/`, `src/core/difficulty/constants.ts` (W2), `docs/difficulty.md` (W2)
- **Acceptance:** server indexes `starter/` with real difficulty; every starter item within ±1 of
  `targetTier` (adjust constants, update the doc and the worked example if it changes); search
  "mountain king" returns the starter item with tier; `GET /api/songs/:id/file` → `loadSong` in Node gives
  the indexed note count.

### T-030 · Wave 2 integration: contract changes, doc fixes, config, robustness
- **Status:** done · **Deps:** Wave 2 · **Parallel:** y (with Wave 3; additive changes only) · **Agent:** `impl-integration`
- **Owns:** `shared/**`, `vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `package.json` (scripts only), `src/types/`, `src/ui/screens/index.ts`, `src/ui/screens/library/`, `src/ui/panels/input/`, `src/ui/panels/tuner/` (if separate), `src/audio/monitor/`, `src/core/dsp/amp/`, `src/game/highway/`, `tests/foundation/`, `starter/README.md`, docs: `song-formats.md`, `sources/local-folder.md`, `game-mechanics.md`, `monitoring.md`
- **Must NOT touch:** Wave 3 owned paths, T-103 paths (`src/core/import/{ascii,align,midi}/`, `server/indexer/`, `tests/server/`), `docs/timing.md` (T-033 this wave — send text in report).
- **Acceptance:** (1) CCRs: `SongClockMapping.ctxTimeInPass?`; doc wording for `ClockChange.pass` + `Judge.startPass` (T-101); `matchRoute` catches URIError → null; `shared/storage.ts` `passesSinceGain` comment; `AmpPresetId` gains `'crunch'` with a real Crunch preset; `LatencyEstimate.parts.dspMs` + assumed flags (remove local extensions); fix `src/types/signalsmith-stretch.d.ts` (Promises, transfer list) and drop T-027's local workaround types if they live in owned paths, else note. (2) `vite.config.ts` `optimizeDeps.include: ['@coderline/alphatab']`. (3) ESLint `no-restricted-syntax`/regex rule banning `songsterr.com/api` anywhere and `ultimate-guitar.com` except link-out builders (`server/sources/linkout/`, `src/ui/screens/import/model.ts`). (4) Library screen + tuner panel mount gracefully with a minimal context (foundation registries test green without weakening it). (5) Monitor re-reads `input.getInputNode()` on device change; highway uses `cueShowAt`. (6) Vitest browser port collisions when runs overlap: make the browser API port configurable/auto (document). (7) npm script `test:e2e:input` for `tests/input/e2e`. (8) Docs: ClassTab match rule (sim ≥ 0.5, octave shift, skipped run = 1 miss) in song-formats.md; Origin-port rule, two-phase import, transient-only retries in local-folder.md; highway layout line in game-mechanics.md; Mountain King rating in starter README. Full suite, typecheck, lint green (except files mid-edit by Wave 3 / T-103 — list them).

## Wave 3 (parallel)

### T-031 · Game session, keyboard mode, game + results screens
- **Status:** done · **Deps:** T-014, T-020, T-021, T-022, T-024, T-027 · **Parallel:** y · **Agent:** `impl-game`
- **Orchestrator notes (from W1):** (Superseded by T-101:) one judge per run, created just before `play()`; call `startPass({pass: change.pass})` on ANY clock change with a different pass (loops, seeks, jumps); call `advance(inputHorizon(...))` (not ctx.currentTime), also while paused. Clock `ctxTimeInPass` returns NaN while paused, -Infinity for skipped notes. Use `cueShowAt` for hand cues. Use `guideShouldMute(settings, backing.link)` for guide muting. Send `expect` hints (upcoming note pitches) to the analysis worklet — without them onsets below D#2 get no pitch (Drop D). DOM tests that build the app context must `import 'fake-indexeddb/auto'`. Handle AudioGestureDismissedError.
- **Owns:** `src/game/session/`, `src/game/input/`, `src/test-hooks/`, `src/ui/screens/game/`,
  `src/ui/screens/results/`, `tests/session/`, `docs/game-mechanics.md` (W3)
- **Acceptance:**
  - Session loads via worker, sets up guide/backing, transport, guitar + keyboard inputs → judge → HUD
    (score, combo/multiplier, accuracy, section progress bar, chord-leniency note, early/late per
    bandwidth rule, feedback-detail setting); pause menu; play vs practice mode; no-fail.
  - Keyboard mode per D6 (remappable keys from settings, Shift wrong pitch, keyboard offset).
  - Results screen per game-mechanics.md (histogram, heatmap, weakest section → "Loop this", bests); run,
    bests, section progress and active time saved.
  - `window.__riffwayTest` (`?e2e=1`): `inject`, `getState`, `getJudgements`, `setSpeed`, `seek`.
  - Tests: scripted events through a fake engine give the expected `RunSummary`; keyboard mapping.

### T-032 · Practice panel + mixer UI
- **Status:** done · **Deps:** T-014, T-016, T-020 · **Parallel:** y · **Agent:** `impl-ui`
- **Owns:** `src/ui/panels/practice/`, `src/ui/panels/mixer/`, `tests/practice-ui/`
- **Acceptance:** speed slider 40–100% (110% opt-in after mastery); A/B loop editor on a section/bar strip
  with snapping and "loop section" buttons; pre-roll rules; speed-trainer toggle with live messages
  ("Clean run! +5% → 80%", "Slow down a notch"); count-in bars; metronome toggle/volume; mixer sliders
  (monitor, backing, guide, metronome, master) persisted. Tests with a fake session.

### T-033 · Latency calibration wizard
- **Status:** done · **Deps:** T-016, T-022 · **Parallel:** y · **Agent:** `impl-audio`
- **Owns:** `src/audio/calibration/`, `src/ui/panels/calibration/`, `tests/calibration/`, `docs/timing.md` (W3)
- **Acceptance:** play-to-click, tap-to-click and visual offset exactly per timing.md (pairing, median,
  MAD rejection, ≥ 8 pairs, spread ≤ 15 ms, retry, "estimated" fallback); results saved in settings;
  algorithm unit tests; browser test recovers a synthetic 37 ms delay within ±3 ms through the analysis worklet.

### T-034 · Home dashboard + song page
- **Status:** done · **Deps:** T-018, T-020, T-026, T-027, T-028 · **Parallel:** y · **Agent:** `impl-ui`
- **Owns:** `src/ui/screens/home/`, `src/ui/screens/song/`, `tests/home/`
- **Acceptance:** home shows 3 session goals, recommendations (6/3/1), streak (current/best, week dots,
  freezes), daily goal ring, next-day checks, continue last song, first-run checklist (input → tune →
  calibrate → first starter song). Song page: meta, difficulty breakdown ("why"), arrangements, sections
  with mastery, bests per speed, accuracy sparkline, attach backing audio, align rhythm, Play / Practice.

### T-035 · Settings + audio setup screens + export/import UI
- **Status:** done · **Deps:** T-018, T-020, T-022, T-023 · **Parallel:** y · **Agent:** `impl-ui`
- **Owns:** `src/ui/screens/settings/`, `src/ui/screens/audio-setup/`, `tests/settings/`
- **Acceptance:** settings for library folder (`PUT /api/config`), sources + ClassTab refresh/status,
  game options (feedback detail, hand cues, strict octave, note speed), keyboard mapping, goals,
  fingerstyle preference, export/import (preview, merge/replace), reset data with confirm. Audio setup
  assembles input → tuner → monitoring → calibration panels in a guided order. All persist across reload.

### T-036 · Audio-pipeline tests (generated tones + recorded guitar)
- **Status:** done · **Deps:** T-014, T-015, T-016, T-022 · **Parallel:** y · **Agent:** `test`
- **Owns:** `tests/audio-pipeline/`, `tests/fixtures/audio/`, `scripts/fetch-audio-fixtures.ts`, `docs/audio-input.md` (W3)
- **Acceptance:**
  - Browser `OfflineAudioContext`: scripted pluck melody (known onsets, one wrong pitch, one omitted note)
    → analysis worklet → judge → expected outcomes; timing error mean ≤ 5 ms, p95 ≤ 10 ms.
  - Recorded clips per DEC-22 (≤ 6 clips, 48 kHz mono 16-bit, ≤ 2 MB, `ATTRIBUTION.md`, provenance
    script): pitch accuracy ≥ 95%, onset recall ≥ 90% and precision ≥ 90% at ±30 ms vs annotations.
  - Measured numbers recorded in audio-input.md. If downloads are blocked, mark `blocked` for the recorded
    part and ship the synthetic suite.

### T-091 · Review round R2 (integration, UX, performance, compliance)
- **Status:** done · **Deps:** wave 3 · **Parallel:** n · **Agent:** `review`
- **Owns:** `docs/reviews/R2.md`; adds fix tasks
- **Acceptance:** walk the spec's Definition of Done in the running app (keyboard mode); 60 fps on a
  dense song; server security (localhost bind, traversal, zip-slip); source-terms compliance; docs vs
  behaviour; fix tasks filed and scheduled before wave 4.

### T-040 · Wave 3 integration: contract changes, startup wiring, polish
- **Status:** done · **Deps:** Wave 3 · **Parallel:** y (with T-036, T-041) · **Agent:** `impl-integration`
- **Owns:** `shared/**`, `src/main.ts`, `src/app/`, `src/ui/screens/**` (except none), `src/ui/panels/**`, `src/game/**`, `src/audio/{input,monitor,backing,calibration}/`, `server/` (small fixes), `tests/` for those areas (not `tests/audio-pipeline/`), docs: `song-formats.md`, `sources/classtab.md`, `game-mechanics.md`, `progress.md`
- **Must NOT touch:** T-036 paths (`tests/audio-pipeline/`, `tests/fixtures/audio/`, `scripts/fetch-audio-fixtures.ts`, `docs/audio-input.md`), T-041 paths (`e2e/`, `playwright.config.ts`, `docs/manual-test-checklist.md`).
- **Acceptance:** (1) CCRs, then remove local workarounds: `RiffwayTestHook.getNotes()`; `CalibrationSettings.profiles` + `deviceKey`, `CalibrationMethod 'loopback'`; `MixerLevels` per-bus mute; `GameSession` getters `countInBars`/`metronome`/`trainerState` (show trainer fail streak); metronome-accent setting wired to engine; Settings `game.timingLeniency`, `game.inputMode`, `game.fretNumbers` (+ highway fret-number toggle). (2) App startup calls `followCalibrationProfiles(ctx.settings)` so offsets follow device switches app-wide. (3) Input service fires `onDevicesChanged` after a context-change rewire; drop the monitor's polling workaround. (4) `stretch.ts` drops local `RawStretchNode`. (5) Chord note shown once (keep highway's, or HUD chip — pick the clearer). (6) Home checklist deep-links to `#/audio-setup?step=`; session sets `songCache.lastPlayedAt`. (7) Library: entries with an import error show "Failed to import" and `rhythmCounts` skips them. (8) `tests/server/network-guard.test.ts` vs `tests/foundation/lint-guards.test.ts` conflict resolved without weakening the guard for shipped code. (9) Docs: T-103 ruler/duet/MIDI-retry text into song-formats.md; counts table + composer rule into sources/classtab.md; T-032 shortcut map in game-mechanics.md (verify present). Full `npm test`, typecheck, lint, build green (except T-036/T-041 files mid-edit — list them).

### T-104 · DSP robustness on recorded guitar
- **Status:** done · **Deps:** T-036 · **Parallel:** y (with T-040, T-041) · **Agent:** `impl-fix-core`
- **Owns:** `src/core/dsp/` (except `amp/`), `tests/dsp/`, `tests/audio-pipeline/`, `docs/audio-input.md`
- **Acceptance:** fix the failing cases T-036 documented in docs/audio-input.md: pre-attack pick/finger-noise onsets 20–50 ms early (and the double onset when gap > 40 ms), octave-down errors with expect hints at N=1024 on the mic clip, stray onsets, bend read as WrongNote (pitch tracking through bends). Raise GuitarSet floors toward 90/90/95 (recall/precision/pitch) without regressing Iowa or synthetic tests (pitch ≤ 2 cents, onsets ±5 ms, no double onsets on decays, single onset on hammer-on); convert `it.fails` to passing tests where fixed. Keep worklet hot path allocation-free. Report before/after table.

### T-111 · R2 fixes: game runtime + game-screen UX
- **Status:** done · **Deps:** T-091 · **Parallel:** y (with T-112) · **Agent:** `impl-fix-game`
- **Owns:** `src/game/**`, `src/audio/**`, `src/core/judge/`, `src/core/practice/`, `src/ui/screens/game/`, `src/ui/screens/results/`, `src/ui/design/` (tokens for outcome colours), `tests/` for those areas, `docs/game-mechanics.md`, `docs/timing.md`, `docs/monitoring.md`
- **Findings:** R2-I-01…06, I-08, I-09; R2-U-01…06, U-14, U-16, U-17, U-18, U-21, U-22, U-30; T-041 notes 2 & 6 (`scratchpad/t041-ux.md`); flaky perf budgets (`tests/judge/scoring.test.ts`, `tests/highway/perf.browser.test.ts`, `tests/guide/render.test.ts`); verify T-104 held-onset delay (≤73 ms in worklet + main-thread delay) always lands inside the judge's input horizon.
- **Acceptance:** each finding fixed (or rejected with reasoning) and marked in the review file's Status column; regression test per behavioural fix; screenshots verify UX fixes at 1440×900 and 1280×720; full suite + e2e green.

### T-112 · R2 fixes: library/home/song/import/setup/practice UX, docs, storage, e2e flake
- **Status:** done · **Deps:** T-091 · **Parallel:** y (with T-111) · **Agent:** `impl-fix-ui`
- **Owns:** `src/ui/screens/{home,song,library,import,settings,audio-setup}/`, `src/ui/panels/**`, `src/ui/shell/`, `src/core/progress/`, `src/storage/`, `server/sources/linkout/`, `e2e/`, `docs/sources/`, `docs/research/learning.md`, `docs/user-profile.md`, `docs/progress.md`, `docs/song-formats.md`
- **Findings:** R2-I-07; R2-U-07…13, U-15, U-19, U-20, U-23…28; R2-S-03…10, S-13, S-15 (CLAUDE.md env line: send text in report); T-041 notes 1, 3, 4, 5, 7; `src/storage/validate.ts` union checks for new string settings. For S-09 remove the promise from the doc rather than implementing it. For S-10 show the loopback-measured round trip in the monitor panel when available.
- **Acceptance:** as T-111.

### T-121 · R3 fixes: correctness
- **Status:** done · **Deps:** T-092 · **Parallel:** y (with T-122) · **Agent:** `impl-fix-core`
- **Owns:** `src/core/judge/`, `src/core/dsp/` (except `amp/`), `src/audio/input/`, `src/audio/worklets/analysis.worklet.ts`, `src/game/session/`, `playwright.config.ts`, `e2e/support/`, tests for those areas, `docs/timing.md`, `docs/audio-input.md`, `docs/game-mechanics.md` (judge sections only)
- **Findings:** R3-C-01 (widen delivery margin to ~60 ms; document Miss-mark delay), R3-C-02 (no silent laptop-mic fallback in guitar/auto mode: pause with notice like I-04, or require explicit opt-in), R3-C-03 (pitch window scales with sample rate so E2–F#2 and Drop-D D2 work at 88.2/96 kHz; tests at 44.1/48/88.2/96 kHz), R3-C-04 (`npm run test:e2e` must not rewrite committed screenshots unless an explicit env flag is set, e.g. `RIFFWAY_UPDATE_SCREENSHOTS=1`; document in CLAUDE.md text in report).
- **Acceptance:** each fixed with regression tests; Status column in R3-correctness.md; full suite + e2e green.

### T-122 · R3 fixes: UX, copy, spelling sweep
- **Status:** done · **Deps:** T-092 · **Parallel:** y (with T-121) · **Agent:** `impl-fix-ui`
- **Owns:** `src/ui/**`, `src/game/highway/`, `src/core/progress/`, `docs/manual-test-checklist.md`, `docs/progress.md`, `e2e/*.spec.ts` (selectors/copy only), tests for those areas
- **Findings:** R3-U-01, 02, 04–24 (R3-U-03 is the orchestrator's). R3-U-21 = R2-U-29 spelling sweep: standardise ALL user-facing copy on US English (practice, favorite, recognize, color…) — UI strings only plus the manual checklist; keep code identifiers stable. Also lane letters on the hit-line target wells are partly occluded by the hit line (orchestrator observation) — make them readable.
- **Acceptance:** each fixed or rejected with reason in R3-ux-dod.md Status column; screenshots at 1440×900 and 1280×720 verify; full suite + e2e green.

## Wave 4

### T-041 · Playwright e2e + screenshots + manual test checklist
- **Status:** done · **Deps:** wave 3, R2 fixes · **Parallel:** n · **Agent:** `test`
- **Owns:** `e2e/` (incl. `e2e/screenshots/`, `e2e/fixtures/`), `docs/manual-test-checklist.md`
- **Acceptance:**
  - Runs against the production build with a temp data dir and library (starter + authored GP + ASCII);
    flags: autoplay, fake media with a WAV.
  - Specs: audio setup with fake device (meter moves); search across sources incl. link-out URLs and
    `target=_blank`; drag-drop import → appears; paste ASCII → snap → playable; play a starter song via
    the test hook with exact Perfect / WrongNote (Shift) / Miss counts on results; real keypress smoke;
    speed 70% + A/B loop wraps twice; export → import round trip; persistence across reload.
  - Screenshots: home, library + filters, import/alignment, audio setup, tuner, calibration, game
    mid-song (hit feedback, glyphs, hand cue), results, settings.
  - Manual checklist: input selection, levels, tuner vs reference, calibration repeatability (3 runs
    within ±5 ms), monitoring latency feel, headphone/speaker guard, single notes on all strings frets
    0–12, legato, chord leniency, backing-audio sync, human check that Songsterr/UG link-outs land on results.

### T-092 · Review round R3 (final)
- **Status:** done · **Deps:** T-041 · **Parallel:** n · **Agent:** `review`
- **Owns:** `docs/reviews/R3.md`; adds fix tasks
- **Acceptance:** all tests, typecheck, lint and e2e green; DoD checklist ticked with evidence; docs
  current; fix tasks closed or explicitly deferred with the owner's visibility.

### T-099 · Wrap-up
- **Status:** todo · **Deps:** T-092 · **Parallel:** n · **Agent:** orchestrator
- **Owns:** `docs/README.md`, `TASKS.md`, `CLAUDE.md`
- **Acceptance:** README state updated, CLAUDE.md commands match `package.json`, open questions listed
  for the owner (D1 acceptance, DEC-24), branch merged to `main` and pushed.

## Review fix tasks
R1: T-101, T-102 (+ T-103, T-104 follow-ups). R2: T-111, T-112. R3: T-121, T-122. See docs/reviews/.
Added by R1–R3 as `T-1xx` with owner, owned files and acceptance.

## Candidate sources (not this iteration unless noted)
| ID | Source | Status | Terms | Effort | Notes |
|---|---|---|---|---|---|
| T-060 | Mutopia Project adapter | todo — candidate, not this iteration | PD / CC BY / CC BY-SA per piece; robots allows all | M | Index `.rdf`, fetch `.mid` on demand ≤ 1 req/s, fret-assign via T-011; attribution per piece |
| T-061 | MusicBrainz metadata normalisation | todo — candidate | CC0 core data; ≤ 1 req/s, descriptive UA | S | Low value; local fuzzy matching suffices |
| T-062 | The Session (ABC) | blocked — owner decision (DEC-24) | Free to share but forbids LLM processing | M | Would need synthetic ABC fixtures and owner sign-off |
| T-063 | Other ABC collections (e.g. Nottingham DB) | todo — candidate | Varies; verify each | M | ABC via abcjs (MIT) |
| T-064 | alphaTab repo test files as parser fixtures | todo — candidate | MPL-2.0; check each file's origin | S | Only if authored fixtures miss a format edge case |

## Stretch tasks (after DoD)
| ID | Title | Notes |
|---|---|---|
| T-070 | Chord detection (verification) | Harmonic salience at expected f0s / chroma template; replaces leniency when confident |
| T-071 | Technique detection | Bend (pitch trajectory), slide, hammer/pull vs picked, palm mute (spectral tilt) |
| T-072 | Stage mode + performance-ready milestone | One take, no assists; 2 Stage runs ≥ 90% on different days |
| T-073 | Memory mode | Fret-number fade on mastered sections (−25% per clean run) |
| T-074 | Wait mode | Notes hold until played correctly |
| T-075 | Mixed practice + section chaining | Rotate 2–3 clean loops every ~3 min; join mastered neighbours |
| T-076 | Spaced review queue | 1/3/7/14/30 days beyond the next-day check |
| T-077 | Warm-up routine | Tune + chromatic 1-2-3-4 at 70 BPM, doubles as input check |
| T-078 | Notation/tab sheet view | `@coderline/alphatab-vite` renderer |
| T-079 | Left-handed mirror + manual "simplify section" | Profile nice-to-haves; learning research row 2 |
