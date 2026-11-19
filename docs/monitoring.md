# Monitoring and amp sim

## Summary
- With no amp in the chain, Riffway routes the guitar to the output through an amp worklet (noise
  gate, 4× oversampled anti-aliased soft clipper, tone stack) and a biquad cab filter. Presets:
  **Clean**, **Crunch**, **Overdrive** and **DI** (bypass).
- Built for low latency: `latencyHint: 0`, matched sample rate, no look-ahead DSP. The amp + cab add
  **≈ 0.45 ms** (measured, below).
- The panel shows an **estimated** monitoring delay split into input · processing · output and
  recommends headphones; guards mute the monitor on laptop speakers and on runaway feedback.

## Graph (`src/audio/monitor/`)
```
MediaStreamSource ─┬─▶ analysis worklet (no output)                                   [T-022]
                   └─▶ [splitter: input channel] ─▶ input (mono) ─▶ amp worklet ─┬─▶ cab ─▶ cabGain ─┐
                                                                                 └──────▶ dryGain ───┴─▶ out ─▶ monitor bus
guide / backing / metronome ─▶ their buses ─▶ master ─▶ safety limiter ─▶ destination   [engine, T-016]
```
- `chain.ts` (`MonitorChain`) builds this on any `BaseAudioContext` (tests use `OfflineAudioContext`).
  `settings.input.channel` picks the interface channel (`'mix'` downmixes; mono sources use 0).
- `out` opens with a **300 ms linear ramp-in** (no pop; a feedback loop shows up gradually) and closes
  with a 10 ms fade. The cab is crossfaded (`cabGain`/`dryGain`), never rewired, so preset changes don't click.
- Mixer buses (engine): `monitor`, `backing`, `guide`, `metronome` → `master`. Mute = gain 0 (`mixerMute`), never disconnect.
- No `AnalyserNode`, `ScriptProcessor` or `DynamicsCompressorNode` in series on the monitor path.
- `index.ts` (`createMonitor`) builds the chain on the engine's context, rebuilds it on
  `onContextChange`, re-attaches `input.getInputNode()` on `onDevicesChanged`, and follows settings.
  `setEnabled(true)` opens the input if it is closed.

## Amp DSP (`src/core/dsp/amp/`, wrapped by `amp.worklet.ts`)
Pure TS, unit-tested in Node; the worklet output equals the Node DSP to < 1e-6. Per sample:
1. DC blocker (10 Hz), **noise gate** (preset threshold; peak detector, 6 dB hysteresis, 50 ms hold,
   0.5 ms attack, 60 ms release, no look-ahead), drive (smoothed).
2. **4× oversampling**: two polyphase half-band FIR stages (31 taps β 8 at 2×, 15 taps β 7 at 4×),
   around an asymmetric soft clip `y = tanh(x + bias) − tanh(bias)` with first-order antiderivative
   anti-aliasing (ADAA). A 5 kHz sine at drive 12 aliases < −70 dB re the fundamental.
3. DC blocker (the bias adds DC), 3-band tone stack (RBJ low shelf 120 Hz, peak 700 Hz Q 0.7, high
   shelf 3 kHz), output level (smoothed).
4. Guard duck gain, denormal flush (state < 1e-20 → 0, so silence decays to exact zeros).
DI crossfades to the dry input (bit-exact once faded). Non-finite input samples are treated as 0.

**Cab** (native `BiquadFilterNode`s, no IR files): high-pass 80 Hz, peak +3 dB @ 120 Hz, dip −4 dB @
400 Hz, presence +3 dB @ 2.5 kHz, two Butterworth low-pass sections at the preset's corner (24 dB/oct).

| Preset | Drive | Bias | Low / Mid / High | Gate | Cab low-pass | Level |
|---|---|---|---|---|---|---|
| Clean | 1.5 | 0.0 | +1 / 0 / +2 dB | −72 dBFS | 7 kHz | −6 dB |
| Crunch | 5 | 0.1 | +1 / +2 / +1 dB | −66 dBFS | 6 kHz | −14 dB |
| Overdrive | 12 | 0.15 | +2 / +3 / −1 dB | −60 dBFS | 5.5 kHz | −20 dB |
| DI | — (bypass) | — | — | off | off | 0 dB |

Presets are data (`presets.ts`). Levels are set so Clean, Crunch and Overdrive sit within ~3 dB of
the dry signal for a typical −12 dBFS pick. Crunch sits between the two in character: it breaks up when
you dig in and cleans up when you pick lightly (≈ 10 % distortion on a −12 dBFS tone vs ≈ 1 % Clean and
≈ 25 % Overdrive; a pick 12 dB quieter loses ≈ 11 dB vs 12 Clean and < 10 Overdrive). The panel exposes drive (0–32 dB, labelled clean / edge of breakup /
crunch / overdrive / saturated), bass/mid/treble (±12 dB) and level (−40…+6 dB); `setPreset` resets
them to the preset's values. Bias, gate and cab come from the preset (`setParams` can override bias
and bypass for the session; they are not persisted).

## Latency measurement and display
**Added by Riffway's DSP** (measured by cross-correlation in `OfflineAudioContext`, 48 kHz):
Clean 21 samples (0.44 ms), Crunch 21.7 samples (0.45 ms), Overdrive 22 samples (0.46 ms), DI 0. The amp alone is 17.875 samples
(`AMP_LATENCY_SAMPLES`: oversampler round trip 17.75 + ADAA ⅛); the cab adds ~3–4 samples of group delay.

The panel shows "≈ N ms (estimated)" with three parts:
```
input       = track.getSettings().latency, else 10 ms (shown "assumed")
processing  = 128 / sampleRate (one render quantum) + amp DSP delay
output      = ctx.baseLatency + (ctx.outputLatency || 10 ms "assumed")
```
`latency()` returns the shared `LatencyEstimate` (`@shared/services`) with `parts.dspMs` and the
`assumed` flags filled; the readout refreshes every 2 s. After a **play-to-click** calibration
it also shows "Calibrated offset ≈ inputOffsetMs" (labelled as including the player's own timing);
until then it says the number is an estimate. Bands: ≤ 15 ms "great", ≤ 30 ms "playable", > 30 ms
"noticeable — see tips" (tips open automatically): wired headphones, plug the interface directly
into the Mac, close other audio apps, keep 48 kHz and matching rates in Audio MIDI Setup. Real values
on Chrome/macOS are typically 20–70 ms round trip; the owner verifies with the manual checklist.

## Headphones and feedback guard
- **Headphone card** until dismissed (`monitor.headphonesCardSeen`): "Hear yourself clearly and avoid
  feedback"; the switch's description also recommends headphones.
- **Speaker guard:** if the output's label (`''` = Chrome's `default` device) matches
  `/built-in|macbook.*speakers|internal speakers/i`, monitoring stays muted with the banner "Monitoring
  is off on laptop speakers" and "Turn on anyway" (persisted in `monitor.allowSpeakers[sinkId]`).
  Re-checked on device changes and output/allow-list setting changes.
- **Built-in mic note:** an input label matching `/built-in|macbook.*microphone|internal microphone/i`
  shows a note that monitoring will pick up the room.
- **Runaway guard** (`guard.ts`, runs in the amp worklet on the DC-blocked input, ~10.7 ms hops):
  - *feedback*: RMS > −10 dBFS for ≥ 300 ms **and** a > 12 dB rise within the last 1 s **and** the
    spectrum's main lobe (strongest bin ± 1 of a 2048-point Hann FFT) holds ≥ 70 % of the power
    (a sustained guitar note measures 0.5–0.6, chords 0.2–0.5, a howl ≥ 0.8);
  - *runaway level*: RMS > −3 dBFS for ≥ 500 ms, whatever the spectrum.
  On a trip the worklet ducks its output to −30 dB over 50 ms on the audio thread, then the service
  mutes the monitor and shows "Feedback detected — monitoring lowered". The player re-enables
  ("Turn monitoring back on" / the switch), which resets the guard and ramps back in.
- `onGuard` replays the current guard state (speaker-muted / feedback-ducked) to new subscribers.
- Master output has the engine's zero-latency safety limiter (`WaveShaperNode` soft clipper: linear to
  −1 dBFS, tanh knee, never above 0 dBFS). A `DynamicsCompressorNode` was rejected: it adds a fixed
  ~6 ms look-ahead in Chrome.

## Settings
`monitor = {enabled, preset, drive, tone {low, mid, high}, level, allowSpeakers: {[sinkId]: bool},
headphonesCardSeen}`, `mixer = {master, monitor, backing, guide, metronome}` (levels 0–1) and
`mixerMute` (same keys, booleans: a muted bus plays at 0 and keeps its level for unmuting).

## Tests (`tests/monitor/`)
- Node: half-band design and passband/stopband, oversampler delay, clipper curve and antiderivative,
  tone stack at band centres (±0.5 dB), cab shape, harmonic content (Clean THD < 3 %, Crunch 5–18 %,
  Overdrive > 18 % with odd + even harmonics, symmetric clip has no even ones), aliasing (< −60 dB), gain staging and
  compression, latency, duck and bypass crossfade, no NaN / subnormals (silence tails are exact zeros),
  gate behaviour (unity when open, silent tail, no chatter), guard trips and non-trips, latency maths,
  device labels.
- Browser (`OfflineAudioContext`): full chain adds < 1 ms (cross-correlation), preset levels, worklet ≡
  Node DSP, closed = silence, ramp-in, channel selection, in-worklet duck. Service on a real engine:
  speaker guard, presets → settings, latency, feedback mute + re-enable, context rebuild. Panel states
  with screenshots in `test-results/monitor/`.
