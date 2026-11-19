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
  (≈ 70 ms at N = 2048 / 48 kHz); the judge's guitar input horizon (`INPUT_LAG_SEC.guitar`) covers this.

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
  tuned on synthetic signals only; T-036 validates on recordings.
- Browser (`npx vitest run --project browser tests/input`): the real worklet on an
  `OfflineAudioContext` fed by an `AudioBufferSource` of plucks (frames ±5 ms, pitches, stereo channel
  select, tuner frames) and the service on Chrome's fake capture device.
- Fake capture with a WAV (`npx playwright test -c tests/input/e2e/playwright.config.ts`): Chrome plays
  a generated tone as its microphone (`--use-file-for-fake-audio-capture`) into both panels on a Vite
  dev server (`/tests/input/e2e/harness.html`); checks meter, tuner (A2 in tune; D2 22 cents flat in
  Drop D) and persistence across reload, and writes screenshots to `test-results/input-e2e/`.
- Recorded clips (Iowa MIS single notes, GuitarSet excerpts; see `tests/fixtures/audio/ATTRIBUTION.md`):
  ≥ 95% note pitch accuracy and ≥ 90% onset recall at ±30 ms against annotations (T-036).
- Owner's manual checklist covers the real cable: level, tuner, and false onsets from string noise.
