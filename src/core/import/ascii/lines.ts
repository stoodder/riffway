/**
 * Line classification for ASCII tab: staff lines (labelled or not) and the annotation lines around
 * staff blocks (beat rulers, `PM----` / `let ring` spans, chord names, section names, repeat
 * markers, the ClassTab "Notes & Legend" heading, multi-version boundaries).
 * @module
 */

/** A line recognised as one string of a staff. */
export interface StaffLine {
  /** Label as written (`e`, `B`, `D#`, `Eb`) or null. */
  label: string | null;
  /** Column of the first body character (after label and spaces). */
  bodyStart: number;
  /** Column after the last body character. */
  bodyEnd: number;
  /** Normalised line text (tabs expanded, Unicode dashes → `-`). */
  text: string;
  /** Repeat count written at the end of the line (`|  x2`), if any. */
  repeat?: number;
  /** Structural strength used to split runs of staff-like lines into 6-line blocks. */
  hasNote: boolean;
  hasBar: boolean;
}

/** A beat-ruler mark: `|` (beat) or `.` (subdivision) in ClassTab style; `1 & 2 &` count style. */
export interface RulerMark {
  column: number;
  beat: boolean;
}

/** Characters allowed inside a staff body. */
const BODY_CHARS = new Set('-|:0123456789/\\~()<>[]{}.=*^hHpPbrRsSxXtTgv+\'!,'.split(''));
/** Characters a staff body may start with. */
const BODY_START = /[|:\-=[{(<*]/;

/** Expand tabs (8-column stops), map NBSP to space and Unicode dashes/box lines to ASCII. */
export function normaliseLine(line: string): string {
  let out = line
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u2010-\u2015\u2212\u2500\u2501]/g, '-')
    .replace(/[\u2502\u2503]/g, '|');
  if (out.includes('\t')) {
    let expanded = '';
    for (const ch of out) {
      if (ch === '\t') expanded += ' '.repeat(8 - (expanded.length % 8));
      else expanded += ch;
    }
    out = expanded;
  }
  return out.replace(/\s+$/, '');
}

/** Repeat count in a free-standing marker (`x2`, `(x3)`, `[2x]`, `repeat 4 times`, `play 2x`); null otherwise. */
export function repeatMarker(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const m =
    /^[[(]?\s*(?:repeat|play)?\s*(?:[x×*]\s*(\d{1,2})|(\d{1,2})\s*(?:[x×]|times))\s*[\])]?$/i.exec(t) ??
    /^[[(]?\s*(?:repeat|play)(?:\s+(?:this|it|above))?\s+(\d{1,2})\s*(?:x|times)?\s*[\])]?$/i.exec(t);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  return n >= 1 && n <= 32 ? n : null;
}

/** Recognise one string of a staff; null for anything else. Input must be normalised. */
export function parseStaffLine(text: string): StaffLine | null {
  let work = text;
  let repeat: number | undefined;
  // `|---|  x2` / `---- (x4)` at the end of the line.
  const tail = /(\||\s)\s*([[(]?\s*(?:repeat\s*|play\s*)?(?:[x×]\s*\d{1,2}|\d{1,2}\s*(?:[x×]|times))\s*[\])]?)\s*$/i.exec(work);
  if (tail) {
    const n = repeatMarker(tail[2]);
    if (n !== null) {
      repeat = n;
      work = work.slice(0, tail.index + (tail[1] === '|' ? 1 : 0));
    }
  }

  const prefix = /^(\s*)([A-Ga-g][#b♯♭]?)?(\s*)/.exec(work);
  if (!prefix) return null;
  const label: string | null = prefix[2] ?? null;
  const bodyStart = prefix[0].length;
  if (bodyStart >= work.length) return null;
  if (label !== null && !BODY_START.test(work[bodyStart])) return null;
  if (label === null && !BODY_START.test(work[bodyStart]) && !/\d/.test(work[bodyStart])) return null;

  let end = bodyStart;
  while (end < work.length) {
    const ch = work[end];
    if (BODY_CHARS.has(ch)) {
      end++;
      continue;
    }
    // A single space inside a staff is tolerated when the staff continues right after it.
    if (ch === ' ' && end + 1 < work.length && /[-|=]/.test(work[end + 1]) && work[end - 1] !== ' ') {
      end++;
      continue;
    }
    break;
  }
  // Trailing letters belong to an annotation (`|--- hold`), except technique marks right after a fret.
  while (end > bodyStart && /[A-Za-z]/.test(work[end - 1]) && !/[0-9)>]/.test(work[end - 2] ?? '')) end--;
  const body = work.slice(bodyStart, end);
  // A label followed by a bar line is strong evidence; bare lines need more dashes.
  const strong = label !== null && /^[|:]/.test(body);
  if (body.length < (strong ? 3 : 4)) return null;
  const dashes = (body.match(/-/g) ?? []).length;
  const sustain = (body.match(/=/g) ?? []).length;
  const visible = body.replace(/\s/g, '').length;
  if (dashes < 1 || dashes + sustain < (strong ? 2 : 4) || (dashes + sustain) / visible < 0.3) return null;
  if (repeat === undefined) {
    const n = repeatMarker(work.slice(end));
    if (n !== null) repeat = n;
  }
  return {
    label,
    bodyStart,
    bodyEnd: end,
    text: work,
    repeat,
    hasNote: /[0-9xX]/.test(body),
    hasBar: body.includes('|'),
  };
}

/**
 * Beat ruler: ClassTab `0   .   | . . | . .` (optional leading bar number, then `|` beats and `.`
 * subdivisions; only above a staff) or count style `1 & 2 & 3 & 4 &` (above or below). Returns the
 * marks with columns, or null.
 */
export function parseRuler(text: string, position: 'above' | 'below'): RulerMark[] | null {
  // Trailing words (`… | . . Fine`) are performance directions, not marks.
  const marksText = text.replace(/\s+[A-Za-z][A-Za-z .,'()-]*$/, '');
  const weed = /^(\s*(?:\(?\d{1,4}\)?(?=\s))?)([\s|.]*)$/.exec(marksText);
  if (weed && /[|.]/.test(weed[2])) {
    if (position === 'below') return null;
    const marks: RulerMark[] = [];
    for (let i = weed[1].length; i < marksText.length; i++) {
      if (marksText[i] === '|' || marksText[i] === '.') marks.push({ column: i, beat: marksText[i] === '|' });
    }
    // Stray `|` pairs are not a ruler; demand at least two marks and a beat.
    if (marks.length >= 2 && marks.some((m) => m.beat) && !/\|\|/.test(marksText)) return marks;
    if (marks.length >= 2 && marks.every((m) => !m.beat) && /^\s*\(?\d/.test(marksText)) return marks;
    return null;
  }
  const tokens = [...text.matchAll(/\S+/g)];
  if (tokens.length < 3) return null;
  if (!tokens.every((t) => /^(?:[1-9]|1[0-2]|&|\+|e|a|n|\.|trip|let)$/.test(t[0]))) return null;
  if (!tokens.some((t) => t[0] === '&' || t[0] === '+') || !tokens.some((t) => /^\d+$/.test(t[0]))) return null;
  return tokens.map((t) => ({ column: t.index ?? 0, beat: /^\d+$/.test(t[0]) }));
}

/** `PM----|`, `P.M. - - -`, `let ring----` spans as `[start, end)`; null when the line is not such a line. */
export function parseSpanLine(text: string, kind: 'pm' | 'ring'): [number, number][] | null {
  const token = kind === 'pm' ? /P\.?\s?M\.?/iy : /(?:let\s*ring|l\.\s?r\.)/iy;
  const spans: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === ' ') {
      i++;
      continue;
    }
    token.lastIndex = i;
    const m = token.exec(text);
    if (!m) return null;
    const start = i;
    i += m[0].length;
    while (i < text.length && /[-_.~|>]/.test(text[i])) i++;
    // `PM` alone covers the note right below it (and a two-digit fret).
    spans.push([start, Math.max(i, start + 2)]);
  }
  return spans.length > 0 ? spans : null;
}

const CHORD_TOKEN =
  /^\(?(?:[A-G][#b]?(?:maj|min|dim|aug|sus|add|m|M|\+|°|ø)?\d{0,2}(?:(?:sus|add|maj|b|#|\+|-)\d{1,2})*(?:\/[A-G][#b]?)?|N\.?C\.?)\)?\*?$/;

/** UG-style chord-name line (`Am     G/B   F#m7`): tokens with columns, or null. */
export function parseChordLine(text: string): { column: number; name: string }[] | null {
  const tokens = [...text.matchAll(/\S+/g)];
  if (tokens.length === 0 || !tokens.every((t) => CHORD_TOKEN.test(t[0]))) return null;
  return tokens.map((t) => ({ column: t.index ?? 0, name: t[0].replace(/^\(|\)$/g, '') }));
}

const SECTION_WORDS =
  'intro|verse|chorus|pre[- ]?chorus|bridge|solo|guitar solo|outro|interlude|riff|main riff|breakdown|coda|refrain|ending|instrumental|hook|fill|theme|part [a-z0-9]+';

/** Section heading (`[Chorus]`, `Verse 2:`, `Solo (x2)`): the name, or null. */
export function parseSectionLine(text: string): string | null {
  const bracket = /^\s*\[\s*([^\]]{1,40}?)\s*\]\s*(?:\(?\s*x?\d*x?\s*\)?)?\s*:?\s*$/.exec(text);
  if (bracket && !/^[\d\sx]+$/i.test(bracket[1])) return bracket[1];
  const word = new RegExp(`^\\s*((?:${SECTION_WORDS})(?:\\s*\\d+)?)\\s*(?:\\([^)]*\\))?\\s*:?\\s*$`, 'i').exec(text);
  if (!word) return null;
  const name = word[1].replace(/\s+/g, ' ');
  return name[0].toUpperCase() + name.slice(1);
}

/** ClassTab's trailing "Notes & Legend" heading (whole line). */
export function isNotesHeading(text: string): boolean {
  return /^\s*(?:notes?(?:\s*(?:&|and)\s*legend)?|legend(?:\s*(?:&|and)\s*notes?)?)\s*:?\s*$/i.test(text);
}

/** Start of another version inside a multi-version tab (`MIDI: …` or `version 2 …` after a staff). */
export function isVersionBoundary(text: string): boolean {
  return /^\s*MIDI\s*:/i.test(text) || /^\s*(?:version\s*\d+|\d+(?:st|nd|rd|th)\s+version)\b/i.test(text);
}
