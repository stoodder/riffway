/**
 * Pure view logic for the backing-audio panel: waveform peaks, the visible song-time window, beat
 * lines, pixel ↔ time mapping and display strings. DOM-free so it is unit-tested in Node.
 * @module
 */
import type { Bar } from '@shared/song';
import type { WarpAnchor } from '@shared/storage';
import { audioTimeAt } from '../../../audio/backing/warp';

/** File picker filter for backing audio (extensions plus the matching MIME types). */
export const BACKING_ACCEPT = '.mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a';

/** "100%" for a speed fraction (no space before %, as everywhere else; R3-U-19). */
export function speedLabel(speed: number): string {
  return `${Math.round(speed * 100)}%`;
}

/** Waveform peak resolution (s per bin). */
export const PEAK_BIN_SEC = 0.005;
/** Zoom choices: bars visible in the waveform. */
export const ZOOM_BARS = [1, 2, 4, 8] as const;
/** Default zoom (bars visible). */
export const DEFAULT_ZOOM_BARS = 4;

/** Something with channel data (an `AudioBuffer` or a test double). */
export interface PcmSource {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Peak absolute amplitude per {@link PEAK_BIN_SEC} bin of audio time (all channels). */
export interface Peaks {
  binSec: number;
  values: Float32Array;
}

/** Compute waveform peaks once per buffer (O(samples)). */
export function computePeaks(pcm: PcmSource, binSec = PEAK_BIN_SEC): Peaks {
  const binSamples = Math.max(1, Math.round(binSec * pcm.sampleRate));
  const bins = Math.ceil(pcm.length / binSamples);
  const values = new Float32Array(bins);
  for (let c = 0; c < pcm.numberOfChannels; c++) {
    const data = pcm.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]!);
      const b = (i / binSamples) | 0;
      if (v > values[b]!) values[b] = v;
    }
  }
  return { binSec: binSamples / pcm.sampleRate, values };
}

/** Largest peak in audio time `[from, to)` (0 outside the recording). */
export function peakIn(peaks: Peaks, from: number, to: number): number {
  const first = Math.floor(from / peaks.binSec);
  const last = Math.min(peaks.values.length - 1, Math.max(first, Math.ceil(to / peaks.binSec) - 1));
  let m = 0;
  for (let i = Math.max(0, first); i <= last; i++) if (peaks.values[i]! > m) m = peaks.values[i]!;
  return m;
}

/** The visible window in song time. */
export interface ViewWindow {
  start: number;
  end: number;
}

/**
 * Window showing `zoomBars` bars from bar `barIndex`, starting a quarter of that bar early so the
 * downbeat is not on the edge. Past the last bar, the last bar's length is used.
 */
export function viewForBar(bars: readonly Pick<Bar, 'time' | 'dur'>[], barIndex: number, zoomBars: number): ViewWindow {
  if (bars.length === 0) return { start: -0.5, end: 2 * zoomBars - 0.5 };
  const i = Math.min(Math.max(0, barIndex), bars.length - 1);
  const first = bars[i]!;
  const lastIdx = Math.min(bars.length - 1, i + zoomBars - 1);
  const last = bars[lastIdx]!;
  const extra = i + zoomBars - 1 - lastIdx; // bars beyond the song: extend with the last bar's length
  const end = last.time + last.dur * (1 + extra);
  const lead = first.dur / 4;
  return { start: first.time - lead, end: end - lead };
}

/** Song time at x pixels across a `width`-pixel view. */
export const xToSong = (x: number, width: number, view: ViewWindow): number => view.start + (x / width) * (view.end - view.start);
/** x pixels of a song time in a `width`-pixel view. */
export const songToX = (t: number, width: number, view: ViewWindow): number => ((t - view.start) / (view.end - view.start)) * width;

/** A beat line to draw. */
export interface BeatLine {
  time: number;
  /** Bar number (1-based, played order) on downbeats, else null. */
  bar: number | null;
}

/** Beat lines inside the view (downbeats carry their 1-based bar number). */
export function beatLines(bars: readonly { readonly beats: readonly number[] }[], view: ViewWindow): BeatLine[] {
  const out: BeatLine[] = [];
  bars.forEach((bar, i) => {
    bar.beats.forEach((t, j) => {
      if (t >= view.start && t <= view.end) out.push({ time: t, bar: j === 0 ? i + 1 : null });
    });
  });
  return out;
}

/**
 * Waveform columns for a view: the peak of the audio heard during each pixel's song-time slice
 * (through the warp), so the waveform lines up with the beat grid exactly as playback will.
 */
export function waveformColumns(peaks: Peaks, anchors: readonly WarpAnchor[], view: ViewWindow, width: number): Float32Array {
  const cols = new Float32Array(Math.max(0, Math.floor(width)));
  const dt = (view.end - view.start) / Math.max(1, width);
  let a0 = audioTimeAt(anchors, view.start);
  for (let x = 0; x < cols.length; x++) {
    const a1 = audioTimeAt(anchors, view.start + (x + 1) * dt);
    cols[x] = peakIn(peaks, Math.min(a0, a1), Math.max(a0, a1));
    a0 = a1;
  }
  return cols;
}

/** Index of bar `barIndex`'s downbeat in the flattened beat list (−1 if none). */
export function downbeatIndex(bars: readonly { readonly beats: readonly number[] }[], barIndex: number): number {
  let idx = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i === barIndex) return bars[i]!.beats.length ? idx : -1;
    idx += bars[i]!.beats.length;
  }
  return -1;
}

/** `+412 ms` / `−38 ms` (where song 0 lands in the recording). */
export function formatOffset(ms: number): string {
  const r = Math.round(ms);
  return `${r < 0 ? '−' : '+'}${Math.abs(r)} ms`;
}

/** `98.8%` recording tempo relative to the tab. */
export function formatTempo(percent: number): string {
  return `${percent.toFixed(1)}%`;
}
