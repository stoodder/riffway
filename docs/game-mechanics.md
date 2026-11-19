# Game mechanics

## Summary
- Pitch and timing are judged **separately**. Outcomes: **Perfect / Great / Good** (with early/late),
  **WrongNote** (onset in window, wrong pitch), **Miss** (no onset in window).
- Windows (real seconds, not scaled by speed): Perfect ±35 ms, Great ±70 ms, Good ±120 ms.
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

`Δ = eventCtx − ` the note's context time in its loop pass, after calibration ([timing.md](timing.md)). Early/late labels
appear only when |Δ| > Great window (bandwidth feedback, learning research row 7); the full timing
histogram is on the results screen.

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
the group get that outcome. HUD shows a small "Chords: any chord tone counts" note while chords are on
screen. Real chord verification is a stretch task (T-070).

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
Score, stars, accuracy, max combo, counts per outcome (per note), timing histogram (early ↔ late, 10 ms
bins from −120 to +120 ms, one entry per hit or WrongNote group),
section heatmap (accuracy per section), **weakest section** with a one-click "Loop this" (opens
practice with that section, speed trainer on), clean-run flag, and personal-best badges. Copy is
informational, never guilt-based.

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
  |Δlo| ≥ 2: a fret-labelled bracket ("7fr") on the highway at `time` = the new position's start,
  appearing at `showAt = time − max(1.5 beats, 0.75 s)`. The beat is the containing bar's
  `dur / beats` (else 60 / BPM from the tempo map, else 0.5 s), in song seconds at 100% speed; at
  slower practice speeds the real lead only grows. Above 100% the renderer shows a cue at
  `cueShowAt(cue, speed)` = `min(showAt, time − 0.75 × speed)`, which keeps ≥ 0.75 real seconds.
Shifts also feed [difficulty.md](difficulty.md).

## Highway and technique glyphs
Horizontal lanes, high e on top. x = `hitX + (note.time − heardSongTime) / speed × pxPerSec`
(constant visual velocity in real time). Gems show the fret number; sustains draw a tail.
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
Hit feedback: gem flash + particle burst + outcome text at the hit line; WrongNote shows red with
"played G3"; Miss greys the gem. Combo flame grows with the multiplier.

## Keyboard input mode (D6)
- Default keys `1`–`6`: `1` = high e … `6` = low E (remappable in settings).
- A key press yields an onset with the pitch of the nearest open note on that lane within the Good
  window, or the lane's open-string pitch. **Shift + key** adds +1 semitone → a deliberate WrongNote.
- Events go through the same judge path as guitar events with `source: 'keyboard'` and the keyboard
  calibration offset. `Esc` pauses.
- e2e test hook (`?e2e=1`): `window.__riffwayTest.inject({lane, songTime, wrongPitch})` enqueues an
  event at an exact song time through the same path.
