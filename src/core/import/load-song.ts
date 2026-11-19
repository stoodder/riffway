/**
 * The isomorphic entry point (DEC-12): the server indexer and the browser song worker run the same
 * `loadSong()`. Format detection → importer (alphaTab, or the ASCII parser of T-012) → `Song`.
 * Implemented by T-011; signatures frozen by T-010. Throws `ImportError` (`./errors`).
 * @module
 */
import type { Song, SongBundle, SongFormat, TrackInfo } from '@shared/song';
import { notImplemented } from '@shared/errors';

/** Options for {@link loadSong}. */
export interface LoadSongOptions {
  /** Track index; default = first playable track. */
  arrangement?: number;
  /** Song id to stamp (else `bundle.id`, else `''` and the caller fills it in). */
  id?: string;
}

/**
 * Detect the format from the extension, sniffing content where needed (`.xml` must have a
 * `score-partwise`/`score-timewise` root). Returns null for unsupported files.
 */
export function detectFormat(fileName: string, data?: Uint8Array): SongFormat | null {
  return notImplemented('detectFormat', 'T-011');
}

/** List the file's tracks; bass, drums and 7-string tracks are marked unsupported. */
export function listTracks(bundle: SongBundle): TrackInfo[] {
  return notImplemented('listTracks', 'T-011');
}

/**
 * Parse a bundle into a `Song` for one arrangement. `.txt/.tab` dispatch to `asciiToSong`
 * (`src/core/import/ascii`). Throws `ImportError` (`unsupported`, `no-playable-track`,
 * `bad-arrangement`, `syntax` with diagnostics, …).
 */
export function loadSong(bundle: SongBundle, opts: LoadSongOptions = {}): Song {
  return notImplemented('loadSong', 'T-011');
}

export { ImportError, isImportError, type ImportErrorCode } from './errors';
