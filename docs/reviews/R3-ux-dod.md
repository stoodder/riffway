# Review round R3: UX and Definition of done (independent reviewer)

Date: 2026-11-19. The reviewer did not build Riffway and saw it for the first time in this round.

**Method:** `npm run build`, then the built server (`node dist-server/index.js`) on a random free port. It
used a throwaway `RIFFWAY_DATA_DIR` and library folder, seeded with `Riff Test.gp` and the ASCII
"Synthetic Riff Study". The browser was Playwright Chromium with fake media and autoplay flags, at
`deviceScaleFactor: 1` and persistent profiles, so state carried across steps as it would for a real user.

The first-run journey was walked at **1440×900** and the main screens again at **1280×720**:

1. Home
2. Audio setup: input, tuner, monitoring, guitar and keyboard calibration, visual calibration, summary
3. Library: search, no-match state, ClassTab card (not downloaded)
4. Song page
5. *Open Strings & First Frets* and *Pentatonic Box Lick*, played with real key presses: hits,
   Shift+key wrong notes, skipped notes, early and late presses
6. Pause and resume
7. Practice drawer: loop from the song page, speed trainer over 4 passes
8. Results
9. ASCII paste → snap/tap → save → song page
10. Add files (.gp and .musicxml)
11. Backing-audio attach (WAV)
12. Settings: all tabs and key rebinding
13. Export, then import (merge) into a fresh browser profile
14. Keyboard navigation of the menus
15. A run without `?e2e=1`: Automatic input with the fake mic, normal motion, Drop D start card

`?e2e=1` forces keyboard input and reduced motion (`src/game/session/index.ts:184`,
`src/ui/shell/index.ts:107`). Animations and the guitar start card were therefore checked separately.
Screenshots (about 120) are in the session scratchpad `r3ux/` and are referenced by file name. They are
not committed.

## Summary

Riffway is a polished, coherent product. The R2 highway fixes all hold:
- The outcome text sits in the gutter on the judged lane.
- Outcomes have their own palette (white / cyan / mint / magenta ✕ / grey ring).
- **EARLY ▸ / ◂ LATE** have their own colours.
- The nav hides during play.
- Pause is a labelled button.
- The hand-position cue band and pill appear ≈1.5 s ahead (measured: bracket 424 px at 320 px/s plus gem
  offset).

Playing feels good. Flame rings grow ×1→×4, PERFECT/GREAT text is crisp, the loop countdown is big,
"Clean run! +5% → 80%" toasts appear, and the speed trainer stepped 70→75→80% on clean passes exactly
as described. Setup is a clear 4-step wizard. The results screen has an above-the-fold action row.
Export → import (merge) into a fresh profile restored section progress. Every DoD bullet that the UI can
show can be reached by a new user without docs.

No high-severity problems. The medium findings:
1. In practice loops, the **HUD names the wrong section**.
2. The **Home checklist marks "Tune up" and "Calibrate latency" done** after only opening the tuner and
   calibrating the keyboard. This contradicts the Audio setup summary ("Guitar not calibrated"), which
   R2-U-09 had fixed.
3. **`docs/README.md` still says "State: planned, not yet implemented"**, which breaks the "docs are
   current" DoD line.

Everything else is low-severity polish: copy, small layout clipping with the practice drawer open,
accessibility names, and spelling.

| Severity | Count |
|---|---|
| High | 0 |
| Medium | 3 |
| Low | 21 |
| **Total** | **24** |

## Definition of done: checked from the UI

| DoD bullet | Works from UI? | Evidence | Notes |
|---|---|---|---|
| Select USB guitar input, tune, calibrate latency | **Yes** (fake device) | 1440-02-setup-1-input, 1440-03-setup-2-tune, 1440-05-cal-guitar-done, 1440-05-cal-kbd-done, 1440-05-setup-summary, 1440-21-visual-cal | The device, channel and output lists, meter and "Listening" status all work. The tuner reads the fake tone. The guitar calibration ran 16 clicks and correctly refused the fake beeps ("Timing too uneven ±166.7 ms, not saved"). Keyboard calibration saved +13 ms "Very consistent". The selection survives a reload. A real Cubilux and a real pluck still need the owner's manual checklist §2–7. See R3-U-02 (Home overstates done). |
| Hear guitar through the app with an amp sim at acceptable latency | **UI yes; ears unverified** | 1440-03-setup-3-monitor-full, 1440-04-monitor-on | The headphone check gates monitoring ("I'm wearing headphones — turn it on"). Presets are Clean / Crunch / Overdrive / DI with Drive, Bass, Mid, Treble and Level. The delay shows "≈ 25 ms ESTIMATED" with an input/processing/output breakdown. It is an estimate, not a measurement (R2-S-10, accepted). Audible latency is for the owner (§6). |
| Search local library, ClassTab and Songsterr from one search box; import and play results | **Partial (by design)** | 1440-06-library-search-greensleeves-full, 1440-06-library-search-nomatch-full, 1440-22-addfiles | Local and starter search is instant, with filters and sort. ClassTab is a clear, low-key card ("Download ClassTab (≈14 MB, classical/fingerstyle)"); it was not downloaded per the brief, so ClassTab results were not seen. Songsterr is a link-out with "Already in your library: Greensleeves" (deviation D1, owner decision still open: R2-S-01). Add files imported a .gp and a .musicxml ("Added 2 files…"), and both were searchable and playable. |
| Import GP / MusicXML or paste ASCII and play as a horizontal game with live scoring that tells wrong notes from timing errors | **Yes** | 1440-15-import-pasted-full, 1440-15-import-tap-full, 1440-15-import-saved-song-full, 1440-22-capo-startcard, 1440-09-game-wrong, 1440-09-game-miss, 1440-09-game-late, 1440-11-results-full | The paste showed "What Riffway read" (4 bars, 28 notes, sections Intro/Riff), snap to grid (Auto 1/8) and a preview strip, then saved as "Rhythm aligned" and played. WRONG NOTE "1 fret high" is magenta with ✕, MISS is grey with a hollow ring, early/late are labelled. Results tiles: Perfect / Great / Good / Wrong / Miss, plus a timing histogram with a tendency ("You tend to play early — about 46 ms"). |
| Attach an audio file I own and play along in sync | **UI yes; sync unverified** | 1440-18-backing-click, 1440-18-backing-attached-full, backing-crop | A WAV attached in two clicks. The waveform shows bar/beat lines, offset ±1/10 ms, Tap along (with Apply), Play check at 100/85/70%, "Mute guide while backing plays" and the level. Sync by ear is for the owner (§10). |
| Starter library with difficulty ratings | **Yes** | 1440-06-library-full, 1440-07-song-pentatonic-full | 14 starter items rated 1.3–5.2 with tier names. The song page explains each rating ("Why it's a 4.6", per section). |
| Speed control and A/B looping work | **Yes** | 1440-14-loop-start, 1440-14-loop-pass2, 1440-14-drawer-after, 1280-14-loop-pass1 | "Loop this" opens practice at 70% looping Bend Lick (bars 5–8, 1-bar pre-roll with a "LOOP" countdown). The trainer stepped +5% per clean pass. A wrong-note pass registered "1 run under 70% · one more steps down 5%". There are a bar strip, A/B nudge, section chips and presets. See R3-U-01 (HUD section name) and R3-U-04 (chord pill clip). |
| Songs, progress and settings persist; progress export/import | **Yes** | 1440-17-settings-data-full, 1440-17-export-toast, 1440-17-import-preview-full, 1440-17-home-after-import | Export downloaded `riffway-backup-2026-11-19.json` (23.8 KB). In a fresh profile, Choose backup file… showed a preview (counts, merge/replace) and **Merge into my data** worked: the song page then showed "Bend Lick — Practising · Trainer at 80% · 2 clean runs", and Home showed "Continue where you left off". Settings, calibration and devices persisted across reloads. |
| Tests pass, reviews complete, docs current, merged to main | **No (pending)** | `docs/README.md:7`, `git branch` | Not checked here: test runs (other R3 reviewers). Reviews: R3 is in progress. Docs: README is stale (R3-U-03), and a few checklist labels drift (R3-U-20, R3-U-26). Branch: `claude/gifted-wozniak-40otll` is not merged (T-099). |

## R2 fixes spot-checked

These R2 findings were verified as fixed in the running app:

| R2 IDs | What was checked |
|---|---|
| R2-U-01, R2-U-02 | Gutter outcome text; outcome palette |
| R2-U-03 | Cue lead about 1.5 s |
| R2-U-04 | Nav hidden while playing |
| R2-U-05 | Chord hint in the bottom strip (play mode) |
| R2-U-06 | Drop D legend "e B G D A D" and the tune-down notice |
| R2-U-07 | Badge and reason agree |
| R2-U-08 | Section bar coloured by progress |
| R2-U-10 | Monitoring off until its step |
| R2-U-12 | ClassTab card |
| R2-U-13 | No Songsterr badge |
| R2-U-14 | Labelled Pause |
| R2-U-15 | 3 focus cards with section names |
| R2-U-16 | "—" until 5 notes |
| R2-U-20 | Drawer "Practice tools"; Count-in "Off" in Settings |
| R2-U-22 | Results action row above the fold at 1280×720 |
| R2-U-23 | Filters collapsed at 720 px; Sort control |
| R2-U-24 | Artist de-duplicated; Techniques/Style split |
| R2-U-26 | GP/MusicXML pointer on Import |
| R2-U-27 | Calibration wording |
| R2-U-28 | Nav key hints only on nav focus |
| R2-U-30 | 404 page "This song isn't in your library" + Rescan |
| R2-S-06 | Typed title used |
| R2-S-07 | learning.md says Deferred (DEC-23) |
| R2-S-08 | ultimate-guitar.md: sidecar location corrected, no popover |

Two did not fully hold:
- **R2-U-09:** fixed in the Audio setup summary, but the Home checklist still marks calibration done
  (R3-U-02).
- **R2-U-29:** still deferred (R3-U-21).

## Findings

| ID | Severity | Screen | Finding | Evidence (screenshot) | Suggested fix | Status |
|---|---|---|---|---|---|---|
| R3-U-01 | medium | Game HUD (practice loop) | While looping **Bend Lick**, the HUD subtitle says **"PRACTICE · Box Run"** on the start card and through every loop pass and the pause. Meanwhile the highway's section label, the loop chip, the drawer ("Looping Bend Lick") and the bottom section bar all say Bend Lick. The player reads the wrong section at a glance. | 1440-14-loop-start, 1440-14-loop-pass2, 1440-14-drawer-after, 1280-14-loop-pass1 | Derive the HUD section from the section at the playhead, the loop start during pre-roll, or the loop's section name ("Loop · Bend Lick"). Add a test for a `section=` start. | **Fixed** (T-122): before A (start card, pre-roll, a pause there) the HUD names the loop's section, like the highway pill and the drawer (`hudSection`, tested). |
| R3-U-02 | medium | Home (first-run checklist) | After the user only **opened** the tuner (nothing was in tune) and calibrated the **keyboard only**, Home shows 3/4 with "Tune up (done)" and "Calibrate latency (done) — Timing offsets are set". In the same state the Audio setup summary says "Almost set up · Guitar not calibrated · keyboard +13 ms" (amber), and the rail shows Tune as "Every session" (not done). R2-U-09's rule was fixed in one place only. | 1440-06-home-after-setup vs 1440-05-setup-summary, 1440-05-cal-kbd-done | Use the summary's completion logic for the Home checklist: calibration is done only for the input games use; tuning is done only after an in-tune reading or "I'm tuned". | **Fixed** (T-122): Home uses the audio setup's rules. Calibration counts only for the input games use. Tuning counts only after an in-tune reading or **I'm tuned**. |
| R3-U-03 | medium | Docs | `docs/README.md` says **"State: planned, not yet implemented"**. The app is built, R1/R2 are done and R3 is running. The index also says the checklist is "added in T-041" and that reviews are "added as they happen", which reads as future tense. The DoD line "docs are current" fails on the first doc a reader opens. | `docs/README.md:7`, `:27–28` | State what exists now: "Built; in final review (R3)". Give the run command and the review index. Link `manual-test-checklist.md` and `reviews/` as present docs. | Not T-122: orchestrator (T-099, `docs/README.md`). |
| R3-U-04 | low | Game (practice drawer open) | With the drawer open, the "Chords: judged on timing + any chord tone" pill wraps to two lines in the bottom strip. Its second line is clipped by the strip edge at both viewports. At 1440×900 the next pass's loop marker ("B" top right, "A" bottom right) is cut at the highway's right edge. | 1440-14-loop-pass2, 1440-14-drawer-after, 1280-14-loop-pass1 | Size the strip to the pill. Shorten it to "Chords: timing + any tone" (with a tooltip) when narrow. Keep loop markers inside the clip rect or hide them when they are off-screen. | **Fixed** (T-122): a short one-line note ("Chords: timing + any tone", full text in the tooltip) when the gutter is narrow. The A/B flags are drawn only when they fit on screen. |
| R3-U-05 | low | Game (practice toast) | The "Clean run at 100%!" toast sits on the top strip over the upcoming section label (a cut "E…" from the next "BEND LICK" is visible behind it). The section strip is something the player reads. | 1280-14-loop-pass1, 1440-14-loop-pass2 | Anchor the toast in the gutter or under the HUD, not on the section/bar strip. | **Fixed** (T-122): coach lines now sit in the HUD's meta row after the section name, off the highway. |
| R3-U-06 | low | Game start card (capo / retune) | *Capo Two* (song page: "Capo 2") starts with no capo reminder on the start card. *Drop D* gets "Drop D — tune string 6 down to D". The song page's "Retune to Standard — your last song was in Drop D" also never reaches the start card, which is where a player who goes straight to Play looks. | 1440-22-capo-startcard, 1440-22-capo-song, 1440-19-real-dropd-startcard | Add a "Capo 2" line and the retune reminder to the start card, using the same component as the Drop D notice. | **Fixed** (T-122): the start card shows "Capo 2 — put your capo on fret 2" and "Retune to Standard — your last song was in Drop D" in the same reminder style. |
| R3-U-07 | low | Home (This week card) | The card heading says **THIS WEEK**, but the ring reads "0 of 15 min", which is the **daily** goal (Settings › Daily goal). Beside it: "Even 5 minutes makes today a practice day" and "Practise 4 days this week (5 minutes each)". That is three numbers with no clear relationship. Day dots read "Friday: ahead" to screen readers. | 1440-01-home-firstrun, 1440-20b-nav-arrows, 1440-17-settings-practice-goals-full | Label the ring "Today · 0 of 15 min", or show week minutes against a weekly goal. Say "Friday: upcoming". | **Fixed** (T-122): the card is "Practice time", the ring is labeled **Today**, and future dots read "Friday: upcoming". |
| R3-U-08 | low | Settings › Data | The stats say "Streak 1" while Home shows "WEEK STREAK 0". The Data number counts stored streak records, not the streak. | 1440-17-settings-data-full vs 1440-20b-nav-arrows | Rename the stat ("Streak records") or show the week streak value. | **Fixed** (T-122): the row is "Streak history: Saved / None", not a count that looks like a streak length. |
| R3-U-09 | low | Song page (a11y) | The four section "Loop this" links have identical accessible names, so a screen-reader link list shows "Loop this ×4". The same applies to the Results "Loop this". | `main` link list on `#/song/starter:pentatonic-box-lick` | `aria-label="Loop Bend Lick"` (visible text can stay). | **Fixed** (T-122): each section link is named "Loop Bend Lick" (or "Take the next-day check on …"). The duplicate Results "Loop this" is gone (R3-U-12). |
| R3-U-10 | low | Song page (sections) | Every unplayed row repeats "Not started · Loop it slowly first: the speed trainer starts you at 70%.", which is the same sentence four times. The legend directly above calls this state **New**, but the rows say "Not started". | 1440-07-song-pentatonic-full | Show the tip once under the heading and use one state name. | **Fixed** (T-122): rows use the legend's names (New / Practicing / …). The tip for new sections appears once under the map. |
| R3-U-11 | low | Song page (Source card) | The heading "Source" is followed by a row label "Source · Starter". | 1440-07-song-pentatonic-full | Rename the row "Library" or drop it. | **Fixed** (T-122): the row is now "Library · Starter". |
| R3-U-12 | low | Results | Three problems on the results screen. (1) The header badge says **CLEAN RUN** after 6 misses and a wrong note (91.5%), while Progress says "Open Strings: 87% — a clean run needs 90%+". (2) "Loop Open Strings" in the action row and "Loop this" under Sections are the same action twice. (3) The Notes card has a large empty area beside the taller Timing card. | 1440-11-results-full | Tooltip or subtitle "Clean run = 90%+ overall". Keep one loop button. Let the Notes card size to its content, or put the chord note there. | **Fixed** (T-122): the badge reads "Clean run · 90%+ overall" with a tooltip, and the section line says "this section needs 90%+ for a clean run". The loop action is in the action row only. A hit summary ("75 of 82 notes hit …") fills the Notes card. |
| R3-U-13 | low | Pause | While paused, the HUD button still reads "Pause Esc", and the pause card's legend says "Esc pause". The player does not know Esc resumes. | 1440-10-pause, 1280-p-10-pause | When paused, show "Resume Esc" on the HUD button and legend. | **Fixed** (T-122): while paused, the HUD button is **Resume Esc** and the pause card's legend says "Esc resume". |
| R3-U-14 | low | Audio setup › Tune | At 1440×900 the "Next: Monitoring" button sits below the fold. At 1280×720 the string buttons are cut off and Back/Next need a scroll. The tuner card is taller than necessary. | 1440-03-setup-2-tune, 1280-23-setup-tune | Reduce the tuner's height on short viewports, or make the step's footer sticky. | **Fixed** (T-122): Back / Next stay on screen in a sticky step footer. Below 760 px of height the tuner shows the readout beside a smaller gauge, so the strings fit at 1280×720. |
| R3-U-15 | low | Audio setup rail | Opening step 2 turns Tune green ("Checked this session") without any in-tune reading. After a reload it reverts to grey "Every session". The summary has no Tune row, so it is unclear what "A step needs attention" means for tuning. | 1440-03-setup-2-tune, 1440-05-setup-summary | Mark Tune done on an in-tune reading or "I'm tuned". Add a Tune row ("Tuned this session / Not yet") to the summary. | **Fixed** (T-122): Tune turns green only on an in-tune reading (tuner event) or **I'm tuned** on the step. It is kept for the tab session (survives a reload). The summary has a Tuning row (optional; never blocks "Ready to play"). |
| R3-U-16 | low | Audio setup › Latency › Visual | Step 1 says "watch the gems reach the line", step 2 says "If the **flash** comes before the click, press +5 ms". The two metaphors differ, and the sign is not explained. | 1440-21-visual-cal | Use one noun ("the gem hits the line") and add "+ = draw later". | **Fixed** (T-122): "watch each gem hit the line" / "If the gem hits the line before you hear the click, press +5 ms (+ draws the gems later)". |
| R3-U-17 | low | Library (rows) | Tag chips sometimes sit inline after the tuning and sometimes wrap under it (Bourrée, Für Elise, House of the Rising Sun). Rows have different heights and the columns look ragged, especially at 1280. | 1280-06-library, 1440-06-library-full | Give tags their own fixed column, truncated with "+n", or always place them on the second line. | **Fixed** (T-122): tags always sit on the second line of the column, at most 3 chips, then "+n" (its tooltip lists the rest). |
| R3-U-18 | low | Library (no match) | The no-match state for "lagrima" (a ClassTab classic) says "find the song on Songsterr or Ultimate Guitar below". The ClassTab card right below is not mentioned. | 1440-06-library-search-nomatch-full | When ClassTab is enabled and not downloaded, add "…or download ClassTab (classical/fingerstyle)". | **Fixed** (T-122): while the ClassTab card is offered, the text adds "…or download ClassTab below for classical and fingerstyle pieces". |
| R3-U-19 | low | Song page › Backing audio | Attaching takes two buttons ("Attach backing audio" opens a panel, then "Attach audio file"). The check-speed control reads "100 %" (with a space), unlike "100%" everywhere else. | 1440-18-backing-click, backing-crop | Open the file picker from the first button. Use "100%". | **Fixed** (T-122): with nothing attached, **Attach backing audio** opens the file picker at once, then opens the panel on the file. Check speeds and the tempo read "100%" / "98.8%". |
| R3-U-20 | low | Docs (manual checklist) | Most labels match the UI exactly. Two drift: §6.3 says "Move Drive / Tone / Level", but the amp has **Drive, Bass, Mid, Treble, Level** (no Tone); §10.1 implies one click to choose the file (see R3-U-19). | `docs/manual-test-checklist.md` §6.3, §10.1; 1440-03-setup-3-monitor-full | Update the wording. | **Fixed** (T-122): §6.3 lists Drive / Bass / Mid / Treble / Level. §10.1 matches the one-click attach. §4.1/4.5 match R3-U-02/15, and §12.5 says **Input mode** (R3-U-24). |
| R3-U-21 | low | Copy (spelling, R2-U-29 still open) | British and US spellings are mixed. **British:** "Practise 4 days this week", "practised" / "not practised" (Home day dots), "Continue practising", "Practising" (section state), "Favourite genres", "Recognisable tunes", "favour" (Settings › Practice & goals), "centred" ("Timing centred — no early or late tendency", results), "grey out" (Settings › Feedback), "licence" (Settings › Library & sources). **US:** the `recognizable` tag on 9 starter songs (`starter/manifest.json`, shown in Library and recommendations), "Quantize taps" (Import › Tap along). | `src/ui/screens/home/model.ts:451,460,529`, `home/view.ts:203,207`, `settings/gameplay.ts:16,46,234,243`, `settings/library.ts:334`, `game/session/results.ts:171`, `import/index.ts:551`, `starter/manifest.json` | Pick US English (Mac, en-US): Practice / practiced / Favorite / Recognizable / favor / centered / gray / license / Quantize. Keep tag ids as they are. | **Fixed** (T-122) for `src/ui`, the highway and the checklist (Practice/practiced, Favorite, Recognizable, favor, gray, license, labeled, canceled, judgments, analyzed, color). Tag ids are unchanged. **Open (outside T-122's files):** `src/game/session/results.ts` "Timing centred" and `progress.ts` "back to practising" (T-121 files), and `src/core/import/ascii/parse.ts` "is labelled". |
| R3-U-22 | low | Song page (difficulty) | For a two-section tab with equal ratings (My Pasted Riff: Intro 2.7, Riff 2.7), both rows get the **HARDEST** badge. | 1440-15-import-saved-song-full | Badge only a unique maximum, or say "All sections similar". | **Fixed** (T-122): **Hardest** marks only a unique top rating (to one decimal). Equal ratings show "All sections are about equally hard." |
| R3-U-23 | low | Game (feedback) | A press more than the Good window early (about 140 ms) shows nothing at the press. The note then shows **MISS**, so the player cannot tell "too early" from "didn't play". Within the window, EARLY/LATE work well. | 1440-09-game-early (no feedback after the early press), 1440-09-game-miss | Draw a faint "early" tick or ghost text on the lane for a stray press within about 250 ms before an unjudged note. | **Fixed** (T-122): a stray press up to 250 ms (real time) before an unjudged note shows a muted **TOO EARLY** and an early tick on that lane. If the note is then missed, it reads "MISS · pressed too early ▸". Hidden with Minimal feedback. |
| R3-U-24 | low | Settings / docs | "Input" is both a Settings tab (devices, calibration, key bindings) and a section inside Gameplay (Automatic / Guitar / Keyboard only). Checklist 12.5's path "Settings › Gameplay › Input" is correct, but a user looking under the **Input** tab will not find the mode there. | 1440-16-settings-full, 1440-17-settings-input-full | Rename the Gameplay section "Input mode", or move it to the Input tab. | **Fixed** (T-122): the Gameplay section is **Input mode**, and its text points to the Input tab for devices, calibration and keys. |

Also fixed in T-122 (orchestrator observation): the lane letters in the target wells were partly
hidden by the hit line. They now sit clear of its glow, with a dark halo, and the string lines start
at the well's edge.

### Notes on committed `e2e/screenshots/*.png`
All 10 match today's app: home, library-filters, import-alignment, audio-setup, tuner, calibration,
game-mid-song, practice-loop, results and settings. Nothing hides information.

- They are captured at **1280×800 @2x (2560×1600)**, not at the 1440×900 / 1280×720 sizes used in
  reviews.
- `practice-loop.png` shows a one-bar loop. There, the loop box on the section bar covers "First Frets"
  and the A marker sits under B in the drawer strip (cosmetic).
- `settings.png` shows **Detailed** feedback selected (set by the e2e run), not the default Standard. An
  owner comparing it with their own screen could be confused.

## What works best
1. **Game feel and readability.** The outcome channels are distinct from the lane colours. Early/late
   hits are labelled and read at a glance. The flame multiplier ring and the clean Rocksmith-style lanes
   with big fret gems and h/p/bend/PM glyphs match the profile. The nav disappears in play, and the
   1280×720 highway is roomy. (1440-09-game-wrong, 1440-12-cue-t26, 1280-p-09-game-later)
2. **Guided setup and practice loop.** The checklist leads into a 4-step wizard. Its calibration feedback
   is honest ("Timing too uneven… not saved"; "Very consistent"). "Loop this" opens practice at 70% with
   a 1-bar pre-roll countdown, and the trainer ladder visibly steps up.
3. **Data safety.** The backup preview shows counts and a recommended Merge, and a round trip into a
   fresh profile keeps progress.
