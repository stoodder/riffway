/**
 * Public types of the ASCII tab parser (re-exported by `./index.ts`). Kept in their own module so
 * `align/` and `midi/` can import them without a runtime cycle.
 * @module
 */
import type { ImportDiagnostic, StringNumber, Tech } from '@shared/song';

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
  /** Column where a `=` sustain run after the note ends (ClassTab "note held"), if any. */
  sustainEnd?: number;
}

/** A group of notes in the same column (one onset). Groups are listed in **played order**. */
export interface AsciiOnsetGroup {
  index: number;
  /** Bar index (counting across blocks, in played order). */
  bar: number;
  /** Column in the block. */
  column: number;
  /** Bar-line columns bracketing this group (`[start, end)`), for proportional spacing. */
  barStartColumn: number;
  barEndColumn: number;
  notes: AsciiNote[];
  /** Index into {@link AsciiTab.blocks} of the block the group was read from. */
  block?: number;
  /** Chord name written above the group (UG-style chord line), if any. */
  chordName?: string;
}

/** One 6-line staff block. */
export interface AsciiBlock {
  /** 1-based line of the top (string 1) line. */
  startLine: number;
  lines: string[];
  /** String labels as written (`'e'`, `'B'`, `'D'`…) or null when unlabelled. */
  labels: (string | null)[];
  /** Columns of `|` bar lines (every `|` column; `||` gives two adjacent columns). */
  barColumns: number[];
  notes: AsciiNote[];
  /** Beat-ruler line above the block, if any (ClassTab house style). */
  ruler?: { line: number; text: string };
  /** `PM----` spans as `[startColumn, endColumn)`. */
  palmMute: [number, number][];
  /** How many times the block is played (`x2`, `(x3)`, `repeat 2x` markers). Default 1. */
  repeat?: number;
  /** Section name written before the block (`[Chorus]`, `Verse 1:`), if any. */
  section?: string;
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
