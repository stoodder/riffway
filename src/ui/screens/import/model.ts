/**
 * Pure logic of the import screen (T-028; docs/song-formats.md § Rhythm alignment UX): parse
 * preview, header overrides, snap/tap onset maths, tap tempo, sidecar building. DOM-free so it is
 * unit-tested in Node; the screen (`./index.ts`) only wires it to controls.
 * @module
 */
import type { TransportTimeline } from '@shared/clock';
import type { ImportDiagnostic, RhythmSidecar } from '@shared/song';
import { parseAsciiTab, splitVersions, type AsciiTab } from '@core/import/ascii';
import {
  DEFAULT_BPM,
  DEFAULT_TIME_SIG,
  barFractions,
  mapTapsToOnsets,
  proportionalTimes,
  snapToGrid,
  type ColumnInfo,
  type Subdivision,
} from '@core/import/align';
import { describeTuning, NOTE_NAMES } from '@core/model';

export type { Subdivision } from '@core/import/align';

/** Subdivisions offered by the snap-to-grid control, coarsest first. */
export const SUBDIVISIONS: readonly { value: Subdivision; label: string }[] = [
  { value: 8, label: '1/8' },
  { value: 12, label: '1/8 triplet' },
  { value: 16, label: '1/16' },
];

/** Tempo bounds accepted by the BPM field (the server enforces the same range). */
export const MIN_BPM = 20;
export const MAX_BPM = 400;

/** Named tunings offered as overrides (high → low MIDI, string 1 first). */
export const TUNING_CHOICES: readonly { id: string; midi: readonly number[] }[] = [
  { id: 'standard', midi: [64, 59, 55, 50, 45, 40] },
  { id: 'drop-d', midi: [64, 59, 55, 50, 45, 38] },
  { id: 'eb-standard', midi: [63, 58, 54, 49, 44, 39] },
  { id: 'd-standard', midi: [62, 57, 53, 48, 43, 38] },
  { id: 'drop-c-sharp', midi: [63, 58, 54, 49, 44, 37] },
  { id: 'drop-c', midi: [62, 57, 53, 48, 43, 36] },
  { id: 'double-drop-d', midi: [62, 59, 55, 50, 45, 38] },
  { id: 'dadgad', midi: [62, 57, 55, 50, 45, 38] },
  { id: 'open-g', midi: [62, 59, 55, 50, 43, 38] },
  { id: 'open-d', midi: [62, 57, 54, 50, 45, 38] },
  { id: 'open-e', midi: [64, 59, 56, 52, 47, 40] },
];

/** One warning for the preview list. `line` is 1-based in the pasted text. */
export interface PasteWarning {
  severity: ImportDiagnostic['severity'];
  code: string;
  message: string;
  line?: number;
}

/** What the live preview shows about a paste. */
export interface PasteParse {
  /** Parse of the first version (what is imported). Null when the text has no tab at all. */
  tab: AsciiTab | null;
  /** Number of versions in the text (ClassTab "version 2 …"); only the first is imported. */
  versions: number;
  /** Bars (played order) and onset groups (one per tap / grid onset). */
  bars: number;
  onsets: number;
  notes: number;
  tuningLabel: string;
  /** Lines (1-based) that belong to a staff block. */
  staffLines: Set<number>;
  /** Lines (1-based) that looked like tab but did not parse. */
  unparsedLines: Set<number>;
  warnings: PasteWarning[];
}

/** Parse pasted text for the preview: first version only (as `asciiToSong` imports it). */
export function parsePaste(text: string): PasteParse {
  const empty: PasteParse = {
    tab: null,
    versions: 0,
    bars: 0,
    onsets: 0,
    notes: 0,
    tuningLabel: '—',
    staffLines: new Set(),
    unparsedLines: new Set(),
    warnings: [],
  };
  if (!text.trim()) return empty;
  const regions = splitVersions(text);
  const first = regions[0];
  let tab: AsciiTab;
  try {
    tab = parseAsciiTab(first?.text ?? text, { lineOffset: first?.startLine ?? 0 });
  } catch (err) {
    return { ...empty, warnings: [{ severity: 'error', code: 'parse-failed', message: `The text could not be read: ${(err as Error).message}` }] };
  }
  const staffLines = new Set<number>();
  for (const b of tab.blocks) for (let k = 0; k < b.lines.length; k++) staffLines.add(b.startLine + k);
  const warnings: PasteWarning[] = tab.diagnostics.map((d) => ({
    severity: d.severity,
    code: d.code,
    message: d.message,
    ...(d.line !== undefined ? { line: d.line } : {}),
  }));
  if (regions.length > 1) {
    warnings.push({ severity: 'info', code: 'multiple-versions', message: `The text holds ${regions.length} versions; only version 1 is imported` });
  }
  if (tab.groups.length === 0) {
    warnings.push({
      severity: 'error',
      code: 'no-notes',
      message: tab.blocks.length ? 'Staves were found but they hold no notes' : 'No 6-line tab staff found',
    });
  }
  warnings.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
  const lastGroup = tab.groups[tab.groups.length - 1];
  return {
    tab,
    versions: regions.length,
    bars: lastGroup ? lastGroup.bar + 1 : 0,
    onsets: tab.groups.length,
    notes: tab.groups.reduce((n, g) => n + g.notes.length, 0),
    tuningLabel: describeTuning(tab.tuning).label,
    staffLines,
    unparsedLines: new Set(tab.unparsed.map((u) => u.line)),
    warnings,
  };
}

/** Values the user can override; written as header lines in front of the saved text. */
export interface HeaderOverrides {
  /** The title the player typed (wins over a title-like first line of the text). */
  title?: string;
  /** The artist the player typed. */
  artist?: string;
  /** MIDI tuning high → low. */
  tuning?: readonly number[];
  capo?: number;
  bpm?: number;
  timeSig?: readonly [number, number];
}

/** `D A D G B E`: pitch classes low → high, the way a `Tuning:` header line is written. */
export function tuningNames(tuning: readonly number[]): string {
  return [...tuning]
    .reverse()
    .map((m) => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12])
    .join(' ');
}

/**
 * The text that is saved: header lines for every override that differs from what the text already
 * says (`Title:`, `Artist:`, `Tuning:`, `Capo:`, `Tempo: Q=`, `Time:`), a blank line, then the pasted
 * text. The header parser keeps the first value it finds, so these lines win over the tab's own
 * header: a typed title beats a title-like first line of the text (R2-S-06).
 */
export function composeText(raw: string, overrides: HeaderOverrides, detected: AsciiTab | null): string {
  const header = detected?.header ?? {};
  const lines: string[] = [];
  const same = (a: readonly number[] | undefined, b: readonly number[] | undefined): boolean =>
    !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
  const title = overrides.title?.trim();
  const artist = overrides.artist?.trim();
  // Only when the text names something else: otherwise the file name ("Artist - Title.txt") says it.
  if (title && header.title !== undefined && title !== header.title) lines.push(`Title: ${oneLine(title)}`);
  if (artist && header.artist !== undefined && artist !== header.artist) lines.push(`Artist: ${oneLine(artist)}`);
  if (overrides.tuning && !same(overrides.tuning, detected?.tuning)) lines.push(`Tuning: ${tuningNames(overrides.tuning)}`);
  if (overrides.capo !== undefined && overrides.capo !== (header.capo ?? 0)) lines.push(`Capo: ${overrides.capo}`);
  if (overrides.bpm !== undefined && overrides.bpm !== header.tempo) lines.push(`Tempo: Q=${Math.round(overrides.bpm)}`);
  if (overrides.timeSig && !same(overrides.timeSig, header.timeSig)) lines.push(`Time: ${overrides.timeSig[0]}/${overrides.timeSig[1]}`);
  if (!lines.length) return raw;
  return `${lines.join('\n')}\n\n${raw}`;
}

/** A typed value as a single header line (no line breaks). */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ');
}

/** Rhythm settings chosen in the alignment UI. */
export interface RhythmChoice {
  bpm: number;
  timeSig: [number, number];
  grid: Subdivision;
  method: 'snap' | 'tap';
  /** Tap-along: song seconds per tapped onset group, in order. */
  taps: readonly number[];
  /** Tap-along: quantise taps to `grid`. */
  quantizeTaps: boolean;
}

/**
 * Onset time (song seconds) per onset group. Snap: column spacing quantised to the grid. Tap: the
 * taps, with untapped groups extrapolated from column spacing at the tapped tempo (or the BPM when
 * fewer than two taps exist), optionally quantised.
 */
export function computeOnsets(groups: readonly ColumnInfo[], choice: RhythmChoice): number[] {
  if (groups.length === 0) return [];
  if (choice.method === 'snap') return snapToGrid(groups, choice.bpm, choice.timeSig, choice.grid);
  const quantize = choice.quantizeTaps ? { bpm: choice.bpm, timeSig: choice.timeSig, subdivision: choice.grid } : undefined;
  if (!quantize && choice.taps.length < 2) {
    const est = proportionalTimes(groups, choice.bpm, choice.timeSig);
    if (choice.taps.length === 0) return est;
    const shift = choice.taps[0] - est[0];
    return est.map((e) => e + shift);
  }
  return mapTapsToOnsets(choice.taps, groups, quantize);
}

/** Build the sidecar saved with the song (`method` `snap` or `tap`). */
export function buildSidecar(onsets: readonly number[], choice: RhythmChoice, now: number): RhythmSidecar {
  return {
    schema: 1,
    bpm: choice.bpm,
    timeSig: [choice.timeSig[0], choice.timeSig[1]],
    grid: choice.grid,
    onsets: onsets.map((t) => Math.max(0, Math.round(t * 1e6) / 1e6)),
    method: choice.method,
    savedAt: now,
  };
}

/** Largest mean distance to the nearest grid slot (in slots) still accepted as "fits this grid". */
const FIT_TOLERANCE = 0.2;

/**
 * True when column spacing fits `sub`: every group of a bar gets its own slot and positions sit on
 * average within {@link FIT_TOLERANCE} of a slot.
 */
function fitsGrid(groups: readonly ColumnInfo[], fractions: readonly number[], timeSig: readonly [number, number], sub: Subdivision): boolean {
  const quarterPerBar = (timeSig[0] * 4) / timeSig[1];
  const slots = Math.max(1, Math.round(quarterPerBar * (sub === 12 ? 3 : sub / 4)));
  let error = 0;
  let prevBar = -1;
  let prevSlot = -1;
  for (let i = 0; i < groups.length; i++) {
    const pos = fractions[i] * slots;
    const slot = Math.round(pos);
    if (groups[i].bar === prevBar && slot === prevSlot) return false;
    error += Math.abs(pos - slot);
    prevBar = groups[i].bar;
    prevSlot = slot;
  }
  return error / groups.length <= FIT_TOLERANCE;
}

/**
 * Suggest a subdivision from column spacing: 1/8 when the tab fits it, else 1/8 triplets when they
 * fit and sixteenths do not, else 1/16 (the finest grid, closest to the written spacing).
 */
export function suggestSubdivision(groups: readonly ColumnInfo[], timeSig: readonly [number, number]): Subdivision {
  if (groups.length === 0) return 16;
  const fr = barFractions(groups);
  if (fitsGrid(groups, fr, timeSig, 8)) return 8;
  if (!fitsGrid(groups, fr, timeSig, 16) && fitsGrid(groups, fr, timeSig, 12)) return 12;
  return 16;
}

/** Taps further apart than this (ms) start a new tap-tempo measurement. */
export const TAP_TEMPO_RESET_MS = 2000;
/** Intervals averaged by tap tempo. */
const TAP_TEMPO_WINDOW = 8;

/**
 * Tap tempo: BPM from tap timestamps (ms, ascending), averaging the last eight intervals of the
 * current run (a pause of {@link TAP_TEMPO_RESET_MS} starts a new run). Null until two taps.
 */
export function tapTempoBpm(timesMs: readonly number[]): number | null {
  let start = timesMs.length - 1;
  while (start > 0 && timesMs[start] - timesMs[start - 1] <= TAP_TEMPO_RESET_MS) start--;
  const run = timesMs.slice(Math.max(start, timesMs.length - 1 - TAP_TEMPO_WINDOW));
  if (run.length < 2) return null;
  const avg = (run[run.length - 1] - run[0]) / (run.length - 1);
  if (avg <= 0) return null;
  return clampBpm(Math.round(60000 / avg));
}

/** Clamp to the accepted BPM range. */
export function clampBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

/** Two taps closer than this (s) are a key bounce; the second is ignored. */
export const MIN_TAP_GAP = 0.03;

/** Add one tap (song seconds). Ignored once every group is tapped, or as a bounce. Never negative. */
export function addTap(taps: readonly number[], songTime: number, total: number): number[] {
  if (taps.length >= total) return [...taps];
  const t = Math.max(0, songTime);
  const prev = taps[taps.length - 1];
  if (prev !== undefined && t < prev + MIN_TAP_GAP) return [...taps];
  return [...taps, t];
}

/** Index of the first onset group in bar `bar` or later (groups.length when none). */
export function firstGroupInBar(groups: readonly ColumnInfo[], bar: number): number {
  const i = groups.findIndex((g) => g.bar >= bar);
  return i < 0 ? groups.length : i;
}

/**
 * Restart tap-along from bar `bar` (0-based): keep taps before that bar's first group, and return
 * where playback should resume (one bar before the expected time of that group; never before 0).
 */
export function restartFromBar(
  taps: readonly number[],
  groups: readonly ColumnInfo[],
  bar: number,
  bpm: number,
  timeSig: [number, number],
): { taps: number[]; from: number } {
  const k = Math.min(firstGroupInBar(groups, bar), taps.length);
  const kept = taps.slice(0, k);
  const barDur = (60 / bpm) * ((timeSig[0] * 4) / timeSig[1]);
  const onsets = computeOnsets(groups, { bpm, timeSig, grid: 16, method: 'tap', taps: kept, quantizeTaps: false });
  const target = k < groups.length ? onsets[k] : (onsets[onsets.length - 1] ?? 0);
  return { taps: kept, from: Math.max(0, target - barDur) };
}

/** Clean names for the saved file (mirrors the server's naming; used for display and the preview song). */
export function previewFileName(title: string, artist: string): string {
  const t = title.trim() || 'Untitled';
  const a = artist.trim();
  return `${a ? `${a} - ${t}` : t}.txt`.replace(/[/\\]/g, '-');
}

/**
 * Transport timeline for tap-along: constant bars at `bpm` in `timeSig` covering the expected end
 * (last estimated onset) plus two spare bars, so the metronome keeps going while the player taps.
 */
export function tapTimeline(onsets: readonly number[], bpm: number, timeSig: readonly [number, number]): TransportTimeline {
  const beat = (60 / bpm) * (4 / timeSig[1]);
  const barDur = beat * timeSig[0];
  const end = onsets.length ? onsets[onsets.length - 1] : 0;
  const count = Math.max(2, Math.ceil(end / barDur) + 2);
  const bars = Array.from({ length: count }, (_, i) => ({
    time: i * barDur,
    dur: barDur,
    beats: Array.from({ length: timeSig[0] }, (_, k) => i * barDur + k * beat),
  }));
  return { durationSec: count * barDur, bars };
}

export { DEFAULT_BPM, DEFAULT_TIME_SIG };

/**
 * "Search on Ultimate Guitar" link-out (docs/sources/ultimate-guitar.md § Link-out search). Only the
 * user's browser opens it, in a new tab; Riffway never requests Ultimate Guitar.
 */
export function ugSearchUrl(query: string): string {
  return `https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(query.trim())}`;
}

/** Common time signatures offered by the picker (a detected other one is added to the list). */
export const TIME_SIGNATURES: readonly (readonly [number, number])[] = [
  [4, 4],
  [3, 4],
  [2, 4],
  [6, 8],
  [12, 8],
  [9, 8],
  [5, 4],
  [7, 8],
  [2, 2],
];
