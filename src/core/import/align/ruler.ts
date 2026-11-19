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

/**
 * Rhythm from beat rulers. Returns `{diagnostics}` only (no times) when the tab has no usable ruler:
 * some blocks lack one, or most notes do not line up with its marks.
 */
export function rulerRhythm(d: DetailedTab, bpm: number, timeSig?: readonly [number, number]): RulerRhythm | { diagnostics: ImportDiagnostic[] } {
  const diagnostics: ImportDiagnostic[] = [];
  if (d.played.length === 0 || d.played.every((p) => !p.ruler)) return { diagnostics };
  if (d.played.some((p) => !p.ruler)) {
    diagnostics.push({ severity: 'info', code: 'ruler-incomplete', message: 'Some staves have a beat ruler and some do not; the ruler was not used' });
    return { diagnostics };
  }

  // Marks per staff bar, in played order.
  interface MarkRef { column: number; beat: boolean; g: number }
  const staffBars: { marks: MarkRef[] }[] = [];
  /** Per played block: the marks of each of its staff bars. */
  const marksByPass: MarkRef[][][] = [];
  let g = 0;
  for (const p of d.played) {
    const marks = [...(p.ruler ?? [])].sort((a, b) => a.column - b.column);
    const passBars: MarkRef[][] = [];
    for (const bar of p.bars) {
      const inBar = marks
        .filter((m) => m.column > bar.start && m.column < bar.end)
        .map((m) => ({ column: m.column, beat: m.beat, g: g++ }));
      staffBars.push({ marks: inBar });
      passBars.push(inBar);
    }
    marksByPass.push(passBars);
  }
  const full = mode(staffBars.map((b) => b.marks.length).filter((n) => n > 0));
  if (full === 0) return { diagnostics };

  let sig: [number, number];
  if (timeSig) {
    sig = [timeSig[0], timeSig[1]];
  } else {
    const beats = mode(staffBars.filter((b) => b.marks.length === full).map((b) => b.marks.filter((m) => m.beat).length)) || full;
    const perBeat = full / beats;
    sig = perBeat === 3 ? [beats * 3, 8] : [beats, 4];
    diagnostics.push({ severity: 'info', code: 'time-signature-guessed', message: `No time signature in the header; ${sig[0]}/${sig[1]} guessed from the beat ruler` });
  }

  const markDur = barSeconds(bpm, sig) / full;
  const marksPerBeat = full / sig[0];

  // Musical bars: accumulate staff bars until a bar is full (pickups and split bars merge right).
  const bars: Bar[] = [];
  let acc = 0;
  let startG = 0;
  const close = (): void => {
    if (acc === 0) return;
    let num = sig[0];
    let den = sig[1];
    if (acc !== full && Number.isInteger(marksPerBeat)) {
      if (acc % marksPerBeat === 0) num = acc / marksPerBeat;
      else {
        num = acc;
        den = sig[1] * marksPerBeat;
      }
    }
    const time = startG * markDur;
    const dur = acc * markDur;
    bars.push(makeBar(bars.length, time, dur, num, den, acc === full || Number.isInteger(marksPerBeat) ? beatSeconds(bpm, den) : dur / num));
    startG += acc;
    acc = 0;
  };
  for (const b of staffBars) {
    const c = b.marks.length;
    if (c === 0) continue;
    if (acc > 0 && acc + c > full) close();
    acc += c;
    if (acc >= full) close();
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
        t = exact.g * markDur;
        onMark++;
      } else if (ms.length === 0) {
        t = 0;
      } else if (c < ms[0].column) {
        const r = reach[barOf[k]].before;
        t = (ms[0].g - (ms[0].column - c) / spacing / (r < 1 ? 1 : r + 1)) * markDur;
      } else if (c > ms[ms.length - 1].column) {
        const r = reach[barOf[k]].after;
        const last = ms[ms.length - 1];
        t = (last.g + (c - last.column) / spacing / (r < 1 ? 1 : r + 1)) * markDur;
      } else {
        const right = ms.findIndex((m) => m.column > c);
        const [lm, rm] = [ms[right - 1], ms[right]];
        t = (lm.g + ((c - lm.column) / (rm.column - lm.column)) * (rm.g - lm.g)) * markDur;
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
