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

`Δ = eventCtx − ctxTimeAt(note.time)` after calibration ([timing.md](timing.md)). Early/late labels
appear only when |Δ| > Great window (bandwidth feedback, learning research row 7); the full timing
histogram is on the results screen.

## Judge algorithm (`src/core/judge/`)
Pure and deterministic; input is a stream of `InputEvent`s (`shared/judge.ts`):
`{ctxTime, kind: 'onset'|'pitch-change', midi?: number, cents?, clarity?, source: 'guitar'|'keyboard'|'test', refines?}`
(`refines` = ctx time of an earlier unpitched onset that this follow-up pitch completes).

1. **Targets.** Notes grouped into *onset groups* (same chord id, or onsets within 10 ms). Tied
   destinations are not targets. Notes in pre-roll/count-in are not judged.
2. **Candidates.** For an event, candidates are open groups with |Δ| ≤ Good window.
3. **Pitch match.** A group matches if the event pitch rounds to any group note's MIDI (±50 cents).
   An octave error (±12) also matches unless *Strict octave* is on (default off; DEC-18). Dead notes
   (`x`) match any onset. No pitch (low clarity) → treated as unpitched: can satisfy dead notes only,
   otherwise stays pending for 40 ms waiting for a pitch update, then counts as WrongNote.
4. **Assignment (greedy).** Prefer the pitch-matching candidate with the smallest |Δ|; tie → earlier
   note. If none match in pitch, mark the nearest-in-time candidate *provisional WrongNote*.
5. **Upgrade.** A provisional WrongNote becomes a hit if a matching onset arrives before its window
   closes (the better outcome wins). Final grade is fixed when `nowCtx > ctxTimeAt(t) + Good`.
6. **Legato.** Notes flagged hammer/pull/slide-destination also accept a `pitch-change` event (no new
   pluck) as their onset.
7. **Retrigger guard.** An event within 50 ms of an already-matched event with the same pitch is
   ignored. Events with no candidates are *strays*: shown as a faint tick, not penalised, do not break
   combo (DEC-19).
8. **Miss.** Groups whose window closes without assignment become Miss.
Every judgement emits `{noteIds, outcome, deltaMs, timing, playedMidi?, expectedMidi, chord, songTime, ctxTime,
final, pass}` (`Judgement` in `shared/judge.ts`) to the HUD and the run log.

**Chord leniency.** A chord group is hit by one onset whose pitch matches any chord tone; all notes in
the group get that outcome. HUD shows a small "Chords: any chord tone counts" note while chords are on
screen. Real chord verification is a stretch task (T-070).

## Combo, score, accuracy, stars
- Multiplier: combo 0–9 → ×1, 10–19 → ×2, 20–29 → ×3, 30+ → ×4. Score = Σ base × multiplier at the
  moment of the hit. Chord groups count as one hit for combo and score.
- **Accuracy %** = (Perfect + Great + Good notes) / judged notes × 100 (per note, chords count each note).
- **Timing score** (shown separately) = mean of 1.0 / 0.75 / 0.5 over hits.
- Stars (per run, any speed; the speed is shown beside them):

| Stars | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Accuracy ≥ | 50% | 70% | 80% | 90% | 97% |

- Best score and best stars are stored per arrangement **at 100% speed**; slower runs keep a separate
  "best at speed" record ([progress.md](progress.md)).

## Results screen
Score, stars, accuracy, max combo, counts per outcome, timing histogram (early ↔ late, 10 ms bins),
section heatmap (accuracy per section), **weakest section** with a one-click "Loop this" (opens
practice with that section, speed trainer on), clean-run flag, and personal-best badges. Copy is
informational, never guilt-based.

## Hand-position cue
`src/core/handpos/` segments fretted notes into positions: a position is a window
`[lo, lo + 3]` (4 frets; 5 when `lo ≥ 7`). Walk notes in time order; when a fretted note falls outside
the window, the new `lo` = minimum fret of the longest upcoming run of notes that fits one window.
Open strings never force a shift. A **cue** is shown when |Δlo| ≥ 2: a fret-labelled bracket
("7fr") on the highway, appearing ≥ 1.5 beats and ≥ 0.75 real seconds before the first note of the new
position. Shifts also feed [difficulty.md](difficulty.md).

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
