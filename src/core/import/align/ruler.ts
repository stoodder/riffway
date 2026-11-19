/**
 * Beat-ruler rhythm (ClassTab house style, docs/song-formats.md § ASCII tab parser step 7): each
 * ruler mark is one subdivision; marks per bar ÷ beats per bar gives the subdivision; notes on a
 * mark take its time, notes between marks interpolate. Musical bars are rebuilt from mark counts so
 * pickups and bars split by repeat signs come out right.
 * @module
 */
import type { Bar, ImportDiagnostic } from '@shared/song';
import type { DetailedTab } from '../ascii/parse';
import { enforceIncreasing } from '../midi';
import { barSeconds, beatSeconds, makeBar } from './timing';

/** Ruler-derived rhythm. */
export interface RulerRhythm {
  /** One time per onset group (played order). */
  times: number[];
  bars: Bar[];
  timeSig: [number, number];
  diagnostics: ImportDiagnostic[];
}

/** Minimum share of groups that must sit exactly on a ruler mark (else the ruler is misaligned). */
const MIN_ON_MARK = 0.3;
/** Tolerance when comparing fractional mark counts. */
const EPS = 1e-6;

/** Most frequent value (ties → the larger value); 0 for an empty list. */
function mode(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 0;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && v > best)) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** One ruler mark in played order, with its place in time (in plain-mark units from the start). */
interface MarkRef {
  column: number;
  beat: boolean;
  tuplet?: { n: number; k: number };
  /** Start, in plain-mark units. */
  pos: number;
  /** Length, in plain-mark units (1 for a plain mark; a tuplet bracket's share for its marks). */
  weight: number;
}

/** Plain marks and tuplet brackets of one staff bar. */
const plainCount = (marks: readonly MarkRef[]): number => marks.filter((m) => !m.tuplet).length;
const bracketCount = (marks: readonly MarkRef[]): number => marks.filter((m) => m.tuplet?.k === 0).length;

/**
 * Weights of one staff bar's marks (plain-mark units). Plain marks weigh 1, except in a bar that has a
 * full bar's beats (and starts on one) but another mark count: there each beat gets a full bar's share
 * and its marks split it (`| . + . |` where full bars have `| |`). A tuplet bracket takes the marks its
 * bar is missing, shared equally between the bar's brackets, else one beat; its marks split that.
 */
function markWeights(ms: readonly MarkRef[], full: number, havePlainBars: boolean, marksPerBeat: number, rulerBeats: number, unitsPerBeat: number): number[] {
  const brackets = bracketCount(ms);
  if (brackets === 0) {
    const beats = ms.filter((m) => m.beat).length;
    if (ms.length === full || rulerBeats === 0 || beats !== rulerBeats || !ms[0]?.beat) return ms.map(() => 1);
    const out: number[] = [];
    for (let i = 0; i < ms.length; ) {
      let j = i + 1;
      while (j < ms.length && !ms[j].beat) j++;
      for (let k = i; k < j; k++) out.push(unitsPerBeat / (j - i));
      i = j;
    }
    return out;
  }
  const missing = havePlainBars ? (full - plainCount(ms)) / brackets : 1;
  const bracketWeight = Number.isInteger(missing) && missing >= 1 ? missing : Number.isInteger(marksPerBeat) && marksPerBeat >= 1 ? marksPerBeat : 1;
  return ms.map((m) => (m.tuplet ? bracketWeight / m.tuplet.n : 1));
}

/**
 * Rhythm from beat rulers. Returns `{diagnostics}` only (no times) when the tab has no usable ruler:
 * some blocks lack one, or most notes do not line up with its marks.
 *
 * A tuplet bracket (`|--3--|`) stands for the plain marks it replaces in its bar (a full bar's mark
 * count minus the bar's plain marks, shared by its brackets; else one beat), and its notes share that
 * time equally.
 */
export function rulerRhythm(d: DetailedTab, bpm: number, timeSig?: readonly [number, number]): RulerRhythm | { diagnostics: ImportDiagnostic[] } {
  const diagnostics: ImportDiagnostic[] = [];
  if (d.played.length === 0 || d.played.every((p) => !p.ruler)) return { diagnostics };
  if (d.played.some((p) => !p.ruler)) {
    diagnostics.push({ severity: 'info', code: 'ruler-incomplete', message: 'Some staves have a beat ruler and some do not; the ruler was not used' });
    return { diagnostics };
  }

  // Marks per staff bar, in played order.
  const staffBars: MarkRef[][] = [];
  /** Per played block: the marks of each of its staff bars. */
  const marksByPass: MarkRef[][][] = [];
  for (const p of d.played) {
    const marks = [...(p.ruler ?? [])].sort((a, b) => a.column - b.column);
    const passBars: MarkRef[][] = [];
    for (const bar of p.bars) {
      const inBar = marks.filter((m) => m.column > bar.start && m.column < bar.end).map((m): MarkRef => ({ ...m, pos: 0, weight: 1 }));
      staffBars.push(inBar);
      passBars.push(inBar);
    }
    marksByPass.push(passBars);
  }
  // A full bar's mark count: from bars without tuplet brackets, else counting each bracket as one mark.
  const plainBars = staffBars.filter((b) => b.length > 0 && bracketCount(b) === 0);
  const full = plainBars.length > 0 ? mode(plainBars.map((b) => b.length)) : mode(staffBars.map((b) => plainCount(b) + bracketCount(b)).filter((n) => n > 0));
  if (full === 0) return { diagnostics };

  let sig: [number, number];
  if (timeSig) {
    sig = [timeSig[0], timeSig[1]];
  } else {
    const beats = mode(staffBars.filter((b) => b.length === full && bracketCount(b) === 0).map((b) => b.filter((m) => m.beat).length)) || full;
    const perBeat = full / beats;
    sig = perBeat === 3 ? [beats * 3, 8] : [beats, 4];
    diagnostics.push({ severity: 'info', code: 'time-signature-guessed', message: `No time signature in the header; ${sig[0]}/${sig[1]} guessed from the beat ruler` });
  }

  const markDur = barSeconds(bpm, sig) / full;
  const marksPerBeat = full / sig[0];

  // Beat marks in a full bar, and the plain marks per beat there.
  const rulerBeats = mode(plainBars.filter((b) => b.length === full).map((b) => b.filter((m) => m.beat).length));
  const unitsPerBeat = rulerBeats > 0 ? full / rulerBeats : 0;

  // Weights and positions, in plain-mark units.
  let pos = 0;
  /** Length of each staff bar in plain-mark units. */
  const units = staffBars.map((ms) => {
    const start = pos;
    const weights = markWeights(ms, full, plainBars.length > 0, marksPerBeat, rulerBeats, unitsPerBeat);
    ms.forEach((m, k) => {
      m.pos = pos;
      m.weight = weights[k];
      pos += m.weight;
    });
    return pos - start;
  });

  // Musical bars: accumulate staff bars until a bar is full (pickups and split bars merge right).
  const bars: Bar[] = [];
  let acc = 0;
  let startPos = 0;
  const close = (): void => {
    if (acc === 0) return;
    let num = sig[0];
    let den = sig[1];
    if (acc !== full && Number.isInteger(marksPerBeat) && Number.isInteger(acc)) {
      if (acc % marksPerBeat === 0) num = acc / marksPerBeat;
      else {
        num = acc;
        den = sig[1] * marksPerBeat;
      }
    }
    const time = startPos * markDur;
    const dur = acc * markDur;
    bars.push(makeBar(bars.length, time, dur, num, den, acc === full || Number.isInteger(marksPerBeat) ? beatSeconds(bpm, den) : dur / num));
    startPos += acc;
    acc = 0;
  };
  for (const c of units) {
    if (c === 0) continue;
    if (acc > 0 && acc + c > full + EPS) close();
    acc += c;
    if (acc >= full - EPS) close();
  }
  close();

  // Group times from marks. Inside a staff bar, notes between marks interpolate; notes before the
  // bar's first mark (grace notes) or after its last mark extrapolate with the bar's mark spacing,
  // compressed so they stay between the neighbouring marks.
  const times = new Array<number>(d.tab.groups.length);
  let onMark = 0;
  d.played.forEach((p, pi) => {
    const all = marksByPass[pi].flat();
    const gaps: number[] = [];
    marksByPass[pi].forEach((ms) => ms.slice(1).forEach((m, k) => gaps.push(m.column - ms[k].column)));
    gaps.sort((a, b) => a - b);
    const spacing = Math.max(1, gaps.length > 0 ? gaps[gaps.length >> 1] : 2);
    const groups = d.tab.groups.slice(p.firstGroup, p.firstGroup + p.groupCount);
    const barOf = groups.map((gr) => Math.max(0, p.bars.findIndex((b) => b.start === gr.barStartColumn && b.end === gr.barEndColumn)));
    // Furthest distance (in mark spacings) before the first / after the last mark, per bar.
    const reach = p.bars.map(() => ({ before: 0, after: 0 }));
    groups.forEach((gr, k) => {
      const ms = marksByPass[pi][barOf[k]];
      if (ms.length === 0) return;
      const r = reach[barOf[k]];
      r.before = Math.max(r.before, (ms[0].column - gr.column) / spacing);
      r.after = Math.max(r.after, (gr.column - ms[ms.length - 1].column) / spacing);
    });
    groups.forEach((gr, k) => {
      const c = gr.column;
      const ms = marksByPass[pi][barOf[k]].length > 0 ? marksByPass[pi][barOf[k]] : all;
      const exact = ms.find((m) => m.column === c);
      let t: number;
      if (exact) {
        t = exact.pos * markDur;
        onMark++;
      } else if (ms.length === 0) {
        t = 0;
      } else if (c < ms[0].column) {
        const r = reach[barOf[k]].before;
        t = (ms[0].pos - (ms[0].column - c) / spacing / (r < 1 ? 1 : r + 1)) * markDur;
      } else if (c > ms[ms.length - 1].column) {
        const r = reach[barOf[k]].after;
        const last = ms[ms.length - 1];
        t = (last.pos + ((c - last.column) / spacing / (r < 1 ? 1 : r + 1)) * last.weight) * markDur;
      } else {
        const right = ms.findIndex((m) => m.column > c);
        const [lm, rm] = [ms[right - 1], ms[right]];
        t = (lm.pos + ((c - lm.column) / (rm.column - lm.column)) * (rm.pos - lm.pos)) * markDur;
      }
      times[p.firstGroup + k] = Math.max(0, t);
    });
  });
  if (onMark / Math.max(1, times.length) < MIN_ON_MARK) {
    diagnostics.push({ severity: 'info', code: 'ruler-misaligned', message: 'Most notes do not line up with the beat ruler; the ruler was not used' });
    return { diagnostics };
  }
  return { times: enforceIncreasing(times, markDur / 16), bars, timeSig: sig, diagnostics };
}
