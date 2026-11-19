# Song formats

## Summary
- Every importer outputs one model, `Song` (`shared/song.ts`): notes with absolute times in seconds
  at 100% speed, **string 1 = high e**, fret, MIDI pitch, duration, technique flags, chord groups,
  tempo map + bar/beat grid, sections, tuning, capo, tags and a source ref.
- **alphaTab 1.9.0** imports Guitar Pro (`.gp`, `.gpx`, `.gp3–5`), MusicXML (`.musicxml`, `.xml`,
  `.mxl`) and alphaTex (`.atex`, the starter-library format). Its string numbering is flipped.
- **ASCII tab** (paste, `.txt`/`.tab`, ClassTab) uses our parser. Rhythm precedence: a saved alignment
  (sidecar) > a paired MIDI > a beat ruler > proportional column spacing ("needs rhythm alignment",
  fixed in the alignment UI).

## Internal model (abridged; `shared/song.ts` is authoritative)
```ts
interface Song {
  schema: 1; id: string; arrangement: number;           // (songId, trackIndex)
  meta: SongInfo;  // { title; artist?; composer?; arranger?; source: SourceRef; tags: SongTags;
                   //   tuning: number[] /* MIDI, [0] = string 1 = high e */; capo; durationSec;
                   //   rhythm: RhythmStatus; tempoEstimated?; tracks: TrackInfo[] /* all tracks */ }
  timing: { tempos: { time: number; bpm: number }[];
            bars: { index: number; sourceIndex?: number; time: number; dur: number; num: number; den: number;
                    beats: number[] /* absolute beat times */ }[] };
  sections: { name: string; startBar: number; endBar: number /* exclusive */; start: number; end: number }[];
  notes: Note[];                                         // sorted by time, then string
  chords: { id: number; time: number; noteIds: number[]; name?: string }[];
  diagnostics?: ImportDiagnostic[];                      // unparsed lines, clipped bars, …
}
interface Note { id: number; time: number; dur: number; string: 1|2|3|4|5|6; fret: number;
  midi: number; bar: number; chordId?: number; tiedFrom?: number; column?: number /* ASCII */; tech: Tech }
interface Tech { hammerOn?: true; pullOff?: true; legatoDest?: true;
  slide?: 'in-below'|'in-above'|'out-up'|'out-down'|'shift'|'legato';
  bend?: { semitones: number; release?: boolean }; palmMute?: true; letRing?: true;
  vibrato?: true; harmonic?: 'natural'|'artificial'|'pinch'|'tap'|'semi'|'feedback'; dead?: true; ghost?: true }
type RhythmStatus = 'exact' | 'midi' | 'ruler' | 'aligned' | 'needs-alignment';
type SongTags = { style: ('pick'|'fingerstyle')[]; genre: string[]; skills: string[] };
type SourceRef = { source: SourceId; path?: string; url?: string; origin?: string };
// SourceId = 'local'|'starter'|'classtab'|'songsterr'|'ultimate-guitar'|'gp-pack'
// loadSong(bundle: SongBundle, {arrangement?, id?, version?}) → Song; errors are ImportError (src/core/import/errors.ts)
//   arrangement: track index (default: first playable); id: stamped on the Song (else bundle.id);
//   version: 1-based version of a multi-version ASCII tab (default 1; other formats ignore it)
```
Invariants (validated by `validateSong`, `src/core/model/validate.ts`; issue codes in brackets): ids equal
indexes [`id-order`]; notes sorted by time, then string [`time-order`]; `midi = tuning[string−1] + capo + fret`
except harmonics [`midi-invariant`]; no two non-tied notes on one string at one time [`string-collision`];
bars indexed in played order, contiguous from 0 s, beats inside their bar starting on the downbeat [`bar-gap`];
sections cover whole bars, in order, without overlap [`section-bars`]; `note.bar` contains the onset
[`note-bar`]; chord ↔ note references agree [`chord-ref`]; `tiedFrom` names an earlier note on the same
string [`tie-ref`]. Tied destinations keep `tiedFrom` and are not judge targets.
When a source has no sections, auto-sections of 8 bars are named "Part 1…n" (`autoSections`).

**Helpers** (`src/core/model/`): `notesInRange(song, from, to)` (binary search, `[start, end)` indexes),
`barAt`, `sectionAt` (clamped; −1 without sections), `beatTimes` (flattened beat grid, for the metronome),
`autoSections`, `validateSong`, `describeTuning` (`standard`, `drop-d`, `eb-standard`, `d-standard`,
`drop-c-sharp`, `drop-c`, `double-drop-d`, `dadgad`, `open-g`, `open-d`, `open-e`, else `custom` labelled
low → high, e.g. `D# A D G B E`), `onsetGroups`, `midiToName`.

## alphaTab import (`src/core/import/alphatab/`)
Uses `importer.ScoreLoader.loadScoreFromBytes` (binary/MusicXML), `importer.AlphaTexImporter` (`.atex`) and
`midi.MidiFileGenerator` (verified recipe in [research/libraries.md](research/libraries.md#verified-alphatab-node-api));
the player is never used.
| alphaTab | Song |
|---|---|
| `gen.tickLookup.masterBars` (played order, repeats/voltas/jumps expanded) | `timing.bars` (`sourceIndex` = written bar), note times |
| `masterBars[].tempoChanges` → tick→seconds | `timing.tempos` (first at 0 s, duplicates dropped) |
| time signature + played bar length | `bar.num/den`, `bar.beats` (one beat per `1/den` note; a pickup keeps only the beats it has) |
| `masterBar.section.text` (else `.marker`), per played pass | `sections` (a repeated section appears once per pass; bars before the first marker form "Start") |
| `staff.tuning` (high → low) | `meta.tuning` (already high-first) |
| `note.string` (**1 = lowest**) | `string = tuning.length − n.string + 1` |
| `note.fret`, `staff.capo` | `fret`; `midi = tuning + capo + fret` (golden-tested equal to `realValue` incl. capo) |
| harmonics | `midi` = harmonic pitch (`realValue − realValueWithoutHarmonic` added; natural 12th = +12, 7th = +19) |
| `isHammerPullOrigin` / destination | `hammerOn` (destination fret ≥ origin) or `pullOff` / `legatoDest` |
| `slideOutType` (else `slideInType`) | `slide` (pick slides map to `out-up`/`out-down`); a legato slide's target gets `legatoDest` |
| `bendPoints` (quarter-tones) | `bend.semitones = max / 2`; `release` when the curve ends below its peak (golden-tested) |
| `isPalmMute`, `isLetRing`, `vibrato`, `harmonicType`, `isDead`, `isGhost`, `isTieDestination` | flags / `tiedFrom` |
| notes sharing a beat (≥ 2, ties excluded), `beat.chord?.name` | `chords` |
| `staff.capo`, `score.title/artist/music` | meta (`title` falls back to the file name; MusicXML composer credits arrive as `artist`) |
Note onset = `masterBar.start + beat.playbackStart` ticks (simile bars play the bar they repeat; triplet
feel is not applied). Text fields are whitespace-normalised (alphaTab's MusicXML importer emits U+00A0).

**Tracks** (`listTracks` / `alphaTabTracks`): drums (percussion or channel 10), bass (program 33–40 in 1-based
GM or 4–5 strings), not-guitar (no tab data and no guitar program, or a non-guitar program not shown as tab),
7-string (`string-count`), no notes. Everything else with 6 strings is playable. Default arrangement = first
playable track. `noteCount` counts written notes (repeats not expanded, ties excluded).

**Diagnostics** (`Song.diagnostics`): alphaTex errors throw `ImportError('syntax')` with every diagnostic
(`AT202`, line, column); alphaTex warnings on a successful load are kept (hints are dropped);
`overfull-bar` (notes past the bar end are dropped), `string-collision` (duplicate onsets on one string
are dropped), `fret-assigned`, `out-of-range`. Grace notes before the very first beat are dropped. Unreadable
bytes throw `unsupported` (alphaTab's own console logging is switched off while it reads bytes, so a corrupt
file produces only the `ImportError`); a non-`ImportError` failure during conversion becomes `internal`.

**MusicXML.** Imported by alphaTab (`.musicxml`, `.xml` with a `score-partwise`/`score-timewise` root,
compressed `.mxl`); repeats are expanded and `<rehearsal>` marks become sections. If notes lack string/fret
(no `<technical><string>/<fret>`), `fret-assign.ts` places them (standard tuning when the part has none):
dynamic programming over onset groups (same time or chord) and hand windows `lo` (window rule from
[game-mechanics.md](game-mechanics.md#hand-position-cue): `[lo, lo+3]`, `lo+4` from fret 7). Each group picks
distinct strings; costs: 0.25 per fret height, +6 per fret above 15, a shift costs 2 + 0.5 per fret moved
(every window covering the group is a candidate), an assignment wider than one window +50. Open strings
never move the hand. Pitches outside the range move by octaves (diagnostic `out-of-range`).

**alphaTex.** `importer.AlphaTexImporter`; diagnostics (code, line, column) are surfaced to the author.
Starter files use `\title`, `\artist`, `\tempo`, `\tuning`, `\section` and per-note effects
(`{h}`, `{sl}`, `{b (0 4)}`, `{pm}`, …). `{h}` marks **both** hammer-ons and pull-offs (alphaTab takes the
direction from the pitches; `{p}` is a slap-bass pop, not a pull-off). Comments are `//` and `/* */`
(`%` is not a comment in alphaTab 1.9). An optional `// riffway: tags=pick,rock` comment line gives tags
(`pick`/`fingerstyle` → style, anything else → genre; merged with `SongBundle.tags`); other
`// riffway:` lines (the starter's `melody` checks, `starter/README.md`) are ignored by the importer.

**Test fixtures** (`tests/fixtures/import/`, all authored for Riffway): alphaTex sources, one file per
technique flag, hand-written MusicXML; `gp/*.gp` and `tab-dropd.mxl` are generated from them by
`npx tsx tests/fixtures/import/build-fixtures.ts` (alphaTab `Gp7Exporter`). Golden summaries live in
`tests/fixtures/import/golden/`.

## ASCII tab parser (`src/core/import/ascii/`)
1. Decode UTF-8, fall back to windows-1252; normalise CRLF.
2. Find **staff blocks**: 6 consecutive lines matching `^\s*[A-Ga-g][#b]?\s*[|:]?[-0-9a-z|/\\~()<>.=*^ ]+`
   (labels optional). Top line = string 1. Labels give tuning (`D|A|D|G|B|e|` → Drop D); ClassTab
   writes `E` for both e strings, so position, not case, decides.
3. Tokenise column-wise: multi-digit frets, `h p / \ b r ~ x`, `(n)` ghost, `<n>` harmonic,
   `=` sustain (ignored), `|` and `||` bar lines. Each note keeps its column.
   **Repeats:** `x2` / `(x3)` / `repeat 2 times` markers on or under a block play the whole block that
   many times. ClassTab repeat signs `|*` (open) and `*|` (close), with the `*` on at least two strings,
   are expanded bar-wise, also across blocks: a close sends playback back once to the latest open (else
   to the bar after the previous close, else to the start). Nested repeats and repeat counts on signs are
   not modelled. A lone `*` is ignored.
4. Lines between blocks: `PM----` spans → palm mute; beat-ruler lines (below) → rhythm; headers
   (`tuning:`, `key:`, `time:`, `tempo: Q=100`, `capo`, `MIDI: …`) → meta via tolerant regexes.
5. Without bar lines, each block is one bar of the given time signature.
6. Output: notes with `column`, `bar` and estimated proportional onsets; `rhythm = 'needs-alignment'`
   unless step 7, a paired MIDI or a sidecar applies. Unparsed lines are reported with line numbers for
   the preview.
7. **Beat ruler** (ClassTab house style, e.g. `0   .   | . . | . .`): ruler marks are column-aligned
   with the staff; each mark is one subdivision. Marks per bar ÷ beats per bar (from `time:`) gives the
   subdivision; notes on a mark get its time, notes between marks interpolate. Tempo from `tempo:` else
   80 BPM with `tempoEstimated`. Result `rhythm = 'ruler'`.
   Rulers may carry bar numbers (`12|`, `(12)`, `12.`), `.` `,` `+` `'` subdivisions, directions (`$`,
   Fine, D.C., `3/8`) and tuplet brackets; a bracket claims the bar's missing slots and its notes share
   that time. Bars with finer marks in one beat split each beat evenly. A fermata line may sit between
   ruler and staff. Staves joined by ` |` lines form a duet system; only guitar 1 is imported.
8. **Rhythm precedence** (`asciiToSong`): a sidecar whose onset count matches the tab's onset groups
   (`'aligned'`; a mismatch keeps the other rhythm and warns `sidecar-mismatch`) > a paired MIDI with
   ≥ 80% of onset groups matched (`'midi'`) > a beat ruler on every block (`'ruler'`) > proportional
   column spacing (`'needs-alignment'`).
9. **Multi-version tabs** (ClassTab "version 2 …", or a second `MIDI:` header between staves) are split
   into versions; `loadSong(bundle, {version})` / `asciiToSong(bundle, {version})` imports one (default 1)
   with an info diagnostic `multiple-versions`.

## Rhythm alignment UX (ASCII paste/file, needs-alignment songs)
Import screen `src/ui/screens/import/` (pure logic in `model.ts`). Goal: playable in under a minute.
Routes: `#/import` (paste; `?q=` prefills the title) and `#/import?song=<id>` ("Align rhythm" for a library
ASCII tab: the file is read-only, only the sidecar is saved; a non-ASCII song shows "already has its rhythm").
1. **Paste or open** a `.txt`/`.tab` (button or drop on the text box; windows-1252 decoded). A
   "Search on Ultimate Guitar" link-out sits beside it (opens `search.php?search_type=title&value=` in a new
   tab with artist + title; the app never requests UG, [sources/ultimate-guitar.md](sources/ultimate-guitar.md)).
2. **Live preview** (150 ms debounce) of the first version only, exactly as `asciiToSong` imports it:
   tuning, bars, onsets, notes, header tempo/time/capo; every parser diagnostic with its line number (a
   "Line n" chip selects that line in the text box); a numbered parsed view with staff lines tinted and
   unparsed lines highlighted. Title/artist/BPM/time signature prefill from the header until edited.
3. **Details:** title (required), artist, tuning override (named tunings), capo. Overrides are saved as
   header lines in front of the text (`Tuning: D A D G B E`, `Capo: 2`, `Tempo: Q=120`, `Time: 3/4`; only
   values that differ from the tab, tempo/time only when the user set them) followed by a blank line; the
   header parser keeps the first value it sees, so they win. Non-standard string labels still beat a
   `Tuning:` line; the screen warns when that happens.
4. **BPM + time signature**; **tap tempo** (button or `T`; mean of the last 8 intervals, a 2 s pause restarts).
5. **Snap to grid (default):** `snapToGrid` (column spacing within a bar = duration ratio, quantised; chords
   stay together). Grid **Auto** picks 1/8 when every onset fits it (own slot, mean distance ≤ 0.2 slot),
   else 1/8 triplet when triplets fit and 1/16 does not, else 1/16; or choose 1/8, 1/8 triplet, 1/16.
6. **Tap along:** the transport plays constant bars at the BPM with the metronome at 50/60/75/100% speed
   (default 75%) after a one-bar count-in; Space or the pad = one tap per onset group (chords = one tap).
   Tap time = `clock.songTimeAt(engine.perfToCtxTime(event.timeStamp) − keyboardOffsetMs)`, so speed is
   factored out. Taps during the count-in and bounces (< 30 ms) are ignored. The next eight onsets are shown
   as fret columns. Backspace / "Undo tap", Esc stops, "Restart from bar n" keeps the taps before that bar
   and restarts a bar earlier. Untapped onsets are extrapolated (`mapTapsToOnsets`; from the BPM with
   fewer than two taps); optional quantise to the grid. Saving with missing taps asks first.
7. **Preview:** the aligned song is rebuilt by `asciiToSong(text + sidecar)` on every change and drawn as
   a six-lane strip (bars, beats, fret chips, playhead that follows playback; scroll bar; click = play from
   there). "Play preview" (50/75/100%, click on/off) plays it through the guide synth; if the guide cannot
   load within 8 s, a simple oscillator voice on the guide bus plays instead.
8. **Save** → sidecar `RhythmSidecar` `{schema, bpm, timeSig, grid, onsets[], method: 'snap'|'tap', savedAt}`
   (onsets rounded to µs). Paste: `POST /api/library/paste`; align: `PUT /api/songs/:id/sidecar`; then the
   song page opens. `rhythm = 'aligned'`.

**Server** (`server/routes/sidecars.ts`, DEC-17): sidecars live in `<dataDir>/sidecars/<encodeURIComponent(id)>.json`.
- `POST /api/library/paste` `{title, artist?, text, sidecar?}`: title 1–200 chars; text ≤ `LIMITS.importBytes`
  (413 `too-large`), a final newline is added. The text is checked with `asciiToSong` (400 `empty` without
  notes; 400 `sidecar-mismatch` when the sidecar's onset count differs). File `<artist> - <title>.txt` (slashes
  → `-`, cleaned like uploads) in the import subfolder, never overwriting (` (2)`, … via exclusive create).
  The sidecar is written first, the file is indexed at once (when the local source is enabled), and the
  sidecar follows the id the indexer assigned. Identical content already in the library returns that song
  (its sidecar is replaced). Response `{id, path}`.
- `GET /api/songs/:id/sidecar` (404 `no-sidecar`); `PUT` validates the shape (bpm 20–400, `timeSig`
  `[1–32, 1|2|4|8|16|32]`, grid 8/12/16, non-decreasing onsets ≥ 0), requires an ASCII song (400
  `unsupported`) whose tab matches the onset count (400 `sidecar-mismatch`), writes, then `reindex`es.
- `GET /api/sidecars` → every valid sidecar; `POST /api/sidecars` writes the valid ones (invalid entries
  are skipped), re-indexes songs in the library and answers `{written}`.

## ClassTab pairing (`src/core/import/align/`)
Files indexed from the data dir only; nothing from ClassTab is committed (D2).
1. **Find MIDI:** exact basename; then suffixed `x_1`, `x_01`, `x_a`, `x_duet`; then the
   `MIDI: http://www.classtab.org/<name>.mid` header URL. Multi-version tabs pair version *k* with the
   *k*-th numbered MIDI when present.
2. **Read MIDI** with `@tonejs/midi`; merge tracks into onset groups (pitch sets with times).
3. **Align** the tab's onset groups to MIDI onset groups (`alignTabToMidi`, `src/core/import/midi/`):
   - **Octave shift:** the whole tab is first transposed by the octave shift (0, −12, +12, −24, +24
     semitones; the smaller wins a tie) whose pitch histogram overlaps the MIDI's most. This covers
     MIDIs written at notated pitch (an octave above the sounding guitar) and tabs an octave off.
   - **Needleman–Wunsch** with similarity = Jaccard of the pitch sets, else 0.5 × the pitch-class
     Jaccard (octave errors); gap −0.4; leading and trailing MIDI gaps are free (an intro, or repeats
     the tab writes once).
   - **Match rule:** an aligned pair counts as matched only when its similarity is **≥ 0.5** (half the
     exact pitches shared, or a pure octave error). Each **run** of MIDI groups skipped between two
     matched pairs counts as **one miss**. Match score = matched pairs / (tab groups + skipped runs).
   - If the score is **≥ 80%**, take MIDI times for matched groups, interpolate the others linearly
     (extrapolating with the matched tempo at the ends) and take tempo/bars from the MIDI →
     `rhythm = 'midi'`. Weak pairs (one shared pitch class) still steer the alignment but never count,
     so an unrelated piece in the same key stays far below 80%.
   - If the MIDI match fails it is retried without the tab's repeats, then against each track alone.
4. Else use the beat ruler if present (`'ruler'`), else `'needs-alignment'`. A saved sidecar beats all
   of these (precedence in § ASCII tab parser step 8).
Tests use **synthetic** tab/MIDI files we author in ClassTab's style (`tests/fixtures/classtab-synthetic/`).
