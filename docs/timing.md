# Timing

## Summary
- **One clock:** the `AudioContext`. Everything else derives from it; the renderer only reads it.
- `songTime = (ctx.currentTime − anchorCtxTime) × speed + anchorSongTime` (D5). `songTime` is in
  song seconds at 100% speed; negative during count-in/pre-roll.
- Guitar onsets are timestamped in the analysis worklet (frame-accurate), then the calibrated input
  offset is subtracted. Keyboard events are mapped from `performance.now()` to context time.
- Timing windows are in **real** seconds and are never scaled by speed.
- Calibration: **play-to-click** (primary) and **tap-to-click** (fallback / keyboard), optional
  **loopback**, plus a visual offset; results kept per input → output device pair.

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
  that just ended; right before it a time near A maps to the coming pass. While paused it
  extrapolates at the requested speed (always finite: renderer, backing alignment). Round trip
  `songTimeAt(ctxTimeAt(t)) = t` holds to < 1 µs across speed changes and wraps. The judge does not
  use it (nearest-to-now is wrong for loops shorter than about the pre-roll); it uses
  `ctxTimeInPass` (§ Passes).
- `clock.anchor` and `ClockChange.anchor` are the **latest** anchor, which may start up to 50 ms (or
  two horizons, for a scheduled wrap) in the future. `state` changes immediately on a control call; `count-in-end` is
  detected by the scheduler tick (≤ 25 ms late; the mapping itself is exact). `onChange` / `onEnded`
  listeners run after the control call has completed, so they may call back into the transport.
- `heardSongTime()` and `perfToCtxTime()` are described below. Interface in `shared/clock.ts`.

### Passes
Every segment carries a **pass** number (`ClockChange.pass`, `PlaybackSegment.pass`):
- a loop wrap, a `seek` (playing or paused) and a jump (`play({from})` while playing or paused) start
  the next pass; a fresh `play()` from `stopped` starts a run at pass 0;
- pause/resume, speed changes, loop changes (`setLoop`) and `stop` continue the pass. Within one run
  pass numbers never repeat.

Consecutive segments of a pass form a *stretch*. `ctxTimeInPass(song, pass)` (on `TransportCore` and
the engine's `SongClock`; the judge's `PassClockMapping`) maps a song time within the newest stretch of
that pass:
- **finite**: the context time the pass played it, or will play it as now scheduled;
- **`-Infinity`**: the pass never plays it — the pass is over (a later pass exists) and did not reach
  it, or it lies before the pass's start (a seek target, or the count-in bars: song times played as
  count-in are not covered);
- **`NaN`**: not known yet — **paused or stopped before reaching it**, not started, past the current
  bound, or no longer retained.

`loop-wrap` is announced (`onChange`) once the wrap has **begun** — the tick that sees `now ≥` the
wrap's anchor, at most one tick (25 ms; ~1 s in a hidden tab) late — not when it is scheduled two
horizons ahead. A wrap that is scheduled and then superseded (a `setSpeed` / `setLoop` just before B
re-anchors) is never announced, so each pass is announced exactly once. Other reasons are emitted
when the control call is made (their anchor is up to 50 ms in the future).

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
  rewinds to `start`; a seek cancels it. State `count-in` → `playing` emits `count-in-end`. `play()`
  after a pause counts in again (if set) and replays the bar before the pause point; that bar is
  count-in, not part of the pass mapping.
- **Loops (A/B):** A and B snap to section markers, then bar lines (minimum 1 bar). Pre-roll is
  **1 bar** (2 bars below 60% speed) of guide audio + click; count-in only on the first pass.
  Pre-roll clicks sound on every wrapped pass even with the metronome off. Setting a loop while
  already past B jumps to `A − preroll` at `t0` (a new pass, announced as `loop-wrap` once it
  begins); clearing it plays on in the same pass.
- **Song end:** outside a loop the transport stops at the end (state `stopped`, position held at
  the duration, `onEnded`); `play()` from there restarts at 0. `stop()` returns to 0.
- **Wrap:** when the scheduler sees B's context time within two horizons, it schedules the next pass
  with `anchorCtxTime` = that time, `anchorSongTime = A − preroll`, and slices the guide buffer from
  `A − preroll`; `loop-wrap` follows once it has begun. There is no gap. The judge finishes the notes
  before B on the previous pass's mapping (game-mechanics.md § Driving the judge).

## Latency calibration (`src/audio/calibration/`)
Files: `estimate.ts` (pairing + robust estimate, pure), `plan.ts` (click plan), `run.ts` (one run on an
injected clock / click sink / event source), `live.ts` (wiring to the engine, input worklet, keyboard),
`profiles.ts` (settings, per device pair, estimated fallback), `visual.ts` (visual offset). UI:
`src/ui/panels/calibration/` (summary + Guitar / Keyboard / Visual tabs; loopback under Guitar ›
Advanced). Settings: `calibration = {inputOffsetMs, keyboardOffsetMs, visualOffsetMs, method,
measuredAt, spreadMs}`.

**Clicks.** 1 bar (4 clicks) of count-in, then 16 measured clicks at 90 BPM, downbeats accented,
scheduled up front from `ctx.currentTime + 0.3` with the engine's click voice straight into the
**master** bus (normal output path, audible even with the metronome bus at 0). A sample-rate change
(context recreated) aborts the run.

**Play-to-click (primary, guitar).**
1. The player picks a muted or open string on each measured click; the analysis worklet reports onsets,
   converted with the judge's `frameToEventCtx(frame, sampleRate, 0)` (uncalibrated).
2. Events closer than 50 ms to the previous one are double triggers (the judge's retrigger guard; the
   first is kept). Each click pairs with the nearest event within ±250 ms, each event at most once
   (greedy from the closest pair outwards, so a missed pluck never steals its neighbour's onset).
3. Drop the first 2 pairs (settling) — the first two *pairs*, whichever clicks they belong to.
4. `med = median(onsetCtx − clickCtx)`, `MAD` = median |Δ − med| (unscaled). Reject pairs with
   |Δ − med| > max(2.5 × MAD, **5 ms**) — the floor keeps a near-perfect run (loopback, MAD ≈ 0).
   `inputOffsetMs` = median of the kept pairs, `spreadMs` = their MAD.
5. Usable with ≥ 8 kept pairs and spread ≤ 15 ms. Otherwise the run fails with a reason —
   `no-events` (nothing paired), `too-few` (< 8), `inconsistent` (spread > 15 ms) — and the panel
   explains it and offers **Try again**; the provisional offset is shown but not saved.
   Quality label: spread ≤ 5 ms "very consistent", ≤ 10 "consistent", ≤ 15 "a bit uneven".
6. The run ends 250 ms + 150 ms (late delivery) after the last click, on the context clock.
The result is saved at once (with **Undo**). It captures output + input latency + the player's habitual
bias, which is what the judge needs. Live: one dot per click fills in as its pair arrives (kept /
settling / rejected) with the running median; the result shows the offset, spread, clicks used/missed
and a residual strip (each pair minus the offset, ±80 ms, Perfect window shaded).

Estimator accuracy (simulated, 14 pairs): jitter σ 3 ms → |error| ≤ 4 ms (95 % ≤ 2.5 ms); σ 6 ms → 95 %
≤ 4.2 ms. Outliers, missed plucks, strays and double triggers do not move it.

**Tap-to-click (fallback / keyboard).** Same clicks; the player taps Space (or a keyboard-mode lane
key; auto-repeat and modified keys ignored). Taps are mapped with `engine.perfToCtxTime(event.timeStamp)`
(the heard domain, as in keyboard play), so the result → `keyboardOffsetMs` is key-event delay +
habit relative to the *heard* click. `method` / `measuredAt` / `spreadMs` describe the guitar offset:
a tap result only sets them (`method: 'tap-to-click'`) when nothing is calibrated yet; its own spread
and time live in the device profile.

**Estimated guitar offset.** If play-to-click finds no onsets the panel offers "Use an estimate":
`keyboardOffsetMs + inputLatency + ctx.baseLatency + ctx.outputLatency` (input = `track.getSettings().latency`;
unreported input/output latency counts as 10 ms, as in the monitoring estimate), saved with
`method: 'estimated'`. (The output latency is included because tap offsets are relative to the heard
click while guitar offsets are relative to the scheduled one.)

**Loopback (optional).** Output cabled to the guitar input; the clicks themselves come back as onsets.
Monitoring is switched off for the run (no feedback loop) and restored after. Same estimator. The
result is the hardware round trip without player bias; it is stored in the device profile
(`loopbackMs`) and "Use as guitar offset" saves it as `inputOffsetMs` with `method: 'loopback'`.

**Visual offset.** Endless clicks (90 BPM); gems scroll right → left into a hit line that flashes when a
click is drawn there, using the highway's formula (drawn time = heard ctx time − `visualOffsetMs`/1000,
so positive = drawn later). The player nudges ±5 ms (buttons or ←/→ on the lane), range ±150 ms,
saved on every nudge. Default 0; applied only to rendering (`heardSongTime`).

**Storage, per device pair.** Every save also writes a copy under
`calibration.profiles[deviceKey]` and sets `calibration.deviceKey`, where `deviceKey` =
normalised input label (else device id, else "default") + ` → ` + output label (else sink id, else
"default") — labels because Chrome rotates ids. A profile holds the six active fields plus the
keyboard spread/time and `loopbackMs` (`CalibrationProfile` in `shared/settings.ts`).
`followCalibrationProfiles(settings)` (run once at app startup by `src/main.ts`) restores a pair's
profile into the active fields whenever the input or output changes, on any screen. A pair without a profile keeps the previous values;
the panel says they were measured on another device, and the first save for the new pair marks carried
guitar values `estimated`. `deviceKey` and `profiles` are part of `CalibrationSettings`, so they live
in IndexedDB and exports.

## How offsets apply to scoring
- Guitar event: `eventCtx = onsetFrame / sampleRate − inputOffsetMs/1000` (`frameToEventCtx`, applied by
  the input service from the active `calibration.inputOffsetMs`).
- Keyboard event: `eventCtx = contextTime + (event.timeStamp − performanceTime)/1000 −
  keyboardOffsetMs/1000`, using a fresh `getOutputTimestamp()` pair, so it is in the "heard" domain.
- Judge: `Δ = eventCtx − ctxTimeInPass(note.time, pass)` in real seconds; windows from
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

signalsmith-stretch 1.3.2 limits (T-027): `schedule()` drops every queued change at or after the
worklet's *current* time, not after the new change's `output`, so only one future change can be
pending. `plan.ts` therefore posts a change only once all earlier ones are in the past and it is at most
`lead` (≥ `latency()`) ahead. When a re-plan drops a posted change, it re-posts the earliest remaining
future change to clear it. Load each file as **one buffer per channel**: the worklet mis-reads windows
spanning two added buffers once playback passes the first, so chunked/streamed loading is unsafe.
`setBuffer` calls `dropBuffers()` then a single `addBuffers(channels, transfer)`.

## Engine wiring (`index.ts`)
- `createEngine({sampleRate = 48000, sinkId, settings})`: `new AudioContext({latencyHint: 0,
  sampleRate})`; a saved `sinkId` that fails falls back to the default output. With a settings store it
  follows `mixer.*` with `mixerMute.*` (a muted bus plays at gain 0 and keeps its level),
  `practice.countInBars` / `practice.metronome` (defaults for play / metronome),
  `practice.metronomeAccent` (off: every click uses the beat voice), `calibration.visualOffsetMs` and
  `output.sinkId`; only changed fields are applied.
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
- Pass numbering, `ctxTimeInPass`, one `loop-wrap` per pass (`tests/engine/transport.test.ts`), and the
  judge driven through the real transport: 1–4-bar loops at 40–100%, hidden-tab horizon, pause/resume,
  seeks, speed and loop changes just before B (`tests/judge/transport-integration.test.ts`).
- Onset timestamp on generated plucks: |error| ≤ 5 ms at hop 128 (48 kHz).
- Calibration (`tests/calibration/`): estimator on simulated onsets (jitter, outliers, missed plucks,
  double triggers, strays, thresholds), run flow on a fake clock, profiles/persistence; in Chromium,
  plucks 37 ms after the real plan's clicks through the analysis worklet recover 37 ms within ±3 ms
  (also with jitter/missed/outlier), loopback of the real click voice through a 37 ms delay, a live
  run on a running context, and the panel flows with screenshots in `test-results/calibration/`.
