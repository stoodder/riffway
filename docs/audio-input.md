# Audio input

## Summary
- The Cubilux USB-C cable is a class-compliant input. Riffway lists inputs, remembers the choice, and
  opens it with echo cancellation, noise suppression and auto gain **off** (read back and warned about
  if the browser ignores that).
- One analysis AudioWorklet (`src/audio/worklets/analysis.worklet.ts`) runs `AnalysisCore`
  (`src/audio/input/analysis-core.ts`), which wraps the pure-TS DSP in `src/core/dsp/`: level meter,
  onset detector, MPM pitch tracker, pitch-change detector, tuner frames.
- Onsets give timing; pitch is measured on the window starting 25 ms after the onset (past the
  inharmonic attack).
- Single notes first. Chords are scored leniently (onset + any chord tone) until chord detection
  (stretch) exists.

Code: `src/audio/input/` (`devices.ts` matching rules, `constraints.ts`, `analysis-core.ts`,
`service.ts` = `InputService`, `index.ts` = real browser wiring), panels `src/ui/panels/input/` and
`src/ui/panels/tuner/`.

## Device selection and persistence (`src/audio/input/devices.ts`, `service.ts`)
1. Chrome hides device ids and labels until microphone permission is granted. `open()` then makes one
   throwaway `getUserMedia({audio: true})` (the permission prompt), stops it, and enumerates again.
   Before that the panel names devices `Input 1`, `Input 2`…
2. Chrome on macOS lists aliases (`default`, `communications`, labelled `Default - …`) next to the real
   devices and appends USB ids to labels (`USB Audio CODEC (08bb:2902)`). Labels are compared without
   the alias prefix and the `(vid:pid)` suffix; aliases are never preselected when a real device matches.
3. Choice, in order: the saved `deviceId`; the saved label (exact, then normalised); a physical device
   whose label matches `/usb|cubilux|guitar|audio codec/i`; the `default` alias; the first input.
   When something was saved but is not connected, the input still opens on the fallback, flagged
   `fellBackToDefault`, and the panel says "Your guitar input wasn't found".
4. `{deviceId, label}` is persisted in `settings.input` on every successful open that did not fall back
   (an explicit pick or the automatic USB preselect); `channel` is its own setting.
5. **Unplug:** the track's `ended` event closes the input (`current = null`, `getInputNode() = null`)
   and fires `onDevicesChanged`; the panel shows "Disconnected". `devicechange` events are debounced
   (300 ms); after one, a vanished input is closed, and if the player still wants input (opened and not
   `close()`d) the saved device is re-opened as soon as it is present again (by id or label), also
   replacing a fallback input. A missing device is never swapped for another one automatically.
6. Output device: the panel calls `engine.setSinkId(id)` and persists `output.{sinkId,label}` (the engine
   also follows that setting at start-up). Disabled when `AudioContext.setSinkId` is unsupported.
7. The panel re-opens the saved input on mount without a click when the microphone permission is
   already `granted` (Permissions API).

## Constraints
```ts
getUserMedia({ audio: {
  deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false,
  autoGainControl: false, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
  latency: { ideal: 0 } }, video: false })
```
Then read `track.getSettings()` and trust only the actual values: headless Chrome's fake device reports
2 channels at 44.1 kHz despite these. Any of the three processing flags reading back `true` becomes a
warning in the panel. If an automatic choice cannot be opened (`OverconstrainedError`,
`NotFoundError`, `NotReadableError`), the `default` alias is opened instead (flagged as a fallback).

**Sample rate.** When the track reports a rate different from the context's, the service calls
`engine.setSampleRate(trackRate)` so Chrome does not resample; the engine recreates its context and
the service rebuilds its graph on the new one (`onContextChange`; monitoring re-reads `getInputNode()`
on `onDevicesChanged`).

**Channels.** The analysis node takes exactly two discrete input channels; the worklet analyses
channel 0, channel 1 or their mean (`settings.input.channel`: 0, 1 or `mix`; the panel shows the
picker only for multi-channel tracks). On a mono track the setting is ignored and channel 0 is used
(`effectiveChannel`), because channel 1 would be silence and `mix` would halve the level. The node has
no outputs (Chrome pulls output-less worklet nodes).

## Level meter
The worklet posts `{type:'level', frame, peakDb, rmsDb}` about every 50 ms (19 quanta at 48 kHz;
−120 dB floor). Panel: horizontal meter over −60…0 dBFS, green below −18 dBFS, amber to −6, red above;
the bar falls at 24 dB/s; peak-hold marker 1 s; clip lamp at ≥ −0.5 dBFS, lit for 2 s. Hint text: "Aim
for peaks around −12 dB; turn the guitar volume up if the meter barely moves". Below −60 dBFS for 5 s
while listening, the panel shows "No signal". While the engine is suspended the panel offers "Enable
audio".

## Tuner
- Same worklet, in tuner mode (`setTunerMode(true)`, sent as `config`): N = 4096, hop 2048 (~23 Hz at
  48 kHz), search range B1–E6 (covers Drop C and Drop D below standard's E2). Frames are
  `{type:'tuner', frame, freq, clarity}` (`freq` 0 for none); the panel smooths them on the main thread
  with `createTunerSmoother` (`@core/dsp`).
- Median of the last 5 valid frames (clarity ≥ 0.9); numbers never jump on noise (the last value is
  held, dimmed, below clarity 0.8). The needle is eased (80 ms time constant) over ±50 cents; a strobe
  band drifts with the error and stops in tune.
- Display: the chromatic note and cents, plus the nearest open string of the **current song's tuning**
  (panel prop `tuning`; default standard; Drop D etc. when the song says so) with "Tune up/down to D2
  (2 semitones)". "In tune" = |cents| ≤ 3 for 0.5 s **on the target string's note**; strings tuned this
  session get a check mark.
- A4 reference adjustable 415–466 Hz in 1 Hz steps (default 440, `settings.tuner.a4`).

## Pitch and onset detection worklet
Pure DSP in `src/core/dsp/` (unit-tested in Node with generated tones); `AnalysisCore` is the
worklet's state machine (Node-tested quantum by quantum); the worklet file is a thin shell.

**Onset detector** (`onset.ts`), per 128-sample quantum:
- Detection function: two energies per hop — of the second difference `x[n] − 2x[n−1] + x[n−2]`
  (+12 dB/oct pre-emphasis, weights the pick transient) and of the plain signal (a new low note under
  a ringing bright one) — each as a novelty in dB against its loudest hop of the preceding 20 ms; the
  larger wins. No spectral flux.
- Adaptive threshold `median(last 0.5 s) + k × MAD` (k = 4), never below 6 dB of novelty, plus an
  absolute floor (−50 dBFS) and a 40 ms refractory period.
- Onset frame = first sample of the rising edge in the triggering hop or the one before it
  (sample-accurate). Timestamps are context frames (`currentFrame`).

**Pitch** (`pitch.ts`, MPM/NSDF via a radix-2 FFT, preallocated buffers):
- Window N = 2048, or 1024 when the `expect` hint's lowest note is above ~160 Hz. The main thread posts
  `{type:'expect', range: {minMidi, maxMidi} | null}` from the upcoming notes; the search range is the
  hint ±7 semitones (E2–E6 without a hint), and the lag search extends one more semitone each way so
  out-of-tune edge notes are found. Without a hint, notes below D♯2 (Drop D's low D) are not searched:
  the game must send hints for low tunings. A hint the window cannot resolve falls back to E2–E6.
- Octave check: switch to the key maximum at twice the period only when its NSDF is ≥ 0.03 higher.
- The onset's pitch is measured on the N-sample window starting 25 ms after it and emitted as
  `{type:'onset', frame, midi, cents, clarity, rmsDb}` (`rmsDb` of that window) as soon as the window is
  complete. If clarity < 0.6, `midi: null`, and one retry window 512 samples later may produce a
  follow-up `{type:'pitch', frame, onsetFrame, midi…}` (≈ 11 ms later; the judge holds the onset open).
- If the next onset arrives before the window is complete, the latest window that ends at the new
  onset is used instead when it starts ≥ 8 ms after the old one, else the old onset is unpitched — a
  window never spans two plucks. At N = 2048 that pitches notes ≥ ~51 ms apart.
- Delivery: an onset message leaves the worklet within one quantum of 25 ms + N after the onset
  (67.7–70.3 ms at N = 2048 / 48 kHz, 74.3 ms worst case at 44.1 kHz); the judge's guitar input
  horizon (`INPUT_LAG_SEC.guitar` = 109.3 ms) covers this plus main-thread delivery. Measured in
  § Audio-pipeline results.

**Pitch-change detector** (legato, `pitch-change.ts`): every 256 samples an MPM frame on the newest
N-sample window, stamped at the window centre, feeds the detector. During a sustained note, a pitch
that moves ≥ 0.8 semitone and stays for ≥ 25 ms without an amplitude onset emits
`{type:'pitch-change', frame, midi, cents, clarity}` with `frame` = the detector's `changeFrame` (first
frame at the new pitch). Used for hammer-ons, pull-offs and slides.

**Messaging.** `port.postMessage` with small plain objects (`shared/audio-events.ts`): ~20 level +
≤ 23 tuner messages/s plus onsets. No allocation in `process()` beyond the message objects. A gap in
`currentFrame` (node paused) restarts the detectors. `reset` clears all state. The service converts
frames to context seconds (`frame / sampleRate`) for `onAnalysis` (uncalibrated) and to judge
`InputEvent`s with `analysisToInputEvent` (`@core/judge`: `inputOffsetMs` subtracted, `pitch` →
`refines`) for `onInput` ([timing.md](timing.md)).

## Chord leniency
Until chord detection exists, a chord group is satisfied by one onset whose detected pitch matches
any chord tone ([game-mechanics.md](game-mechanics.md)). The HUD shows "Chords: any chord tone counts"
while chords are visible, and the results screen notes how many notes were judged this way.
Chord *verification* (harmonic salience at expected f0s, chroma template match) is stretch task T-070.

## Tests
- Node (`npx vitest run tests/input tests/dsp`): DSP on generated tones E2–E6 (pitch within ±10 cents,
  onsets within ±5 ms, no double onsets on a 2 s decay); `AnalysisCore` on plucked melodies E2–C6
  (onsets ±5 ms, exact MIDI), level cadence, channel select, tuner frames (Drop D's D2 within 2 cents),
  fast notes, follow-up pitch, legato, 44.1 kHz; device matching, constraints and read-back; the
  service against fake devices (unplug / re-plug, fallback, context recreation, event bridge); both
  panels in happy-dom. Synthetic notes fade out (an abrupt cut reads as an onset). Thresholds were
  tuned on synthetic signals; § Audio-pipeline results checks them on recordings.
- Browser (`npx vitest run --project browser tests/input`): the real worklet on an
  `OfflineAudioContext` fed by an `AudioBufferSource` of plucks (frames ±5 ms, pitches, stereo channel
  select, tuner frames) and the service on Chrome's fake capture device.
- Fake capture with a WAV (`npx playwright test -c tests/input/e2e/playwright.config.ts`): Chrome plays
  a generated tone as its microphone (`--use-file-for-fake-audio-capture`) into both panels on a Vite
  dev server (`/tests/input/e2e/harness.html`); checks meter, tuner (A2 in tune; D2 22 cents flat in
  Drop D) and persistence across reload, and writes screenshots to `test-results/input-e2e/`.
- Audio pipeline (`npx vitest run tests/audio-pipeline`, both projects; T-036): generated plucks and
  recorded guitar through `AnalysisCore` (Node) and the real worklet (browser), into the real judge,
  plus the worklet → main-thread delay in a running `AudioContext`. Results below.
- Owner's manual checklist covers the real cable: level, tuner, and false onsets from string noise.

## Audio-pipeline results (T-036)
Measured with `npx vitest run tests/audio-pipeline --silent=false` (the tests log the numbers with a
`[T-036 …]` prefix). Code: `tests/audio-pipeline/` (`scenario.ts` plans and judges a run,
`evaluate.ts` scores detections, `wav.ts` reads the fixtures).

### Generated plucks → analysis → judge
Starter song *Ode to Joy* (96 notes, 57.6 s) rendered as Karplus–Strong plucks with per-note
dynamics (−22 to −6 dBFS), brightness and sustain over a −70 dBFS floor, 23 ms simulated input
latency, an 8-pluck play-to-click calibration (median), one wrong note (+2 semitones), one omitted
note, plucks at +50, −50, +90, −100 and +100 ms. Events reach the judge through
`analysisToInputEvent` on a 60 Hz loop of `advance(inputHorizon(…))`.

| Run | Calibrated offset | Outcomes | Timing error (judged Δ − intended) |
|---|---|---|---|
| `AnalysisCore`, 100 % (Node) | 23.00 ms | as planned: 89 Perfect, 2 Great, 3 Good, 1 WrongNote, 1 Miss | mean 0.00 ms, p95 0.02 ms |
| `AnalysisCore`, 70 % (Node) | 23.00 ms | as planned | mean 0.00 ms, p95 0.01 ms |
| Real worklet, `OfflineAudioContext` (browser) | 23.00 ms | as planned; detections identical to the Node core | mean 0.00 ms, p95 0.02 ms |

Synthetic attacks are sample-accurate for the detector, so the e2e error is ~0: what remains is
the judge path, the calibration and the horizon. The recorded clips below give the realistic spread.

### Recorded guitar (fixtures)
`tests/fixtures/audio/` (1.66 MiB, DEC-22; provenance and licences in
[`ATTRIBUTION.md`](../tests/fixtures/audio/ATTRIBUTION.md); rebuilt byte for byte by
`NODE_USE_ENV_PROXY=1 npx tsx scripts/fetch-audio-fixtures.ts`, which reads only the needed members of
the GuitarSet zips with HTTP range requests):

| Clip | Notes | Content |
|---|---|---|
| `iowa-single-notes` | 15 | Univ. of Iowa MIS classical guitar, anechoic mic: E2–A5, all strings, 13 *mf* + 2 *pp*, isolated |
| `guitarset-rock1-mic` | 24 | GuitarSet `01_Rock1-90-C#_solo`, acoustic, microphone: picked line with hammer-ons/pull-offs, ~6 notes/s |
| `guitarset-rock2-pickup` | 17 | GuitarSet `03_Rock2-142-D_solo`, hexaphonic pickup mix (closest to a DI electric): picked line, one bend, one hammer-on |

Scored against reference onsets at ±30 ms (one-to-one, closest pairs first). **Raw** = onsets as
detected. **Calibrated** = the clip's median offset removed first (what latency calibration does;
GuitarSet's annotations sit ~10–15 ms after the steep part of the attack), with legato notes counted
when reported as `pitch-change`. Pitch accuracy is over matched notes. Hint = the clip's MIDI range
sent as `expect` (as the game does).

| Clip | Hint | Recall raw / cal. | Precision raw / cal. | Pitch (octave errors) | Offset | Timing raw: mean, p95 |
|---|---|---|---|---|---|---|
| Iowa | off / on | 93.3 % / 93.3 % | 93.3 % / 93.3 % | 100 % (0) | −0.9 ms | −1.3 ms, 3.5 ms |
| Rock 2, pickup | on (= off) | 76.5 % / 94.1 % | 81.3 % / 88.9 % | 93.8 % (0) | −15.0 ms | −15.2 ms, 24.3 ms |
| Rock 1, mic | off | 83.3 % / 87.5 % | 74.1 % / 67.7 % | 90.5 % (1) | −5.5 ms | −5.3 ms, 10.1 ms |
| Rock 1, mic | on (N = 1024) | 83.3 % / 91.7 % | 74.1 % / 66.7 % | 72.7 % (5) | −5.5 ms | −5.3 ms, 10.1 ms |

Judged as a song made from the annotations (calibrated offset, octave-tolerant default): Iowa 100 %
accuracy (15 Perfect); rock 2 88.2 % (15 Perfect, 1 WrongNote = the bend, 1 Miss = the hammer-on,
which the annotation-made song does not mark as legato); rock 1 83.3 % (18 Perfect, 2 Great, 2
WrongNote, 2 Miss, 3 strays). No event reached the judge after its horizon.

**Verdict:** the T-036 targets (≥ 90 % recall and precision at ±30 ms, ≥ 95 % pitch) hold for the
isolated Iowa notes and not yet for the GuitarSet lines. The failing cases, for the DSP owner
(`src/core/dsp/`; pinned in `recorded.test.ts` as floors plus `it.fails` targets):
1. **Pre-attack contact noise fires the onset early.** The pick or fingertip touching the string
   20–50 ms before the pluck (15–30 dB below the note) crosses the onset threshold: Iowa A5 at
   7.287 s vs 7.320 s (−33 ms); rock 2 B-string notes at 1.451 vs 1.495 s and 4.176 vs 4.222 s
   (−44/−46 ms raw; the latter is still −31 ms after calibration, rock 2's only miss), 2.296 vs
   2.326 s (−30 ms). When the gap exceeds the 40 ms refractory, the real attack fires a second onset:
   rock 1 at 0.450 (unpitched) + 0.498 s, 2.611 + 2.657 s, 3.972 + 4.032 s, 2.461 (pitched 42) before
   2.505 s, 3.280 before 3.324 s. Idea: re-anchor an onset to a much larger rise (≥ 15 dB) within
   ~50 ms, or drop an unpitched onset followed by a stronger one within 60 ms.
2. **Octave-down errors at N = 1024.** Rock 1 with its hint (56–73 → N = 1024, search from 49):
   63→51 at 0.991 s, 65→53 at 1.340 s, 66→54 at 1.482 s and 1.662 s, 61→49 at 4.032 s. Without the
   hint (N = 2048) only 66→54 at 1.662 s. Harmless while octave tolerance is on (DEC-18); wrong with
   *Strict octave*. Idea: a stricter octave check at N = 1024, or a smaller downward search margin.
3. **Stray onsets** between notes on the microphone recording: rock 1 at 2.267 s (54) and 4.395 s (43).
4. **Bend into a note:** rock 2 at 3.789 s (annotated 60.14) reads 59 +43 cents from the 25 ms
   window, then `pitch-change` 60 at 3.835 s; the judge scores a WrongNote.
5. **Repeated legato events:** on the microphone recording the pitch-change detector re-reports the
   just-plucked note 30–50 ms after many onsets (11 of 24 notes). The judge ignores `pitch-change` outside
   legato notes, so this is noise only.

The Iowa sources carry strong sub-30 Hz rumble (often louder below 30 Hz than the note); the
fixtures are high-passed at 30 Hz because a pickup into an AC-coupled interface has none. The
detectors themselves have no rumble rejection, so a microphone in a noisy room is untested.

### Worklet → main-thread delay
`delivery.browser.test.ts`: 24 plucks through the real worklet in a running `AudioContext`
(48 kHz, headless Chromium with its fake audio sink; the main thread sees `currentTime` move in
2.7 ms steps). Lag = `ctx.currentTime` on receipt − `frame / sampleRate`, the clock
`inputHorizon` uses. Two runs each:

| Main thread | Onset lag p50 | p95 | max | Delivery only (level messages) p95 / max |
|---|---|---|---|---|
| Idle | 68.0 ms | 70.0–74.7 ms | 74.0–76.7 ms | 5.3–8.0 / 8.0 ms |
| 30 ms busy block every 100 ms | 71.3–74.0 ms | 79.3–83.3 ms | 80.7–83.3 ms | 21.3 / 29.3 ms |

The analysis part is exact (Node, every onset of the Ode to Joy run): 25 ms + 2048 samples + ≤ 1
quantum ≤ 70.3 ms at 48 kHz (`GUITAR_ANALYSIS_DELAY_SEC` budgets 74.3 ms for 44.1 kHz). Against
`INPUT_LAG_SEC.guitar` = 109.3 ms that leaves ≥ 32 ms idle and ≥ 26 ms under 30 ms jank. Only a
late Good near +120 ms is at risk when delivery overruns: `pipeline.test.ts` shows a +115 ms pluck
stays Good with delivery 20 ms inside the budget and becomes a Miss 30 ms beyond it.
**Recommendation:** keep `INPUT_LAG_SEC.guitar` at ≈ 0.110 s (no change). Re-measure on the owner's
Mac: a CoreAudio callback of 256–512 frames makes `currentTime` advance in 5–11 ms steps, which
the 35 ms delivery margin absorbs.
