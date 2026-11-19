# R1 — platform review (Wave 1: import, model, server, storage, progress, UI shell, starter)

Independent adversarial review, 2026-11-19. Scope: `src/core/import/`, `src/core/model/`, `server/`,
`src/storage/`, `src/core/progress/`, `src/ui/{shell,design,components}`, `starter/` and their tests.
Method: read the code against `docs/spec.md`, the Decisions, the T-011/12/17/18/19/20 acceptance criteria,
`docs/{architecture,song-formats,progress}.md`, `docs/sources/*` and `docs/research/learning.md`. Throwaway
scripts (not committed) were run against the working tree for every confirmed finding. The tree changed during the
review (T-089 edits to `ascii/parse.ts`, `mastery.ts`, `export.ts` and `schema.ts`). I re-ran the affected checks
after those edits, and every finding still applies.

## Summary
- **Compliance (high):** real ClassTab tabs and MIDIs are still in the pushed git history (`c376af9`), even though
  they were deleted later. D2 says ClassTab content is never committed or redistributed. No `songsterr.com/api` or
  Ultimate Guitar access exists in tracked code. The ESLint ban covers Songsterr only.
- **Import:** the alphaTab path is solid. Tests confirmed the string flip, the tempo map (including late tempo
  changes), repeats and voltas, ties across repeats, and capo. The ASCII parser handles most messy real-world
  layouts. It has two real defects: (1) header lines that sit directly above the first staff are swallowed as
  annotations, so title, tuning, tempo and capo are lost; (2) staves with spaces between the dashes lose their notes
  with no diagnostic. The ClassTab MIDI aligner's 80% threshold is too permissive: an unrelated piece in the same key
  passes it.
- **Server security:** the Host/Origin guard, traversal checks, symlink handling, the upload cap and SSE cleanup all
  checked out (tested over a real socket). Minor issues: any localhost origin is trusted, there is a collision race
  on rename, and a request with more than 100 files imports some of them and then answers 413.
- **Progress:** the streak and recommendation logic match the docs, with no dark patterns. The plateau nudge fires
  while the player is making steady speed progress.
- **Storage:** migrations, validation and merge follow the documented semantics. No data-loss bug found.
- **Starter:** the melodies I spot-checked (Ode to Joy, Mountain King, Für Elise, Carol ostinato, Scarborough Fair,
  Rising Sun progression) are correct. The public-domain claims are sound.
- **UI shell:** focus handling, the roving nav, the modal focus trap and `inert` are correct. One routing crash on a
  malformed `%` escape.

Counts: **critical 0 · high 1 · medium 4 · low 7**.

## Findings
| ID | Severity | File:line | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| R1-P-01 | high | git history `c376af9` (`tests/fixtures/classtab/*`) | 15 real ClassTab files (tabs and MIDIs by Aguado, Carulli, Giuliani, Sor and others), "byte-for-byte as it came", were committed and pushed. They were deleted in a later commit but remain in the history of `origin/claude/gifted-wozniak-40otll`. Merging to main would redistribute them, against D2 ("never commit or redistribute"). | `git log --diff-filter=D --name-only` lists them. `git merge-base --is-ancestor c376af9 origin/claude/gifted-wozniak-40otll` succeeds. `git show c376af9:tests/fixtures/classtab/README.md` says "Small sample of files from the ClassTab.org whole-site zip". | Before merging to main, rewrite the history to drop `tests/fixtures/classtab/` (`git filter-repo --path tests/fixtures/classtab --invert-paths`) and force-push the branch. This needs the owner's approval. Add a CI or lint check that fails on `tests/fixtures/classtab/`. |
| R1-P-02 | medium | `src/core/import/ascii/parse.ts:262` and `:373` | Up to 4 contiguous non-blank lines directly above the first staff are taken as block annotations, and the header ends above them. Header lines that touch the first staff are therefore never parsed: `Title:`, `Tuning: Eb Ab …`, `Tempo: 120`, `Capo 2`. Pasted tabs often look like this. The result is wrong pitch (tuning and capo), a wrong tempo, and a file-name title. | `Capo 2\n<staff>` gives capo 0, while `Capo 2\n\n<staff>` gives capo 2. `Title/Tuning Eb/Tempo 120/Capo 1` directly above the staff gives standard tuning, capo 0, 80 BPM and the file-name title; with a blank line it gives Eb, capo 1, 120 and "Foo". | Run `parseHeader` over the above-block lines that are neither a ruler, a PM/let-ring span, a chord line nor a section line, or always include them in the header input. Add regression tests. |
| R1-P-03 | medium | `src/core/import/midi/index.ts:196` | A tab group counts as "matched" when its similarity is > 0. Because of the octave-insensitive fallback, any shared pitch class is enough. The 80% rule therefore measures alignment length more than agreement, and a wrong MIDI is accepted as `rhythm: 'midi'`, giving wrong timings with no "needs alignment" prompt. Suffix pairing (`x_1`, `x_a`) is exactly where the MIDI can be a different movement. | Script: 20 trials of two *unrelated* random C-major pieces (60 tab groups vs 70 MIDI groups). With 1–3 notes per group, 55–73% matched. With 2–4 notes per group, 78–90% matched, and 19 of 20 trials reached the 80% threshold. | Count a pair only when its exact-pitch Jaccard is at least about 0.5, or require a mean similarity of matched pairs at or above a threshold. Add a "same key, different piece" negative test. |
| R1-P-04 | medium | `src/core/progress/mastery.ts:80` | The plateau counter resets only when accuracy beats the all-time best at *any* speed. When the speed trainer raises the tempo, accuracy naturally dips, so a player with only clean runs and a rising speed gets "Good place to stop" (learning row 10 intends it for a real plateau). The same happens forever once a section has reached its best accuracy. | Script: 7 clean runs at 70→100% speed with accuracy 95, 93, 92, 91, 90, 92, 91 give `passesSinceGain = 6` and `isPlateau = true` on the run that first reaches 100%. | Count a gain when the speed rises, when a run is clean at a new highest speed, or when accuracy beats the best *at that speed bucket*. Reset the counter when the trainer speed rises. |
| R1-P-05 | low | `src/core/import/ascii/lines.ts:95` | Staves written with spaces between the dashes (`e\|- - - 3 - -\|`) stop the staff body at the first space before a digit. The block is still recognised, but its notes are dropped with **no diagnostic**. T-012 requires unparsed content to be reported with line numbers. | A G-chord block in this style plus a normal block gives 5 notes and `diagnostics: []`; the chord vanishes. | Allow single spaces before digits when the line's dash pattern alternates, or emit an `unparsed-line` diagnostic when a staff line holds digits beyond `bodyEnd`. |
| R1-P-06 | low | `src/core/import/ascii/parse.ts:181` | Label tuning trusts line order. A staff written low-to-high (`D A D G B e` from the top) produces nonsense tuning (`62,57,50,55,47,40`) silently, with no diagnostic. | The `dropd-labels` experiment. | If the labels' pitch classes match a known tuning when reversed, flip the staff and add a diagnostic; otherwise warn. |
| R1-P-07 | low | `server/app.ts:36` | Any loopback origin on any port is trusted, for example another local dev server or a page served by some local tool. A cross-origin *simple* POST from such an origin (multipart `/api/library/import`, `/api/library/rescan`) passes the guard; only responses are protected by the lack of CORS. | `inject` with `Origin: http://localhost:9999` returns 200. | Allow-list the app's own origins (`SERVER_PORT`, Vite 5173, the e2e 5175) or compare the `Origin` port with the `Host` port. |
| R1-P-08 | low | `server/routes/library.ts:86` | Check-then-`rename` race: two concurrent imports with the same name and different content can both see `dest` missing. The second `rename` then silently replaces the first file, which is user data. | Code reading: `fileSize(dest) === null` → `rename(tmp, dest)` with no exclusive create. | Use `link(tmp, dest)` (fails with EEXIST) then `unlink(tmp)`, or `copyFile(..., COPYFILE_EXCL)`, and retry with the next suffix on EEXIST. |
| R1-P-09 | low | `server/routes/library.ts:119-125` | With more than 100 files, the multipart iterator throws `FilesLimitError` after the first 100 parts were already saved. The client gets a 413 with no per-file results, but the files are in the library. | Code reading: `importPart` writes each part as it iterates; the catch returns only the error. | Count the parts and stop *before* writing, or return 413 together with the `files` already processed. |
| R1-P-10 | low | `server/indexer/library-index.ts:128` | `isStale` re-analyses every entry with `error` on **every** scan. That includes permanent states such as "no playable 6-string track" (bass-only or drums-only GP files). Every watcher event triggers a full-source scan, so a library with many such files re-parses all of them on each change. | Code reading: the analyzer sets `error` for `no-playable-track`; `isStale` returns true on `!!entry.error`. | Retry only transient failures (internal or unreadable). Cache deterministic results such as no-playable-track or syntax errors by mtime and size. |
| R1-P-11 | low | `src/ui/screens/index.ts:58` (frozen registry) | `decodeURIComponent` on a route parameter throws `URIError` for a malformed escape (`#/song/%`). The router's `current()` throws inside the shell's hashchange handler, so "Page not found" never renders and the previous screen stays up. | `decodeURIComponent('%')` throws. | Wrap the decode in try/catch and treat failure as a non-match (null). This is a registry contract change, so file a CCR. |
| R1-P-12 | low | `eslint.config.js:6-10` | The lint guard bans `songsterr.com/api` only. Nothing guards against automated Ultimate Guitar access (spec: "no automated access"); today only link-out stubs exist. | grep. | Add `ultimate-guitar.com` (except the `/search.php?` link-out builder) to `no-restricted-syntax`, or allow it only in `server/sources/linkout/ultimate-guitar.ts`. |

## Checked and found sound (no finding)
- alphaTab: string flip, high-first tuning, Drop D, capo midi invariant, tempo change after bar 1 (a 120→60
  change at bar 3 gives bars at 0, 2 and 4 s), ties across a repeat, volta played order. Golden times are tested
  against `generateSyncPoints`.
- ASCII: CRLF, windows-1252, `||`, `:`, unlabelled staves, ragged string lengths, chord-name lines, lyrics between
  staves, `x2` repeats, `PM----`, `5h7p5`, `12p10`, `(5)`, `<12>`, `7b9`, `8b10r8`, `5/7`, `Eb` labels, `DADGAD`.
- Server: Host guard (rejects `evil.com`, `127.0.0.1.nip.io`, `0.0.0.0`, `localhost.`), Origin guard (rejects
  `null`, `file://`, extensions), binding to 127.0.0.1, traversal-name rejection, subfolder validation, symlinks
  skipped in the scan and the watcher, `realpath` containment on serve, 20 MB cap (truncation is detected), SSE
  unsubscribe on disconnect (verified over a real socket), atomic JSON writes.
- Storage: v1 schema matches `docs/progress.md`; fall-through `stepsBetween`; newer and foreign files are rejected;
  merge rules match the docs and are idempotent; import runs in one transaction.
- Streak: freeze earn/apply, grace repair, silent end, early finalisation of the current week, DST and year
  boundaries (the test really runs in `Europe/Berlin`). No loss messaging anywhere.
- Recommendations: 6/3/1 mix, fit cut-off at 3 tiers, review items, 24 h penalty, determinism.
- Starter: public-domain claims are sound (Leontovych died 1921; the 1936 Wilhousky setting is not used). The
  melodies spot-checked above match.
