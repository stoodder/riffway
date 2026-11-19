/**
 * Title/artist normalisation and local matching for link-out sources (D1, docs/sources/songsterr.md
 * § Compliant design 3). Pure functions: no I/O of any kind.
 *
 * A query "matches" an indexed entry when every normalised query word appears among the entry's
 * normalised title + artist (or composer) words. Normalisation lower-cases, strips diacritics,
 * drops `feat.`/`live`/`remaster`-style suffixes, removes punctuation and the word "the", so
 * "Metallica – Enter Sandman (Remastered 2021)" and "enter sandman metallica" agree.
 * @module
 */
import type { IndexEntry } from '@shared/sources';

/** Words inside brackets or after a dash that mark a version suffix, not part of the title. */
const VERSION_WORDS = /\b(live|remaster(?:ed)?|demo|version|mono|stereo|edit|mix|acoustic|unplugged|instrumental)\b/;

/** `feat. X`, `ft. X`, `featuring X` up to the end of the string (or a closing bracket). */
const FEATURING = /\s*[([]?\s*\b(?:feat\.?|ft\.|featuring)\s+[^)\]]*[)\]]?/g;

/** Bracketed groups: `(…)`, `[…]`. */
const BRACKETED = /\s*[([]([^)\]]*)[)\]]/g;

/** Words dropped entirely ("the" per docs/sources/songsterr.md). */
const STOP_WORDS: ReadonlySet<string> = new Set(['the']);

/**
 * Normalise a song title or artist for matching. Removes `feat.` credits, bracketed or dash-separated
 * version suffixes (live, remaster, …), diacritics, apostrophes, other punctuation and the word "the";
 * `&` becomes "and". Returns space-separated lower-case words (possibly empty).
 * @example normalizeTitle('The Trooper (2015 Remaster)') === 'trooper'
 */
export function normalizeTitle(raw: string): string {
  let s = raw.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  s = s.replace(FEATURING, ' ');
  s = s.replace(BRACKETED, (whole, inner: string) => (VERSION_WORDS.test(inner) ? ' ' : ` ${inner} `));
  // "Song - Live at Wembley", "Song – 2011 Remaster": drop a dash-separated version tail.
  s = s.replace(/\s[-–—]\s([^-–—]*)$/u, (whole, tail: string) => (VERSION_WORDS.test(tail) ? '' : whole));
  s = s.replace(/&/g, ' and ').replace(/['’`]/g, '');
  return words(s.replace(/[^\p{L}\p{N}]+/gu, ' ')).join(' ');
}

function words(s: string): string[] {
  return s.split(' ').filter((w) => w && !STOP_WORDS.has(w));
}

/** Normalised word set of an entry's title, artist and composer. */
function entryWords(entry: IndexEntry): Set<string> {
  const parts = [entry.title, entry.artist ?? '', entry.composer ?? ''];
  return new Set(parts.flatMap((p) => normalizeTitle(p).split(' ')).filter(Boolean));
}

/**
 * Ids of `entries` whose normalised title + artist/composer contain every normalised word of `query`
 * (order-free, whole words). An empty normalised query matches nothing. Pure; `O(entries × words)`.
 */
export function matchLocalEntries(query: string, entries: readonly IndexEntry[]): string[] {
  const wanted = normalizeTitle(query).split(' ').filter(Boolean);
  if (!wanted.length) return [];
  const out: string[] = [];
  for (const entry of entries) {
    const have = entryWords(entry);
    if (wanted.every((w) => have.has(w))) out.push(entry.id);
  }
  return out;
}
