/**
 * The isomorphic entry point (DEC-12): the server indexer and the browser song worker run the same
 * `loadSong()`. Format detection → importer (alphaTab, or the ASCII parser of T-012) → `Song`.
 * Throws `ImportError` (`./errors`).
 * @module
 */
import type { Song, SongBundle, SongFormat, TrackInfo } from '@shared/song';
import { alphaTabToSong, alphaTabTracks, loadAlphaTabScore } from './alphatab';
import { asciiToSong, decodeText, parseAsciiTab } from './ascii';
import { ImportError } from './errors';

/** Options for {@link loadSong}. */
export interface LoadSongOptions {
  /** Track index; default = first playable track. */
  arrangement?: number;
  /** Song id to stamp (else `bundle.id`, else `''` and the caller fills it in). */
  id?: string;
}

const EXTENSION_FORMATS: Readonly<Record<string, SongFormat>> = {
  '.gp': 'gp',
  '.gpx': 'gpx',
  '.gp5': 'gp5',
  '.gp4': 'gp4',
  '.gp3': 'gp3',
  '.musicxml': 'musicxml',
  '.xml': 'musicxml',
  '.mxl': 'mxl',
  '.atex': 'alphatex',
  '.txt': 'ascii',
  '.tab': 'ascii',
};

/** Bytes inspected when sniffing an `.xml` root element. */
const SNIFF_BYTES = 4096;

/**
 * True when the XML's root element is `score-partwise` / `score-timewise` (skips the BOM, XML
 * declaration, processing instructions, comments and DOCTYPE).
 */
function isMusicXmlRoot(data: Uint8Array): boolean {
  const head = new TextDecoder('utf-8').decode(data.subarray(0, SNIFF_BYTES));
  const body = head.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '');
  return /^\s*<(score-partwise|score-timewise)[\s>/]/.test(body);
}

/**
 * Detect the format from the extension, sniffing content where needed (`.xml` must have a
 * `score-partwise`/`score-timewise` root). Returns null for unsupported files. Without `data`,
 * `.xml` is optimistically reported as MusicXML (the indexer checks again once it has the bytes).
 */
export function detectFormat(fileName: string, data?: Uint8Array): SongFormat | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = fileName.slice(dot).toLowerCase();
  const format = EXTENSION_FORMATS[ext];
  if (!format) return null;
  if (ext === '.xml' && data !== undefined && !isMusicXmlRoot(data)) return null;
  return format;
}

function requireFormat(bundle: SongBundle): SongFormat {
  const format = detectFormat(bundle.fileName, bundle.data);
  if (!format) throw new ImportError('unsupported', `${bundle.fileName} is not a supported song file`);
  return format;
}

/**
 * List the file's tracks; bass, drums and 7-string tracks are marked unsupported. ASCII tabs have
 * one guitar track. Throws `ImportError` like {@link loadSong}.
 */
export function listTracks(bundle: SongBundle): TrackInfo[] {
  if (requireFormat(bundle) === 'ascii') {
    const tab = parseAsciiTab(decodeText(bundle.data));
    const noteCount = tab.groups.reduce((sum, g) => sum + g.notes.length, 0);
    const track: TrackInfo = {
      index: 0,
      name: 'Guitar',
      strings: tab.tuning.length,
      tuning: [...tab.tuning],
      capo: tab.header.capo ?? 0,
      playable: noteCount > 0,
    };
    if (noteCount > 0) track.noteCount = noteCount;
    else track.unsupportedReason = 'no-notes';
    return [track];
  }
  return alphaTabTracks(loadAlphaTabScore(bundle));
}

/**
 * Parse a bundle into a `Song` for one arrangement. `.txt/.tab` dispatch to `asciiToSong`
 * (`src/core/import/ascii`). Throws `ImportError` (`unsupported`, `empty` when no track has notes,
 * `no-playable-track`, `bad-arrangement`, `syntax` with diagnostics, …); unexpected importer failures
 * become `internal`.
 */
export function loadSong(bundle: SongBundle, opts: LoadSongOptions = {}): Song {
  const format = requireFormat(bundle);
  const id = opts.id ?? bundle.id;
  if (format === 'ascii') return asciiToSong(bundle, id === undefined ? {} : { id });

  const score = loadAlphaTabScore(bundle);
  const tracks = alphaTabTracks(score);
  let arrangement = opts.arrangement;
  if (arrangement === undefined) {
    arrangement = tracks.find((t) => t.playable)?.index;
    if (arrangement === undefined) {
      if (tracks.every((t) => t.unsupportedReason === 'no-notes')) throw new ImportError('empty', `${bundle.fileName} contains no notes`);
      const reasons = tracks.map((t) => `${t.name} (${t.unsupportedReason ?? 'unsupported'})`).join(', ');
      throw new ImportError('no-playable-track', `${bundle.fileName} has no playable 6-string guitar track: ${reasons}`);
    }
  } else if (!tracks[arrangement]?.playable) {
    throw new ImportError('bad-arrangement', `Track ${arrangement} of ${bundle.fileName} is not a playable 6-string guitar track`);
  }
  try {
    return alphaTabToSong(score, arrangement, id === undefined ? bundle : { ...bundle, id });
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError('internal', `Importing ${bundle.fileName} failed: ${err instanceof Error ? err.message : String(err)}`, [], { cause: err });
  }
}

export { ImportError, isImportError, type ImportErrorCode } from './errors';
