# Monitoring and amp sim

## Summary
- With no amp in the chain, Riffway routes the guitar to the output through an amp worklet
  (oversampled soft clipper + tone stack) and a biquad cab filter. Presets: **Clean**, **Overdrive**,
  and **DI** (bypass).
- The graph is built for low latency: `latencyHint: 0`, matched sample rate, no lookahead DSP.
- The UI shows an **estimated** monitoring latency and recommends headphones; a feedback guard ducks
  the monitor when the output is built-in speakers or runaway level is detected.

## Graph (`src/audio/monitor/`)
```
MediaStreamSource ─┬─▶ analysis worklet (no output)            [T-022]
                   └─▶ inputTrim ─▶ amp worklet ─▶ cab (biquads) ─▶ monitorBus ─▶ master ─▶ destination
guide / backing / metronome ─▶ their buses ─▶ master            [engine mixer, T-016]
```
- Mixer buses (engine): `monitor`, `backing`, `guide`, `metronome` → `master`. Each is a `GainNode`
  with a level in settings (`mixer.*`, 0–1, dB-scaled sliders). Mute = gain 0, never disconnect.
- The monitor path has no `AnalyserNode` or `ScriptProcessor` in series.

## Amp worklet (`src/core/dsp/amp/`, wrapped by `amp.worklet.ts`)
Pure TS, unit-tested in Node:
1. Input gain (drive), DC blocker.
2. 4× oversampling with a polyphase half-band FIR (≈ 31 taps per stage, a few samples of group delay).
3. Asymmetric soft clip: `y = tanh(g·x + bias) − tanh(bias)`.
4. Decimate, then a 3-band tone stack (low shelf 120 Hz, peak 700 Hz, high shelf 3 kHz) and output level.

**Cab:** native biquads: high-pass 80 Hz, peak +3 dB @ 120 Hz, dip −4 dB @ 400 Hz, presence +3 dB @
2.5 kHz, low-pass 5.5 kHz (12 dB/oct ×2). No IR files (licence-free).

| Preset | Drive | Bias | Low / Mid / High | Cab | Level |
|---|---|---|---|---|---|
| Clean | 1.5 | 0.0 | +1 / 0 / +2 dB | on, low-pass 7 kHz | −6 dB |
| Overdrive | 12 | 0.15 | +2 / +3 / −1 dB | on | −12 dB |
| DI | — (bypass) | — | — | off | 0 dB |
Presets are data (`presets.ts`); the panel exposes drive, tone and level knobs per preset.

## Latency measurement and display
Shown in the monitoring panel as "≈ N ms (estimated)":
```
inputLatency  = track.getSettings().latency ?? 0.01
outputLatency = ctx.outputLatency || 0.01   // estimate in Chrome
monitorMs ≈ (inputLatency + ctx.baseLatency + outputLatency + 128 / ctx.sampleRate) × 1000
```
After play-to-click calibration, also show "measured round trip ≈ inputOffsetMs" (it includes the
player's own bias, so label it "calibrated offset"). Bands: ≤ 15 ms "great", ≤ 30 ms "playable",
> 30 ms "noticeable — see tips". Tips: use headphones or a wired output, close other audio apps, keep
the device at 48 kHz, plug directly into the Mac, and on macOS check Audio MIDI Setup for a matching
sample rate. Real values on Chrome/macOS are typically 20–70 ms round trip; the owner verifies with
the manual checklist.

## Headphones and feedback guard
- First time monitoring is enabled, a card recommends headphones ("Hear yourself clearly and avoid
  feedback").
- **Speaker guard:** if the output device label matches `/built-in|macbook.*speakers|internal
  speakers/i`, monitoring starts muted with a banner "Monitoring is off on laptop speakers"
  and an explicit "Turn on anyway" (persisted per output device).
- **Runaway guard:** while monitoring, if input RMS rises > 12 dB within 1 s while above −10 dBFS
  for ≥ 300 ms and the spectrum is dominated by one bin (peak/total ≥ 0.5), duck the monitor bus to
  −30 dB over 50 ms and show "Feedback detected — monitoring lowered". The user re-enables.
- Master output has a brick-wall safety limiter (`DynamicsCompressorNode`, threshold −1 dB,
  ratio 20) before the destination.

## Settings
`monitor = {enabled, preset, drive, tone {low, mid, high}, level, allowSpeakers: {[sinkId]: bool}}`
and `mixer = {master, monitor, backing, guide, metronome}`.

## Tests
- Node: clipper transfer curve, oversampling aliasing (a 5 kHz sine at drive 12 has aliased
  components < −60 dB relative), tone-stack responses at band centres (±0.5 dB).
- Browser (`OfflineAudioContext`): the full monitor chain introduces < 1 ms of added delay
  (cross-correlation of an impulse), presets produce expected RMS levels, mute = silence.
- Guard logic unit-tested on synthetic level/spectrum sequences.
