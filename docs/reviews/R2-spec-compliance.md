# R2 — Spec gap audit and source-terms compliance

Date: 2026-11-19 · Reviewer: independent subagent (did not write the code) · Part of T-091.
Code reviewed: `910424a` at the start, re-checked at `96938a0` (T-041 e2e and T-104 DSP landed during the review).

## Summary
- **Gates (on a clean `git archive` of `96938a0` in a scratch folder):** `npm test` 140 files, 1857 passed +
  1 expected fail; `npm run typecheck` and `npm run lint` clean; `npm run build` OK (1.3 s, `dist/` 17 MB incl.
  source maps). `npm run test:e2e`: 9/10 passed on the first run; `e2e/audio-setup.spec.ts` is **flaky**
  (it failed 2 of 4 runs; see R2-S-03).
- **`npm run dev`:** starts both processes (`[web]` Vite on 127.0.0.1:5173 and `[server]` tsx watch).
  `/api/health` works through the Vite proxy (`RIFFWAY_PORT` is honoured by the proxy). **`npm start`:** serves
  `dist/` and `/api` on `RIFFWAY_PORT`. The temp `RIFFWAY_DATA_DIR` and `RIFFWAY_LIBRARY_DIR` are respected.
- **End-to-end walkthrough of the built app** (my own Playwright scripts, random port, temp dirs):
  - The API imported a `.gp`, a `.musicxml` and a `.txt`. All were indexed, searchable and filterable
    (tier, tuning, playable, tags), and the GP and MusicXML files loaded in the game.
  - An ASCII paste went through snap-to-grid and was saved as playable (`rhythm: aligned`).
  - A starter song was played through the test hook to results: 66 Perfect / 8 Wrong / 8 Miss, exactly as scripted.
  - Run, bests and section progress were saved. Export → import (merge) into a fresh browser profile →
    reload kept all counts. The song page showed the imported bests.
  - Backing audio upload (`POST /api/audio`) worked. A cross-origin POST and a foreign `Host` both returned 403.
  - **No request left 127.0.0.1** during the walkthrough, and no page or console errors were logged.
  - Game frame times on the densest starter items (227 and 313 notes): p95 16.8 ms, p99 16.8 ms, 1 frame over 20 ms in 600.
- **Spec matrix:** 45 Met, 10 Partial, 0 Missing, 2 Deviation-documented (both Songsterr, D1).
  Most of the Partial rows are DoD items that cannot be finished until the owner tests with the real
  guitar, R3 runs and the branch is merged. Others have small UX or doc gaps.
- **Source-terms compliance:** clean.
  - Shipped code builds Songsterr, Ultimate Guitar and GP-pack URLs only for link-outs, and ESLint enforces it.
  - The only outbound fetch in shipped code is the ClassTab zip. It is conditional, at most once a day,
    has ≥ 10 s back-off, an anonymous User-Agent and size/zip-slip guards.
  - No ClassTab content in the tree. The only exception is the known history issue R1-P-01.
  - Audio fixtures are properly attributed. The soundfont licence is recorded. Starter provenance is documented.
  - No personal data is sent anywhere.
- **Findings:** 0 Critical · 0 High · 4 Medium · 9 Low · 2 Info.

## Requirement matrix
Status: **Met** · **Partial** · **Missing** · **Deviation-documented** (accepted in TASKS.md Decisions, pending owner).

### Platform & stack
| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Local-only Vite + TS frontend + Node companion server (indexing, source indexes, proxying) | Met | `package.json`, `server/` (Fastify, binds 127.0.0.1, Host/Origin guard verified with curl → 403) | — |
| One command starts both (`npm run dev`) | Met | Ran it: `[web]` Vite 5173 + `[server]` tsx; `curl :5173/api/health` → ok via proxy | Vite port fixed (strictPort 5173), fine for the owner |
| Optimized local build | Met | `npm run build` → `dist/` + `dist-server/index.js`; `npm start` served the app and API | — |
| Works in current Chrome on macOS | Partial | Verified only in headless Chromium (Linux); manual checklist §0–12 covers the Mac | Owner run on the Mac pending |
| 6-string, standard default, alternate tunings from file; no bass/7-string | Met | `src/core/model/tuning.ts` (Drop D, Eb, DADGAD …); Drop D MusicXML/GP indexed as `drop-d`; T-011 marks bass/7-string unplayable | — |

### Core experience
| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Horizontal R→L highway, fixed hit line left, 6 lanes high e on top, fret numbers | Met | Screenshot of game (`e2e/screenshots/game-mid-song.png`, my run); `src/game/highway/` | — |
| Windows Perfect/Great/Good/Miss, combo multiplier, score, accuracy %, stars, results screen | Met | Results screen verified (score 6,600, 3★, 80.5%, histogram, sections); `tests/judge/` | — |
| Pitch vs timing judged separately (wrong note ≠ early/late ≠ miss), shown clearly | Met | WRONG vs MISS tiles; early/late outside Great (D5); `tests/judge/` window-edge tables | — |
| Hand-position cue ahead of shifts | Met | `src/core/handpos/`, highway cue brackets (`cueShowAt`), `tests/handpos/` | — |
| Technique markings displayed (h, p, slide, bend, PM) | Met | Glyphs in highway, `#/dev/highway`; one fixture per technique (`tests/fixtures/import/techniques`) | Detection is stretch (T-071), OK |
| Speed without pitch change, A/B loop, speed trainer, count-in, metronome | Met | T-032 panel; guide re-rendered at tempo×speed, backing via signalsmith-stretch; e2e "70% speed + one-bar A/B loop wraps twice" passes | — |

### Guitar input
| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| List inputs, pick one, remember it | Met | `src/audio/input/` (id → label re-match, `devicechange`); T-022 tests | Real Cubilux untested (manual §2) |
| Live level meter and tuner | Met | Input/tuner panels; fake-mic e2e (`tests/input/e2e`, `e2e/audio-setup.spec.ts`) | e2e flaky (R2-S-03) |
| Latency calibration applied to scoring | Met | T-033 wizard (play-to-click, tap, loopback, visual); per-device profiles followed app-wide (T-040) | Repeatability on hardware: manual §7 |
| EC / NS / AGC disabled | Met | `src/audio/input/constraints.ts` + read-back warnings | — |
| Solid single-note detection; chords lenient + transparent UI | Partial | T-104: Iowa 100%, GuitarSet pickup 100/100/100. HUD chord-leniency note (`src/ui/screens/game/hud.ts`) | GuitarSet mic clip still 96/85/96 (one `it.fails`, R2-S-12); real-guitar check pending |
| Keyboard input mode | Met | D6; e2e "real keypresses … Shift = wrong note" passes | — |

### Monitoring & audio
| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Route guitar to output with amp/cab sim (≥ clean + overdrive) | Met | `src/audio/worklets/amp.worklet.ts`; presets Clean / Crunch / Overdrive / DI | Feel on hardware: manual §6 |
| Low latency, **show measured** monitoring latency, recommend headphones | Partial | Latency panel shows browser-reported input/output + DSP, "(assumed)" flags, calibrated offset; headphone card + speaker guard | The number is an estimate, not a measurement (R2-S-10) |
| Attach own MP3/WAV/M4A, align (offset + beat/tempo) | Met | `POST /api/audio` verified (sha1 store); warp anchors + nudge + tap anchors (T-027) | No e2e of attach→play in sync (manual §10) |
| Guide synth fallback | Met | alphaSynth offline render in worker (T-021) | — |
| Mixer: monitor, backing, guide, metronome | Met | T-032 mixer (+ master, per-bus mute) | — |

### Timing & performance
| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Scheduling + judgement on AudioContext clock; renderer only reads | Met | D5, `docs/timing.md`, T-101 tests through the real `TransportCore` | — |
| Pitch detection, monitoring, amp sim in AudioWorklets | Met | `analysis.worklet.ts`, `amp.worklet.ts` (+ stretch worklet) | — |
| Canvas highway at smooth 60 fps on long, dense songs | Met | `tests/highway/perf.browser.test.ts` (19.2k notes, p95 draw ~0.6 ms). My run in the full game: frame p95 16.8 ms | Headless only; no full-screen game test with a 20-min song |

### Song sources & library
| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Pluggable source adapters with a shared interface | Met | `shared/sources.ts` `SourceAdapter`, `server/sources/registry.ts` | — |
| Terms verified + documented per source in `docs/sources/` | Met | `docs/sources/*.md` (Last verified 2026-11-19) | Minor doc drift (R2-S-08, R2-S-09) |
| Local folder: watch + index GP (.gp, .gp3–5, .gpx), MusicXML, ASCII | Met | `shared/song.ts` extension list; chokidar watcher; imports indexed within seconds | — |
| Drag-and-drop import copies into the folder | Met | `POST /api/library/import` verified; e2e drag-drop spec passes | — |
| Songsterr: search catalog via public API, link out, local matches playable | Deviation-documented | D1: API declined (403 + robots). Link-out `songsterr.com/?pattern=` + local match badge | Owner acceptance outstanding (R2-S-01); badge wording misleading (R2-S-04) |
| ClassTab: zip download + index + refresh command; MIDI pairing; "needs rhythm alignment" | Met | `server/sources/classtab/`, `npm run classtab:refresh`, `tests/classtab/` (local HTTP server, 200/304, zip-slip); real run documented in `docs/sources/classtab.md` | Not re-run live by me (politeness). Hard to discover from Library (R2-S-05) |
| Ultimate Guitar: no automation, "Search on UG" new tab + paste flow | Met | `server/sources/linkout/ultimate-guitar.ts`, Import screen link (`target=_blank`, `noopener noreferrer`) | — |
| More sources researched, candidates in TASKS.md, permitted low-effort ones implemented | Met | `docs/sources/candidates.md`; TASKS T-060…T-064; GP free pack link-out (D11); The Session blocked (DEC-24) | DEC-24 owner decision |

### Import formats, search, starter
| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| GP & MusicXML via alphaTab (parse; render/synth evaluated) | Met | D3, `docs/research/libraries.md`; GP/MusicXML fixtures load in game | Notation view deferred (T-078), OK |
| ASCII paste/file: BPM + alignment (tap-along, snap-to-grid), painless | Partial | Import screen: tap tempo, snap/tap, grid, preview, save → playable (verified; e2e passes) | Typed title ignored in one case (R2-S-06) |
| One search box across sources; filters source / difficulty / tuning / playable vs needs import | Partial | Library: source chips, tier range, tuning, technique, "Playable now / Needs import or rhythm" | Songsterr catalog is not searchable (D1). ClassTab chip appears only after a refresh in Settings (R2-S-05) |
| Starter library: PD songs + original exercises, beginner → intermediate, committed, playable out of the box | Met | 14 items in `starter/`, provenance in `starter/README.md`; computed tiers 1–5 (targets 1–6, all within ±1) | See R2-S-13 (Info) |

### Data, difficulty, learning, UI
| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Song files only in library folder (gitignored) | Met | `.gitignore` (`/library/`, `.riffway/`); default `~/Music/Tabs` outside the repo | — |
| Progress, scores, settings, audio links in IndexedDB | Met | `src/storage/` (idb v1); verified persistence across reload | — |
| Export/import progress + settings as JSON | Met | Verified merge into a fresh profile + reload; e2e export → delete → import (replace) passes; sidecars included | Backing-audio bytes not exported (DEC-13, stated in UI) |
| Difficulty per song + section from tempo, density, span/shifts, skipping, techniques, chords; documented; tier / 1–10 | Met | `src/core/difficulty/`, `docs/difficulty.md`; song page "Why it's a 1.3" + section ratings | — |
| Progress: bests, accuracy history, sections mastered, streaks, recommend next | Met | Song page (bests per speed, sparkline, mastery map), Home (weekly streak, goals), results "Next up / stretch picks" | — |
| Learning research with sources, each finding → feature or decision | Partial | `docs/research/learning.md`: 17 rows with sources | Rows still say "This iteration" for features deferred by DEC-23 (R2-S-07) |
| Sleek, clear hierarchy, hit feedback, readable while playing; keyboard menu nav | Met | Screenshots; T-018 keyboard nav (arrows / Enter / Esc) | — |

### Testing
| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Unit tests: parsing, difficulty, judge, each adapter (recorded fixtures, no network) | Met | `tests/{import,ascii,align,difficulty,judge,classtab,linkout,server}`; network guards | — |
| Audio pipeline tests: generated tones + recorded guitar, timing accuracy | Met | `tests/audio-pipeline/` (synthetic mean ≤ 5 ms, p95 ≤ 10 ms; Iowa + GuitarSet) | One `it.fails` left (R2-S-12) |
| Playwright e2e via keyboard mode with screenshots of key screens | Partial | 10 specs, 10 screenshots in `e2e/screenshots/` | `audio-setup` spec flaky (R2-S-03) |
| Manual checklist: guitar input, monitoring latency, calibration | Met | `docs/manual-test-checklist.md` (12 sections) | — |

### Definition of done
| Requirement | Status | Evidence | Gap |
|---|---|---|---|
| Select USB input, tune, calibrate | Partial | Implemented and tested with fake devices | Real-hardware check (manual §2–4, §7) |
| Hear guitar through amp sim at acceptable latency | Partial | Implemented; latency is an estimate | Real-hardware check (manual §6) |
| Search local, ClassTab, Songsterr from one box; import + play results | Deviation-documented | Local + ClassTab in the unified index; Songsterr = link-out (D1) | Owner acceptance (R2-S-01) |
| Import GP/MusicXML or paste ASCII → horizontal game, live scoring, wrong-note vs timing | Met | Verified in the built app (GP, MusicXML, paste) | — |
| Attach own audio and play in sync | Met | T-027 browser test: aligned onset within ±10 ms at 100/75% | Owner check (manual §10) |
| Starter library with difficulty ratings | Met | 14 items with tiers in the Library | — |
| Speed control and A/B looping work | Met | e2e practice spec passes | — |
| Songs, progress, settings persist; export/import | Met | Verified (above) | — |
| Tests pass, reviews done, docs current, merged to main | Partial | Unit/browser/lint/typecheck green | e2e flaky; R2/R3 in progress; `docs/README.md` stale (R2-S-02); branch `claude/gifted-wozniak-40otll` not merged |

## Source-terms compliance checks
| Check | Result | Evidence |
|---|---|---|
| Requests to `songsterr.com` other than link-out URL building | None | `git ls-files` grep: only `server/sources/linkout/songsterr.ts` (URL const), comments, tests asserting URLs. ESLint bans `songsterr.com/api` (`tests/foundation/lint-guards.test.ts`). The single 403 probe in research is recorded in `docs/sources/songsterr-probe.md` |
| Requests to `ultimate-guitar.com` | None | URL literals only in `server/sources/linkout/ultimate-guitar.ts` and `src/ui/screens/import/model.ts` (ESLint-enforced). Opened with `noopener,noreferrer`, never framed |
| Other outbound network in shipped code | ClassTab zip only | `fetch(` appears only in `server/sources/classtab/download.ts` (+ same-origin `src/api/client.ts`, worker soundfont from own origin) and the dev-only `scripts/fetch-audio-fixtures.ts`. `index.html` loads no external fonts or CDNs. My walkthrough logged 0 non-loopback requests |
| Scraping / login / paywall bypass | None | No HTML parsing of remote pages. Songsterr hint says GP download is a Plus feature ("Free accounts have no file download") |
| ClassTab politeness | Good | UA `Riffway/0.1 (personal local app)` (no personal data); `If-None-Match`/`If-Modified-Since`; ≤ 1 contact/24 h unless `--force`; 3 attempts, ≥ 10 s back-off (crawl-delay), `Retry-After` ≤ 5 min honoured; never auto-refreshes (only CLI or `POST /api/classtab/refresh`); 100 MB / 20k-entry / zip-slip guards |
| ClassTab content committed | No (tree) | `tests/fixtures/classtab-synthetic/` is authored ("Ada Fictional", `riffway_*`), README states it. Test strings reference only invented or URL-shaped names. History: R1-P-01 (c376af9 → removed 0730cf9) still open (R2-S-14) |
| Audio fixtures licence/attribution | Good | `tests/fixtures/audio/ATTRIBUTION.md`: Iowa MIS ("without restrictions", credited), GuitarSet CC BY 4.0 with authors, DOI, licence link and changes listed; SHA-256 provenance in `annotations.json`; 1.7 MB total |
| Soundfont licence | Good | `sonivox.sf2` Apache-2.0 (verified `node_modules/@coderline/alphatab/dist/soundfont/LICENSE`), recorded in `docs/research/libraries.md`; served from own origin; not committed (`dist/` gitignored) |
| Starter PD claims and provenance | Good | `starter/README.md` + `manifest.json` per item. Composers died before 1928, traditional tunes, the 1936 "Carol of the Bells" lyrics excluded, arrangements original. Mutopia/Wikipedia used only for pitch checks |
| Personal info sent anywhere | No | No analytics or telemetry; UAs are generic; health/config paths stay on loopback |
| `docs/sources/*.md` vs implementation | Mostly accurate | Drift listed in R2-S-08, R2-S-09 |

## Findings
| ID | Severity | Finding | Evidence | Suggested fix | Status |
|---|---|---|---|---|---|
| R2-S-01 | Medium | DoD line "search … the Songsterr catalog from one search box" is unmet as written. D1 replaces it with a link-out, which is justified (403 `ERR_ACCESS_POLICY`, robots `Disallow: /api/`) and clearly explained in docs and the hint copy. The owner has not accepted it yet. Spec § Songsterr also says "link out to the **song**". The app links to the search results page, which is the only compliant option | TASKS.md D1; `docs/sources/songsterr.md` § Spec deviation; T-099 lists it as an open question | Keep it in the T-099 owner questions. In R3, record the owner's answer in TASKS.md D1 |
| R2-S-02 | Medium | `docs/README.md` still says "**State:** planned, not yet implemented". The DoD requires "docs are current" | `docs/README.md:7` | Replace it with a current-state paragraph: what works, open owner decisions (D1, DEC-24, R1-P-01) and a link to `manual-test-checklist.md`. Do this now rather than waiting for T-099 |
| R2-S-03 | Medium | `e2e/audio-setup.spec.ts` is flaky. `if (await connect.isVisible()) await connect.click()` races with the panel opening the input on mount: the button disappears and `click` waits 60 s. Failed 2 of 4 runs | `e2e/audio-setup.spec.ts:27-28`; my runs: full suite 9/10, then isolated pass, pass, fail | Wait for either outcome: `await expect(status.or(connect)).toBeVisible()`, then click only if the status is not yet `Listening`. Or use `click({trial})` / `force` with a short timeout and ignore detach | fixed: the input card stays in a neutral "Checking…" state (`data-state`) until it knows whether the input opened itself, so "Connect" never vanishes under a click; the spec waits for the settled state; 6/6 repeated runs pass |
| R2-S-04 | Medium | The "Songsterr match" badge appears on **any** library row matching the query, including starter and ClassTab items. Its tooltip says "matches your search on Songsterr by title and artist". That implies Riffway checked Songsterr's catalog, which it never does (D1) | `src/ui/screens/library/*` badge: `` `${SOURCE_LABEL[b.source]} match` `` with that title; the API result for "mountain" gave the starter item a `songsterr` badge | Drop the per-row badge (the link-out row already says "Already in your library: …"). Or relabel it "In your library" with a tooltip "matches your search words; Riffway doesn't search Songsterr" | fixed: no per-row badge (see R2-U-13); `docs/sources/songsterr.md` updated |
| R2-S-05 | Low | ClassTab can't be found from the Library until it is downloaded: the source chips show only My files and Starter, with no hint. The download lives in Settings → Library & sources. The DoD flow "search … ClassTab from one search box" needs that undiscoverable step | Library text in my walkthrough; `GET /api/sources` message mentions Settings only | Show a ClassTab card or empty-state hint in the Library when `state: not-downloaded`, with a "Download ClassTab (13.6 MB)" button that calls the refresh route | fixed: ClassTab download card in the Library (see R2-U-12); `docs/sources/classtab.md` |
| R2-S-06 | Low | Import screen: the typed **Title** is ignored when Artist is blank and the pasted text starts with a title-like line. The song took the first line ("My Riff"); my "Review Riff" was used only as the file name. `composeText` writes header lines only for tuning, capo, tempo and time | `src/ui/screens/import/model.ts:153-163`, `src/core/import/ascii/song.ts:266-270`; built-app walkthrough | Prepend `Title:` (and `Artist:`) header lines when they differ from the detected header, or let the file name win whenever the user typed a title | fixed: `composeText` writes `Title:`/`Artist:` header lines when the typed values differ from the text's own, so the typed title wins |
| R2-S-07 | Low | `docs/research/learning.md` still marks deferred features as "This iteration": Stage mode (row 16, TL;DR item 7) and the "performance-ready" milestone. DEC-23 deferred them. The spec asks that each finding map to a feature **or a deliberate decision** | `docs/research/learning.md:15,36`; TASKS.md DEC-23 | Edit rows 16 and 17 and the TL;DR to say "Deferred (DEC-23, T-072)". Add a "Status" column or a note under the table | fixed: Priority column renamed Status (Built / Later / Deferred); Stage mode, performance-ready and Wait mode marked deferred (DEC-23, T-072/T-074) with a note under the table |
| R2-S-08 | Low | Source docs have drifted from the code. `ultimate-guitar.md` describes a "UG button's popover", a header holding "the confirmed alignment (or a sidecar `.riffway.json`)" and title/artist prefilled from the search query. The real design keeps the sidecar in `<dataDir>/sidecars/<id>.json` (DEC-17), adds header lines only for overrides, and has no popover. `local-folder.md` and the `sources/README.md` table still say "implement now" | `docs/sources/ultimate-guitar.md` § ASCII paste flow; `docs/sources/local-folder.md:3`; `docs/sources/README.md` table | Rewrite the paste-flow steps to match T-028/DEC-17. Change "implement now" to "implemented (T-017 / T-025)" | fixed: UG paste flow rewritten to the real Import screen and DEC-17 sidecars; local folder and ClassTab marked implemented in `local-folder.md` and `sources/README.md` |
| R2-S-09 | Low | `songsterr.md` § Compliant design 3 promises "an optional `origin: songsterr` tag … on import". It is not implemented anywhere | grep `origin` in `src/`, `server/`, `shared/`: none | Delete the sentence, or file a small candidate task | fixed: the `origin: songsterr` promise removed from `songsterr.md` |
| R2-S-10 | Low | The spec asks to "show the **measured** monitoring latency". The panel shows an estimate: browser-reported input/output latency (10 ms assumed when unavailable) plus DSP, with the calibrated offset beside it. Honestly labelled, but not a measurement. The loopback calibration could provide a real round trip | `src/audio/monitor/latency.ts`, `src/ui/panels/monitor/index.ts:287-292` | When a loopback calibration exists, show its round trip as "measured monitoring latency". Otherwise keep "estimated" | fixed: with a loopback profile for the device pair the panel shows "measured" = loopback round trip + amp DSP (band from it); otherwise "estimated" as before |
| R2-S-11 | Low | Bookkeeping: TASKS.md § Review fix tasks still says "None yet" although T-101 to T-104 exist. `docs/reviews/R1.md` "Outcome: _filled in when fix tasks land._" is unfilled although T-101 and T-102 are done | `TASKS.md` § Review fix tasks; `docs/reviews/R1.md` last line | List T-101 to T-104 there and fill in the R1 outcome (P-01 still open) |
| R2-S-12 | Low | Recorded-guitar target not met on one clip: GuitarSet mic 96/85/96 (precision < 90%), kept as `it.fails`. It is documented, and the pickup clip, which matches a USB-cable setup, now scores 100/100/100 | `tests/audio-pipeline/recorded.test.ts:159`; TASKS T-104 notes | Accept as documented, or tune the slide and contact-noise cases later. Confirm with the owner's guitar (manual §5) |
| R2-S-13 | Info | Starter computed tiers span 1–5 (Spanish Romance and Bourrée target 6 but rate 5; Greensleeves 3 → 2). All are within T-029's ±1, but `docs/user-profile.md` says "tier 1–6" | `GET /api/search` tiers | None needed, or note it in `starter/README.md` | fixed: `docs/user-profile.md` notes the authored 1–6 vs computed 1–5 span |
| R2-S-14 | Info (open, owner) | R1-P-01: unlicensed ClassTab files in pushed history (c376af9; removed in 0730cf9). The remote `origin/claude/gifted-wozniak-40otll` exists, so the files are on GitHub if the repo is or becomes public | `git log --all -- tests/fixtures` | Owner decision at T-099: rewrite the branch history before merging to `main` (squash-merge without c376af9), or confirm the repo stays private |
| R2-S-15 | Low | CLAUDE.md env list omits `RIFFWAY_E2E_PORT` / `RIFFWAY_E2E_DATA_DIR`, which `playwright.config.ts` reads. They are mentioned only inside the `test:e2e` row. The commands table otherwise matches `package.json` | `CLAUDE.md` Env line; `playwright.config.ts:8-9` | Add both to the Env line | text sent to the orchestrator (CLAUDE.md is orchestrator-owned) |

## Method notes
- Every run used `git archive` snapshots under the scratchpad (`r2c/app`, `r2c/app2`), with symlinked
  `node_modules`, random ports and temp data/library dirs. Only my own processes were stopped (matched by cwd).
  No repo files were changed except this report.
- I did not contact classtab.org, songsterr.com or ultimate-guitar.com. ClassTab behaviour was judged from
  code, tests and the documented real run.
