/**
 * Beat-grid queries over a {@link TransportTimeline} (pure, DOM-free): metronome beats in a song-time
 * range, beat length at a position, count-in clicks and bar lines. See docs/timing.md § Scheduling.
 *
 * The grid is the song's `bars[].beats`. Before the first bar it is extrapolated backwards with the
 * first bar's meter (pre-roll / count-in before song start); there are no beats after the last bar.
 * An empty timeline (nothing loaded) is an endless 120 BPM 4/4 grid anchored at 0, which is what a
 * bare metronome or calibration click track needs.
 * @module
 */
import type { TransportTimeline } from '@shared/clock';

/** One metronome click in song time. */
export interface BeatClick {
  /** Song time of the beat (s at 100%). */
  time: number;
  /** Downbeat (first beat of a bar): played accented. */
  accent: boolean;
}

/** Bar shape used when the timeline has no bars: 120 BPM, 4/4. */
const DEFAULT_BEAT_SEC = 0.5;
const DEFAULT_BEATS_PER_BAR = 4;

type TimelineBar = TransportTimeline['bars'][number];

/** Beat length and count of a bar (falls back to an even split of `dur`). */
function barMeter(bar: TimelineBar): { beatSec: number; beatsPerBar: number } {
  const beatsPerBar = Math.max(1, bar.beats.length);
  const beatSec = bar.beats.length >= 2 ? bar.beats[1]! - bar.beats[0]! : bar.dur / beatsPerBar;
  return { beatSec: beatSec > 0 ? beatSec : DEFAULT_BEAT_SEC, beatsPerBar };
}

/**
 * Beats of an evenly spaced grid `origin + i × beatSec` (i any integer, accent when
 * `i ≡ 0 mod beatsPerBar`) with `lo ≤ time < hi` and `time < before`.
 */
function evenGrid(origin: number, beatSec: number, beatsPerBar: number, lo: number, hi: number, before: number): BeatClick[] {
  const out: BeatClick[] = [];
  const end = Math.min(hi, before);
  if (!(end > lo)) return out;
  for (let i = Math.floor((lo - origin) / beatSec) - 1; ; i++) {
    const time = origin + i * beatSec;
    if (time >= end) break;
    if (time >= lo) out.push({ time, accent: ((i % beatsPerBar) + beatsPerBar) % beatsPerBar === 0 });
  }
  return out;
}

/** Index of the last bar starting at or before `t` (−1 if `t` precedes the first bar). */
function barIndexAt(bars: TransportTimeline['bars'], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Metronome beats with song time in the half-open range `[lo, hi)`, in ascending order.
 * Downbeats (`beats[0]` of each bar) are accented.
 */
export function beatsInRange(timeline: TransportTimeline, lo: number, hi: number): BeatClick[] {
  const { bars } = timeline;
  if (!(hi > lo)) return [];
  if (bars.length === 0) return evenGrid(0, DEFAULT_BEAT_SEC, DEFAULT_BEATS_PER_BAR, lo, hi, Infinity);
  const first = bars[0]!;
  const { beatSec, beatsPerBar } = barMeter(first);
  const out = evenGrid(first.time, beatSec, beatsPerBar, lo, hi, first.time);
  for (let b = Math.max(0, barIndexAt(bars, lo)); b < bars.length; b++) {
    const bar = bars[b]!;
    if (bar.time >= hi) break;
    bar.beats.forEach((time, j) => {
      if (time >= lo && time < hi) out.push({ time, accent: j === 0 });
    });
  }
  return out;
}

/** Length of the beat containing song time `t` and the beat count of its bar (count-in shape). */
export function meterAt(timeline: TransportTimeline, t: number): { beatSec: number; beatsPerBar: number } {
  const { bars } = timeline;
  if (bars.length === 0) return { beatSec: DEFAULT_BEAT_SEC, beatsPerBar: DEFAULT_BEATS_PER_BAR };
  const idx = barIndexAt(bars, t);
  const bar = bars[Math.max(0, idx)]!;
  const meter = barMeter(bar);
  if (idx < 0 || bar.beats.length === 0) return meter;
  let j = bar.beats.length - 1;
  while (j > 0 && bar.beats[j]! > t) j--;
  const next = j + 1 < bar.beats.length ? bar.beats[j + 1]! : bar.time + bar.dur;
  const beatSec = next - bar.beats[j]!;
  return { beatSec: beatSec > 0 ? beatSec : meter.beatSec, beatsPerBar: meter.beatsPerBar };
}

/**
 * Count-in before `from`: `bars × beatsPerBar` clicks one beat apart ending one beat before `from`,
 * using the meter at `from`; the first click of every count-in bar is accented.
 * Returns the song time where playback must start (the first click) and the clicks.
 */
export function countInClicks(
  timeline: TransportTimeline,
  from: number,
  bars: number,
): { start: number; clicks: BeatClick[] } {
  const { beatSec, beatsPerBar } = meterAt(timeline, from);
  const n = Math.max(0, Math.round(bars)) * beatsPerBar;
  const clicks: BeatClick[] = [];
  for (let k = n; k >= 1; k--) clicks.push({ time: from - k * beatSec, accent: (n - k) % beatsPerBar === 0 });
  return { start: n > 0 ? from - n * beatSec : from, clicks };
}

/** First bar line at or after song time `t`, or null if `t` is past the last bar line. */
export function nextBarLine(timeline: TransportTimeline, t: number): number | null {
  const { bars } = timeline;
  if (bars.length === 0) return Math.ceil(t / (DEFAULT_BEAT_SEC * DEFAULT_BEATS_PER_BAR)) * DEFAULT_BEAT_SEC * DEFAULT_BEATS_PER_BAR;
  const first = bars[0]!;
  if (t <= first.time) {
    const { beatSec, beatsPerBar } = barMeter(first);
    const barSec = beatSec * beatsPerBar;
    return first.time - Math.floor((first.time - t) / barSec) * barSec;
  }
  const idx = barIndexAt(bars, t);
  const bar = bars[idx]!;
  if (bar.time === t) return t;
  return idx + 1 < bars.length ? bars[idx + 1]!.time : null;
}
