/**
 * MIDI rhythm source for ASCII tabs (T-012): `@tonejs/midi` → onset groups, then Needleman–Wunsch
 * alignment of tab groups to MIDI groups (score = Jaccard of pitch sets, octave-insensitive 0.5,
 * gap −0.4; ≥ 80% matched → `rhythm: 'midi'`). Signatures frozen by T-010.
 * @module
 */
import * as tonejsMidi from '@tonejs/midi';
import type { TempoChange } from '@shared/song';
import { ImportError } from '../errors';

/** Notes starting together in the MIDI (all tracks merged). */
export interface MidiOnsetGroup {
  time: number;
  pitches: number[];
}

/** What the aligner needs from a MIDI file. */
export interface MidiRhythm {
  groups: MidiOnsetGroup[];
  tempos: TempoChange[];
  timeSignatures: { time: number; num: number; den: number }[];
  ppq: number;
  durationSec: number;
}

/** Alignment result. */
export interface MidiAlignment {
  /** Fraction of tab groups matched (0–1). */
  matched: number;
  /** One time per tab group (matched → MIDI time; unmatched → interpolated). */
  times: number[];
  /** `[tabGroupIndex, midiGroupIndex]` pairs. */
  pairs: [number, number][];
}

/** A tab onset group for alignment. `estTime` (proportional estimate) guides interpolation. */
export interface TabGroupPitches {
  pitches: readonly number[];
  /** Estimated time (any monotonic unit); unmatched groups interpolate along it. Defaults to the index. */
  estTime?: number;
}

/** Fraction of tab groups that must match for `rhythm: 'midi'`. */
export const MIDI_MATCH_THRESHOLD = 0.8;
/** Needleman–Wunsch gap penalty. */
export const GAP_PENALTY = -0.4;
/** Weight of the octave-insensitive (pitch-class) Jaccard when exact pitches do not overlap. */
export const OCTAVE_FALLBACK = 0.5;
/** Notes starting within this many seconds form one MIDI onset group. */
const GROUP_WINDOW_SEC = 0.02;
/** Minimum spacing kept between consecutive aligned times. */
const MIN_SPACING_SEC = 0.001;

type MidiCtor = typeof tonejsMidi.Midi;
/**
 * `@tonejs/midi` ships CommonJS only: bundlers (Vite) expose the named export, while Node's ESM
 * loader exposes the CommonJS `exports` object as `default`. Accept both.
 */
const interop = tonejsMidi as unknown as { Midi?: MidiCtor; default?: { Midi?: MidiCtor } };
const Midi: MidiCtor | undefined = interop.Midi ?? interop.default?.Midi;

/** Parse MIDI bytes into onset groups + tempo/time-signature maps. Throws `ImportError('unsupported')`. */
export function readMidiRhythm(data: Uint8Array): MidiRhythm {
  if (!Midi) throw new ImportError('internal', '@tonejs/midi could not be loaded');
  let midi: InstanceType<MidiCtor>;
  try {
    midi = new Midi(data);
  } catch (cause) {
    throw new ImportError('unsupported', 'Not a readable MIDI file', [], { cause });
  }
  const header = midi.header;
  const events: { time: number; pitch: number }[] = [];
  for (const track of midi.tracks) {
    if (track.channel === 9 || track.instrument.percussion) continue;
    for (const n of track.notes) events.push({ time: n.time, pitch: n.midi });
  }
  events.sort((a, b) => a.time - b.time || a.pitch - b.pitch);

  const groups: MidiOnsetGroup[] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && e.time - last.time <= GROUP_WINDOW_SEC) {
      if (!last.pitches.includes(e.pitch)) last.pitches.push(e.pitch);
    } else {
      groups.push({ time: e.time, pitches: [e.pitch] });
    }
  }
  for (const g of groups) g.pitches.sort((a, b) => a - b);

  const tempos: TempoChange[] = header.tempos
    .map((t) => ({ time: header.ticksToSeconds(t.ticks), bpm: t.bpm }))
    .sort((a, b) => a.time - b.time);
  if (tempos.length === 0 || tempos[0].time > 1e-6) tempos.unshift({ time: 0, bpm: 120 });
  const timeSignatures = header.timeSignatures
    .map((t) => ({ time: header.ticksToSeconds(t.ticks), num: t.timeSignature[0], den: t.timeSignature[1] }))
    .filter((t) => t.num > 0 && t.den > 0)
    .sort((a, b) => a.time - b.time);
  if (timeSignatures.length === 0 || timeSignatures[0].time > 1e-6) timeSignatures.unshift({ time: 0, num: 4, den: 4 });

  return { groups, tempos, timeSignatures, ppq: header.ppq, durationSec: midi.duration };
}

/** Jaccard of two sorted pitch sets. */
function jaccard(a: readonly number[], b: readonly number[]): number {
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inter++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  const union = a.length + b.length - inter;
  return union === 0 ? 0 : inter / union;
}

/** Popcount of a 12-bit pitch-class mask. */
function bits(mask: number): number {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  return n;
}

const pcMask = (pitches: readonly number[]): number => pitches.reduce((m, p) => m | (1 << (((p % 12) + 12) % 12)), 0);
const uniqueSorted = (pitches: readonly number[]): number[] => [...new Set(pitches)].sort((a, b) => a - b);

/**
 * Similarity of two onset groups: Jaccard of the pitch sets; when they share no exact pitch,
 * {@link OCTAVE_FALLBACK} × Jaccard of the pitch classes (octave errors in the tab or the MIDI).
 */
export function groupSimilarity(a: readonly number[], b: readonly number[]): number {
  const sa = uniqueSorted(a);
  const sb = uniqueSorted(b);
  return similarity(sa, pcMask(sa), sb, pcMask(sb));
}

/** {@link groupSimilarity} on pre-sorted unique sets with pre-computed pitch-class masks. */
function similarity(a: readonly number[], ma: number, b: readonly number[], mb: number): number {
  const exact = jaccard(a, b);
  if (exact > 0) return exact;
  const union = bits(ma | mb);
  return union === 0 ? 0 : (OCTAVE_FALLBACK * bits(ma & mb)) / union;
}

/**
 * Align tab onset groups (pitch sets in order) to MIDI onset groups: Needleman–Wunsch with free
 * leading/trailing MIDI gaps (a MIDI may hold an intro or repeats the tab writes once). A pair counts
 * as matched when its similarity is > 0; unmatched groups interpolate between matched neighbours along
 * `estTime` (or the index), extrapolating with the overall matched tempo at the ends.
 */
export function alignTabToMidi(tabGroups: readonly TabGroupPitches[], midi: MidiRhythm): MidiAlignment {
  const n = tabGroups.length;
  const m = midi.groups.length;
  if (n === 0) return { matched: 0, times: [], pairs: [] };

  const tabSets = tabGroups.map((g) => uniqueSorted(g.pitches));
  const tabMasks = tabSets.map(pcMask);
  const midiSets = midi.groups.map((g) => uniqueSorted(g.pitches));
  const midiMasks = midiSets.map(pcMask);
  const sim = (i: number, j: number): number => similarity(tabSets[i], tabMasks[i], midiSets[j], midiMasks[j]);

  // DP over (n+1) × (m+1); 0 = diagonal, 1 = up (tab gap), 2 = left (MIDI gap).
  const W = m + 1;
  const dir = new Uint8Array((n + 1) * W);
  let prev = new Float64Array(W); // row 0: free leading MIDI gaps
  let cur = new Float64Array(W);
  for (let j = 1; j <= m; j++) dir[j] = 2;
  for (let i = 1; i <= n; i++) {
    cur[0] = prev[0] + GAP_PENALTY;
    dir[i * W] = 1;
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1] + sim(i - 1, j - 1);
      const up = prev[j] + GAP_PENALTY;
      const left = cur[j - 1] + (i === n ? 0 : GAP_PENALTY); // free trailing MIDI gaps
      if (diag >= up && diag >= left) {
        cur[j] = diag;
        dir[i * W + j] = 0;
      } else if (up >= left) {
        cur[j] = up;
        dir[i * W + j] = 1;
      } else {
        cur[j] = left;
        dir[i * W + j] = 2;
      }
    }
    [prev, cur] = [cur, prev];
  }

  const pairs: [number, number][] = [];
  for (let i = n, j = m; i > 0; ) {
    const d = j === 0 ? 1 : dir[i * W + j];
    if (d === 0) {
      if (sim(i - 1, j - 1) > 0) pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (d === 1) i--;
    else j--;
  }
  pairs.reverse();

  const est = tabGroups.map((g, i) => g.estTime ?? i);
  const times = interpolate(est, pairs.map(([i, j]) => [i, midi.groups[j].time] as const));
  return { matched: pairs.length / n, times, pairs };
}

/**
 * Times for every group from anchors `(groupIndex, time)`: anchors keep their time; groups between
 * anchors interpolate linearly along `est`; groups outside extrapolate with the overall anchor slope.
 * Result is strictly increasing and ≥ 0.
 */
export function interpolate(est: readonly number[], anchors: readonly (readonly [number, number])[]): number[] {
  const n = est.length;
  const times = new Array<number>(n);
  if (anchors.length === 0) {
    const base = est[0] ?? 0;
    for (let i = 0; i < n; i++) times[i] = est[i] - base;
    return enforceIncreasing(times);
  }
  const [fi, ft] = anchors[0];
  const [li, lt] = anchors[anchors.length - 1];
  const slope = li !== fi && est[li] !== est[fi] ? (lt - ft) / (est[li] - est[fi]) : 1;
  for (let i = 0; i < fi; i++) times[i] = ft - (est[fi] - est[i]) * slope;
  for (let a = 0; a < anchors.length; a++) {
    const [ia, ta] = anchors[a];
    times[ia] = ta;
    if (a + 1 < anchors.length) {
      const [ib, tb] = anchors[a + 1];
      const span = est[ib] - est[ia];
      for (let i = ia + 1; i < ib; i++) times[i] = span > 0 ? ta + ((est[i] - est[ia]) / span) * (tb - ta) : ta + ((i - ia) / (ib - ia)) * (tb - ta);
    }
  }
  for (let i = li + 1; i < n; i++) times[i] = lt + (est[i] - est[li]) * slope;
  return enforceIncreasing(times);
}

/** Clamp to ≥ 0 and make strictly increasing (later groups pushed by at least 1 ms). */
export function enforceIncreasing(times: number[], minSpacing = MIN_SPACING_SEC): number[] {
  for (let i = 0; i < times.length; i++) {
    const floor = i === 0 ? 0 : times[i - 1] + minSpacing;
    if (!(times[i] >= floor)) times[i] = floor;
  }
  return times;
}
