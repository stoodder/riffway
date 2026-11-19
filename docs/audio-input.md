# Audio input

## Summary
- The Cubilux USB-C cable is a class-compliant input. Riffway lists inputs, remembers the choice, and
  opens it with echo cancellation, noise suppression and auto gain **off**.
- One analysis AudioWorklet (`src/audio/worklets/analysis.worklet.ts`) wraps pure-TS DSP from
  `src/core/dsp/`: level meter, onset detector, MPM pitch tracker, pitch-change detector.
- Onsets give timing; pitch is measured 20–40 ms after the onset (past the inharmonic attack).
- Single notes first. Chords are scored leniently (onset + any chord tone) until chord detection
  (stretch) exists.

## Device selection and persistence (`src/audio/input/devices.ts`)
1. On first run, call `getUserMedia({audio: true})` once so device labels become visible, then
   `enumerateDevices()` and list `kind === 'audioinput'`.
2. Pre-select a device whose label matches `/usb|cubilux|guitar|audio codec/i`; otherwise the default.
3. Persist `{deviceId, label, channel}` in settings. On later runs match by `deviceId`, then by
   `label` (Chrome may rotate ids), else fall back to default and show "Your guitar input wasn't found".
4. Listen to `navigator.mediaDevices.ondevicechange`; re-open when the chosen device reappears.
5. Output device: `ctx.setSinkId(id)` from the same panel; persisted as `output.sinkId`.

## Constraints
```ts
getUserMedia({ audio: {
  deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false,
  autoGainControl: false, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
  latency: { ideal: 0 } } })
```
Then read `track.getSettings()` and trust only the actual values: headless Chrome reported
2 channels at 44.1 kHz despite these. The worklet analyses channel 0 by default (setting: 0, 1, or
mix). The `AudioContext` is created with `{latencyHint: 0, sampleRate: <track sampleRate>}` so Chrome
does not resample (owned by the engine, T-016). If any of the three processing flags read back
`true`, show a warning.

## Level meter
The worklet computes peak and RMS per 128-sample quantum and posts `{type:'level', peakDb, rmsDb}`
every ~50 ms. UI: horizontal meter, green below −18 dBFS, yellow to −6, red above, peak-hold 1 s,
clip indicator at ≥ −0.5 dBFS. Hint text: "Aim for peaks around −12 dB; turn the guitar volume up if
the meter barely moves". Silence detection (< −60 dBFS for 5 s while playing) shows "No signal".

## Tuner
- Same worklet, continuous pitch frames (N = 4096 at 48 kHz for stability, hop 1024, ~21 Hz updates).
- Median of the last 5 valid frames (clarity ≥ 0.9); display nearest string of the **current song's
  tuning** (default standard; Drop D etc. when the song says so), plus note name and cents ±50.
- In tune = |cents| ≤ 3 for 0.5 s. Needle eased in the UI; numbers never jump on noise (hold the last
  value below clarity 0.8).
- A4 reference adjustable (default 440).

## Pitch and onset detection worklet
Pure DSP in `src/core/dsp/` (unit-tested in Node with generated tones); the worklet is a thin shell.

**Onset detector** (`onset.ts`), per 128-sample hop:
- Detection function: energy of the first-difference (pre-emphasised, HF-weighted) signal, plus
  positive spectral flux on a 512-point window every 2 hops for weak attacks.
- Adaptive threshold: `median(last 0.5 s) + k × MAD` (k ≈ 4) and an absolute floor (−50 dBFS).
- Peak-pick with a 40 ms refractory period. Onset time = frame of the rising edge, refined to the
  sample of maximum slope inside the hop. Timestamp = `currentFrame + offset` (context frames).

**Pitch** (`pitch.ts`, MPM/NSDF via a radix-2 FFT, preallocated buffers):
- Window N = 2048 when the expected note is below ~160 Hz, else 1024. The main thread posts
  `{type:'expect', minMidi, maxMidi}` hints from the upcoming notes so the worklet can choose N and a
  search range (expected ±7 semitones, widened to E2–E6 when no hint).
- After an onset, wait 25 ms, then estimate on the next window; emit
  `{type:'onset', frame, midi, cents, clarity, rmsDb}`. If clarity < 0.6, emit `midi: null`; a
  follow-up `{type:'pitch', frame, midi…}` may arrive within 40 ms (the judge waits for it).
- Octave check: if the NSDF peak at 2× period is ≥ 0.9 of the chosen peak, prefer the lower octave
  only when it is in the expected range.

**Pitch-change detector** (legato): during a sustained note, if the tracked pitch moves ≥ 0.8
semitone and stays for ≥ 25 ms without an amplitude onset, emit `{type:'pitch-change', frame, midi}`.
Used for hammer-ons, pull-offs and slides.

**Messaging.** `port.postMessage` with small plain objects (`shared/audio-events.ts`); rates are low
(≤ 50 msgs/s). No allocation in `process()` beyond the message objects. The main thread converts
frames to context seconds (`frame / sampleRate`) and applies the calibration offset
([timing.md](timing.md)).

## Chord leniency
Until chord detection exists, a chord group is satisfied by one onset whose detected pitch matches
any chord tone ([game-mechanics.md](game-mechanics.md)). The HUD shows "Chords: any chord tone counts"
while chords are visible, and the results screen notes how many notes were judged this way.
Chord *verification* (harmonic salience at expected f0s, chroma template match) is stretch task T-070.

## Tests
- Generated tones E2–E6 (sine + harmonics + noise, plucked envelopes): pitch within ±10 cents,
  clarity ≥ 0.9; onsets within ±5 ms; no double onsets on a 2 s decay.
- Recorded clips (Iowa MIS single notes, GuitarSet excerpts; see `tests/fixtures/audio/ATTRIBUTION.md`):
  ≥ 95% note pitch accuracy and ≥ 90% onset recall at ±30 ms against annotations.
- Owner's manual checklist covers the real cable: level, tuner, and false onsets from string noise.
