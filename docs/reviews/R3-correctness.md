# R3 review: correctness (DSP latency budget, R2 fixes, fresh pass)

Date: 2026-11-19. Reviewer: an independent subagent that did not write this code and had not reviewed
it before. Scope:
1. The T-104 DSP changes (`7a39e09`, `src/core/dsp/`): onset hold logic, octave guard, glide
   re-measure, allocation-freedom, and the end-to-end guitar latency budget.
2. The R2 fix commits `432cef0` (T-111) and `086b938` (T-112), checked for regressions.
3. A fresh pass over session, judge, transport, guide, backing, calibration, storage and server
   against the Definition of Done in `docs/spec.md`.

## Summary
**Gates** (run at `93f636c`; the e2e run used a free port and a temp data dir):

| Gate | Result |
|---|---|
| `npm test` | 142 files; 1905 passed + 1 expected fail |
| `npm run typecheck` | OK |
| `npm run lint` | OK |
| `npm run build` | OK |
| `npm run test:e2e` | 10/10 passed in 1.9 min (it also rewrote 4 committed screenshots, see R3-C-04; I restored them) |

**T-104 DSP: it holds up.**
- **Holds are bounded.** A held trigger is reported at most `CONFIRM_MS` + 1 hop after the frame it
  reports. That is still true after a re-anchor to a challenger or a re-hold of the new trigger.
- **No onset can be lost from the one-slot queue.** A hold needs the last reported onset to be
  ≥ 25 ms + 2560 samples old. Any trigger released together with a held one therefore fails that
  guard and is reported on the next hop.
- **Allocation-free.** `onset.ts`, `pitch.ts` (`tailPeriod`, `guardSubharmonic`) and
  `pitch-change.ts` allocate nothing per hop. `AnalysisCore` allocates only the posted messages and
  one small `pending` object per onset. Both predate T-104 and are negligible.
- **The hold does not raise the 44.1 kHz worst case.** A held report is ≤ 70 + 2.9 = 72.9 ms. The
  pre-existing worst case is an unheld N = 2048 onset at 74.3 ms.
  - At 48 kHz a hold moves the worst case from 70.3 to 72.7 ms.
  - At N = 1024 a hold adds up to 24 ms, but the total stays inside the N = 2048 budget.

**Latency-budget conclusion.** The hold logic is not the risk. The risk is the fixed **35 ms
delivery margin** in `INPUT_LAG_SEC.guitar` (R3-C-01):
- It covers main-thread long tasks up to ~35 ms, minus the `currentTime` step.
- The 29.3 ms "worst measured" figure is simply the length of the test's own 30 ms busy block, in
  headless Chromium with 2.7 ms clock steps.
- On a Mac with a 256–512-frame callback (as `docs/audio-input.md` itself expects), the step adds
  up to 5.8–11.6 ms. Any long task ≥ ~40 ms (the browser's own long-task threshold is 50 ms) then
  makes a late Good near +110…120 ms a **Miss**. The same late onset is then assigned to the next
  note as a provisional WrongNote, which breaks the combo.

I recommend widening the margin to ~60 ms. The cost is small and is quantified under R3-C-01.

**R2 fixes.** I found no regressions in the transport (`placeSpeedChange` on `setLoop`), clock
(`heardSpeed`), session (pass speed, guitar-lost and audio-stopped pauses, abort/ownership of the
guide and backing), keyboard (`isTextEntryTarget`), worklet retirement, or the storage
union/profile validators.

**Fresh pass.** Two medium defects in the guitar input path would hurt the DoD line "select my USB
guitar input … play … with live scoring":
- A song opened while the cable is unplugged silently judges the laptop microphone (R3-C-02).
- An interface running at 88.2/96 kHz cannot pitch the lowest notes of the guitar (R3-C-03).

Counts: critical 0 · high 0 · medium 3 · low 1.

| ID | Severity | File:line | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| R3-C-01 | medium | `src/core/judge/constants.ts:64-77` (`GUITAR_ANALYSIS_DELAY_SEC`, `INPUT_DELIVERY_MARGIN_SEC = 0.035`); `src/game/session/core.ts:598-617, 957-962` (tick → `advance(horizon)`); docs `docs/audio-input.md:139-143, 294-312`, `docs/game-mechanics.md` § Windows | **A main-thread long task of ~36–40 ms is enough to turn a late Good into a Miss plus a combo break on the next note.**<br>**Why the margin is too thin:**<br>• The guitar horizon is `currentTime − offset − 109.3 ms`. The worst analysis delay is 74.3 ms at 44.1 kHz; at 48 kHz it is 70.3 ms unheld and 72.7 ms held. That leaves 35 ms (36.6 ms held at 48 kHz) for everything between the worklet's `postMessage` and the judge seeing it.<br>• A long task delays the session timer and the worklet message alike. When it ends, the delayed tick can run first: it reads a `currentTime` that advanced during the block and closes the window.<br>• A real CoreAudio callback of 256–512 frames also lets `currentTime` run up to one callback ahead of messages not yet dispatched (5.8–11.6 ms at 44.1 kHz).<br>• The 29.3 ms "worst measured delivery" in `held-onset-budget.test.ts` is just the test's own 30 ms block length, in headless Chromium with 2.7 ms steps. It is not an upper bound for the owner's Mac.<br>**Consequence:** the late onset arrives after its note closed as Miss. If the next note is within 240 ms (16ths at ≥ 63 BPM, 8ths at ≥ 125 BPM), it lands in that note's window. There it becomes a provisional WrongNote (combo broken even if upgraded), an early hit on a repeated pitch (which cascades), or a stray.<br>**What T-104 changed:** nothing at 44.1 kHz. At 48 kHz holds cost 2.4 ms of margin.<br>**No way to check on the Mac:** the docs say "re-measure on the owner's Mac", but there is no runtime measurement and no checklist step. | Scratch test (real `createJudge` + `inputHorizon`; a long task ends exactly when the message arrives, and the delayed tick runs first).<br>Extra main-thread delay at which a Good is lost:<br>• pluck +100 ms → 55.5 ms<br>• +110 ms → 45.5 ms<br>• +115 ms → 40.5 ms<br>• +119 ms → 36.5 ms<br>Pluck +115 ms with 11.6 ms step + 29.3 ms jank, next note (other pitch) 200 ms later: `n0:Miss n1:WrongNote? n1:WrongNote`. With 29.3 ms alone: `n0:Good`.<br>`grep` finds no lag instrumentation in `src/audio/input/` and no delivery step in `docs/manual-test-checklist.md`. | **Widen:** `INPUT_DELIVERY_MARGIN_SEC` 0.035 → ~0.060 (horizon ≈ 134 ms). That tolerates ~60 ms long tasks with a 512-frame step.<br>**Cost:**<br>• Hits are final at once, so hit feedback is unchanged.<br>• Miss and final-WrongNote marks (and the combo reset on a Miss) appear ~25 ms later: ~255 ms instead of ~230 ms after the note.<br>• Unpitched-onset expiry, song-end settle and loop-pass/trainer evaluation each move 25 ms later. That is well inside even a 1-bar pre-roll.<br>• Keyboard-only play is unaffected (the guitar horizon applies only with a guitar open).<br>• Update `judge.test.ts`, `held-onset-budget.test.ts`, `pipeline.test.ts` and both docs.<br>**Better, jank-proof:** bound the guitar horizon by a FIFO watermark. Level messages share the port and carry `frame`, so once level frame F has arrived, every onset with frame ≤ F − `GUITAR_ANALYSIS_DELAY_SEC` has arrived too. Use `min(timeHorizon, lastLevelFrame/sr − analysisDelay − offset)`, and post level messages every ~10 ms.<br>**Also:** record the live lag (`currentTime` at receipt − `frame/sr`) in the input service, show p99/max in the input panel, and add a manual-checklist row. |
| R3-C-02 | medium | `src/game/session/index.ts:219-233` (`openGuitar`); `src/audio/input/devices.ts:99-102` (`chooseInput` fallback); `src/audio/input/service.ts:197-262` | **In `auto` (default) and `guitar` input mode, a song opened while the saved guitar is unplugged silently judges the system default input**, typically the MacBook's built-in microphone.<br>• `openGuitar` calls `input.open()` whenever a device was chosen before. `chooseInput` then falls back to a USB-looking device or `default`, with `fellBackToDefault: true`.<br>• `openGuitar` never checks that flag. Only the input panel warns about it.<br>**Consequences:**<br>• The run plays and saves as a guitar run on room noise. With speakers, the mic hears the guide synth playing the right notes at the right times, which scores **unearned hits** and feeds bests, mastery and the speed trainer.<br>• Monitoring is started on the mic (feedback risk; mitigated only by the T-023 guard).<br>• The session's "guitar disconnected" logic never fires, because `input.current` is non-null.<br>This contradicts `docs/game-mechanics.md` ("`auto` uses an input that is already open or the device chosen before"). | Scratch test: `chooseInput([default MacBook mic, MacBook mic], {deviceId:'cubilux-id', label:'Cubilux USB Audio'})` → `{"device":{"deviceId":"default",…},"by":"default","fellBack":true}`.<br>Code reading: `openGuitar` returns `input` after `open()` with no `fellBackToDefault` check; the only other reader of the flag is `src/ui/panels/input/index.ts:295`. | In `openGuitar`:<br>• `auto`: if the saved device is not present (`savedDevicePresent`), or `input.current?.fellBackToDefault`, play with the keys and post a notice ("Guitar input not found — playing with the keys; plug it in and press Restart"). Do not open or keep the fallback.<br>• `guitar`: show the same notice on the start card and require a confirmation before using a fallback.<br>Add a session test with fake devices where the saved device is missing. |
| R3-C-03 | medium (if the interface runs at ≥ 88.2 kHz) | `src/audio/input/service.ts:235-237` (context follows the track's rate); `src/core/dsp/pitch.ts:108-114, 173-174` (window fixed in samples, lag ≤ N/2); `src/audio/input/analysis-core.ts` (sizes 1024/2048) | **At 96 kHz the guitar's lowest notes are never pitched.**<br>• The input service recreates the AudioContext at the input track's sample rate.<br>• The onset pitch window is a fixed 2048 (or 1024) samples, and the lag search is capped at N/2.<br>• At 96 kHz that gives a floor of 93.75 Hz for N = 2048. E2, F2 and F♯2 (low E string frets 0–2, and Drop D's D2) come out `midi: null` → WrongNote.<br>• With N = 1024, which the hint picks when the lowest expected note is ≥ 160 Hz, the floor is 187.5 Hz, so E3–F♯3 are lost too.<br>• `docs/audio-input.md` and the constants assume 44.1/48 kHz. Nothing warns about or rejects other rates. (At 88.2 kHz the floor is 86 Hz, so E2 is lost.) | Scratch test, `createPitchDetector({sampleRate, size: 2048})` on a 3-harmonic tone:<br>• 48 kHz: `40→40 41→41 42→42 43→43 45→45`<br>• 96 kHz: `40→null 41→null 42→null 43→43 45→45`<br>`AnalysisCore` at 96 kHz with hint E2–E4 on Karplus-Strong E2, F2, A2 plucks: `onset:null onset:null onset:45` (48 kHz: `40 41 45`). | Size windows in **time**, not samples: use N = 4096 / 2048 above 48 kHz (`createPitchDetector` already supports 4096). Make `planPitchWindow` rate-aware, or decimate ×2 in `AnalysisCore` before analysis.<br>Keep `HOLD_GUARD_SAMPLES` and the delay budget consistent: 4096 @ 96 kHz = 42.7 ms, inside today's budget.<br>Add a 96 kHz case to `tests/input` and `tests/dsp`. Alternatively, keep the context at 48 kHz and let Chrome resample, and document the supported rates. |
| R3-C-04 | low | `playwright.config.ts:6`, `e2e/*.spec.ts` (screenshot paths) | **`npm run test:e2e` rewrites the committed `e2e/screenshots/*.png` on every run.** 4 of 10 differed byte-wise after a clean run. Running the DoD gate therefore leaves the working tree dirty, and a later `git add -A` would commit screenshot churn. | After `npm run test:e2e`: `git status` → `M e2e/screenshots/{audio-setup,game-mid-song,library-filters,practice-loop}.png` (I restored them with `git checkout`). | Write screenshots to `test-results/e2e-screenshots/` by default. Copy them to `e2e/screenshots/` only with an explicit flag (e.g. `RIFFWAY_UPDATE_SCREENSHOTS=1`), and document it in CLAUDE.md. |

## Verified fixed (sampled R1/R2 claims)
- **R1-C-01 / R1-C-02 / R1-C-04** (pass-aware mapping; wrap announced once begun): `ctxTimeInPass`
  is used by the judge (`judge.ts` `resolve`). `tests/judge/transport-integration.test.ts` passes.
- **R1-C-07** (`finish` only closes reached notes): `judge.ts` `finish()` finalises only
  assignments and slots with `target ≤ now`.
- **R1-P-08** (no overwrite on concurrent import): `placeExclusive` uses `link` / `COPYFILE_EXCL`
  (`server/routes/library.ts`).
- **R1-P-11** (malformed route escape): `decodeParam` catches `URIError`
  (`src/ui/screens/index.ts:75`).
- **R2-I-02** (loop change drops a pending speed change): `setLoop`'s split re-places it via
  `placeSpeedChange` (`transport.ts`), with transport tests.
- **R2-I-05** (slider swallows lane keys): `isTextEntryTarget` (`src/game/input/keyboard.ts`).
- **R2-I-06 / R2-I-04** (context stopped / guitar lost mid-run): `tick()` polls `ctx.state`, and
  `onInputDevices` pauses with a notice (`src/game/session/core.ts`).
- **R2-I-08** (retired analysis nodes keep running): `process()` returns false after 0.5 s
  disconnected (`analysis.worklet.ts`).
- **R2-S-03** (flaky e2e): 10/10 on this run.
- **R2-S-04** ("Songsterr match" badge): no longer in `src/`.
- **Not fixed, by assignment:** R2-S-02 (`docs/README.md:7` still says "planned, not yet
  implemented") belongs to T-099 wrap-up. It must land before the DoD's "docs are current" can be
  ticked.

Throwaway scripts (not in the repo): `/tmp/claude-0/-home-user-riffway/41288f0a-2e6d-5563-8cee-98f758ebc829/scratchpad/r3a/tests/`
(`horizon.test.ts`, `fallback.test.ts`, `sr96.test.ts`). Run them with `npx vitest run --config <that dir>/../vitest.config.mts`.
