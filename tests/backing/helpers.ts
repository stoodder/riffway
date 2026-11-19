/**
 * Shared helpers for backing-audio tests: a beat-grid builder, generated click-track audio (no
 * recorded material), a WAV encoder, an onset detector and a segment recorder that yields the beat
 * times the transport scheduled.
 */
import type { PlaybackSegment, ScheduledSource, TransportTimeline } from '@shared/clock';

/** A uniform 4/4 grid at `bpm` for `bars` bars, starting at song 0. */
export function grid(bpm: number, bars: number, num = 4): TransportTimeline {
  const beat = 60 / bpm;
  return {
    durationSec: bars * num * beat,
    bars: Array.from({ length: bars }, (_, b) => ({
      time: b * num * beat,
      dur: num * beat,
      beats: Array.from({ length: num }, (_, j) => (b * num + j) * beat),
    })),
  };
}

/** Every beat time of a timeline. */
export const beatsOf = (tl: TransportTimeline): number[] => tl.bars.flatMap((b) => b.beats);

/** Interleaved-free PCM: per-channel sample arrays. */
export interface Pcm {
  sampleRate: number;
  channels: Float32Array<ArrayBuffer>[];
}

/** A 1.5 kHz decaying click (30 ms) added at each time in `times` (s), on every channel. */
export function clickTrack(times: readonly number[], seconds: number, sampleRate = 48000, channels = 2): Pcm {
  const len = Math.round(seconds * sampleRate);
  const out = Array.from({ length: channels }, () => new Float32Array(len));
  for (const t of times) {
    const s0 = Math.round(t * sampleRate);
    for (let i = 0; i < 0.03 * sampleRate; i++) {
      const v = 0.8 * Math.sin((2 * Math.PI * 1500 * i) / sampleRate) * Math.exp(-i / (0.006 * sampleRate));
      for (const ch of out) if (s0 + i >= 0 && s0 + i < len) ch[s0 + i]! += v;
    }
  }
  return { sampleRate, channels: out };
}

/** 16-bit PCM WAV bytes. */
export function encodeWav(pcm: Pcm): Uint8Array {
  const n = pcm.channels[0]!.length;
  const ch = pcm.channels.length;
  const data = n * ch * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, pcm.sampleRate, true);
  v.setUint32(28, pcm.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, data, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, pcm.channels[c]![i]!));
      v.setInt16(o, Math.round(s * 32767), true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

/** Onsets (s): first sample above `threshold` after ≥ `quietSec` below it. */
export function detectOnsets(pcm: Float32Array, sampleRate: number, threshold = 0.1, quietSec = 0.1): number[] {
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]!) <= threshold) continue;
    if (i - last > quietSec * sampleRate) out.push(i / sampleRate);
    last = i;
  }
  return out;
}

/** Records the segments/stops a transport issues, with `ScheduledSource` replace-from semantics. */
export class SegmentRecorder implements ScheduledSource {
  readonly name = 'recorder';
  private items: ({ at: number; seg: PlaybackSegment } | { at: number; seg: null })[] = [];
  constructor(private readonly now: () => number) {}
  schedule(seg: PlaybackSegment): void {
    this.items = this.items.filter((i) => i.at < seg.ctxStart - 1e-9);
    this.items.push({ at: seg.ctxStart, seg });
  }
  stop(when?: number): void {
    const at = when ?? this.now();
    this.items = this.items.filter((i) => i.at < at - 1e-9);
    this.items.push({ at, seg: null });
  }
  /** Context times at which each song beat in `beats` was scheduled to sound. */
  beatTimes(beats: readonly number[]): { ctx: number; song: number }[] {
    const out: { ctx: number; song: number }[] = [];
    this.items.forEach((it, i) => {
      if (!it.seg) return;
      const s = it.seg;
      const until = Math.min(this.items[i + 1]?.at ?? Infinity, s.ctxEnd ?? Infinity);
      for (const b of beats) {
        if (b < s.songStart - 1e-9 || (s.songEnd !== undefined && b >= s.songEnd - 1e-9)) continue;
        const ctx = s.ctxStart + (b - s.songStart) / s.speed;
        if (ctx < until - 1e-9) out.push({ ctx, song: b });
      }
    });
    return out.sort((a, b) => a.ctx - b.ctx);
  }
}
