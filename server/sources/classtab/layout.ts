/**
 * ClassTab constants and on-disk layout under `<dataDir>/classtab/` (docs/sources/classtab.md, D2).
 *
 * ```
 * <dataDir>/classtab/
 *   classtab.zip   last downloaded zip (kept so a failed extract can be retried offline)
 *   files/         extracted `.txt` / `.mid` files, flat (the source root of the index)
 *   state.json     ETag / Last-Modified, last check, counts ({@link ClassTabState})
 *   pairs.json     tab ↔ MIDI pairing cache, keyed by a fingerprint of `files/`
 * ```
 * @module
 */
import { join } from 'node:path';

/** The whole-site zip ClassTab offers on its home page ("updated monthly"). */
export const CLASSTAB_ZIP_URL = 'https://www.classtab.org/zip/classtab.zip';

/** Polite, anonymous User-Agent (no personal data). */
export const CLASSTAB_USER_AGENT = 'Riffway/0.1 (personal local app)';

/** Web page of one ClassTab file (`IndexEntry.url`). */
export const classTabPageUrl = (fileName: string): string => `https://www.classtab.org/${encodeURIComponent(fileName)}`;

/** A refresh contacts the site at most once per this many ms unless forced. */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Minimum wait before a retry (the site's `Crawl-delay: 10`). */
export const MIN_RETRY_DELAY_MS = 10_000;

/** Download attempts per refresh (first try + retries). */
export const DOWNLOAD_ATTEMPTS = 3;

/** Abort a download that takes longer than this (ms). */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Size limits for the download and the extraction (the real zip: 13.6 MB, 65.9 MB unpacked, 6,336 entries). */
export const CLASSTAB_LIMITS = {
  /** Largest zip we download. */
  zipBytes: 100 * 1024 * 1024,
  /** Most entries we accept in the zip's central directory. */
  entries: 20_000,
  /** Largest single extracted file; bigger entries are skipped. */
  entryBytes: 10 * 1024 * 1024,
  /** Largest total of extracted bytes; beyond it the extraction fails. */
  totalBytes: 300 * 1024 * 1024,
} as const;

/** File extensions kept from the zip (nothing else is written, nothing is executed). */
export const KEPT_EXTENSIONS: readonly string[] = ['.txt', '.mid'];

/** The site's readme, extracted but never indexed as a song. */
export const README_NAME = '0_readme.txt';

/** Tags every ClassTab entry carries: filterable, never hidden (docs/user-profile.md). */
export const CLASSTAB_TAGS = { style: ['fingerstyle' as const], genre: ['classical'] };

/** Paths inside the ClassTab data folder. */
export interface ClassTabLayout {
  /** `<dataDir>/classtab`. */
  root: string;
  zip: string;
  /** Extracted files (index source root). */
  files: string;
  state: string;
  pairs: string;
}

/** Resolve the layout for a data dir. */
export function classTabLayout(dataDir: string): ClassTabLayout {
  const root = join(dataDir, 'classtab');
  return {
    root,
    zip: join(root, 'classtab.zip'),
    files: join(root, 'files'),
    state: join(root, 'state.json'),
    pairs: join(root, 'pairs.json'),
  };
}
