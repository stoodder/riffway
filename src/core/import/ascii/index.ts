/**
 * ASCII tab parser (T-012): paste, `.txt`/`.tab` and ClassTab files → `Song`
 * (docs/song-formats.md § ASCII tab parser). Signatures frozen by T-010.
 * @module
 */
import type { ImportDiagnostic, Song, SongBundle, StringNumber, Tech } from '@shared/song';
import { notImplemented } from '@shared/errors';

/** Header fields recognised by tolerant regexes (`tuning:`, `key:`, `time:`, `tempo: Q=`, `capo`, `MIDI:`). */
export interface AsciiHeader {
  title?: string;
  composer?: string;
  artist?: string;
  /** MIDI tuning high → low, from labels or prose (`6=D`, `Tuning: D A D G B E`). */
  tuning?: number[];
  key?: string;
  timeSig?: [number, number];
  /** Quarter-note BPM from `tempo: Q=100`. */
  tempo?: number;
  capo?: number;
  /** `MIDI: http://www.classtab.org/<name>.mid`. */
  midiUrl?: string;
}

/** One note found in a staff block. */
export interface AsciiNote {
  string: StringNumber;
  /** Fret; dead notes (`x`) have `fret: 0` and `tech.dead`. */
  fret: number;
  /** Column within the block (characters from the start of the line). */
  column: number;
  /** 1-based source line. */
  line: number;
  tech: Tech;
}

/** A group of notes in the same column (one onset). */
export interface AsciiOnsetGroup {
  index: number;
  /** Bar index (counting across blocks). */
  bar: number;
  /** Column in the block. */
  column: number;
  /** Bar-line columns bracketing this group (`[start, end)`), for proportional spacing. */
  barStartColumn: number;
  barEndColumn: number;
  notes: AsciiNote[];
}

/** One 6-line staff block. */
export interface AsciiBlock {
  /** 1-based line of the top (string 1) line. */
  startLine: number;
  lines: string[];
  /** String labels as written (`'e'`, `'B'`, `'D'`…) or null when unlabelled. */
  labels: (string | null)[];
  /** Columns of `|` bar lines. */
  barColumns: number[];
  notes: AsciiNote[];
  /** Beat-ruler line above the block, if any (ClassTab house style). */
  ruler?: { line: number; text: string };
  /** `PM----` spans as `[startColumn, endColumn)`. */
  palmMute: [number, number][];
}

/** Full parse result (used by the import preview, T-028). */
export interface AsciiTab {
  header: AsciiHeader;
  blocks: AsciiBlock[];
  groups: AsciiOnsetGroup[];
  /** Effective tuning (labels, header, else standard), high → low. */
  tuning: number[];
  /** Lines that looked like tab but did not parse, with line numbers. */
  unparsed: { line: number; text: string }[];
  diagnostics: ImportDiagnostic[];
}

/** Decode bytes: UTF-8, falling back to windows-1252; CRLF normalised to LF. */
export function decodeText(data: Uint8Array): string {
  return notImplemented('decodeText', 'T-012');
}

/** Parse ASCII tab text (no rhythm applied). */
export function parseAsciiTab(text: string): AsciiTab {
  return notImplemented('parseAsciiTab', 'T-012');
}

/**
 * Bundle → `Song`. Rhythm: paired MIDI (`bundle.midi`) → `'midi'`, beat ruler → `'ruler'`,
 * sidecar → `'aligned'`, else proportional onsets with `'needs-alignment'`.
 */
export function asciiToSong(bundle: SongBundle, opts: { id?: string } = {}): Song {
  return notImplemented('asciiToSong', 'T-012');
}
