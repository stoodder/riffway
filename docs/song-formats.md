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
8. **Rhythm precedence** (`asciiToSong`): a sidecar whose onset count matches the tab's onset groups
   (`'aligned'`; a mismatch keeps the other rhythm and warns `sidecar-mismatch`) > a paired MIDI with
   ≥ 80% of onset groups matched (`'midi'`) > a beat ruler on every block (`'ruler'`) > proportional
   column spacing (`'needs-alignment'`).
9. **Multi-version tabs** (ClassTab "version 2 …", or a second `MIDI:` header between staves) are split
   into versions; `loadSong(bundle, {version})` / `asciiToSong(bundle, {version})` imports one (default 1)
   with an info diagnostic `multiple-versions`.

## Rhythm alignment UX (ASCII paste/file, needs-alignment songs)
Goal: playable in under a minute.
1. **Preview** the detected staves (unparsed lines highlighted), editable title/artist/tuning.
2. **BPM + time signature** fields; a "tap tempo" button.
3. **Snap-to-grid (default):** within each bar, column spacing is the duration ratio; quantise onsets
   to the chosen subdivision (1/8, 1/16, 1/8 triplet); chords stay together. Instant guide-synth preview.
4. **Tap-along (optional):** a metronome plays at the BPM (optionally 50% speed); the player taps
   Space for each note onset (chords = one tap). Taps map to onsets in order; optional quantise to grid.
   Undo last tap, restart from bar.
5. **Confirm** → sidecar `RhythmSidecar` `{schema, bpm, timeSig, grid, onsets[], method, savedAt}` saved via `PUT /api/songs/:id/sidecar`
   (pasted tabs: `POST /api/library/paste` writes `<artist> - <title>.txt` + sidecar); `rhythm = 'aligned'`.

## ClassTab pairing (`src/core/import/align/`)
Files indexed from the data dir only; nothing from ClassTab is committed (D2).
1. **Find MIDI:** exact basename; then suffixed `x_1`, `x_01`, `x_a`, `x_duet`; then the
   `MIDI: http://www.classtab.org/<name>.mid` header URL. Multi-version tabs pair version *k* with the
   *k*-th numbered MIDI when present.
2. **Read MIDI** with `@tonejs/midi`; merge tracks into onset groups (pitch sets with times).
3. **Align** the tab's onset groups to MIDI onset groups with Needleman–Wunsch (score = Jaccard of
   pitch sets, octave-insensitive fallback 0.5; gap −0.4). If ≥ 80% of tab groups match, take MIDI times,
   interpolate unmatched groups linearly, take tempo/bars from the MIDI → `rhythm = 'midi'`.
4. Else use the beat ruler if present (`'ruler'`), else `'needs-alignment'`. A saved sidecar beats all
   of these (precedence in § ASCII tab parser step 8).
Tests use **synthetic** tab/MIDI files we author in ClassTab's style (`tests/fixtures/classtab-synthetic/`).
