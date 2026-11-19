# Manual test checklist (owner)

Hands-on checks that the automated suites can't make: a real guitar, real ears, real latency.
Written for one setup: a **right-handed beginner–intermediate player** with a **Cubilux USB-C → ¼"
guitar cable** on a **Mac in Chrome**, **no amp**, listening on **headphones or speakers**.

Work top to bottom; later sections assume the earlier ones passed. Tick **Pass** or **Fail** for every
step and write what you saw next to a failure (the exact message, a number, a screenshot). About
60–90 minutes in total. Results go to the R3 review (`docs/reviews/R3.md`).

**Legend:** ☐ = tick one. "Expected" is what should happen; anything else is a Fail.

---

## 0 · Before you start

| # | Step | Expected | Result |
|---|---|---|---|
| 0.1 | Tune the guitar with a reference you trust (clip-on or phone tuner app); keep it at hand for § 4. | Reference reads all six open strings in tune. | ☐ Pass ☐ Fail |
| 0.2 | Plug the Cubilux cable into the Mac (USB-C) and the guitar (¼"). Turn the guitar's volume knob fully up, tone knob mid. Plug **wired** headphones into the Mac (Bluetooth adds 150 ms or more of delay). | macOS › System Settings › Sound › Input lists the cable (name like "USB Audio Device" or "Cubilux…"). | ☐ Pass ☐ Fail |
| 0.3 | In Terminal, in the repository: `npm install`, then `npx playwright install chromium` (first time only). | Both finish without errors. | ☐ Pass ☐ Fail |
| 0.4 | Run `npm run build`, then `npm start`. | Terminal shows the server listening on `http://127.0.0.1:5174`. Leave it running. | ☐ Pass ☐ Fail |
| 0.5 | Open **Chrome** at `http://127.0.0.1:5174`. If you used Riffway before and want a true first run, open a new Chrome profile (or Settings › Data › *Delete all data…* first). | "Welcome to Riffway" with a "Four steps to your first song" checklist at 0/4. | ☐ Pass ☐ Fail |

## 1 · Automated suites (5 minutes, no guitar)

| # | Step | Expected | Result |
|---|---|---|---|
| 1.1 | Stop `npm start` (Ctrl-C) for this section. Run `npm run test:e2e`. | Builds, then every spec passes (about 2 minutes). It uses its own temp data and library, never your `~/.riffway` or `~/Music/Tabs`. | ☐ Pass ☐ Fail |
| 1.2 | Open `e2e/screenshots/` and look at each PNG (home, library + filters, import/alignment, audio setup, tuner, calibration, game mid-song, practice loop, results, settings). | They show today's app; nothing cut off or overlapping in a way that hides information. Note anything that looks wrong. | ☐ Pass ☐ Fail |
| 1.3 | Run `npm run test:e2e:input`. | The fake-microphone input/tuner tests pass (in-tune A2, flat D2 in Drop D). Screenshots land in `test-results/input-e2e/`. | ☐ Pass ☐ Fail |
| 1.4 | Start the app again: `npm start`, reload the Chrome tab. | App loads as in 0.5. | ☐ Pass ☐ Fail |

## 2 · First-run setup and input selection

| # | Step | Expected | Result |
|---|---|---|---|
| 2.1 | On Home, click **Choose input** (checklist step 1). | Audio setup opens at step 1 "Connect your guitar". Chrome asks for microphone access. | ☐ Pass ☐ Fail |
| 2.2 | Click **Allow** in Chrome's prompt. (If you clicked Block: Chrome address bar › site settings › Microphone › Allow, and macOS › Privacy & Security › Microphone › Chrome on.) | Status "Listening". | ☐ Pass ☐ Fail |
| 2.3 | In **Input device**, pick the Cubilux cable (not "MacBook … Microphone"). | The device is selected; no "built-in microphone" note; the details line shows its sample rate (44.1 or 48 kHz) and channels. No warning about echo cancellation / noise suppression / auto gain. | ☐ Pass ☐ Fail |
| 2.4 | If **Input channel** is shown, keep **Channel 1**. Strum: if the meter doesn't move, try Channel 2 and keep the one that moves. | The meter moves with the guitar on the chosen channel only. | ☐ Pass ☐ Fail |
| 2.5 | In **Output device**, pick your headphones (or "System default" if they are the default). | Selected. | ☐ Pass ☐ Fail |
| 2.6 | Reload the page (⌘R) and come back to Audio setup. | The same input, channel and output are still selected and the meter starts without asking again. The rail shows "Input & level" done. | ☐ Pass ☐ Fail |
| 2.7 | Unplug the cable for 5 s, then plug it back in. | A clear "disconnected" state while unplugged; after replugging, the input comes back (automatically or with one click) and the meter moves again. | ☐ Pass ☐ Fail |

## 3 · Levels

| # | Step | Expected | Result |
|---|---|---|---|
| 3.1 | Guitar volume fully up. Strum all six strings hard with a pick. | Peaks land roughly between −18 and −6 dB; the readout follows the strum and falls back as it decays. | ☐ Pass ☐ Fail |
| 3.2 | Pick a single open high-e softly. | The meter still clearly moves (above about −40 dB). | ☐ Pass ☐ Fail |
| 3.3 | Strum as hard as you can, bridge pickup if you have one. | The **CLIP** light only lights on the hardest hits, if at all. If it clips constantly, note the peak value. | ☐ Pass ☐ Fail |
| 3.4 | Hands off the strings, guitar still plugged in. | The meter sits low (below about −50 dB); no constant hum reading. | ☐ Pass ☐ Fail |

## 4 · Tuner vs reference

Go to **Audio setup › Tune** (or the "Open tuner" link on Home).

| # | Step | Expected | Result |
|---|---|---|---|
| 4.1 | Play each open string (6 → 1), one at a time, let it ring. | Note names E2, A2, D3, G3, B3, E4; the string's row is highlighted; needle in the green; the cents readout within ±3 ¢ of what your reference tuner says. After the first string reads in tune, the rail's **Tune** step turns green: "Tuned this session". | ☐ Pass ☐ Fail |
| 4.2 | Detune the low E a little flat with the tuning peg. | Needle moves left / flat, cents negative, the hint says to tune up; your reference agrees within ±3 ¢. Tune back. | ☐ Pass ☐ Fail |
| 4.3 | Detune the G string a little sharp. | Needle right / sharp, cents positive, hint says tune down. Tune back. | ☐ Pass ☐ Fail |
| 4.4 | Play the open low E very softly and let it decay to silence. | The reading stays steady while the note rings, then goes idle; no jumping to an octave (E3/E1) as it fades. | ☐ Pass ☐ Fail |
| 4.5 | Back on Home, look at the checklist. | Step 2 "Tune up" shows done (the tuner read a string in tune). Opening the tuner without an in-tune reading does not tick it; **I'm tuned** does. | ☐ Pass ☐ Fail |

## 5 · Single notes on every string, frets 0–12 (pitch detection)

Stay on the tuner. Pick each note cleanly and let it ring for a second. The tuner should name
exactly these notes (sharps may show as ♯; G-string fret 3 is A♯3 = B♭3):

| String | Fret 0 | Fret 3 | Fret 5 | Fret 7 | Fret 12 | Result |
|---|---|---|---|---|---|---|
| 6 (low E) | E2 | G2 | A2 | B2 | E3 | ☐ Pass ☐ Fail |
| 5 (A) | A2 | C3 | D3 | E3 | A3 | ☐ Pass ☐ Fail |
| 4 (D) | D3 | F3 | G3 | A3 | D4 | ☐ Pass ☐ Fail |
| 3 (G) | G3 | A♯3 | C4 | D4 | G4 | ☐ Pass ☐ Fail |
| 2 (B) | B3 | D4 | E4 | F♯4 | B4 | ☐ Pass ☐ Fail |
| 1 (high e) | E4 | G4 | A4 | B4 | E5 | ☐ Pass ☐ Fail |

| # | Step | Expected | Result |
|---|---|---|---|
| 5.1 | Note any cell where the tuner showed the right name but the wrong octave (e.g. E2 read as E3). | None. Octave slips are the most likely failure: write down which string/fret. | ☐ Pass ☐ Fail |
| 5.2 | In the game: Library › **Open Strings & First Frets** › **Play** (100%). Play it through with the guitar. | Notes you play cleanly are judged Perfect/Great/Good (not Wrong); results accuracy ≥ 80% if you played it well. The start card says "Guitar: <your cable> — keys work too". | ☐ Pass ☐ Fail |
| 5.3 | Play it again and deliberately play a few notes one fret too high. | Those notes show **Wrong** (with "played …" on Detailed feedback) and count as Wrong on the results, not as hits. | ☐ Pass ☐ Fail |

## 6 · Monitoring: latency feel and the headphone / speaker guard

Go to **Audio setup › Monitoring**.

| # | Step | Expected | Result |
|---|---|---|---|
| 6.1 | With headphones on, turn on **Hear my guitar** (if off) and play. | You hear the guitar through the amp sim; the panel shows "≈ N ms (estimated)". Write N: ____ ms. | ☐ Pass ☐ Fail |
| 6.2 | Play fast 16th notes on one string for 10 seconds. | Feels immediate or only slightly behind (like standing a few metres from an amp). Not a slap-back echo. Rate it: ☐ can't tell ☐ slight ☐ distracting. | ☐ Pass ☐ Fail |
| 6.3 | Switch through the presets (Clean, Crunch, …) while playing. Move Drive / Bass / Mid / Treble / Level. | Changes are smooth, no clicks or dropouts; Crunch/Overdrive distort as expected; the noise gate keeps silence quiet between notes. | ☐ Pass ☐ Fail |
| 6.4 | Take the headphones off and choose the Mac's **built-in speakers** as output (Audio setup step 1 › Output device, or macOS Sound output). | Monitoring mutes itself with "Monitoring is off on laptop speakers" and offers **Turn on anyway**. | ☐ Pass ☐ Fail |
| 6.5 | Click **Turn on anyway**, play quietly, then switch back to headphones. | Monitoring plays on the speakers only after you allowed it; back on headphones it plays normally. | ☐ Pass ☐ Fail |
| 6.6 | (External speakers only.) Choose them as output, monitoring on, play at moderate volume. | Works; no howl. If a feedback tone ever builds up, the guard ducks the output and shows "Feedback detected". | ☐ Pass ☐ Fail |

## 7 · Latency calibration: repeatability

Headphones on, same output you play with. **Audio setup › Latency › Guitar** tab.

| # | Step | Expected | Result |
|---|---|---|---|
| 7.1 | Click **Start**. After the four count-in clicks, pick the open low E once on each of the next 16 clicks, as close to the click as you can. | The run finishes with an offset, a consistency label ("very consistent" / "consistent") and "saved". Run 1 offset: ____ ms. | ☐ Pass ☐ Fail |
| 7.2 | Run it a second time. | Run 2: ____ ms. | ☐ Pass ☐ Fail |
| 7.3 | Run it a third time. | Run 3: ____ ms. **All three within ±5 ms of their middle value** (e.g. 72, 75, 79 passes; 70, 75, 84 fails). | ☐ Pass ☐ Fail |
| 7.4 | Run once more and deliberately play late on every click. | Either a clearly larger offset or an "a bit uneven"/"inconsistent" result; Undo puts the previous value back. Use Undo. | ☐ Pass ☐ Fail |
| 7.5 | **Keyboard** tab: tap Space on 16 clicks. | A keyboard offset is saved (its own row in "Current calibration"). | ☐ Pass ☐ Fail |
| 7.6 | **Visual** tab: nudge until the scrolling note crosses the line exactly on the click. | Saved visual offset; with it, notes look in time with the guide in the game. | ☐ Pass ☐ Fail |
| 7.7 | Play **Open Strings & First Frets** with the guitar again and open the results' **Timing** card. | The histogram is centered (the tendency says centered or only slightly early/late), not shifted by tens of ms. | ☐ Pass ☐ Fail |
| 7.8 | Switch the output to another device (e.g. built-in speakers with "Turn on anyway"), back to Latency. | A note says these offsets were measured with another input/output; switching back to the headphones restores your calibrated values. | ☐ Pass ☐ Fail |

## 8 · Legato (hammer-ons and pull-offs)

Library › **Pentatonic Box Lick** › **Practice**. In the practice drawer: loop **Box Run**, speed 70%.

| # | Step | Expected | Result |
|---|---|---|---|
| 8.1 | Play the Box Run as written: pick the first note of each pair, **hammer on** the second (don't pick it). | Hammered notes are judged as hits (Perfect/Great/Good), not Miss. Arcs marked "h" on the highway match what you play. | ☐ Pass ☐ Fail |
| 8.2 | Loop **Bend Lick** and play its pull-offs ("p") and bends. | Pull-off targets count as hits; a full bend reaching pitch counts as a hit (bends are the weakest spot of pitch tracking: note what happens). | ☐ Pass ☐ Fail |
| 8.3 | Let the speed trainer run: play the loop cleanly twice. | After a clean pass (≥ 90%) the trainer steps the speed up 5%. | ☐ Pass ☐ Fail |

## 9 · Chord leniency

Library › **Power Chord Drive** › **Play**.

| # | Step | Expected | Result |
|---|---|---|---|
| 9.1 | Play the power chords cleanly in time. | Chords are judged on timing (any chord tone counts); the highway/HUD shows the note about lenient chord judging. | ☐ Pass ☐ Fail |
| 9.2 | On a few chords, hit only one of the strings (still in time). | Those still count as hits (leniency). | ☐ Pass ☐ Fail |
| 9.3 | Results › **Notes**. | A line like "N chord notes judged leniently (timing + any chord tone)". | ☐ Pass ☐ Fail |

## 10 · Backing-audio sync

You need a recording you own of a song in your library. If you have none: with QuickTime Player ›
New Audio Recording, record yourself playing **Open Strings & First Frets** along with the game's
guide at 100% (headphones on the Mac, guitar via the cable), save it as `.m4a`.

| # | Step | Expected | Result |
|---|---|---|---|
| 10.1 | Song page › **Backing audio** › **Attach backing audio** (the file picker opens straight away), choose the file. | The panel shows the waveform and an alignment step. | ☐ Pass ☐ Fail |
| 10.2 | Align it (tap along or offset) and **Apply**. Play the song at 100%. | Backing audio and highway/guide agree within what you can hear (no audible flam between the guide and the recording). | ☐ Pass ☐ Fail |
| 10.3 | Practice mode at 70% with a loop. | The recording slows down without changing pitch, stays in sync through two loop wraps. | ☐ Pass ☐ Fail |
| 10.4 | Mixer: mute/unmute the guide and the backing track. | Each mute does exactly what it says; with "Mute the guide while backing audio plays" on, the guide is silent while backing plays. | ☐ Pass ☐ Fail |

## 11 · Link-outs land on search results (human check)

The app never contacts these sites itself; only you, by clicking.

| # | Step | Expected | Result |
|---|---|---|---|
| 11.1 | Library › search **Greensleeves** › **Search on Songsterr**. | A **new tab** opens on Songsterr's search results for "Greensleeves". The Riffway tab stays where it was. The Songsterr row also said "Already in your library: Greensleeves". | ☐ Pass ☐ Fail |
| 11.2 | Back in Riffway › **Search on Ultimate Guitar**. | New tab with UG's title search results for "Greensleeves". | ☐ Pass ☐ Fail |
| 11.3 | **Get the free Guitar Pro pack** (if shown). | New tab on guitar-pro.com's free tabs page. | ☐ Pass ☐ Fail |
| 11.4 | Import screen › **Search on Ultimate Guitar**. | New tab with UG search; copy a tab you like, paste it into **Tab text**, give it a title and save (personal practice only). It opens as a playable song. | ☐ Pass ☐ Fail |

## 12 · Data and everyday flow

| # | Step | Expected | Result |
|---|---|---|---|
| 12.1 | Quit Chrome completely and reopen `http://127.0.0.1:5174`. | Home shows your practice today, streak progress and recommendations; Audio setup keeps your devices and calibration. | ☐ Pass ☐ Fail |
| 12.2 | Settings › Data › **Export backup**. | A `riffway-backup-YYYY-MM-DD.json` lands in Downloads; a toast confirms it. | ☐ Pass ☐ Fail |
| 12.3 | Same page › **Choose backup file…**, pick that file with the **macOS file picker**, then **Merge into my data**. | Preview shows your counts; merging changes nothing (same data). The automated test feeds the file in directly, so this native-picker step matters. | ☐ Pass ☐ Fail |
| 12.4 | Drag a Guitar Pro file from Finder onto the Library window. | "Drop to add to your library" overlay, then "Added 1 file…"; the song appears in the list and plays. | ☐ Pass ☐ Fail |
| 12.5 | Play any song with the keyboard only (Settings › Gameplay › **Input mode** › Keyboard only; set it back to Automatic afterwards): keys 1–6, Shift + key. | Keys hit the right strings (1 = high e); Shift + key gives Wrong. | ☐ Pass ☐ Fail |

---

**Sign-off:** date ______ · Chrome version ______ · macOS version ______ · failures (step numbers) ______
