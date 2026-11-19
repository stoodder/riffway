/**
 * Tolerant header parsing for ASCII tabs (ClassTab and UG styles): title/composer/artist, tuning
 * (note names or prose such as `6=D`, `6th string to D`, `drop D`), key, time, tempo, capo, MIDI URL.
 * @module
 */
import type { AsciiHeader } from './types';
import { STANDARD_TUNING, nearestPitch, pitchClassOf, splitNoteNames, tuningFromPitchClasses } from './pitch';

/** `(1778-1839)`, `(1750–1836)`, `(b. 1950)`: life dates mark a composer. */
const LIFE_DATES = /\(\s*(?:b\.\s*|c\.\s*)?\d{3,4}\s*(?:[-–—?]\s*(?:c\.\s*)?\d{0,4}\s*)?\??\)/;
/** Lower-case words allowed inside a person's name. */
const NAME_PARTICLES = new Set(['de', 'del', 'della', 'di', 'da', 'van', 'von', 'der', 'den', 'la', 'le', 'y', 'du', 'dos', 'das']);

const FIELD_LINE = /^\s*(?:title|song|artist|band|composer|music|tuning|tune|key|time|tempo|speed|capo|midi|video|vid|mp3|editions?|sheet|tabbed|tab|transcribed|arranged|arr\.?|see|notes?|legend|difficulty|author|email|https?:)\b/i;

/** True when `s` looks like a person's name: 1–5 capitalised words, no digits. */
function looksLikeName(s: string): boolean {
  const words = s.trim().split(/\s+/);
  if (words.length === 0 || words.length > 5 || /\d/.test(s)) return false;
  return words.every((w) => /^[A-ZÀ-Þ][\p{L}'.-]*$/u.test(w) || NAME_PARTICLES.has(w.toLowerCase()));
}

/** Collapse whitespace and trim. */
function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Split `Title - Composer (dates)` / `Composer - Title` / `Composer (dates)` into parts. */
function parseTitleLine(line: string): { title?: string; composer?: string; dated?: boolean } {
  const parts = line.split(/\s+[-–—]\s+/).map(clean).filter((p) => p.length > 0);
  const dated = parts.findIndex((p) => LIFE_DATES.test(p));
  let composerIdx = -1;
  if (dated >= 0) composerIdx = dated;
  else if (parts.length >= 2 && looksLikeName(parts[parts.length - 1])) composerIdx = parts.length - 1;
  else if (parts.length >= 2 && looksLikeName(parts[0])) composerIdx = 0;
  if (composerIdx < 0) return { title: clean(line) };
  const composer = clean(parts[composerIdx].replace(LIFE_DATES, ''));
  const rest = parts.filter((_, i) => i !== composerIdx).join(' - ');
  return { composer: composer || undefined, title: rest || undefined, dated: dated >= 0 };
}

/** Parse a tempo out of one line; returns quarter-note BPM or undefined. */
export function parseTempo(line: string): number | undefined {
  const scale = (unit: string | undefined): number => {
    if (!unit) return 1;
    const u = unit.toLowerCase();
    if (/dotted\s*(?:quarter|crotchet|q)/.test(u)) return 1.5;
    if (/eighth|quaver|8th/.test(u)) return 0.5;
    if (/half|minim/.test(u)) return 2;
    return 1;
  };
  const inRange = (bpm: number): number | undefined => (bpm >= 20 && bpm <= 400 ? bpm : undefined);
  let m = /(?:^|[\s(:])(?:q|♩|quarter(?:\s*note)?)\s*=\s*(\d{2,3})\b/i.exec(line);
  if (m) return inRange(Number(m[1]));
  m = /\b(?:tempo|speed)\b\s*[:=-]?\s*(?:\(([^)]*)\)\s*)?(\d{2,3})\s*(?:bpm|beats\s+per\s+minute)?(?:\s*\(([^)]*)\))?/i.exec(line);
  if (m) return inRange(Math.round(Number(m[2]) * scale(m[1] ?? m[3])));
  m = /\b(\d{2,3})\s*(?:bpm|beats\s+per\s+minute)\b(?:\s*\(([^)]*)\))?/i.exec(line);
  if (m) {
    const before = line.slice(0, m.index);
    const unit = m[2] ?? /\(([^)]*)\)\s*$/.exec(before)?.[1];
    return inRange(Math.round(Number(m[1]) * scale(unit)));
  }
  return undefined;
}

/** Parse a time signature out of one line. */
export function parseTimeSig(line: string): [number, number] | undefined {
  const m =
    /\btime(?:\s*sig(?:nature)?)?\s*[:=-]?\s*(\d{1,2})\s*\/\s*(\d{1,2})\b/i.exec(line) ??
    /\b(\d{1,2})\s*\/\s*(\d{1,2})\s+time\b/i.exec(line) ??
    /\b(?:played|in)\s+(?:in\s+)?(\d{1,2})\s*\/\s*(\d{1,2})\b(?!\s*\/)/i.exec(line);
  if (!m) return undefined;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (num < 1 || num > 32 || ![1, 2, 4, 8, 16, 32].includes(den)) return undefined;
  return [num, den];
}

/** Parse a capo position (`capo 2`, `Capo: 3rd fret`, `capo VII`, `no capo`). */
export function parseCapo(line: string): number | undefined {
  if (/\bno\s+capo\b/i.test(line)) return 0;
  const m = /\bcapo\b\s*(?:on|at|is|:|-|=)?\s*(?:the\s+)?(?:fret\s*)?(\d{1,2}|[IVX]{1,5})(?:st|nd|rd|th)?\b/i.exec(line);
  if (!m) return undefined;
  const raw = m[1];
  const n = /^\d+$/.test(raw) ? Number(raw) : romanToInt(raw.toUpperCase());
  return n !== undefined && n >= 0 && n <= 15 ? n : undefined;
}

function romanToInt(s: string): number | undefined {
  const val: Record<string, number> = { I: 1, V: 5, X: 10 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = val[s[i]];
    const next = val[s[i + 1]] ?? 0;
    if (v === undefined) return undefined;
    total += v < next ? -v : v;
  }
  return total;
}

/** Parse `key: G major`, `Key - C`, `key of Em`. */
export function parseKey(line: string): string | undefined {
  const m = /\bkey\b\s*(?:of\s+)?[:=-]?\s*([A-G][#b♯♭]?)(\s*(?:major|minor|maj|min|m)\b)?/i.exec(line);
  if (!m) return undefined;
  const root = m[1][0].toUpperCase() + m[1].slice(1);
  const mode = m[2]?.trim().toLowerCase();
  if (!mode) return root;
  return /^(?:minor|min|m)$/.test(mode) ? `${root} minor` : `${root} major`;
}

/**
 * Tuning from a `tuning:` line (note names, `standard`, `drop D`, `half step down`). Returns null
 * when the line names no tuning.
 */
export function parseTuningLine(line: string): number[] | null {
  const m = /\btun(?:ing|ed|e)\b\s*(?:is)?\s*[:=-]?\s*(.*)$/i.exec(line);
  if (!m) return null;
  // Stop at the next field on the same line (`key:`, `time:`, `tempo:` …).
  const segment = m[1].split(/\s{2,}|\b(?:key|time|tempo|speed|capo)\b/i)[0] ?? '';
  // Runs of consecutive note-name tokens; words (`6th`, `low`, `open`) break a run.
  const runs: string[][] = [[]];
  for (const token of segment.split(/[^A-Za-z0-9#♯♭]+/)) {
    if (!token) continue;
    const split = splitNoteNames(token);
    if (split && (split.length === 6 || token.length <= 2)) runs[runs.length - 1].push(...split);
    else if (runs[runs.length - 1].length > 0) runs.push([]);
  }
  const names = runs.find((r) => r.length >= 6);
  if (names) {
    // `open G: D G D G B D` → the last six names. Written low → high (E A D G B E) unless it is
    // clearly high → low (e B G D A E).
    const six = names.slice(-6);
    const highFirst = six[0] === 'e' && six[5] === 'E';
    const ordered = highFirst ? six : [...six].reverse();
    const pcs = ordered.map((n) => pitchClassOf(n));
    if (pcs.every((p): p is number => p !== null)) return tuningFromPitchClasses(pcs);
  }
  return prose(line) ?? (/\bstandard\b/i.test(segment) ? [...STANDARD_TUNING] : null);
}

/** Whole-tuning prose: drop D, half/whole step down. */
function prose(line: string): number[] | null {
  if (/\bdrop(?:ped)?[\s-]*d\b/i.test(line)) return [64, 59, 55, 50, 45, 38];
  if (/half[\s-]*(?:step|tone)\s*down|\bE[b♭]\s*(?:standard|tuning)|tuned\s+down\s+(?:a\s+)?half/i.test(line)) {
    return STANDARD_TUNING.map((p) => p - 1);
  }
  if (/(?:whole|full)[\s-]*(?:step|tone)\s*down|\bD\s+standard\b/i.test(line)) return STANDARD_TUNING.map((p) => p - 2);
  return null;
}

/** Per-string overrides in prose: `6=D`, `(6) = D`, `6th string to D`, `Tune 6th to D`. */
export function parseStringOverrides(line: string): Map<number, number> {
  const out = new Map<number, number>();
  const re = /\(?\b([1-6])\)?(?:st|nd|rd|th)?\s*(?:string)?\s*(?:=|to|tuned\s+(?:down\s+|up\s+)?to|down\s+to|up\s+to|->|→)\s*([A-G][#b♯♭]?)(?![A-Za-z])/gi;
  for (const m of line.matchAll(re)) {
    if (m[2][0] !== m[2][0].toUpperCase()) continue; // `6 to a` is prose, `6 to A` a tuning
    const string = Number(m[1]);
    const pc = pitchClassOf(m[2]);
    if (pc !== null) out.set(string, pc);
  }
  return out;
}

/**
 * Parse header lines (the text before the first staff block). `fallback` supplies fields from an
 * earlier region (multi-version tabs restate tuning/MIDI per version but not the title).
 */
export function parseHeader(lines: readonly string[], fallback: AsciiHeader = {}): AsciiHeader {
  const header: AsciiHeader = {};
  let tuning: number[] | null = null;
  const overrides = new Map<number, number>();
  let titleLineSeen = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const labelled = /^(title|song|artist|band|composer|music\s+by|by)\s*[:=-]\s*(.+)$/i.exec(line);
    if (labelled) {
      const key = labelled[1].toLowerCase();
      const value = clean(labelled[2]);
      if (key === 'title' || key === 'song') header.title ??= value;
      else if ((key === 'composer' || key === 'music by') && !header.composer) {
        header.composer = clean(value.replace(LIFE_DATES, ''));
        header.composerConfirmed = true;
      } else if (key !== 'composer' && key !== 'music by') header.artist ??= value;
      titleLineSeen = true;
      continue;
    }

    const midi = /\bMIDI\s*:\s*(\S+?\.midi?)(?=$|[\s)>,;])/i.exec(line);
    if (midi) header.midiUrl ??= midi[1];

    if (/\btun(?:ing|ed|e)\b/i.test(line)) tuning ??= parseTuningLine(line);
    else tuning ??= prose(line);
    for (const [s, pc] of parseStringOverrides(line)) overrides.set(s, pc);

    header.key ??= parseKey(line);
    header.timeSig ??= parseTimeSig(line);
    header.tempo ??= parseTempo(line);
    header.capo ??= parseCapo(line);

    if (!titleLineSeen && !FIELD_LINE.test(line) && !/https?:\/\/|@/.test(line) && /\p{L}/u.test(line)) {
      titleLineSeen = true;
      const parsed = parseTitleLine(line);
      header.title ??= parsed.title;
      if (!header.composer && parsed.composer) {
        header.composer = parsed.composer;
        if (parsed.dated) header.composerConfirmed = true;
      }
    } else if (titleLineSeen && !header.title && header.composer && !FIELD_LINE.test(line) && !/https?:\/\/|@|[:=]/.test(line)) {
      // `Composer (dates)` on line 1, the title on the next plain line.
      header.title = clean(line);
    }
  }

  if (tuning || overrides.size > 0) {
    const base = tuning ?? fallback.tuning ?? [...STANDARD_TUNING];
    const result = [...base];
    for (const [string, pc] of overrides) result[string - 1] = nearestPitch(pc, STANDARD_TUNING[string - 1]);
    header.tuning = result;
  }

  return {
    ...fallback,
    ...Object.fromEntries(Object.entries(header).filter(([, v]) => v !== undefined)),
  };
}
