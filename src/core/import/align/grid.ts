/**
 * Column-proportional onset estimates, snap-to-grid and tap-along mapping (alignment UI, T-028).
 * @module
 */
import type { AsciiOnsetGroup } from '../ascii/types';
import { enforceIncreasing } from '../midi';
import { barSeconds, DEFAULT_BPM, DEFAULT_TIME_SIG } from './timing';

/** What the column maths needs from an onset group. */
export type ColumnInfo = Pick<AsciiOnsetGroup, 'bar' | 'column' | 'barStartColumn' | 'barEndColumn'>;

/** Snap grid as note value: 8 = eighths, 12 = eighth triplets, 16 = sixteenths. */
export type Subdivision = 8 | 12 | 16;

/** Quantise step in seconds for `subdivision` at quarter-note `bpm`. */
export function gridStep(bpm: number, subdivision: Subdivision): number {
  return (60 / bpm) * (subdivision === 12 ? 1 / 3 : 4 / subdivision);
}

/**
 * Typical dashes between a bar line and the bar's first note (`|-0---` → 1, ClassTab `|--0-` → 2):
 * the mode over bars, considering leads of 0–3 columns. Used so the first note of a bar lands on
 * its downbeat.
 */
export function leadPad(columns: readonly ColumnInfo[]): number {
  const first = new Map<number, ColumnInfo>();
  for (const c of columns) {
    const f = first.get(c.bar);
    if (!f || c.column < f.column) first.set(c.bar, c);
  }
  const counts = new Map<number, number>();
  for (const c of first.values()) {
    const lead = c.column - c.barStartColumn - 1;
    if (lead >= 0 && lead <= 3) counts.set(lead, (counts.get(lead) ?? 0) + 1);
  }
  let best = 1;
  let bestCount = 0;
  for (const [lead, n] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (n > bestCount) {
      best = lead;
      bestCount = n;
    }
  }
  return best;
}

/** Position of each group inside its bar, in `[0, 1)`, from column spacing. */
export function barFractions(columns: readonly ColumnInfo[]): number[] {
  const lead = leadPad(columns);
  return columns.map((c) => {
    let start = c.barStartColumn + 1 + lead;
    if (c.barEndColumn - start <= 0) start = c.barStartColumn + 1;
    const width = Math.max(1, c.barEndColumn - start);
    return Math.min(Math.max((c.column - start) / width, 0), 1 - 1e-6);
  });
}

/**
 * Proportional onsets: bar `b` starts at `b × barDur`; inside a bar, column spacing is the duration
 * ratio. Strictly increasing.
 */
export function proportionalTimes(columns: readonly ColumnInfo[], bpm: number, timeSig: readonly [number, number]): number[] {
  const barDur = barSeconds(bpm, timeSig);
  const fr = barFractions(columns);
  return enforceIncreasing(columns.map((c, i) => (c.bar + fr[i]) * barDur));
}

/**
 * Snap-to-grid: inside each bar, column spacing is the duration ratio; quantise to `subdivision`
 * at `bpm` in `timeSig`. Returns one onset time (song s) per group; chords stay together. Groups that
 * would share a grid slot move to the next free slot in the bar; when a bar has more groups than
 * slots its groups keep their unquantised proportional times.
 */
export function snapToGrid(
  columns: readonly ColumnInfo[],
  bpm: number,
  timeSig: [number, number],
  subdivision: Subdivision,
): number[] {
  const barDur = barSeconds(bpm, timeSig);
  const step = gridStep(bpm, subdivision);
  const slots = Math.max(1, Math.round(barDur / step));
  const fr = barFractions(columns);
  const out = new Array<number>(columns.length);
  for (let i = 0; i < columns.length; ) {
    let j = i;
    while (j < columns.length && columns[j].bar === columns[i].bar) j++;
    const barStart = columns[i].bar * barDur;
    const n = j - i;
    if (n > slots) {
      for (let k = i; k < j; k++) out[k] = barStart + fr[k] * barDur;
    } else {
      const slot = new Array<number>(n);
      for (let k = 0; k < n; k++) {
        slot[k] = Math.min(Math.round(fr[i + k] * slots), slots - 1);
        if (k > 0) slot[k] = Math.max(slot[k], slot[k - 1] + 1);
      }
      for (let k = n - 1; k >= 0; k--) slot[k] = Math.min(slot[k], slots - (n - k));
      for (let k = 0; k < n; k++) out[i + k] = barStart + slot[k] * step;
    }
    i = j;
  }
  return out;
}

/**
 * Tap-along: map taps (song seconds, in order) to onset groups (chord = one tap). Extra taps are
 * dropped; missing taps are interpolated: groups after the last tap follow the column-proportional
 * spacing at the tempo implied by the taps (or `quantize.bpm`, else 80 BPM). Optional quantise to a
 * grid; results stay strictly increasing.
 */
export function mapTapsToOnsets(
  taps: readonly number[],
  groups: readonly ColumnInfo[],
  quantize?: { bpm: number; timeSig: [number, number]; subdivision: Subdivision },
): number[] {
  const n = groups.length;
  if (n === 0) return [];
  const est = proportionalTimes(groups, quantize?.bpm ?? DEFAULT_BPM, quantize?.timeSig ?? DEFAULT_TIME_SIG);
  const used = Math.min(taps.length, n);
  const out = new Array<number>(n);
  for (let i = 0; i < used; i++) out[i] = taps[i];
  if (used < n) {
    const last = used - 1;
    let slope = 1;
    if (used >= 2 && est[last] > est[0]) slope = (taps[last] - taps[0]) / (est[last] - est[0]);
    const anchorT = used > 0 ? taps[last] : 0;
    const anchorE = used > 0 ? est[last] : est[0];
    for (let i = used; i < n; i++) out[i] = anchorT + (est[i] - anchorE) * slope;
  }
  if (quantize) {
    const step = gridStep(quantize.bpm, quantize.subdivision);
    for (let i = 0; i < n; i++) {
      let t = Math.round(out[i] / step) * step;
      if (i > 0 && t <= out[i - 1] + 1e-9) t = out[i - 1] + step;
      out[i] = t;
    }
    return out;
  }
  return enforceIncreasing(out);
}
