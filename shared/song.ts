/**
 * The one song model (D4). Every importer (alphaTab for GP/MusicXML/alphaTex, the ASCII parser,
 * ClassTab MIDI pairing) produces a {@link Song}; the game, renderer, difficulty and judge consume
 * only this. Authoritative over the abridged copy in `docs/song-formats.md`.
 *
 * Conventions:
 * - All times are **seconds at 100% speed** from the start of the song (bar 0 = 0 s).
 * - **String 1 = high e**, string 6 = low E (alphaTab numbers the other way round; importers flip).
 * - Tunings are MIDI note numbers ordered high → low (`tuning[0]` = string 1).
 * - Pure data: JSON-serialisable (crosses the worker boundary and the server API).
 *
 * DOM-free (also checked by `tsconfig.node.json`).
 * @module
 */

/** Identifier of a song source adapter (see `docs/sources/README.md`). */
export type SourceId = 'local' | 'starter' | 'classtab' | 'songsterr' | 'ultimate-guitar' | 'gp-pack';

/** Every {@link SourceId}, in display order. */
export const SOURCE_IDS: readonly SourceId[] = ['local', 'starter', 'classtab', 'songsterr', 'ultimate-guitar', 'gp-pack'];

/** Where a song came from. */
export interface SourceRef {
  source: SourceId;
  /** Path relative to the source root (library folder, ClassTab dir, `starter/`). Never absolute. */
  path?: string;
  /** Canonical web page for the song, if known (e.g. a ClassTab `MIDI:` header URL). */
  url?: string;
  /** Optional user-chosen origin tag, e.g. `'songsterr'` for a GP file downloaded from Songsterr. */
  origin?: string;
}

/**
 * How the note times were obtained.
 * - `exact`: the file has rhythm (GP, MusicXML, alphaTex).
 * - `midi`: ASCII tab aligned to a paired MIDI file (ClassTab).
 * - `ruler`: ASCII tab with a beat-ruler line.
 * - `aligned`: ASCII tab with a saved rhythm-alignment sidecar.
 * - `needs-alignment`: proportional column spacing only; not playable until aligned.
 */
export type RhythmStatus = 'exact' | 'midi' | 'ruler' | 'aligned' | 'needs-alignment';

/** Song tags used by search filters, recommendations and skill display. */
export interface SongTags {
  /** Right-hand style. */
  style: ('pick' | 'fingerstyle')[];
  /** Free-form genres, lower-case (`'rock'`, `'metal'`, `'classical'`, `'recognizable'`, …). */
  genre: string[];
  /** Skill tags derived by difficulty analysis (`'bends'`, `'legato'`, `'chords'`, `'string-skipping'`, `'position-shifts'`, …). */
  skills: string[];
}

/** A guitar string number: 1 = high e … 6 = low E. */
export type StringNumber = 1 | 2 | 3 | 4 | 5 | 6;

/** Slide kinds (alphaTab `slideInType` / `slideOutType` mapped). */
export type SlideType = 'in-below' | 'in-above' | 'out-up' | 'out-down' | 'shift' | 'legato';

/** Harmonic kinds (alphaTab `harmonicType` mapped). */
export type HarmonicType = 'natural' | 'artificial' | 'pinch' | 'tap' | 'semi' | 'feedback';

/** Technique flags on a note. Absent = not set. */
export interface Tech {
  /** Origin of a hammer-on (next note on the same string is higher). */
  hammerOn?: true;
  /** Origin of a pull-off (next note on the same string is lower). */
  pullOff?: true;
  /** Destination of a hammer-on, pull-off or legato slide: the judge also accepts a `pitch-change` event. */
  legatoDest?: true;
  slide?: SlideType;
  /** Bend amount in semitones (alphaTab bend values are quarter-tones: semitones = max value / 2). */
  bend?: { semitones: number; release?: boolean };
  palmMute?: true;
  letRing?: true;
  vibrato?: true;
  harmonic?: HarmonicType;
  /** Dead / muted note (`x`): matches any onset. */
  dead?: true;
  /** Ghost note (`(n)` in ASCII tab): displayed smaller, still judged. */
  ghost?: true;
}

/** One played note. */
export interface Note {
  /** Unique within the song; equals the index in `Song.notes`. */
  id: number;
  /** Onset, seconds at 100% speed. */
  time: number;
  /** Sounding duration in seconds at 100% speed (≥ 0). */
  dur: number;
  string: StringNumber;
  /** Fret number (0 = open). */
  fret: number;
  /** Sounding MIDI pitch. Invariant: `midi = tuning[string-1] + capo + fret`, except harmonics. */
  midi: number;
  /** Index into `Song.timing.bars` (played order). */
  bar: number;
  /** Set when the note belongs to a chord group (`Song.chords[].id`). */
  chordId?: number;
  /** Set on a tied destination: the id of the note it continues. Tied destinations are not judge targets. */
  tiedFrom?: number;
  /** ASCII tab only: column of the note in its staff block (used by the alignment UI). */
  column?: number;
  tech: Tech;
}

/** A tempo change. */
export interface TempoChange {
  /** Seconds at 100% speed. */
  time: number;
  /** Quarter-note beats per minute. */
  bpm: number;
}

/** One bar in **played order** (repeats, voltas and jumps expanded). */
export interface Bar {
  /** Index in `Song.timing.bars` (0-based, played order). */
  index: number;
  /** Index of the bar in the written score (before repeat expansion), for display. Defaults to `index`. */
  sourceIndex?: number;
  /** Start time, seconds. */
  time: number;
  /** Duration, seconds. */
  dur: number;
  /** Time-signature numerator. */
  num: number;
  /** Time-signature denominator. */
  den: number;
  /** Absolute start time of every beat in the bar (`beats[0] === time`; the downbeat). */
  beats: number[];
}

/** Tempo map plus bar/beat grid. Metronome clicks come from `bars[].beats`. */
export interface Timing {
  tempos: TempoChange[];
  bars: Bar[];
}

/** A named section; covers whole bars. */
export interface Section {
  name: string;
  /** First bar index (inclusive). */
  startBar: number;
  /** Bar index after the last bar (**exclusive**). */
  endBar: number;
  /** Start time, seconds (= `bars[startBar].time`). */
  start: number;
  /** End time, seconds (= end of bar `endBar - 1`). */
  end: number;
}

/** A chord group: notes struck together. */
export interface Chord {
  id: number;
  time: number;
  noteIds: number[];
  /** Chord name from the source, if any (`'A5'`, `'Em'`). */
  name?: string;
}

/** Why a track is not playable. */
export type UnsupportedReason = 'bass' | 'drums' | 'string-count' | 'not-guitar' | 'no-notes';

/** One track of a source file. An arrangement is `(songId, trackIndex)`; only 6-string guitar tracks are playable. */
export interface TrackInfo {
  /** Track index in the source file (= arrangement number). */
  index: number;
  name: string;
  /** Number of strings on the track's staff. */
  strings: number;
  /** MIDI tuning high → low. */
  tuning: number[];
  capo: number;
  playable: boolean;
  unsupportedReason?: UnsupportedReason;
  /** Note count (playable tracks), for display. */
  noteCount?: number;
}

/** Song-level metadata (`Song.meta`). Not to be confused with the API DTO `SongMeta` in `shared/api.ts`. */
export interface SongInfo {
  title: string;
  artist?: string;
  composer?: string;
  arranger?: string;
  source: SourceRef;
  tags: SongTags;
  /** MIDI tuning, `tuning[0]` = string 1 = high e. */
  tuning: number[];
  capo: number;
  durationSec: number;
  rhythm: RhythmStatus;
  /** True when the tempo was guessed (ASCII ruler without `tempo:`; default 80 BPM). */
  tempoEstimated?: boolean;
  /** Every track in the source file, playable or not (arrangement picker). */
  tracks: TrackInfo[];
}

/** Severity-tagged message produced while importing. */
export interface ImportDiagnostic {
  severity: 'error' | 'warning' | 'info';
  /** Machine-readable code, e.g. alphaTex `AT201`, `'unparsed-line'`, `'overfull-bar'`. */
  code: string;
  message: string;
  /** 1-based line, when the source is text. */
  line?: number;
  /** 1-based column, when the source is text. */
  column?: number;
}

/** The internal song model (schema 1). */
export interface Song {
  schema: 1;
  /** Song id (DEC-14): `<source>:<sha1(content)[0..16]>`, starter `starter:<slug>`. */
  id: string;
  /** Track index in the source file. */
  arrangement: number;
  meta: SongInfo;
  timing: Timing;
  sections: Section[];
  /** Sorted by time, then string. */
  notes: Note[];
  chords: Chord[];
  /** Non-fatal import messages (unparsed ASCII lines, clipped bars, …). */
  diagnostics?: ImportDiagnostic[];
}

/** File formats `loadSong` understands. */
export type SongFormat = 'gp' | 'gpx' | 'gp5' | 'gp4' | 'gp3' | 'musicxml' | 'mxl' | 'alphatex' | 'ascii';

/** Lower-case extensions accepted by import and the indexer (with the dot). */
export const SONG_EXTENSIONS: readonly string[] = [
  '.gp', '.gpx', '.gp5', '.gp4', '.gp3', '.musicxml', '.xml', '.mxl', '.atex', '.txt', '.tab',
];

/** Rhythm-alignment sidecar (DEC-17), stored in `<dataDir>/sidecars/<songId>.json`. */
export interface RhythmSidecar {
  schema: 1;
  bpm: number;
  /** `[numerator, denominator]`. */
  timeSig: [number, number];
  /** Snap grid as note value: 8 = eighths, 16 = sixteenths, 12 = eighth triplets. */
  grid: 8 | 12 | 16;
  /** Onset time (seconds at 100%) per ASCII onset group, in tab order. */
  onsets: number[];
  method: 'snap' | 'tap' | 'manual';
  /** Epoch ms. */
  savedAt: number;
}

/**
 * Everything `loadSong()` needs. The browser fetches it from `/api/songs/:id/*`; the server reads it
 * from disk. Bytes are a `Uint8Array` (transferable to the worker).
 */
export interface SongBundle {
  /** File name with extension (format detection). */
  fileName: string;
  data: Uint8Array;
  /** Paired MIDI (ClassTab or sibling `.mid`) for ASCII rhythm. */
  midi?: { fileName: string; data: Uint8Array };
  /** Saved rhythm alignment for ASCII tabs. */
  sidecar?: RhythmSidecar;
  /** Song id to stamp on the result; defaults to a content hash computed by the caller. */
  id?: string;
  source?: SourceRef;
  /** Extra tags to merge (e.g. ClassTab adds `fingerstyle`, `classical`). */
  tags?: Partial<SongTags>;
}

// ---------------------------------------------------------------------------------------------
// Difficulty (docs/difficulty.md) — produced by src/core/difficulty (T-013)
// ---------------------------------------------------------------------------------------------

/** Difficulty tier 1–10 (rounded rating). */
export type Tier = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** Tier band name. 1–2 Beginner, 3–4 Developing, 5–6 Intermediate, 7–8 Advanced, 9–10 Expert. */
export type TierName = 'Beginner' | 'Developing' | 'Intermediate' | 'Advanced' | 'Expert';

/** The seven difficulty factors. */
export type DifficultyFactorId = 'density' | 'tempo' | 'shifts' | 'span' | 'skipping' | 'techniques' | 'chords';

/** One factor's raw measure and normalised value. */
export interface DifficultyFactor {
  /** Raw measure (e.g. density `0.6·D + 0.4·Dp`, tempo in BPM, shifts per second). */
  measure: number;
  /** Normalised value `c` in [0, 1]. */
  c: number;
  /** Weight in the formula (density 0.35, …). */
  weight: number;
}

/** Difficulty of one section. */
export interface SectionDifficulty {
  /** Index into `Song.sections` (after merging sections shorter than 2 s, the first merged index). */
  sectionIndex: number;
  name: string;
  start: number;
  end: number;
  /** Rating 1.0–10.0 (one decimal). */
  rating: number;
  tier: Tier;
  /** `raw` = Σ weight × c, in [0, 1]. */
  raw: number;
  factors: Record<DifficultyFactorId, DifficultyFactor>;
}

/** Full difficulty report for one arrangement. */
export interface DifficultyReport {
  version: 1;
  /** Song rating 1.0–10.0: 0.7 × hardest section (≥ 4 s) + 0.3 × duration-weighted mean. */
  rating: number;
  tier: Tier;
  tierName: TierName;
  /** True for `needs-alignment` songs (rating from proportional onsets; shown with "≈"). */
  provisional: boolean;
  sections: SectionDifficulty[];
  /** Derived skill tags (feed `SongTags.skills`). */
  skills: string[];
  /** Human-readable "why" phrases, hardest first ("fast position shifts", "string skipping"). */
  highlights: string[];
}

// ---------------------------------------------------------------------------------------------
// Hand positions (docs/game-mechanics.md § Hand-position cue) — src/core/handpos (T-013)
// ---------------------------------------------------------------------------------------------

/** A fretting-hand position window `[lo, hi]` held from `start` to `end`. */
export interface HandPosition {
  /** Lowest fret of the window. */
  lo: number;
  /** `lo + 3` (or `lo + 4` when `lo ≥ 7`). */
  hi: number;
  start: number;
  end: number;
  /** First and last note ids played in this position. */
  firstNoteId: number;
  lastNoteId: number;
}

/** A position-shift cue drawn on the highway ("7fr" bracket). Emitted when |Δlo| ≥ 2. */
export interface PositionCue {
  /** Song time the cue appears (≥ 1.5 beats and ≥ 0.75 real s at 100% before `time`). */
  showAt: number;
  /** Song time of the first note in the new position. */
  time: number;
  fromLo: number;
  lo: number;
  hi: number;
}

/** Output of `computePositions(song)`. */
export interface HandPositionAnalysis {
  positions: HandPosition[];
  cues: PositionCue[];
}
