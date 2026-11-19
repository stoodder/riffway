/**
 * Filesystem safety helpers for the companion server (T-017): upload-name validation and
 * sanitising, containment checks against path traversal, and the extension allowlists.
 * @module
 */
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { SONG_EXTENSIONS } from '@shared/song';

/** Paired-MIDI extension accepted beside ASCII tabs (docs/sources/local-folder.md). */
export const MIDI_EXTENSION = '.mid';

/** Extensions accepted by `POST /api/library/import`: song files plus paired `.mid`. */
export const IMPORT_EXTENSIONS: readonly string[] = [...SONG_EXTENSIONS, MIDI_EXTENSION];

/** Extensions whose files can pair with a sibling `.mid` (ASCII tabs). */
export const ASCII_EXTENSIONS: readonly string[] = ['.txt', '.tab'];

/** Longest file name we write (bytes of UTF-8, well under the 255-byte APFS/ext4 limit). */
const MAX_NAME_BYTES = 200;

/** Lower-case extension including the dot (`'Song.GP5'` → `'.gp5'`). */
export function lowerExt(fileName: string): string {
  return extname(fileName).toLowerCase();
}

/** True when `fileName` has an extension the library indexes (`SONG_EXTENSIONS`). */
export function isSongFile(fileName: string): boolean {
  return SONG_EXTENSIONS.includes(lowerExt(fileName));
}

/** True when `child` is `root` itself or lies inside it (both resolved; no `..` escape). */
export function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Outcome of {@link sanitizeUploadName}. */
export type SanitizedName = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Validate and clean an uploaded file name. Names carrying a path (`/`, `\`, NUL, `.`/`..`) are
 * **rejected**, never silently stripped, so traversal attempts are visible to the caller. The rest
 * is cleaned: Unicode NFC, control and reserved characters (`<>:"|?*`) replaced, whitespace
 * collapsed, leading dots/spaces removed (no hidden files), length capped. The extension must be
 * in {@link IMPORT_EXTENSIONS}.
 */
export function sanitizeUploadName(raw: string): SanitizedName {
  if (/[/\\\0]/.test(raw)) return { ok: false, reason: 'File name must not contain a path' };
  const trimmed = raw.trim();
  if (trimmed === '.' || trimmed === '..') return { ok: false, reason: 'Invalid file name' };
  const ext = lowerExt(trimmed);
  if (!IMPORT_EXTENSIONS.includes(ext)) {
    return { ok: false, reason: `Unsupported file type${ext ? ` ${ext}` : ''}; allowed: ${IMPORT_EXTENSIONS.join(' ')}` };
  }
  let stem = trimmed
    .slice(0, trimmed.length - ext.length)
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- strip control characters on purpose
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim();
  if (!stem) stem = 'untitled';
  while (Buffer.byteLength(stem + ext) > MAX_NAME_BYTES) stem = stem.slice(0, -1);
  return { ok: true, name: stem.trimEnd() + ext };
}

/**
 * Validate a library-relative subfolder (config `importSubfolder`). Returns the normalised
 * `/`-separated path (`''` = library root), or null when it is absolute or escapes the root.
 */
export function normalizeSubfolder(raw: string): string | null {
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  for (const p of parts) {
    if (p === '..' || p.startsWith('.') || /[\0<>:"|?*]/.test(p)) return null;
  }
  return parts.join('/');
}

/** Convert an OS-relative path to the `/`-separated form stored in the index. */
export function toPosix(relPath: string): string {
  return sep === '/' ? relPath : relPath.split(sep).join('/');
}
