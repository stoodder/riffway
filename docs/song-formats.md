# Song formats

## Summary
- Every importer outputs one model, `Song` (`shared/song.ts`): notes with absolute times in seconds
  at 100% speed, **string 1 = high e**, fret, MIDI pitch, duration, technique flags, chord groups,
  tempo map + bar/beat grid, sections, tuning, capo, tags and a source ref.
- **alphaTab 1.9.0** imports Guitar Pro (`.gp`, `.gpx`, `.gp3–5`), MusicXML (`.musicxml`, `.xml`,
  `.mxl`) and alphaTex (`.atex`, the starter-library format). Its string numbering is flipped.
- **ASCII tab** (paste, `.txt`/`.tab`, ClassTab) uses our parser. Rhythm comes from a paired MIDI, a
  beat ruler, a saved alignment, or the alignment UI; otherwise the song is "needs rhythm alignment".

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
// loadSong(bundle: SongBundle, {arrangement?, id?}) → Song; errors are ImportError (src/core/import/errors.ts)
```
Invariants (validated by `src/core/model/validate.ts`): times non-decreasing; `midi = tuning[string−1] +
capo + fret` except harmonics; no two non-tied notes on one string at one time; bars contiguous;
sections cover whole bars. Tied destinations keep `tiedFrom` and are not judge targets.
When a source has no sections, auto-sections of 8 bars are named "Part 1…n".

## alphaTab import (`src/core/import/alphatab/`)
Uses `importer.ScoreLoader` and `midi.MidiFileGenerator` (verified recipe in
[research/libraries.md](research/libraries.md#verified-alphatab-node-api)); the player is never used.
| alphaTab | Song |
|---|---|
| `gen.tickLookup.masterBars` (played order, repeats/voltas/jumps expanded) | `timing.bars`, note times |
| tempo changes per master bar → tick→time | `timing.tempos` |
| `masterBar.section.text` | `sections` |
| `staff.tuning` (high → low) | `meta.tuning` (already high-first) |
| `note.string` (**1 = lowest**) | `string = tuning.length − n.string + 1` |
| `note.fret`, `note.realValue` | `fret`, `midi` (golden-test that `realValue` matches the invariant incl. capo) |
| `isHammerPullOrigin` / destination | `hammerOn` or `pullOff` (by pitch direction) / `legatoDest` |
| `slideInType`, `slideOutType` | `slide` |
| `bendPoints` (values are quarter-tones: semitones = max value / 2; verify with a golden test) | `bend` |
| `isPalmMute`, `isLetRing`, `vibrato`, `harmonicType`, `isDead`, `isTieDestination` | flags / `tiedFrom` |
| `beat.chord?.name`, notes sharing a beat | `chords` |
| `staff.capo`, `track.name`, `score.title/artist` | meta |
Track selection: list tracks whose staff has 6 strings and a tab-capable guitar program; bass,
drums and 7-string tracks are listed as unsupported. Default arrangement = first playable track.
Grace notes take ~1/32 before the main beat; overfull bars are clipped and logged.

**MusicXML.** Imported by alphaTab. If notes lack string/fret (no `<technical><string>/<fret>`), run
`fret-assign.ts`: dynamic programming over candidate (string, fret) positions minimising
hand-position shifts and span (same window rule as [game-mechanics.md](game-mechanics.md#hand-position-cue)),
frets ≤ 15 preferred, open strings allowed.

**alphaTex.** `ScoreLoader.loadAlphaTex`; diagnostics (code, line, column) are surfaced to the author.
Starter files use `\title`, `\artist`, `\tempo`, `\tuning`, `\section` and per-note effects
(`{h}`, `{sl}`, `{b (0 4)}`, `{pm}`, …), plus a `% riffway: tags=pick,rock` comment for tags.

## ASCII tab parser (`src/core/import/ascii/`)
1. Decode UTF-8, fall back to windows-1252; normalise CRLF.
2. Find **staff blocks**: 6 consecutive lines matching `^\s*[A-Ga-g][#b]?\s*[|:]?[-0-9a-z|/\\~()<>.=*^ ]+`
   (labels optional). Top line = string 1. Labels give tuning (`D|A|D|G|B|e|` → Drop D); ClassTab
   writes `E` for both e strings, so position, not case, decides.
3. Tokenise column-wise: multi-digit frets, `h p / \ b r ~ x`, `(n)` ghost, `<n>` harmonic,
   `=` sustain (ignored), `*` repeat dots (ignored), `|` and `||` bar lines. Each note keeps its column.
4. Lines between blocks: `PM----` spans → palm mute; beat-ruler lines (below) → rhythm; headers
   (`tuning:`, `key:`, `time:`, `tempo: Q=100`, `capo`, `MIDI: …`) → meta via tolerant regexes.
5. Without bar lines, each block is one bar of the given time signature.
6. Output: notes with `column`, `bar` and estimated proportional onsets; `rhythm = 'needs-alignment'`
   unless step 7 or a sidecar applies. Unparsed lines are reported with line numbers for the preview.
7. **Beat ruler** (ClassTab house style, e.g. `0   .   | . . | . .`): ruler marks are column-aligned
   with the staff; each mark is one subdivision. Marks per bar ÷ beats per bar (from `time:`) gives the
   subdivision; notes on a mark get its time, notes between marks interpolate. Tempo from `tempo:` else
   80 BPM with `tempoEstimated`. Result `rhythm = 'ruler'`.

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
4. Else use the beat ruler if present (`'ruler'`), else `'needs-alignment'`.
Tests use **synthetic** tab/MIDI files we author in ClassTab's style (`tests/fixtures/classtab-synthetic/`).
