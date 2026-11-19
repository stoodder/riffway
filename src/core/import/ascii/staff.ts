/**
 * Column-wise tokeniser for one 6-line staff block: multi-digit frets, `h p / \ s b r ~ x t`,
 * `(n)` ghost, `<n>` natural harmonic, `=` sustain, `*`/`:` repeat dots, `|`/`||` bar lines.
 * @module
 */
import type { StringNumber, Tech } from '@shared/song';
import type { AsciiNote } from './types';

/** A note plus the character span it occupies (used to group chords). */
export interface RawNote extends AsciiNote {
  spanStart: number;
  spanEnd: number;
}

/** Highest fret read as one two-digit number; `35` is read as 3 then 5. */
const MAX_TWO_DIGIT_FRET = 24;
/** Bend amount assumed when a `b` has no target fret (a full bend). */
const DEFAULT_BEND_SEMITONES = 2;

interface Token {
  kind: 'note' | 'bar';
  start: number;
  end: number;
  note?: RawNote;
}

/** Tokenise one staff line (`text` aligned so columns match the other lines of the block). */
function tokeniseLine(text: string, from: number, to: number, string: StringNumber, line: number): Token[] {
  const tokens: Token[] = [];
  const note = (fret: number, column: number, start: number, end: number, tech: Tech): void => {
    tokens.push({ kind: 'note', start, end, note: { string, fret, column, line, tech, spanStart: start, spanEnd: end } });
  };
  let i = from;
  while (i < to) {
    const ch = text[i];
    if (ch === '|') {
      tokens.push({ kind: 'bar', start: i, end: i + 1 });
      i++;
    } else if (ch === 'x' || ch === 'X') {
      note(0, i, i, i + 1, { dead: true });
      i++;
    } else if ((ch === '(' || ch === '<') && /\d/.test(text[i + 1] ?? '')) {
      const close = ch === '(' ? ')' : '>';
      const m = /^\d{1,2}/.exec(text.slice(i + 1, to));
      const digits = m ? m[0] : '';
      if (text[i + 1 + digits.length] === close) {
        note(Number(digits), i + 1, i, i + digits.length + 2, ch === '(' ? { ghost: true } : { harmonic: 'natural' });
        i += digits.length + 2;
      } else {
        i++;
      }
    } else if (/\d/.test(ch)) {
      let j = i;
      while (j < to && /\d/.test(text[j])) j++;
      let k = i;
      while (k < j) {
        const two = k + 1 < j ? Number(text.slice(k, k + 2)) : Infinity;
        const len = two <= MAX_TWO_DIGIT_FRET ? 2 : 1;
        note(Number(text.slice(k, k + len)), k, k, k + len, {});
        k += len;
      }
      i = j;
    } else {
      i++;
    }
  }
  return tokens;
}

/**
 * Apply the technique marks found in `text[gapStart, gapEnd)` between two tokens on one string.
 * Returns true when `cur` is a bend target / release fret (consumed, not a new onset).
 */
function connect(text: string, prev: RawNote | null, cur: RawNote | null, gapStart: number, gapEnd: number, state: { bendOrigin: RawNote | null; lastWasTarget: boolean }): boolean {
  const gap = text.slice(gapStart, gapEnd);
  const crossesBar = gap.includes('|');

  if (prev && cur && !crossesBar) {
    const g = gap.toLowerCase();
    if (g === 'h' || g === 'p' || g === 't') {
      if (cur.fret >= prev.fret) prev.tech.hammerOn = true;
      else prev.tech.pullOff = true;
      cur.tech.legatoDest = true;
    } else if (g === '/' || g === '\\' || g === 's') {
      prev.tech.slide = 'legato';
      cur.tech.legatoDest = true;
    } else if ((g === 'b' || g === '^') && !prev.tech.dead) {
      prev.tech.bend = { semitones: Math.max(1, cur.fret - prev.fret) };
      state.bendOrigin = prev;
      state.lastWasTarget = true;
      return true;
    } else if (g === 'r' && state.lastWasTarget && state.bendOrigin) {
      state.bendOrigin.tech.bend = { semitones: state.bendOrigin.tech.bend?.semitones ?? DEFAULT_BEND_SEMITONES, release: true };
      state.lastWasTarget = true;
      return true;
    }
  }

  // Marks attached to the previous note only.
  const after = crossesBar ? gap.slice(0, gap.indexOf('|')) : gap;
  if (prev) {
    const sustain = /^=+/.exec(after);
    if (sustain) prev.sustainEnd = gapStart + sustain[0].length;
    if (/^[~v]/.test(after)) prev.tech.vibrato = true;
    if (/^[/]-/.test(after) || (after === '/' && !cur)) prev.tech.slide ??= 'out-up';
    if (/^[\\]-/.test(after) || (after === '\\' && !cur)) prev.tech.slide ??= 'out-down';
    if (/^[b^](?![\d(])/.test(after) && !prev.tech.bend && !prev.tech.dead) {
      prev.tech.bend = { semitones: DEFAULT_BEND_SEMITONES, release: /^[b^]r/i.test(after) || undefined };
      if (!prev.tech.bend.release) delete prev.tech.bend.release;
    }
  }
  // Marks attached to the current note only.
  const before = crossesBar ? gap.slice(gap.lastIndexOf('|') + 1) : gap;
  if (cur && (before.length > 1 || !prev || crossesBar)) {
    if (/-\/$|^\/$/.test(before)) cur.tech.slide = 'in-below';
    else if (/-\\$|^\\$/.test(before)) cur.tech.slide = 'in-above';
    else if (/[-|]?[hHtT]$/.test(before) && before.length > 1) cur.tech.legatoDest = true;
  }
  state.lastWasTarget = false;
  return false;
}

/**
 * Tokenise a block. `lines` are aligned (all bodies start at the same column); `from`/`to` bound
 * the body columns per line; `startLine` is the 1-based source line of the top line.
 */
export function tokeniseBlock(
  lines: readonly string[],
  bodies: readonly { from: number; to: number }[],
  startLine: number,
): { notes: RawNote[]; barColumns: number[] } {
  const notes: RawNote[] = [];
  const barCount = new Map<number, number>();
  lines.forEach((text, idx) => {
    const string = (idx + 1) as StringNumber;
    const { from, to } = bodies[idx];
    const tokens = tokeniseLine(text, from, to, string, startLine + idx);
    const state = { bendOrigin: null as RawNote | null, lastWasTarget: false };
    let prev: RawNote | null = null;
    let cursor = from;
    for (const t of tokens) {
      if (t.kind === 'bar') {
        barCount.set(t.start, (barCount.get(t.start) ?? 0) + 1);
        continue;
      }
      const cur = t.note as RawNote;
      if (connect(text, prev, cur, cursor, cur.spanStart, state)) {
        cursor = cur.spanEnd;
        continue;
      }
      notes.push(cur);
      prev = cur;
      cursor = cur.spanEnd;
    }
    connect(text, prev, null, cursor, to, state);
  });
  // A column is a bar line when at least half the strings have `|` there.
  const barColumns = [...barCount.entries()].filter(([, n]) => n >= 3).map(([c]) => c).sort((a, b) => a - b);
  return { notes, barColumns };
}
