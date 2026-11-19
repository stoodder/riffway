/**
 * ASCII tab parsing: staff-block detection, annotations, header, tuning and played-order onset
 * groups (docs/song-formats.md § ASCII tab parser, steps 1–6).
 * @module
 */
import type { ImportDiagnostic } from '@shared/song';
import type { AsciiBlock, AsciiHeader, AsciiNote, AsciiOnsetGroup, AsciiTab } from './types';
import { normaliseNewlines } from './decode';
import { parseHeader } from './header';
import {
  isFermataLine,
  isNotesHeading,
  isVersionBoundary,
  normaliseLine,
  parseChordLine,
  parseRuler,
  parseSectionLine,
  parseSpanLine,
  parseStaffLine,
  repeatMarker,
  type RulerMark,
  type StaffLine,
} from './lines';
import { STANDARD_TUNING, pitchClassOf, tuningFromPitchClasses } from './pitch';
import { tokeniseBlock, type RawNote } from './staff';

/** Options for {@link parseTabDetailed}. */
export interface ParseOptions {
  /** Source lines before `text` (multi-version regions): reported line numbers stay file-relative. */
  lineOffset?: number;
  /** Header fields inherited from an earlier region (title, composer…). */
  headerFallback?: AsciiHeader;
  /**
   * Play `x2` blocks and `|*` … `*|` repeats (default true). False keeps the written order, for a paired
   * MIDI that does not play the repeats.
   */
  repeats?: boolean;
}

/** One bar of a block: the columns bracketing it (`[start, end)` bar-line columns). */
export interface BlockBar {
  start: number;
  end: number;
}

/**
 * A run of consecutive bars of one block as played. A block is played whole once per `x2` pass;
 * `|*` … `*|` repeat signs split it into runs (the repeated bars are played again).
 */
export interface PlayedBlock {
  block: number;
  /** Earlier runs of the same block in played order (0 for the first). */
  pass: number;
  /** Index of the run's first bar in played order. */
  firstBar: number;
  /** Index of the run's first group in {@link AsciiTab.groups}; the run owns `groupCount` groups. */
  firstGroup: number;
  groupCount: number;
  /** The run's bars (a contiguous slice of the block's bars). */
  bars: BlockBar[];
  /** Beat-ruler marks (aligned columns), when the block has a ruler. */
  ruler?: RulerMark[];
}

/** {@link AsciiTab} plus the played-order layout the rhythm sources need. */
export interface DetailedTab {
  tab: AsciiTab;
  played: PlayedBlock[];
  /** Total bars in played order. */
  barCount: number;
  /** Section names by first played bar. */
  sections: { bar: number; name: string }[];
}

interface BlockGroup {
  column: number;
  spanEnd: number;
  notes: RawNote[];
}

/** Group notes of one block into onsets: overlapping character spans on different strings. */
function groupBlockNotes(notes: readonly RawNote[]): BlockGroup[] {
  const sorted = [...notes].sort((a, b) => a.spanStart - b.spanStart || a.string - b.string);
  const groups: BlockGroup[] = [];
  let cur: BlockGroup | null = null;
  for (const n of sorted) {
    if (cur && n.spanStart < cur.spanEnd && !cur.notes.some((m) => m.string === n.string)) {
      cur.notes.push(n);
      cur.spanEnd = Math.max(cur.spanEnd, n.spanEnd);
      cur.column = Math.min(cur.column, n.column);
      continue;
    }
    cur = { column: n.column, spanEnd: n.spanEnd, notes: [n] };
    groups.push(cur);
  }
  for (const g of groups) g.notes.sort((a, b) => a.string - b.string);
  return groups;
}

/** Bars of a block from its bar-line columns (`||` runs merged); notes outside bars get edge bars. */
function blockBars(barColumns: readonly number[], bodyStart: number, bodyEnd: number, groups: readonly BlockGroup[]): BlockBar[] {
  const runs: { start: number; end: number }[] = [];
  for (const c of barColumns) {
    const last = runs[runs.length - 1];
    if (last && c === last.end + 1) last.end = c;
    else runs.push({ start: c, end: c });
  }
  if (runs.length === 0) return [{ start: bodyStart - 1, end: bodyEnd }];
  const hasNotes = (a: number, b: number): boolean => groups.some((g) => g.column > a && g.column < b);
  const bars: BlockBar[] = [];
  if (hasNotes(bodyStart - 1, runs[0].start)) bars.push({ start: bodyStart - 1, end: runs[0].start });
  for (let i = 0; i + 1 < runs.length; i++) {
    const start = runs[i].end;
    const end = runs[i + 1].start;
    if (end - start > 2 || hasNotes(start, end)) bars.push({ start, end });
  }
  const lastRun = runs[runs.length - 1];
  if (hasNotes(lastRun.end, bodyEnd + 1)) bars.push({ start: lastRun.end, end: bodyEnd + 1 });
  return bars;
}

/** Bar indexes of a block that open (`|*`) or close (`*|`) a repeat. */
interface RepeatSigns {
  open: Set<number>;
  close: Set<number>;
}

/**
 * Repeat signs: a `*` on at least {@link REPEAT_DOT_LINES} strings in one column, right after (`|*`,
 * opens) or right before (`*|`, closes) a `|` on those lines. Each sign belongs to the bar holding
 * its column.
 */
function repeatSigns(lines: readonly string[], bodies: readonly { from: number; to: number }[], bars: readonly BlockBar[]): RepeatSigns {
  const open = new Map<number, number>();
  const close = new Map<number, number>();
  lines.forEach((text, idx) => {
    const { from, to } = bodies[idx];
    for (let c = from; c < to; c++) {
      if (text[c] !== '*') continue;
      if (text[c - 1] === '|') open.set(c, (open.get(c) ?? 0) + 1);
      if (text[c + 1] === '|') close.set(c, (close.get(c) ?? 0) + 1);
    }
  });
  const barsOf = (dots: Map<number, number>): Set<number> => {
    const out = new Set<number>();
    for (const [c, n] of dots) {
      const b = bars.findIndex((bar) => c > bar.start && c < bar.end);
      if (n >= REPEAT_DOT_LINES && b >= 0) out.add(b);
    }
    return out;
  };
  return { open: barsOf(open), close: barsOf(close) };
}

/** One bar of a block in written order (block `x2` passes already unrolled). */
interface WrittenBar {
  block: number;
  bar: number;
  open: boolean;
  close: boolean;
}

/**
 * Expand `|*` … `*|` repeats: a closing sign sends playback back once to the latest opening sign
 * (else to the bar after the previous closing sign, else to the start). Nested repeats are not
 * modelled: the inner opening sign wins.
 */
function expandRepeats(written: readonly WrittenBar[]): WrittenBar[] {
  const out: WrittenBar[] = [];
  const repeated = new Set<number>();
  let from = 0;
  for (let i = 0; i < written.length; i++) {
    if (written[i].open) from = i;
    out.push(written[i]);
    if (!written[i].close) continue;
    if (repeated.has(i)) {
      from = i + 1;
      continue;
    }
    repeated.add(i);
    i = from - 1;
  }
  return out;
}

/** Tuning from six labels (top line = string 1); null unless all six are note names. */
function labelTuning(labels: readonly (string | null)[]): number[] | null {
  const pcs = labels.map((l) => (l === null ? null : pitchClassOf(l)));
  return pcs.every((p): p is number => p !== null) ? tuningFromPitchClasses(pcs) : null;
}

/** Total semitone distance of a tuning from standard, string by string. */
const tuningCost = (t: readonly number[]): number => t.reduce((sum, p, i) => sum + Math.abs(p - STANDARD_TUNING[i]), 0);

/**
 * A string labelled this many semitones (or more) from its standard pitch makes a label tuning
 * implausible (every common tuning stays within 4: Drop C, DADGAD, open G/D/C, Eb).
 */
const IMPLAUSIBLE_STRING_SEMITONES = 5;

/**
 * Margin by which the reversed reading must beat the written one before a staff counts as written
 * low string first (`D A D G B e` from the top); keeps palindromic and near-symmetric labels as written.
 */
const REVERSED_MARGIN = 4;

/**
 * Whether a labelled staff was written low string first: its labels read bottom-up give a tuning much
 * closer to standard than read top-down (`D A D G B e` → Drop D instead of `62,57,50,55,47,40`).
 */
function isReversedStaff(labels: readonly (string | null)[]): boolean {
  const written = labelTuning(labels);
  const reversed = labelTuning([...labels].reverse());
  return written !== null && reversed !== null && tuningCost(reversed) + REVERSED_MARGIN <= tuningCost(written);
}

/** Whether a label tuning has a string implausibly far from standard. */
const isImplausibleTuning = (t: readonly number[]): boolean => t.some((p, i) => Math.abs(p - STANDARD_TUNING[i]) >= IMPLAUSIBLE_STRING_SEMITONES);

const isStandard = (t: readonly number[]): boolean => t.every((p, i) => p === STANDARD_TUNING[i]);

/** Strings that must carry a `*` for it to count as a repeat sign (tabs write the dots on two). */
const REPEAT_DOT_LINES = 2;

/** Parse ASCII tab text into blocks, header, tuning and played-order groups (no rhythm applied). */
export function parseTabDetailed(text: string, opts: ParseOptions = {}): DetailedTab {
  const offset = opts.lineOffset ?? 0;
  const lines = normaliseNewlines(text).split('\n').map(normaliseLine);
  const staff: (StaffLine | null)[] = lines.map(parseStaffLine);
  const diagnostics: ImportDiagnostic[] = [];
  const unparsed: { line: number; text: string }[] = [];
  /** Why each unparsed line was not read (by 1-based line); the default is "not part of a 6-line staff". */
  const unparsedWhy = new Map<number, string>();
  const lineNo = (idx: number): number => offset + idx + 1;

  // 1. Runs of staff-like lines → 6-line blocks.
  const tops: number[] = [];
  const failedRuns: [number, number][] = [];
  for (let i = 0; i < lines.length; ) {
    if (!staff[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && staff[j]) j++;
    const sig = (k: number): string => `${staff[k]?.label !== null}|${staff[k]?.hasBar}`;
    const counts = new Map<string, number>();
    for (let k = i; k < j; k++) counts.set(sig(k), (counts.get(sig(k)) ?? 0) + 1);
    const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let s = i;
    let e = j;
    if ((e - s) % 6 !== 0) {
      while (s < e && sig(s) !== majority && !staff[s]?.hasNote) s++;
      while (e > s && sig(e - 1) !== majority && !staff[e - 1]?.hasNote) e--;
    }
    if (e > s && (e - s) % 6 === 0) {
      for (let k = s; k < e; k += 6) tops.push(k);
    } else {
      failedRuns.push([i, j]);
    }
    i = j;
  }

  // 2. ClassTab "Notes & Legend": staves after it are examples, not part of the piece.
  let cutoff = lines.length;
  if (tops.length > 0) {
    for (let k = tops[0] + 6; k < lines.length; k++) {
      if (isNotesHeading(lines[k])) {
        cutoff = k;
        break;
      }
    }
  }
  const ignored = tops.filter((t) => t > cutoff).length;
  if (ignored > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'notes-section',
      message: `${ignored} staff block(s) after the Notes/Legend heading were treated as examples and skipped`,
      line: lineNo(cutoff),
    });
  }
  const blockTops = tops.filter((t) => t < cutoff);
  const parts = ensembleParts(lines, blockTops);
  const partCount = Math.max(0, ...parts) + 1;
  if (partCount > 1) {
    diagnostics.push({
      severity: 'info',
      code: 'ensemble-parts',
      message: `The tab is written for ${partCount} guitars (systems of ${partCount} staves); the top part (guitar 1) is imported`,
    });
  }
  // Runs that are not 6 lines: reported when they hold notes (legend diagrams and rules are not).
  for (const [i, j] of failedRuns) {
    if (i > cutoff || !staff.slice(i, j).some((l) => l?.hasNote)) continue;
    diagnostics.push({
      severity: 'warning',
      code: 'staff-line-count',
      message: `${j - i} tab line(s) in a row; a guitar staff has 6 (4-string bass and 7-string tabs are not supported)`,
      line: lineNo(i),
    });
    for (let k = i; k < j; k++) unparsed.push({ line: lineNo(k), text: lines[k] });
  }

  // 3. Annotation lines directly above each block (contiguous, up to 4).
  const used = new Set<number>();
  const aboveOf = blockTops.map((top, bi) => {
    const floor = bi > 0 ? blockTops[bi - 1] + 6 : 0;
    const idx: number[] = [];
    for (let k = top - 1; k >= floor && idx.length < 4 && lines[k].trim() !== ''; k--) idx.push(k);
    idx.forEach((k) => used.add(k));
    return idx;
  });

  const blocks: AsciiBlock[] = [];
  const blockGroups: BlockGroup[][] = [];
  const blockBarList: BlockBar[][] = [];
  const blockRulers: (RulerMark[] | undefined)[] = [];
  const blockRepeats: RepeatSigns[] = [];
  const blockChords: { column: number; name: string }[][] = [];
  /** Tunings read from the string labels, by how many staves carry them (a typo in one staff is outvoted). */
  const labelTunings = new Map<string, { tuning: number[]; count: number; line: number; labels: (string | null)[] }>();

  blockTops.forEach((top, bi) => {
    const rows = lines.slice(top, top + 6);
    const written = staff.slice(top, top + 6) as StaffLine[];
    // A staff written low string first is read bottom-up, so string 1 is always the high string.
    const reversed = isReversedStaff(written.map((p) => p.label));
    const parsed = reversed ? [...written].reverse() : written;
    const maxStart = Math.max(...parsed.map((p) => p.bodyStart));
    const aligned = parsed.map((p) => ' '.repeat(maxStart - p.bodyStart) + p.text);
    const bodies = parsed.map((p) => ({ from: maxStart, to: p.bodyEnd + (maxStart - p.bodyStart) }));
    const shift = maxStart - written[0].bodyStart;
    const { notes, barColumns } = tokeniseBlock(aligned, bodies, lineNo(top));
    if (reversed) {
      for (const n of notes) n.line = lineNo(top) + 6 - n.string;
      diagnostics.push({
        severity: 'info',
        code: 'staff-reversed',
        message: `The staff at line ${lineNo(top)} is labeled low string first (${written.map((p) => p.label).join(' ')}); read bottom-up`,
        line: lineNo(top),
      });
    }
    // Frets past the end of a staff body (a layout the line reader could not follow) are lost: say so.
    written.forEach((p, k) => {
      if (!/\d/.test(p.text.slice(p.bodyEnd))) return;
      const line = lineNo(top + k);
      unparsed.push({ line, text: rows[k] });
      unparsedWhy.set(line, `Line ${line}: tab after column ${p.bodyEnd + 1} could not be read (the staff line breaks off there)`);
    });
    const bodyEnd = Math.max(...bodies.map((b) => b.to));

    const block: AsciiBlock = {
      startLine: lineNo(top),
      lines: rows,
      labels: written.map((p) => p.label),
      barColumns,
      notes,
      palmMute: [],
      ...(parts[bi] > 0 ? { part: parts[bi] } : {}),
    };
    let ruler: RulerMark[] | undefined;
    const chords: { column: number; name: string }[] = [];
    const spansOf = (k: number, kind: 'pm' | 'ring'): [number, number][] | null =>
      parseSpanLine(lines[k], kind)?.map(([a, b]) => [a + shift, b + shift]) ?? null;

    // The ruler sits right above the staff, or above a fermata line (`/.\`) there.
    const rulerAt = isFermataLine(lines[top - 1] ?? '') ? top - 2 : top - 1;
    for (const k of aboveOf[bi]) {
      if (k === rulerAt) {
        const marks = parseRuler(lines[k], 'above');
        if (marks) {
          ruler = marks.map((m) => ({ ...m, column: m.column + shift }));
          block.ruler = { line: lineNo(k), text: lines[k] };
          continue;
        }
      }
      const pm = spansOf(k, 'pm');
      if (pm) block.palmMute.push(...pm);
      const ring = spansOf(k, 'ring');
      if (ring) applySpans(notes, ring, 'letRing');
      const chordLine = parseChordLine(lines[k]);
      if (chordLine) chords.push(...chordLine.map((c) => ({ ...c, column: c.column + shift })));
    }

    // Lines below: PM / let ring spans, a count ruler, a repeat marker.
    const next = bi + 1 < blockTops.length ? blockTops[bi + 1] : cutoff;
    for (let k = top + 6, n = 0; k < Math.min(next, lines.length) && n < 3; k++) {
      if (lines[k].trim() === '') {
        if (n > 0) break;
        continue;
      }
      if (used.has(k)) break;
      n++;
      if (k === top + 6 && !ruler) {
        const marks = parseRuler(lines[k], 'below');
        if (marks) {
          ruler = marks.map((m) => ({ ...m, column: m.column + shift }));
          block.ruler = { line: lineNo(k), text: lines[k] };
          continue;
        }
      }
      const pm = spansOf(k, 'pm');
      if (pm) block.palmMute.push(...pm);
      const ring = spansOf(k, 'ring');
      if (ring) applySpans(notes, ring, 'letRing');
      const rep = repeatMarker(lines[k].replace(/^.*?\b(repeat|play)\b/i, '$1'));
      if (rep !== null) block.repeat = rep;
    }
    applySpans(notes, block.palmMute, 'palmMute');

    const staffRepeat = parsed.map((p) => p.repeat).find((r) => r !== undefined);
    if (staffRepeat !== undefined) block.repeat = staffRepeat;

    // Section heading: the nearest section line between the previous block and this one.
    const floor = bi > 0 ? blockTops[bi - 1] + 6 : 0;
    for (let k = top - 1; k >= floor; k--) {
      const name = parseSectionLine(lines[k]);
      if (name) {
        block.section = name;
        break;
      }
    }

    const fromLabels = labelTuning(parsed.map((p) => p.label));
    if (fromLabels) {
      const key = fromLabels.join();
      const seen = labelTunings.get(key);
      if (seen) seen.count++;
      else labelTunings.set(key, { tuning: fromLabels, count: 1, line: lineNo(top), labels: block.labels });
    }
    const groups = groupBlockNotes(notes);
    const bars = blockBars(barColumns, maxStart, bodyEnd, groups);
    blocks.push(block);
    blockGroups.push(groups);
    blockBarList.push(bars);
    blockRepeats.push(repeatSigns(aligned, bodies, bars));
    blockRulers.push(ruler);
    blockChords.push(chords);
  });

  for (const u of unparsed) {
    const message = unparsedWhy.get(u.line) ?? `Line ${u.line} looks like tab but is not part of a 6-line staff`;
    diagnostics.push({ severity: 'warning', code: 'unparsed-line', message, line: u.line });
  }

  // 4. Header (text before the first block) and tuning. Lines touching the first block are header
  //    lines too (`Capo 2`, `Tuning: …`), unless they are its annotations: a ruler right above it,
  //    PM / let-ring spans, a chord-name line or a section heading.
  const headerLines: string[] = [];
  if (blockTops.length > 0) {
    const top = blockTops[0];
    const rulerAt = isFermataLine(lines[top - 1] ?? '') ? top - 2 : top - 1;
    const isAnnotation = (k: number): boolean =>
      (k === rulerAt && parseRuler(lines[k], 'above') !== null) ||
      (k === top - 1 && rulerAt !== k) ||
      parseSpanLine(lines[k], 'pm') !== null ||
      parseSpanLine(lines[k], 'ring') !== null ||
      parseChordLine(lines[k]) !== null ||
      parseSectionLine(lines[k]) !== null;
    for (let k = 0; k < top; k++) if (!aboveOf[0].includes(k) || !isAnnotation(k)) headerLines.push(lines[k]);
  } else {
    headerLines.push(...lines);
  }
  const header = parseHeader(headerLines, opts.headerFallback);
  let voted: { tuning: number[]; count: number; line: number; labels: (string | null)[] } | null = null;
  for (const t of labelTunings.values()) if (!voted || t.count > voted.count) voted = t;
  if (voted && isImplausibleTuning(voted.tuning)) {
    diagnostics.push({
      severity: 'warning',
      code: 'label-tuning-unusual',
      message: `The string labels at line ${voted.line} (${voted.labels.join(' ')}) give an unusual tuning; check the tuning`,
      line: voted.line,
    });
  }
  const labelled: number[] | null = voted?.tuning ?? null;
  const tuning = labelled && !isStandard(labelled) ? labelled : header.tuning ?? labelled ?? [...STANDARD_TUNING];

  // 5. Played order: blocks × `x2` passes, then `|*` … `*|` repeats, cut into runs of consecutive bars.
  const written: WrittenBar[] = [];
  blocks.forEach((block, bi) => {
    if (block.part) return;
    const { open, close } = blockRepeats[bi];
    for (let pass = 0; pass < (opts.repeats === false ? 1 : block.repeat ?? 1); pass++) {
      blockBarList[bi].forEach((_, b) => written.push({ block: bi, bar: b, open: open.has(b), close: close.has(b) }));
    }
  });
  // Bar of each group within its block (notes outside every bar go to the nearest edge bar).
  const groupBars = blockGroups.map((bg, bi) => {
    const bars = blockBarList[bi];
    return bg.map((g) => {
      const bIdx = bars.findIndex((b) => g.column > b.start && g.column < b.end);
      return bIdx >= 0 ? bIdx : g.column <= bars[0].start ? 0 : bars.length - 1;
    });
  });
  const played: PlayedBlock[] = [];
  const groups: AsciiOnsetGroup[] = [];
  const sections: { bar: number; name: string }[] = [];
  const runsOfBlock = new Array<number>(blocks.length).fill(0);
  let bar = 0;
  const order = opts.repeats === false ? written : expandRepeats(written);
  for (let i = 0; i < order.length; ) {
    const bi = order[i].block;
    const from = order[i].bar;
    let to = from;
    let j = i + 1;
    while (j < order.length && order[j].block === bi && order[j].bar === to + 1) to = order[j++].bar;
    i = j;

    const block = blocks[bi];
    const bars = blockBarList[bi];
    const chords = blockChords[bi];
    const pass = runsOfBlock[bi]++;
    if (pass === 0 && from === 0 && block.section) sections.push({ bar, name: block.section });
    const firstGroup = groups.length;
    blockGroups[bi].forEach((g, k) => {
      const bIdx = groupBars[bi][k];
      if (bIdx < from || bIdx > to) return;
      const chordName = g.notes.length > 1 ? chords.find((c) => Math.abs(c.column - g.column) <= 2)?.name : undefined;
      groups.push({
        index: groups.length,
        bar: bar + bIdx - from,
        column: g.column,
        barStartColumn: bars[bIdx].start,
        barEndColumn: bars[bIdx].end,
        notes: g.notes.map(stripSpan),
        block: bi,
        ...(chordName ? { chordName } : {}),
      });
    });
    played.push({ block: bi, pass, firstBar: bar, bars: bars.slice(from, to + 1), ruler: blockRulers[bi], firstGroup, groupCount: groups.length - firstGroup });
    bar += to - from + 1;
  }

  const tab: AsciiTab = {
    header,
    blocks: blocks.map((b) => ({ ...b, notes: b.notes.map(stripSpan) })),
    groups,
    tuning,
    unparsed,
    diagnostics,
  };
  return { tab, played, barCount: bar, sections };
}

/**
 * Ensemble systems (ClassTab duets): a staff joined to the one above it by lines that each start with
 * the system's bracket `|` (fingering, dynamics, ` | guitar 2  |`) is a lower part of the same system.
 * Returns each block's 0-based part (0 = top staff).
 */
function ensembleParts(lines: readonly string[], tops: readonly number[]): number[] {
  const parts = tops.map(() => 0);
  for (let bi = 1; bi < tops.length; bi++) {
    const from = tops[bi - 1] + 6;
    const col = lines[tops[bi - 1]].indexOf('|');
    if (tops[bi] <= from || col < 0) continue;
    const joined = lines.slice(from, tops[bi]).every((l) => l.indexOf('|') === col && l.slice(0, col).trim() === '');
    if (joined) parts[bi] = parts[bi - 1] + 1;
  }
  return parts;
}

/** Mark notes whose column falls in one of `spans`. */
function applySpans(notes: readonly RawNote[], spans: readonly [number, number][], flag: 'palmMute' | 'letRing'): void {
  for (const n of notes) {
    if (spans.some(([a, b]) => n.column >= a && n.column < b)) n.tech[flag] = true;
  }
}

/** Drop the internal span fields so the public objects stay small and JSON-clean. */
function stripSpan(n: AsciiNote & { spanStart?: number; spanEnd?: number }): AsciiNote {
  const { spanStart: _s, spanEnd: _e, ...note } = n;
  return note;
}

/** One version region of a multi-version tab. */
export interface VersionRegion {
  /** 1-based version number. */
  version: number;
  /** 0-based index of the region's first line in the file. */
  startLine: number;
  text: string;
}

/**
 * Split a multi-version tab ("version 2 … (MIDI 2)") into regions. Between two staves, the first
 * `MIDI:` line (else the first `version N` line) starts a new version; ClassTab restates the MIDI
 * URL in each version's header, after the previous version's Notes & Legend. Single-version tabs yield
 * one region.
 */
export function splitVersions(text: string): VersionRegion[] {
  const lines = normaliseNewlines(text).split('\n');
  const isStaff = lines.map((l) => parseStaffLine(normaliseLine(l)) !== null);
  const staffRunAt: number[] = [];
  for (let i = 0; i + 5 < lines.length; i++) {
    if (isStaff.slice(i, i + 6).every(Boolean) && (i === 0 || !isStaff[i - 1])) staffRunAt.push(i);
  }
  if (staffRunAt.length < 2) return [{ version: 1, startLine: 0, text: lines.join('\n') }];
  // At most one boundary per gap between staves: its first `MIDI:` line, else its first `version N` line.
  const starts = [0];
  for (let k = 0; k + 1 < staffRunAt.length; k++) {
    const gap = lines.slice(staffRunAt[k] + 6, staffRunAt[k + 1]);
    const midi = gap.findIndex((l) => /^\s*MIDI\s*:/i.test(l));
    const at = midi >= 0 ? midi : gap.findIndex(isVersionBoundary);
    if (at >= 0) starts.push(staffRunAt[k] + 6 + at);
  }
  return starts.map((s, idx) => ({
    version: idx + 1,
    startLine: s,
    text: lines.slice(s, starts[idx + 1] ?? lines.length).join('\n'),
  }));
}
