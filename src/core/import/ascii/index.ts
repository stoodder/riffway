/**
 * ASCII tab parser (T-012): paste, `.txt`/`.tab` and ClassTab files → `Song`
 * (docs/song-formats.md § ASCII tab parser). Signatures frozen by T-010.
 *
 * Handles ClassTab house style (headers, `tuning: … key: … time:` lines, beat rulers, `=` sustains,
 * `*` repeat dots, grace `g`, CRLF, windows-1252) and messy UG-style tabs (chord-name and lyric lines,
 * multi-digit frets, `h p / \ s b r ~ x t`, `(n)`, `<n>`, `PM----` / `let ring` lines, varying dash
 * widths, `||` bar lines, `x2` repeat markers, `[Chorus]` section headings).
 * @module
 */
import type { AsciiTab } from './types';
import { parseTabDetailed } from './parse';

export type { AsciiHeader, AsciiNote, AsciiOnsetGroup, AsciiBlock, AsciiTab } from './types';
export { decodeText } from './decode';
export { asciiToSong, type AsciiToSongOptions } from './song';
export { splitVersions, type VersionRegion } from './parse';

/**
 * Parse ASCII tab text (no rhythm applied). Groups and bars are in played order (blocks marked `x2`
 * repeat); staves after a ClassTab "Notes & Legend" heading are skipped. For a multi-version file,
 * parse one region from {@link splitVersions}; `lineOffset` keeps line numbers file-relative.
 */
export function parseAsciiTab(text: string, opts: { lineOffset?: number } = {}): AsciiTab {
  return parseTabDetailed(text, opts).tab;
}
