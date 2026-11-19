/**
 * Bar/beat grids and sections for ASCII-derived songs: constant-tempo grids (proportional, sidecar),
 * MIDI tempo/time-signature maps, and section building.
 * @module
 */
import type { Bar, Section, TempoChange } from '@shared/song';

/** Default tempo when a tab states none (`tempoEstimated`). */
export const DEFAULT_BPM = 80;
/** Default time signature when a tab states none. */
export const DEFAULT_TIME_SIG: [number, number] = [4, 4];
/** Bars per auto-section ("Part 1…n"). */
export const AUTO_SECTION_BARS = 8;

const EPS = 1e-9;

/** Seconds per beat of `den` (e.g. an eighth in 6/8) at quarter-note `bpm`. */
export function beatSeconds(bpm: number, den: number): number {
  return (60 / bpm) * (4 / den);
}

/** Seconds per bar of `timeSig` at quarter-note `bpm`. */
export function barSeconds(bpm: number, timeSig: readonly [number, number]): number {
  return timeSig[0] * beatSeconds(bpm, timeSig[1]);
}

/** One bar with beats every `beatDur` seconds from its start (the downbeat is `beats[0]`). */
export function makeBar(index: number, time: number, dur: number, num: number, den: number, beatDur: number): Bar {
  const beats: number[] = [];
  for (let k = 0; k < 64 && (k === 0 || time + k * beatDur < time + dur - 1e-6); k++) beats.push(time + k * beatDur);
  return { index, time, dur, num, den, beats };
}

/** `count` bars at a constant tempo, starting at `start`. */
export function constantBars(bpm: number, timeSig: readonly [number, number], count: number, start = 0, firstIndex = 0): Bar[] {
  const dur = barSeconds(bpm, timeSig);
  const beat = beatSeconds(bpm, timeSig[1]);
  return Array.from({ length: Math.max(1, count) }, (_, k) => makeBar(firstIndex + k, start + k * dur, dur, timeSig[0], timeSig[1], beat));
}

/** Append constant-tempo bars after `bars` until they cover `endTime`. */
export function extendBars(bars: Bar[], endTime: number, bpm: number, timeSig: readonly [number, number]): Bar[] {
  const last = bars[bars.length - 1];
  const t = last ? last.time + last.dur : 0;
  if (t >= endTime - 1e-6) return bars;
  const count = Math.ceil((endTime - t) / barSeconds(bpm, timeSig) - 1e-6);
  return [...bars, ...constantBars(bpm, timeSig, count, t, bars.length)];
}

/** Index of the bar containing `time` (clamped). */
export function barIndexAt(bars: readonly Bar[], time: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].time <= time + 1e-6) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Seconds reached after `quarters` quarter notes from `t`, following the tempo map. */
function advance(tempos: readonly TempoChange[], t: number, quarters: number): number {
  let time = t;
  let q = quarters;
  let k = 0;
  while (k + 1 < tempos.length && tempos[k + 1].time <= time + EPS) k++;
  while (q > EPS) {
    const spq = 60 / tempos[k].bpm;
    const segEnd = k + 1 < tempos.length ? tempos[k + 1].time : Infinity;
    const avail = (segEnd - time) / spq;
    if (q <= avail) return time + q * spq;
    q -= avail;
    time = segEnd;
    k++;
  }
  return time;
}

/** Bars from a MIDI tempo map and time signatures, covering `[0, endTime]`. */
export function midiBars(
  tempos: readonly TempoChange[],
  timeSignatures: readonly { time: number; num: number; den: number }[],
  endTime: number,
): Bar[] {
  const tmap = tempos.length > 0 ? tempos : [{ time: 0, bpm: 120 }];
  const sigs = timeSignatures.length > 0 ? timeSignatures : [{ time: 0, num: 4, den: 4 }];
  const bars: Bar[] = [];
  let t = 0;
  while (bars.length === 0 || t < endTime - 1e-6) {
    let s = 0;
    while (s + 1 < sigs.length && sigs[s + 1].time <= t + 1e-6) s++;
    const { num, den } = sigs[s];
    const beatQ = 4 / den;
    let end = advance(tmap, t, num * beatQ);
    const nextSig = sigs[s + 1];
    if (nextSig && nextSig.time > t + 1e-6 && nextSig.time < end - 1e-6) end = nextSig.time;
    const beats: number[] = [];
    for (let k = 0; k < num; k++) {
      const b = advance(tmap, t, k * beatQ);
      if (k === 0 || b < end - 1e-6) beats.push(b);
    }
    bars.push({ index: bars.length, time: t, dur: end - t, num, den, beats });
    t = end;
    if (bars.length > 100_000) break;
  }
  return bars;
}

/**
 * Sections from named starts (`[Chorus]` lines) or, without any, auto-sections of
 * {@link AUTO_SECTION_BARS} bars named "Part 1…n". Bars before the first named start become "Intro".
 */
export function buildSections(bars: readonly Bar[], named: readonly { bar: number; name: string }[]): Section[] {
  const starts: { bar: number; name: string }[] = [];
  for (const s of [...named].sort((a, b) => a.bar - b.bar)) {
    if (s.bar >= bars.length) continue;
    if (starts.length > 0 && starts[starts.length - 1].bar === s.bar) starts[starts.length - 1] = s;
    else starts.push(s);
  }
  if (starts.length === 0) {
    for (let b = 0, k = 1; b < bars.length; b += AUTO_SECTION_BARS, k++) starts.push({ bar: b, name: `Part ${k}` });
  } else if (starts[0].bar > 0) {
    starts.unshift({ bar: 0, name: 'Intro' });
  }
  return starts.map((s, i) => {
    const endBar = i + 1 < starts.length ? starts[i + 1].bar : bars.length;
    const last = bars[endBar - 1];
    return { name: s.name, startBar: s.bar, endBar, start: bars[s.bar].time, end: last.time + last.dur };
  });
}
