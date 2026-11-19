/**
 * Song names from file names: `Artist - Title.txt` (how pasted tabs are saved) and ClassTab's
 * `composer[_firstname]_[opus]_[title]` convention (docs/sources/classtab.md § Layout).
 * @module
 */

/** File stem: the base name without folders and extension. */
const stemOf = (fileName: string): string => fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

/** `Artist - Title.txt` → both parts; otherwise the humanised stem as the title. */
export function namesFromFile(fileName: string): { title: string; artist?: string } {
  const base = stemOf(fileName);
  const dash = /^(.+?)\s+-\s+(.+)$/.exec(base);
  if (dash) return { artist: dash[1].trim(), title: dash[2].trim() };
  return { title: base.replace(/_+/g, ' ').trim() || 'Untitled' };
}

/** First file-name words that are not a composer (`the_legend_of_zelda_…`). */
const NOT_COMPOSERS = new Set(['the', 'a', 'an']);
/** Composer keys ClassTab abbreviates. */
const KEY_NAMES: Readonly<Record<string, string>> = { anon: 'Anonymous', trad: 'Traditional' };
/** Header spellings that agree with a key (`anon` ↔ "Traditional", "Anonymous"). */
const KEY_SYNONYMS: Readonly<Record<string, readonly string[]>> = { anon: ['anon', 'trad'], trad: ['trad', 'anon'] };

/** Lower-case, accents removed (`Tárrega` → `tarrega`). */
const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * Composer of a ClassTab tab. The file name starts with the composer's surname (`sor_op60_no10.txt`,
 * `castelnuovo-tedesco_…`, `anon_…`). The header's composer is kept when it is `confirmed` (a
 * `Composer:` label or life dates) or names that composer ("Fernando Sor"); otherwise (no composer in
 * the header, or a title part misread as one, such as "II. Intermezzo") the file name's is used. Returns
 * the header's composer unchanged when the file name does not start with a composer.
 */
export function classTabComposer(fileName: string, headerComposer: string | undefined, confirmed = false): string | undefined {
  if (headerComposer && confirmed) return headerComposer;
  const key = fold(stemOf(fileName).split('_')[0] ?? '');
  if (!/^[a-z][a-z'-]*$/.test(key) || NOT_COMPOSERS.has(key)) return headerComposer;
  const header = headerComposer ? fold(headerComposer) : '';
  const spellings = KEY_SYNONYMS[key] ?? [key, ...key.split('-')];
  if (header && spellings.some((s) => s.length >= 3 && header.includes(s))) return headerComposer;
  return KEY_NAMES[key] ?? key.replace(/(^|[-'])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}
