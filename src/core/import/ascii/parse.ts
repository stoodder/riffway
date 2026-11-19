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
}

/** One bar of a block: the columns bracketing it (`[start, end)` bar-line columns). */
export interface BlockBar {
  start: number;
  end: number;
}

/** A block as played (blocks with `x2` markers are played several times). */
export interface PlayedBlock {
  block: number;
  pass: number;
  /** Index of the block's first bar in played order. */
  firstBar: number;
  /** Index of the pass's first group in {@link AsciiTab.groups}; the pass owns `groupCount` groups. */
  firstGroup: number;
  groupCount: number;
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

/** Tuning from six labels (top line = string 1); null unless all six are note names. */
function labelTuning(labels: readonly (string | null)[]): number[] | null {
  const pcs = labels.map((l) => (l === null ? null : pitchClassOf(l)));
  return pcs.every((p): p is number => p !== null) ? tuningFromPitchClasses(pcs) : null;
}

const isStandard = (t: readonly number[]): boolean => t.every((p, i) => p === STANDARD_TUNING[i]);

/** Parse ASCII tab text into blocks, header, tuning and played-order groups (no rhythm applied). */
export function parseTabDetailed(text: string, opts: ParseOptions = {}): DetailedTab {
  const offset = opts.lineOffset ?? 0;
  const lines = normaliseNewlines(text).split('\n').map(normaliseLine);
  const staff: (StaffLine | null)[] = lines.map(parseStaffLine);
  const diagnostics: ImportDiagnostic[] = [];
  const unparsed: { line: number; text: string }[] = [];
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
  const blockChords: { column: number; name: string }[][] = [];
  let tuningFromLabels: number[] | null = null;

  blockTops.forEach((top, bi) => {
    const rows = lines.slice(top, top + 6);
    const parsed = staff.slice(top, top + 6) as StaffLine[];
    const maxStart = Math.max(...parsed.map((p) => p.bodyStart));
    const aligned = parsed.map((p) => ' '.repeat(maxStart - p.bodyStart) + p.text);
    const bodies = parsed.map((p) => ({ from: maxStart, to: p.bodyEnd + (maxStart - p.bodyStart) }));
    const shift = maxStart - parsed[0].bodyStart;
    const { notes, barColumns } = tokeniseBlock(aligned, bodies, lineNo(top));
    const bodyEnd = Math.max(...bodies.map((b) => b.to));

    const block: AsciiBlock = {
      startLine: lineNo(top),
      lines: rows,
      labels: parsed.map((p) => p.label),
      barColumns,
      notes,
      palmMute: [],
    };
    let ruler: RulerMark[] | undefined;
    const chords: { column: number; name: string }[] = [];
    const spansOf = (k: number, kind: 'pm' | 'ring'): [number, number][] | null =>
      parseSpanLine(lines[k], kind)?.map(([a, b]) => [a + shift, b + shift]) ?? null;

    for (const k of aboveOf[bi]) {
      if (k === top - 1) {
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

    tuningFromLabels ??= labelTuning(block.labels);
    const groups = groupBlockNotes(notes);
    blocks.push(block);
    blockGroups.push(groups);
    blockBarList.push(blockBars(barColumns, maxStart, bodyEnd, groups));
    blockRulers.push(ruler);
    blockChords.push(chords);
  });

  for (const u of unparsed) {
    diagnostics.push({ severity: 'warning', code: 'unparsed-line', message: `Line ${u.line} looks like tab but is not part of a 6-line staff`, line: u.line });
  }

  // 4. Header (text before the first block and its annotations) and tuning.
  const headerEnd = blockTops.length > 0 ? Math.min(blockTops[0], ...aboveOf[0]) : lines.length;
  const header = parseHeader(lines.slice(0, headerEnd), opts.headerFallback);
  const labelled: number[] | null = tuningFromLabels;
  const tuning = labelled && !isStandard(labelled) ? labelled : header.tuning ?? labelled ?? [...STANDARD_TUNING];

  // 5. Played order.
  const played: PlayedBlock[] = [];
  const groups: AsciiOnsetGroup[] = [];
  const sections: { bar: number; name: string }[] = [];
  let bar = 0;
  blocks.forEach((block, bi) => {
    const bars = blockBarList[bi];
    const chords = blockChords[bi];
    for (let pass = 0; pass < (block.repeat ?? 1); pass++) {
      if (pass === 0 && block.section) sections.push({ bar, name: block.section });
      played.push({ block: bi, pass, firstBar: bar, bars, ruler: blockRulers[bi], firstGroup: groups.length, groupCount: blockGroups[bi].length });
      for (const g of blockGroups[bi]) {
        let bIdx = bars.findIndex((b) => g.column > b.start && g.column < b.end);
        if (bIdx < 0) bIdx = g.column <= bars[0].start ? 0 : bars.length - 1;
        const chordName = g.notes.length > 1 ? chords.find((c) => Math.abs(c.column - g.column) <= 2)?.name : undefined;
        groups.push({
          index: groups.length,
          bar: bar + bIdx,
          column: g.column,
          barStartColumn: bars[bIdx].start,
          barEndColumn: bars[bIdx].end,
          notes: g.notes.map(stripSpan),
          block: bi,
          ...(chordName ? { chordName } : {}),
        });
      }
      bar += bars.length;
    }
  });

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
