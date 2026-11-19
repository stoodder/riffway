/**
 * ClassTab tab ↔ MIDI pairing (docs/sources/classtab.md § Pairing tabs with MIDI): exact basename,
 * suffixed variants, the `MIDI:` header URL, and multi-version tabs. Pure: works on names (+ text).
 * @module
 */
import { splitVersions } from '../ascii/parse';

/** A file in the ClassTab data dir (name only; `text` when header URLs should be read). */
export interface ClassTabFile {
  name: string;
  text?: string;
}

/** How a tab got its MIDI. */
export type PairRule = 'basename' | 'suffix' | 'header-url' | 'version';

/** One pairing result per tab (multi-version tabs yield one row per version). */
export interface ClassTabPair {
  tab: string;
  midi: string | null;
  rule: PairRule | null;
  /** 1-based version number inside a multi-version tab. */
  version?: number;
}

/** Suffixes tried after the exact basename, in order (`x_1.mid`, `x_01.mid`, `x_a.mid`, `x_duet.mid`). */
export const MIDI_SUFFIXES: readonly string[] = ['_1', '_01', '_a', '_duet'];

const stem = (name: string): string => name.replace(/\.[^.]+$/, '');
const ext = (name: string): string => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

/** File name (without directories or query) from a `MIDI:` header URL. */
function urlFileName(url: string): string | null {
  const path = url.replace(/[?#].*$/, '');
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (!/\.midi?$/i.test(last)) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Every `MIDI:` URL in a text, in order. */
function midiUrls(text: string): string[] {
  return [...text.matchAll(/\bMIDI\s*:\s*(\S+?\.midi?)(?=$|[\s)>,;])/gim)].map((m) => m[1]);
}

/**
 * Pair ClassTab `.txt` files with `.mid` files. Rules, in order: exact basename (`x.txt` ↔ `x.mid`);
 * suffixed variants ({@link MIDI_SUFFIXES}); the `MIDI: http://www.classtab.org/<name>.mid` header
 * URL. A tab whose text holds several versions yields one row per version: version *k* pairs with the
 * *k*-th numbered MIDI (`x_k` / `x_0k`), else with the URL in that version's header, else (version 1
 * only) with the exact basename. A MIDI that exactly matches another tab's basename is never taken
 * by a suffix rule. Names compare case-insensitively; non-`.txt` files and `0_readme.txt` are skipped.
 */
export function pairClassTab(files: readonly ClassTabFile[]): ClassTabPair[] {
  const midis = new Map<string, string>();
  for (const f of files) if (ext(f.name) === 'mid' || ext(f.name) === 'midi') midis.set(stem(f.name).toLowerCase(), f.name);
  const tabs = files.filter((f) => ext(f.name) === 'txt' && f.name.toLowerCase() !== '0_readme.txt');
  const tabStems = new Set(tabs.map((t) => stem(t.name).toLowerCase()));
  const byName = (name: string | null): string | null => (name ? midis.get(stem(name).toLowerCase()) ?? null : null);
  const suffixed = (base: string, suffix: string): string | null => {
    const key = `${base}${suffix}`;
    return tabStems.has(key) ? null : midis.get(key) ?? null;
  };

  const out: ClassTabPair[] = [];
  for (const tab of tabs) {
    const base = stem(tab.name).toLowerCase();
    const regions = tab.text ? splitVersions(tab.text) : [];
    if (regions.length > 1) {
      for (const r of regions) {
        const k = r.version;
        const numbered = suffixed(base, `_${k}`) ?? suffixed(base, `_${String(k).padStart(2, '0')}`);
        const fromUrl = midiUrls(r.text).map(urlFileName).map(byName).find((m) => m !== null) ?? null;
        const exact = k === 1 ? midis.get(base) ?? null : null;
        if (numbered) out.push({ tab: tab.name, midi: numbered, rule: 'version', version: k });
        else if (fromUrl) out.push({ tab: tab.name, midi: fromUrl, rule: 'header-url', version: k });
        else if (exact) out.push({ tab: tab.name, midi: exact, rule: 'basename', version: k });
        else out.push({ tab: tab.name, midi: null, rule: null, version: k });
      }
      continue;
    }
    const exact = midis.get(base);
    if (exact) {
      out.push({ tab: tab.name, midi: exact, rule: 'basename' });
      continue;
    }
    const suffix = MIDI_SUFFIXES.map((s) => suffixed(base, s)).find((m) => m !== null);
    if (suffix) {
      out.push({ tab: tab.name, midi: suffix, rule: 'suffix' });
      continue;
    }
    const fromUrl = tab.text ? midiUrls(tab.text).map(urlFileName).map(byName).find((m) => m !== null) ?? null : null;
    out.push(fromUrl ? { tab: tab.name, midi: fromUrl, rule: 'header-url' } : { tab: tab.name, midi: null, rule: null });
  }
  return out;
}
