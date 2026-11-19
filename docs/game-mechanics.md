# Game mechanics

## Summary
- Pitch and timing are judged **separately**. Outcomes: **Perfect / Great / Good** (with early/late),
  **WrongNote** (onset in window, wrong pitch), **Miss** (no onset in window).
- Windows (real seconds, not scaled by speed): Perfect ±35 ms, Great ±70 ms, Good ±120 ms, scaled by
  the *timing leniency* setting (tight ×0.75, standard ×1, relaxed ×1.5).
- Score = base × combo multiplier (×1–×4). **Accuracy % = notes hit with correct pitch (Good or
  better) / total judged notes**, the same metric the speed trainer and mastery use.
- Chords are judged leniently (one onset + any chord tone) and the HUD says so.
- No song ever stops on errors. Every assist can be toggled.
Constants live in `src/core/judge/constants.ts`; tune them there and update this doc.

## Windows
| Outcome | Window | Base points | Combo |
|---|---|---|---|
| Perfect | \|Δ\| ≤ 35 ms | 100 | +1 |
| Great | ≤ 70 ms | 75 | +1 |
| Good | ≤ 120 ms | 50 | +1 |
| WrongNote | onset ≤ 120 ms, pitch mismatch | 0 | reset |
| Miss | no matching onset by note time + 120 ms | 0 | reset |

The table is the `standard` leniency. Settings `game.timingLeniency` scales all three windows for the
next run (`windowsFor` in `src/game/session/leniency.ts`): `tight` ×0.75 (26 / 53 / 90 ms), `relaxed`
×1.5 (53 / 105 / 180 ms); the settings screen shows the resulting windows. The run's Good window also
sets the song-end settle, the loop-pass evaluation delay and the keyboard pitch lookup.

`Δ = eventCtx − ` the note's context time in its loop pass, after calibration ([timing.md](timing.md)). Early/late labels
appear only when |Δ| > Great window (bandwidth feedback, learning research row 7); the full timing
histogram is on the results screen.

The guitar horizon covers held onsets too: the onset detector may hold a suspect trigger (contact
noise, a soft note after a loud one, a re-pick on a ringing string) for up to 70 ms, and every onset
message — held or not, at 44.1 or 48 kHz, either pitch window — is still posted within
`GUITAR_ANALYSIS_DELAY_SEC` (74.3 ms; measured worst 74.1 ms at 44.1 kHz). With the worst measured
main-thread delay (29.3 ms under 30 ms jank) a late Good at +115 ms stays a Good
(`tests/judge/held-onset-budget.test.ts`).

## Judge algorithm (`src/core/judge/`)
Pure and deterministic; input is a stream of `InputEvent`s (`shared/judge.ts`):
`{ctxTime, kind: 'onset'|'pitch-change', midi?: number, cents?, clarity?, source: 'guitar'|'keyboard'|'test', refines?}`
(`refines` = ctx time of an earlier unpitched onset that this follow-up pitch completes).

1. **Targets.** Notes grouped into *onset groups* (same chord id, or onsets within 10 ms). Tied
   destinations are not targets. Notes before `judgeFrom` (count-in / start position) or outside the
   loop `region` `[A, B)` (so also the pre-roll) are not judged.
2. **Candidates.** For an event, candidates are open groups (not yet hit, window not closed) with
   |Δ| ≤ Good window.
3. **Pitch match.** A note matches if the detected pitch (`midi + cents/100`) is within ±50 cents of
   its MIDI, or of any semitone up to its bend target for a bent note. An octave error (±12) also
   matches unless *Strict octave* is on (default off; DEC-18). Dead notes (`x`) match any onset. No
   pitch (low clarity) → unpitched: it hits a dead-note candidate at once, otherwise it stays pending
   for 40 ms waiting for its follow-up pitch (`refines`), which is then judged at the onset's time;
   without one it counts as WrongNote. A late follow-up can only complete the judgement its own onset
   already got.
4. **Assignment (greedy).** Among pitch-matching candidates prefer an exact match over an octave match,
   then the smallest |Δ − bias|, then the earlier note. `bias` is the player's running timing bias (EMA
   of hit deltas, α = 0.2, clamped to ± Great); with an on-time player this is plain nearest-in-time,
   and a player who is consistently late through a fast trill or tremolo stays on the notes they mean.
   If none match in pitch, the nearest candidate without an assignment becomes a *provisional
   WrongNote*; if every candidate already has one, the event is a stray. One onset is assigned to at
   most one group.
5. **Upgrade.** A provisional WrongNote becomes a hit if a matching onset arrives before its window
   closes (the better outcome wins). Hits are final at once: a hit group is no longer a candidate, so
   the next onset goes to the next note. A WrongNote is fixed when `now > target + Good`.
6. **Legato.** Notes flagged hammer/pull/slide-destination also accept a `pitch-change` event (no new
   pluck) as their onset. A `pitch-change` that matches no legato destination is ignored (vibrato and
   bends never create WrongNotes or strays).
7. **Retrigger guard.** An event within 50 ms of an already-assigned event is a detector double
   trigger and is ignored, unless the gap is at least half the target spacing between that event's
   group and the group the new event would take (so a 45 ms tremolo still counts). Events with no
   candidates are *strays*: shown as a faint tick, not penalised, do not break combo (DEC-19).
8. **Miss.** Groups whose window closes without assignment become Miss.
Every judgement emits `{noteIds, outcome, deltaMs, timing, playedMidi?, expectedMidi, chord, songTime, ctxTime,
final, pass}` (`Judgement` in `shared/judge.ts`) to the HUD and the run log. Hits are emitted once with
`final: true`; a WrongNote is emitted provisional (`final: false`) and again when final (or as the hit
that upgraded it).

**Chord leniency.** A chord group is hit by one onset whose pitch matches any chord tone; all notes in
the group get that outcome. The game HUD shows a small "Chords: judged on timing + any chord tone" note
while chords are in view (the highway itself draws no chord note). Real chord verification is a
stretch task (T-070).

### Driving the judge (time domains)
- **One judge per run** (a fresh `play()` until song end or quit). `config.clock` is the engine's
  `SongClock`, which is a `PassClockMapping` (`ctxTimeInPass`, [timing.md § Passes](timing.md#passes)).
  Create the judge right before the run's `play()`.
- **Events** arrive calibrated ([timing.md](timing.md)): `analysisToInputEvent(msg, sampleRate,
  inputOffsetMs)` for worklet messages (a `pitch` follow-up maps to exactly its onset's time) and
  `keyboardEventCtx(timeStamp, outputTimestamp, keyboardOffsetMs)` for keys.
- **`advance(now)`** every frame (also while paused) takes the *input horizon*, not `ctx.currentTime`:
  `inputHorizon(ctxNow, source, offsetMs, outputLatency)` = `ctxNow − offset − INPUT_LAG_SEC[source]`
  (guitar ≈ 110 ms: 25 ms pitch wait + a 2048-sample window at 44.1 kHz + one render quantum + 35 ms
  delivery margin; keyboard 20 ms). A window therefore closes only after every onset that could land
  in it has arrived, so a pluck 110 ms late is still a Good.
- **Targets** resolve live per pass from `clock.ctxTimeInPass(note.time, pass)`, so speed changes are
  followed exactly. A finite value is the target. `NaN` means not known yet: **while paused** the
  notes after the pause point are not candidates and never close, so onsets during a pause are strays
  (notes already reached keep their real target and close normally). `-Infinity` means the pass never
  plays the note (skipped by a seek, or in a count-in): it stays unjudged.
- **Passes.** Whenever a transport `ClockChange` carries a `pass` other than the judge's, call
  `startPass({pass: change.pass})` synchronously in the handler. That covers `loop-wrap` (announced once
  the wrap has begun), `seek` and `play({from})`. The new pass re-opens the notes in the region; the
  previous pass keeps opening and closing its own remaining notes on its own mapping (the notes just
  before B are judged whenever the switch is announced). A forward seek leaves the skipped notes
  unjudged; after a backward seek the replayed notes are judged again in the new pass. Combo and the run
  tally carry across passes. `passStats(judgements, pass)` gives one pass's accuracy and clean flag for
  the speed trainer. Count-in bars are never judged, so `judgeFrom` is not needed for them.
- **Loop changes mid-pass** (`setLoop` without a wrap keeps the pass): call `startPass({pass:
  samePass, region})`. With the current pass number `startPass` only applies the new `judgeFrom` /
  `region` to the rest of the pass: notes already opened keep their judgement, notes whose window had
  already closed are not judged.
- **`finish(now)`** fixes the windows of notes already reached (Miss) and provisional WrongNotes, and
  returns the `RunSummary`; notes not yet reached (ahead of `now`, or after the pause point) stay
  unjudged.
- A plain `SongClockMapping` without `ctxTimeInPass` (tests) works for one pass: only the current pass
  resolves (`ctxTimeAt`, non-finite = wait); on `startPass` the previous pass's open notes keep their
  last target and its notes not yet opened are dropped.

## Combo, score, accuracy, stars
- Multiplier: combo 0–9 → ×1, 10–19 → ×2, 20–29 → ×3, 30+ → ×4. Score = Σ base × multiplier at the
  moment of the hit (the multiplier shown before it, so the 11th consecutive hit is the first ×2).
  Chord groups count as one hit for combo and score.
- Combo is counted in **note order**: hits after the latest WrongNote/Miss in song order (across loop
  passes). A WrongNote breaks it when it is assigned, even if later upgraded; a Miss breaks it when its
  window closes without erasing hits already made on later notes.
- **Accuracy %** = (Perfect + Great + Good notes) / judged notes × 100 (per note, chords count each note).
- **Timing score** (shown separately) = mean of 1.0 / 0.75 / 0.5 over hit groups (one per onset).
- **Clean run** = accuracy ≥ 90% and at most 2 non-hit groups (WrongNote or Miss) in a row.
- Stars (per run, any speed; the speed is shown beside them):

| Stars | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Accuracy ≥ | 50% | 70% | 80% | 90% | 97% |

- Best score and best stars are stored per arrangement **at 100% speed**; slower runs keep a separate
  "best at speed" record ([progress.md](progress.md)).

## Results screen
Score, stars, accuracy, max combo, **timing precision** (the timing score, with a tooltip), counts per
outcome (per note), timing histogram (early ↔ late, 10 ms bins from −120 to +120 ms, one entry per
hit or WrongNote group),
section heatmap (accuracy per section), **weakest section** with a one-click "Loop this" (opens
practice with that section, speed trainer on), clean-run flag, and personal-best badges. Copy is
informational, never guilt-based. Implemented in `src/ui/screens/results/` (`#/results/:runId`):
- **Timing tendency** from the histogram's bin centres: fewer than 8 entries → unknown; mean within
  ±10 ms → centred; else "You tend to play early/late — about N ms".
- **Progress** lists this run's section-progress changes: clean runs (with the 2-at-100%-per-session
  mastery count), mastered, locked in, failed next-day check, plateau nudge.
- **Action row** right under the score card (above the fold at 1280×720): Play again · Loop
  <weakest section> (when below 100%) · Song page · Library. A new best reads "New best at 70%".
- **Progress** lines use plain words: "Clean run — 1 of 2 clean runs at full speed toward mastering
  Box Run", "Clean run at 75% in Box Run — 3 so far".
- **Next up** (`nextSteps`, at most 3): loop the weakest section when it is below 90%; after a clean
  run below 100% "Try it at +5%", at 100% "Go for mastery"; below 70% "Play it at −10%"; always "Play
  again". The cards leave out what the action row already offers (Play again, Loop weakest). Plus up
  to 3 stretch picks from the library (`recommend()`).
- A starter original credited to "Riffway" is shown without an artist (results, game HUD, start card).
- A just-played run is handed over in memory; a results URL opened later is rebuilt from the stored
  run (no timing score, chord count or progress lines). Unsaved runs use the key `unsaved-<endedAt>`.

## Game session (`src/game/session/`)
`createGameSession` loads the song meta + bundle, the `Song` (song worker), renders the guide at the
start speed, loads the backing link (guide muted per `guideShouldMute`), opens the guitar input
(below) and creates a `GameSessionImpl`, which drives the judge as in § Driving the judge:
- **Run** = one `play()` from `ready`/`ended` until song end, "End run" or quit. The judge is created
  right before `transport.play()`; with a loop the run starts at `A − pre-roll`.
- A session timer (20 ms `setInterval`, keeps ~1 Hz in a hidden tab) flushes test injections, adds
  active time (transport playing or counting in), calls `advance()` with the **earliest** horizon of
  the active sources (keyboard always, guitar when open), evaluates finished loop passes and the end.
- **Song end:** the run is finished once the horizon passes the end + Good + 10 ms, so late input for
  the last notes still counts. Then the run is saved (run record, best for its speed bucket — full-song
  runs without a loop only, at the slowest speed played — practice time + streak, song cache) and
  `onRunEnd(summary, runId)` fires; the screen opens the results.
- **Section progress:** a full-song run counts for every section whose notes were all judged; a loop
  pass whose loop is exactly one section counts for that section once its notes are final (wrap +
  Good + 10 ms), which also steps the speed trainer (`trainerStep`) and, with the trainer on, sets the
  new speed (bar-aligned) and posts "Clean run! +5% → 75%" / "Slow down a notch → 75%". Loops over
  other bar ranges use an in-memory trainer. Mastery / lock-in / plateau post `info` / `plateau`
  messages. Mastery counts clean runs at 100% within one practice session = one page load.
- **Quit** records only the active time (no run); **restart** discards the run the same way.
- **Pass speed:** each tick records the speed actually playing (`transport.speedAt(now)`) for the
  pass playing, while its judged part plays (loop region, else song time ≥ 0). A loop pass counts at
  the slowest speed it played; a bar-aligned change announced in a pass but heard only in the next
  pass does not count for it.
- **Guitar unplugged:** the session listens to `input.onDevicesChanged`. When `input.current` turns
  null during a run it pauses with "Guitar disconnected — plug it back in, or press Resume to
  continue with the keys." (also on the pause card, `pauseNotice`). The run is still shown on
  results but **not saved** (its misses are the cable's): only its active time is recorded.
  `onInputStatus` reports the guitar coming back; the notice then clears.
- **Audio stopped:** a context that leaves `running` mid-run (OS, device or power events) pauses
  the run with "Audio stopped … press Resume"; Resume goes through `requireAudioGesture`.
- **Loading** takes an `AbortSignal` (`extras.signal`): the play screen aborts it when left, and an
  aborted load never builds a session, touches the shared transport or opens input. The guide and
  backing are app-wide singletons: the load that last claimed one owns it, and only the owner
  unloads it (on dispose or a failed load), so a stale game never tears down the next game's guide
  or backing. A guide load superseded while rendering (`GuideImpl.holds(song)` false) leaves the
  session without the guide and says so.
- Practice start speed: explicit `speed`, else for a looped section with the trainer on the stored
  trainer speed (or 70% / 60% by tier), else 100%. Speeds clamp to 40–110%; crossing 60% re-applies the
  loop with its 1- or 2-bar pre-roll.
- **Guitar input:** the `input` route param, else settings `game.inputMode`: `keyboard` never opens
  it; `auto` (default) uses an input that is already open or the device chosen before (it never
  prompts on its own); `guitar` opens it. With `?e2e=1` the default is `keyboard` (a fake capture
  device's beeps would add onsets).
- **Practice state** read by the practice panel: `countInBars` (from settings `practice.countInBars`,
  then `setCountInBars`), `metronome` (settings `practice.metronome`, `setMetronome`, and later settings
  changes) and `trainerState` (`{speed, failStreak}`; the panel shows "1 run under 70% · one more steps
  down 5%").
- The session sets the song cache's `lastPlayedAt` when a run starts (home "Continue" and
  recently-played order). The session sends `expect`
  hints (pitch range of notes from 0.25 s back to 3 s ahead, bends included, dead notes excluded) every
  0.2 s when the range changes, and `expect(null)` on dispose.

## Game screen (`src/ui/screens/game/`, `#/play/:id`)
Query: `arr`, `mode` (`play` | `practice`), `section` (loop it), `speed`, `input`.
- **Layout.** While a run plays or counts in, the app's top nav is hidden (it returns on pause, the
  start card and results), so the lanes get its height. HUD bar: song, mode, current section, score,
  accuracy, live star meter (stars + progress to the next threshold), speed, "Practice tools" and a
  labelled **Pause · Esc** button of the same size.
- **One outcome display**, on the highway: the gutter text left of the hit line (see § Highway) —
  nothing is drawn over the notes still to come, and the combo shows once (the canvas cluster in the
  gutter; the HUD has no combo). Live accuracy and stars count a provisional WrongNote at once and
  show "—" until 5 notes are judged.
- **Overlays**: the count-in number over the gutter (and, during every loop pass's pre-roll, a beat
  countdown captioned "Loop" while the highway shows the loop's section and hand position); coach
  messages as a pill in the highway's top strip; the note "Chords: judged on timing + any chord
  tone" in the gutter's bottom strip while chords are in view. None of them covers a lane.
- **Footer**: section progress bar (live per-section accuracy as the underline colour, loop region,
  a playhead on the underline that never covers a name, the played part; click to jump in practice
  mode) and a key hint shown until the first run starts.
- **Start card**: mode, speed, loop, input, key legend named from the song's tuning (string 1 always
  lower case: Drop D reads e B G D A D) and, for a non-standard tuning, a retune reminder ("Drop D —
  tune string 6 down to D") with **Open tuner** (the tuner panel in a modal).
- **Pause menu**: Resume, Restart, Practice tools, End run & see results, Quit to song; when the
  session paused itself it says why (guitar unplugged, audio stopped). The tab going hidden pauses.
- **Errors**: a song not in the library (404) shows "This song isn't in your library" with **Back to
  library** and **Rescan library** (no raw id, no retry); other load errors keep Try again / Back.
- Practice tools (drawer, open by default in practice mode on wide screens) mount the `practice` and
  `mixer` panels.

## Practice logic (`src/core/practice/`)
- **Speed trainer** (D8, parameters in `TRAINER`): start 70% (60% when the section is ≥ 2 tiers above
  the comfort tier). Clean run → +5% ("Clean run! +5% → 80%"), cap 100%. Two runs below 70% in a row →
  −5% ("Slow down a notch → 75%"), floor 40%. Any other run holds the speed and resets the fail streak.
  Speeds stay on a 1% grid.
- **Loops** (`LOOP`): `snapLoop` snaps each edge to a section boundary less than 1 bar away, else to the
  nearest bar line; minimum 1 bar, clamped to the song. `toTransportLoop` gives A/B in song seconds plus
  the pre-roll: the real length of the 1 bar before A (2 bars below 60% speed; before bar 0 the first
  bar's length repeats).

## Hand-position cue
`src/core/handpos/` (`computePositions`) segments the song into hand positions. A position is a
window `[lo, hi]`: `hi = lo + 3` (4 frets), or `lo + 4` (5 frets) when `lo ≥ 7`.
- Work on onset groups (`onsetGroups`: chords and onsets within 10 ms; tied destinations excluded).
  Only **fretted** notes count: fret > 0 and not a dead note. Open strings and dead notes never move
  the hand (a group of only those stays in the current position).
- A group whose fretted notes all fit the current window stays in it. Otherwise (and for the first
  fretted group) the new `lo` is the minimum fret of the longest run of upcoming fretted groups, starting
  with this one, that fits one window (open/dead-only groups are skipped in the run).
- If that `lo` equals the current one (a chord stretching wider than the window), it is not a shift.
- Each position records `start` (its first group's time), `end` (the next position's start; the last
  one ends with the last sounding note) and its first/last note ids.
- Every `lo` change is a shift (difficulty counts 1-fret ones too). A **cue** is shown only when
  |Δlo| ≥ 2 at `time` = the new position's start. The analysis records
  `showAt = time − max(1.5 beats, 0.75 s)` (`cueShowAt` keeps ≥ 0.75 real s above 100%); the game
  shows cues earlier: from `time − max(2 beats, 1.5 s × speed)` (`CUE_LEAD_BEATS`,
  `CUE_LEAD_REAL_SEC` in `src/game/highway/renderer.ts`), i.e. at least 2 beats and 1.5 real seconds
  ahead at any speed. The beat is the containing bar's `dur / beats` (else 60 / BPM from the tempo
  map, else 0.5 s), in song seconds.
- The cue on the highway: a thick fret bracket across all six lanes with a tinted band over the new
  position's zone and a large "▲ 7fr" pill in the top strip. At the same time the position pill on
  the hit line turns accent-filled and announces the shift ("5fr ▲ 7fr"), so it is visible where the
  player looks; when the shift lands it pulses once and shows the new position.
Shifts also feed [difficulty.md](difficulty.md).

## Highway and technique glyphs
Horizontal lanes, high e on top. x = `hitX + (note.time − heardSongTime) / speed × pxPerSec`
(constant visual velocity in real time). Gems show the fret number (settings `game.fretNumbers`,
highway option `fretNumbers`; off = position-only reading); sustains draw a tail.
Layout (`src/game/highway/layout.ts`, CSS px): a 30 px strip above the lanes (sections, bar numbers,
cue labels, loop flags) and 26 px below (palm-mute brackets); six equal lanes in between,
gem half-size `clamp(0.36 × laneH, 9, 24)`; hit line at `hitX = clamp(0.24 × width, 220, 340)` with the
gutter (combo, outcome text, lane letters, fade-out) to its left; `pxPerSec = 320 × noteSpeed`
(note speed 0.5–2), so a 1280 px canvas at note speed 1 shows ~3 real seconds of notes ahead of the
hit line.
| Technique | Glyph |
|---|---|
| Hammer-on / pull-off | `h` / `p` arc to next note |
| Slide (in/out/shift/legato) | diagonal `/` or `\` line |
| Bend | upward arrow with `½`, `full`, `1½`; release arrow |
| Palm mute | `PM` bracket under the lane span |
| Let ring | dashed tail |
| Vibrato | `~` on the tail |
| Harmonic | diamond gem |
| Dead note | `×` gem |
x uses the speed being **heard** (`clock.heardSpeed`), so a requested change that waits for its bar
line changes gem spacing only when it plays. Lane letters sit in the right half of each target well,
clear of the hit line.

**Hit feedback** (the game's only outcome display; never over the notes still to come):
- Outcome colours are never lane colours (CIE76 ΔE ≥ 30 from every string colour; tokens
  `--judge-*`): Perfect white, Great cyan, Good mint, WrongNote magenta, Miss grey.
- The gutter text, right-aligned left of the judged lane's well (a chord's on its top string), says
  per the *feedback detail* setting: minimal = the word; standard = plus **EARLY ▸** (icy blue) /
  **◂ LATE** (peach) outside the Great window and, for a wrong note, how far off in frets ("1 fret
  high", "an octave low", "not a chord tone"); detailed = plus the signed ms and the played note
  ("played F4 · 1 fret high"). Text: `feedbackText` in `src/game/highway/feedback.ts`.
- On the well: a magenta ✕ for a wrong note, a hollow grey ring for a miss, and an early/late tick
  on that side of the hit line (early right, where the note still was; late left).
- Gem flash + a short particle spray straight up over the hit line; a wrong gem turns magenta, a
  missed one grey. The combo flame in the gutter grows with the multiplier.

## Keyboard input mode (D6)
- Default keys `1`–`6`: `1` = high e … `6` = low E (remappable in settings, `keyboard.lanes`).
- A key press yields an onset with the pitch of the nearest note on that lane within the Good
  window (`0.12 s × speed` in song time), or the lane's open-string pitch (tuning + capo). **Shift +
  key** adds +1 semitone → a deliberate WrongNote. Key repeats are ignored; lane keys also work while a
  button, slider, checkbox or radio has focus, never while typing in a text field, select or
  editable content (R2-I-05); Ctrl/Alt/Meta combos are left alone.
- Events go through the same judge path as guitar events with `source: 'keyboard'`, timed in the heard
  domain (`engine.perfToCtxTime(event.timeStamp)`) minus `keyboardOffsetMs`. `Esc` pauses / resumes;
  `Space` / `Enter` (no control focused) start or resume.
- **Practice-panel shortcuts** (T-032, `src/ui/panels/practice/shortcuts.ts`; physical keys, no
  Ctrl/Alt/Meta; ignored while typing, while a modal is open and on auto-repeat except speed). The game
  never binds or `preventDefault`s these:

| Key | Action | Panel |
|---|---|---|
| `-` | Slower: −5% | practice |
| `=` (`+`) | Faster: +5% | practice |
| `A` | Set loop start (A) at the heard position | practice |
| `B` | Set loop end (B) at the heard position | practice |
| `L` | Loop the current section; again clears the loop | practice |
| `[` / `]` | Loop the previous / next section | practice |
| `T` | Speed trainer on/off | practice |
| `M` | Metronome on/off | practice |
| `C` | Count-in: 0 → 1 → 2 bars | practice |
| `G` | Guide synth on/off | mixer |

  Reserved for the game: the lane keys (a remapped lane wins over a shortcut), Shift, `Esc`, Space,
  Enter, Tab and the arrows.

### e2e test hook (`?e2e=1`, `src/test-hooks/`)
`window.__riffwayTest` drives the game session on screen:
- `ready()` — a session is loaded; `getState()` — route + `{songId, arrangement, state, songTime,
  speed, judge}`.
- `inject({lane, songTime, wrongPitch})` — an onset (`source: 'test'`) at exactly `songTime` in the
  pass being played, pitched like keyboard mode. Injections are queued until that pass reaches the
  time (dropped if the pass skips it), so a whole song can be scripted right after pressing Play;
  an exact time gives Δ = 0 → Perfect.
- `getJudgements()` — the run's final judgements (also after leaving for the results page).
- `getNotes()` — the song's judge targets `{id, songTime, lane, midi, chord}`; inject one
  event per chord.
- `setSpeed(speed)` / `seek(songTime)` — like the practice panel.
