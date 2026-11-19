import { describe, expect, it } from 'vitest';
import {
  beatLines,
  computePeaks,
  downbeatIndex,
  formatOffset,
  formatTempo,
  peakIn,
  songToX,
  viewForBar,
  waveformColumns,
  xToSong,
} from '../../src/ui/panels/backing/model';
import { grid } from './helpers';

const pcm = (sr: number, data: number[][]) => ({
  sampleRate: sr,
  length: data[0]!.length,
  numberOfChannels: data.length,
  getChannelData: (c: number) => Float32Array.from(data[c]!),
});

describe('backing panel model', () => {
  it('computes per-bin peaks over all channels and looks them up by audio time', () => {
    const p = computePeaks(pcm(1000, [[0, 0.2, 0, 0, 0, 0, 0, 0, 0, 0.1], [0, 0, 0, 0, 0, 0, -0.7, 0, 0, 0]]), 0.005);
    expect(p.binSec).toBe(0.005);
    expect(Array.from(p.values).map((v) => +v.toFixed(3))).toEqual([0.2, 0.7]);
    expect(peakIn(p, 0, 0.004)).toBeCloseTo(0.2, 6);
    expect(peakIn(p, 0.006, 0.009)).toBeCloseTo(0.7, 6);
    expect(peakIn(p, -1, -0.5)).toBe(0);
    expect(peakIn(p, 5, 6)).toBe(0);
  });

  it('views a bar range starting a quarter bar early, past the end too', () => {
    const bars = grid(120, 4).bars; // 2 s bars
    expect(viewForBar(bars, 1, 2)).toEqual({ start: 1.5, end: 5.5 });
    expect(viewForBar(bars, 3, 4)).toEqual({ start: 5.5, end: 13.5 });
    expect(viewForBar([], 0, 2)).toEqual({ start: -0.5, end: 3.5 });
    const v = { start: 2, end: 6 };
    expect(songToX(4, 400, v)).toBe(200);
    expect(xToSong(100, 400, v)).toBe(3);
  });

  it('lists beat lines with 1-based bar numbers on downbeats and finds downbeat indices', () => {
    const bars = grid(120, 4).bars;
    expect(beatLines(bars, { start: 1.6, end: 4 })).toEqual([
      { time: 2, bar: 2 },
      { time: 2.5, bar: null },
      { time: 3, bar: null },
      { time: 3.5, bar: null },
      { time: 4, bar: 3 },
    ]);
    expect(downbeatIndex(bars, 2)).toBe(8);
    expect(downbeatIndex(bars, 9)).toBe(-1);
  });

  it('draws the waveform through the warp: a click at audio 1.25 s shows at its song time', () => {
    const data = new Array(3000).fill(0);
    data[1250] = 1; // 1 kHz: audio 1.25 s
    const peaks = computePeaks(pcm(1000, [data]));
    // Song 1 = audio 1.25 (offset 0.25 s).
    const cols = waveformColumns(peaks, [{ songTime: 0, audioTime: 0.25 }], { start: 0, end: 2 }, 200);
    const hot = Array.from(cols).findIndex((v) => v > 0.5);
    expect(hot).toBe(100);
  });

  it('formats offsets and tempo', () => {
    expect(formatOffset(412.4)).toBe('+412 ms');
    expect(formatOffset(-38)).toBe('−38 ms');
    expect(formatTempo(98.765)).toBe('98.8%');
  });
});
