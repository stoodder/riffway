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
Engine files: `index.ts` (`createEngine`, wiring), `clock.ts` (segment timeline, `SongClock`),
`transport.ts` (state machine + click scheduling, pure), `scheduler.ts` (look-ahead timer),
`beats.ts` (beat grid, count-in), `metronome.ts` (click voice), `mixer.ts` (buses + limiter).
`clock.ts`, `transport.ts`, `scheduler.ts` and `beats.ts` are DOM-free and tested in Node with a fake clock.

The transport keeps a short list of **segments**, each an anchor `{anchorCtxTime, anchorSongTime,
speed}` (speed 0 while paused/stopped) that holds until the next one starts. Every change (play,
seek, speed, pause, stop) appends a segment at a future context time `t0 = ctx.currentTime + 0.05`
(continuous changes use `anchorSongTime = songTimeAt(t0)`); loop wraps are appended up to two
scheduler horizons before B. So the mapping at any context time — past, now, or already scheduled —
is exact:
- `songTimeAt(ctx)` uses the segment in effect at `ctx`. A playing segment that has run past its
  bound (song end, or loop B before the wrap is appended) holds at the bound.
- `ctxTimeAt(song)` = `anchorCtxTime + (song − anchorSongTime) / speed` of the **nearest occurrence**
  to now among retained segments (2 s of history). Right after a wrap a time near B maps to the pass
  that just ended (the judge's late window); right before it a time near A maps to the coming pass.
  While paused it extrapolates at the requested speed. Round trip `songTimeAt(ctxTimeAt(t)) = t` holds
  to < 1 µs across speed changes and wraps.
- `clock.anchor` and `ClockChange.anchor` are the **latest** anchor, which may start up to 50 ms (or a
  horizon, for wraps) in the future. `state` changes immediately on a control call; `count-in-end` is
  detected by the scheduler tick (≤ 25 ms late; the mapping itself is exact). `onChange` / `onEnded`
  listeners run after the control call has completed, so they may call back into the transport.
- `heardSongTime()` and `perfToCtxTime()` are described below. Interface in `shared/clock.ts`.

**Rendering time.** Audio scheduled at context time T is heard at about T + `outputLatency`.
`ctx.getOutputTimestamp()` returns `{contextTime, performanceTime}` for the sample being heard now;
the renderer extrapolates it to the frame's `performance.now()` and draws at
`heardSongTime = songTimeAt(contextTime + (perfNow − performanceTime)/1000) − visualOffset × speed`.
So a gem reaches the hit line when its sound is heard. Without a usable timestamp (context not
running, timestamp older than 1 s) the fallback is `currentTime − baseLatency − outputLatency`.
`engine.perfToCtxTime(ms)` uses the same mapping, so keyboard events land in the heard domain.

## Scheduling (`scheduler.ts`, `transport.ts`)
- A look-ahead loop (`setInterval` 25 ms, horizon 120 ms) runs while the transport plays. Each tick
  appends due loop wraps, detects count-in end and song end, and schedules every click in
  `[now, now + horizon)`. The timer only decides *when we look*: every time is computed from the
  segment timeline (`ctx.currentTime` domain), so timer jitter never moves a click.
- **Throttling.** The horizon adapts to the observed gap between ticks (`max(120 ms, gap + 50 ms)`,
  capped at 3 s) and is 1.5 s while the page is hidden (Chrome throttles hidden timers to ~1 Hz).
  A click whose time has already passed when a late tick runs is skipped, never played late.
  Becoming visible triggers an immediate tick.
- Clicks are keyed by (segment, song time): repeated ticks never duplicate a click, and a re-anchor
  cancels exactly the clicks of dropped segments or past the closed segment's new end. Segment ends
  are exact (`songEnd` = the bar line or B), so a beat on a boundary belongs to exactly one segment.
- **Click voice** (`metronome.ts`): pre-rendered 30 ms decaying-cosine buffers (accent 2 kHz / 1.0,
  beat 1.3 kHz / 0.6) on `AudioBufferSourceNode`s into the metronome bus; the onset is the sample
  `ceil(when × sampleRate)`.
- Metronome beats come from the song's beat grid (`timing.bars[].beats`, `beats.ts`), downbeats
  accented, so tempo changes and odd meters click correctly. Before the first bar the grid is
  extrapolated with the first bar's meter; with no song loaded it is an endless 120 BPM 4/4 grid.
- **Long audio** (guide PCM, backing) registers a `ScheduledSource` (`engine.registerScheduledSource`).
  It gets `schedule(segment)` whenever a playing segment is created — play, seek, speed change, loop
  wrap, a loop change (new bound) — at least one horizon ahead for wraps, `t0` for the others, and
  `stop(t0)` on pause/stop/song end. A source registered while playing is scheduled from
  `now + 0.05`. Semantics: `schedule` replaces everything the source had scheduled from
  `segment.ctxStart` on; `songEnd`/`ctxEnd` are the segment's bound (loop B or the song end).

## Speed changes
- Range 40–110% (110% only after mastery, off by default). Guide audio is re-rendered by alphaSynth
  with tempo × speed (no pitch change). Re-render is ~300× real time, chunked so playback can start
  after the first ~5 s is ready.
- While playing, a speed change takes effect at the next bar line after the render is ready
  (`setSpeed(speed, {ready})`); the transport re-anchors there (`anchorSongTime` = the bar line
  exactly). If that bar line is loop B, the wrap carries the new speed. While paused it applies
  immediately. A newer `setSpeed` supersedes a pending one; a rejected `ready` keeps the old speed.
  `transport.speed` is the requested speed; speeds are clamped to 40–110%.
- Backing audio uses signalsmith-stretch `rate = speed × warpSlope` (see backing alignment).

## Count-in, loops and pre-roll
- **Count-in:** default 1 bar of clicks (setting 0–2 bars). Start at `anchorSongTime = start −
  countInBeats × beatDur(start)`; notes before `start` are not judged. `countInBeats` = bars × the
  beat count of the bar at `start`; the first click of each count-in bar is accented. Count-in clicks
  play even with the metronome off (but through the metronome bus). Pausing during the count-in
  rewinds to `start`; a seek cancels it. State `count-in` → `playing` emits `count-in-end`.
- **Loops (A/B):** A and B snap to section markers, then bar lines (minimum 1 bar). Pre-roll is
  **1 bar** (2 bars below 60% speed) of guide audio + click; count-in only on the first pass.
  Pre-roll clicks sound on every wrapped pass even with the metronome off. Setting a loop while
  already past B jumps to `A − preroll` at `t0` (reason `loop-wrap`); clearing it plays on.
- **Song end:** outside a loop the transport stops at the end (state `stopped`, position held at
  the duration, `onEnded`); `play()` from there restarts at 0. `stop()` returns to 0.
- **Wrap:** when the scheduler sees `ctxTimeAt(B)` within two horizons, it schedules the next pass with
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

## Engine wiring (`index.ts`)
- `createEngine({sampleRate = 48000, sinkId, settings})`: `new AudioContext({latencyHint: 0,
  sampleRate})`; a saved `sinkId` that fails falls back to the default output. With a settings store it
  follows `mixer.*`, `practice.countInBars` / `practice.metronome` (defaults for play / metronome),
  `calibration.visualOffsetMs` and `output.sinkId`; only changed fields are applied.
- Mixer: `monitor/backing/guide/metronome → master → safety limiter → destination`; `setLevel` is
  smoothed over ~10 ms. **Safety limiter:** a zero-latency `WaveShaperNode` soft clipper (linear to
  −1 dBFS, tanh knee, never above 0 dBFS, +12 dB range). A `DynamicsCompressorNode` was rejected:
  Chrome delays its output by a fixed 6 ms look-ahead (measured 288 samples at 48 kHz) and changes
  levels below threshold, which would add latency to monitoring and shift clicks.
- `setSampleRate()` recreates the context: the transport pauses at the current song time on the new
  clock, the mixer is rebuilt with the same levels, `onContextChange` fires; sources reconnect.

## Test targets
- Scheduled click vs `OfflineAudioContext` render: error ≤ 1 sample — across a tempo/meter change, a
  loop wrap (no gap or duplicate), count-in click count and a speed change (`tests/engine/*.browser.test.ts`;
  the transport is ticked at render-time `suspend()` points like the live timer).
- Clock round trip `songTimeAt(ctxTimeAt(t)) = t` across speed changes and loop wraps (≤ 1 µs), and
  throttled ticks (1 s gaps) never play a click late (`tests/engine/*.test.ts`, fake clock).
- Onset timestamp on generated plucks: |error| ≤ 5 ms at hop 128 (48 kHz).
- Calibration on a synthetic click+delayed-pluck signal recovers the delay within ±3 ms.
