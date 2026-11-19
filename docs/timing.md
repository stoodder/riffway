# Timing

## Summary
- **One clock:** the `AudioContext`. Everything else derives from it; the renderer only reads it.
- `songTime = (ctx.currentTime − anchorCtxTime) × speed + anchorSongTime` (D5). `songTime` is in
  song seconds at 100% speed; negative during count-in/pre-roll.
- Guitar onsets are timestamped in the analysis worklet (frame-accurate), then the calibrated input
  offset is subtracted. Keyboard events are mapped from `performance.now()` to context time.
- Timing windows are in **real** seconds and are never scaled by speed.
- Calibration: **play-to-click** (primary) and **tap-to-click** (fallback / keyboard), plus a visual offset.

## Clock model (`src/audio/engine/clock.ts`)
The transport holds `{anchorCtxTime, anchorSongTime, speed, state}`. Every change (play, seek, speed,
loop wrap) re-anchors at a future context time `t0 = ctx.currentTime + 0.05`:
`anchorSongTime = songTimeAt(t0)`, `anchorCtxTime = t0`. Inverse: `ctxTimeAt(songTime) =
anchorCtxTime + (songTime − anchorSongTime) / speed`. The clock exposes `songTimeAt(ctxTime)`,
`ctxTimeAt(songTime)`, `nowSong()` and a `heardSongTime()` for rendering (below). Interface in
`shared/clock.ts`.

**Rendering time.** Audio scheduled at context time T is heard at about T + `outputLatency`.
`ctx.getOutputTimestamp()` returns `{contextTime, performanceTime}` for the sample being heard now;
the renderer extrapolates it to the frame's `performance.now()` and draws at
`heardSongTime = songTimeAt(contextTime + (perfNow − performanceTime)/1000) − visualOffset × speed`.
So a gem reaches the hit line when its sound is heard.

## Scheduling (`scheduler.ts`)
- A look-ahead loop (`setInterval` 25 ms, horizon 120 ms) schedules short events: metronome and
  count-in clicks (oscillator bursts, accent on downbeats), loop wraps, rate changes.
- Long audio (guide PCM, backing) is started once with `AudioBufferSourceNode.start(when, offset)` /
  the stretch worklet's `schedule()`, and re-issued on seek, speed change or loop wrap.
- Metronome beats come from the song's beat grid (`timing.bars[].beats`, flattened by `beatTimes()`), so
  tempo changes and odd meters click correctly.

## Speed changes
- Range 40–110% (110% only after mastery, off by default). Guide audio is re-rendered by alphaSynth
  with tempo × speed (no pitch change). Re-render is ~300× real time, chunked so playback can start
  after the first ~5 s is ready.
- While playing, a speed change takes effect at the next bar line after the render is ready; the
  transport re-anchors there. While paused it applies immediately.
- Backing audio uses signalsmith-stretch `rate = speed × warpSlope` (see backing alignment).

## Count-in, loops and pre-roll
- **Count-in:** default 1 bar of clicks (setting 0–2 bars). Start at `anchorSongTime = start −
  countInBeats × beatDur(start)`; notes before `start` are not judged.
- **Loops (A/B):** A and B snap to section markers, then bar lines (minimum 1 bar). Pre-roll is
  **1 bar** (2 bars below 60% speed) of guide audio + click; count-in only on the first pass.
- **Wrap:** when the scheduler sees `ctxTimeAt(B)` inside its horizon, it schedules the next pass with
  `anchorCtxTime = ctxTimeAt(B)`, `anchorSongTime = A − preroll`, slices the guide buffer from
  `A − preroll`, and finalises notes before B after their window closes. There is no gap.

## Latency calibration (`src/audio/calibration/`)
Stored in settings as `calibration = {inputOffsetMs, keyboardOffsetMs, visualOffsetMs, method,
measuredAt, spreadMs}`.

**Play-to-click (primary, guitar).**
1. 1 bar of count-in, then 16 clicks at 90 BPM through the normal output path.
2. The player picks the open low E (or any string) on each click; the analysis worklet reports onsets.
3. Pair each click with the nearest onset within ±250 ms; drop the first 2 pairs (settling).
4. `inputOffsetMs = median(onsetCtx − clickCtx)`; reject pairs beyond 2.5 × MAD; need ≥ 8 valid pairs
   and spread (MAD) ≤ 15 ms, otherwise ask to retry.
This captures output latency + input latency + the player's habitual bias, which is what the judge needs.

**Tap-to-click (fallback).** Same clicks, player taps Space. Result → `keyboardOffsetMs`. If guitar
calibration fails (no onsets), the guitar offset falls back to `keyboardOffsetMs +
track.getSettings().latency + ctx.baseLatency` and the UI marks it "estimated".

**Visual offset.** A flash crosses the hit line with each click; the player nudges ±5 ms until flash
and click coincide. Default 0; applied only to rendering.

## How offsets apply to scoring
- Guitar event: `eventCtx = onsetFrame / sampleRate − inputOffsetMs/1000`.
- Keyboard event: `eventCtx = contextTime + (event.timeStamp − performanceTime)/1000 −
  keyboardOffsetMs/1000`, using a fresh `getOutputTimestamp()` pair, so it is in the "heard" domain.
- Judge: `Δ = eventCtx − ctxTimeAt(note.time)` in real seconds; windows from
  [game-mechanics.md](game-mechanics.md). Speed never rescales windows.

## Backing audio alignment
An `AudioLink` (IndexedDB) maps song time to audio-file time with **anchors**
`[{songTime, audioTime}]`:
- 1 anchor = pure offset (`audioTime = songTime + (a0.audio − a0.song)`).
- 2+ anchors = piecewise-linear warp; slope between anchors absorbs tempo drift. Extrapolate with the
  nearest segment's slope.
Alignment UI: waveform + beat grid overlay, drag to set offset, ±10 ms nudge, "tap the beat" mode
(taps at bar 1 and at a later bar create anchors), and a play-check with click on top. Playback:
`stretch.schedule({output: ctxTimeAt(songTime), input: audioTimeAt(songTime), rate: speed × slope})`
at least `stretch.latency()` ahead, with a rate change scheduled at each anchor boundary.

## Test targets
- Scheduled click vs `OfflineAudioContext` render: error ≤ 1 sample.
- Clock round trip `songTimeAt(ctxTimeAt(t)) = t` across speed changes and loop wraps (≤ 1 µs).
- Onset timestamp on generated plucks: |error| ≤ 5 ms at hop 128 (48 kHz).
- Calibration on a synthetic click+delayed-pluck signal recovers the delay within ±3 ms.
