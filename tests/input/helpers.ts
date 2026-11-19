/**
 * Test helpers for the input area (T-022): drive {@link AnalysisCore} over generated signals the way
 * the worklet does (128-sample quanta, context frames), and build plucked melodies whose notes fade
 * out (an abrupt cut would read as an onset).
 */
import type { AnalysisCommand, AnalysisEvent } from '@shared/audio-events';
import { AnalysisCore, QUANTUM } from '../../src/audio/input/analysis-core';
import { addPickTransient, fadeOut, midiToHz, pluckedTone, renderTimeline } from '../helpers/signals';

export const SR = 48000;

/** A note of a test melody. */
export interface MelodyNote {
  atSec: number;
  midi: number;
  /** Sounding length before the fade, s (default 0.35). */
  durSec?: number;
}

/** One plucked note: additive tone + pick transient + 8 ms fade-out. */
export function pluck(midi: number, durSec: number, sampleRate = SR, amp = 0.5): Float32Array {
  const tone = pluckedTone(midiToHz(midi), durSec, sampleRate, { amp, decaySec: 0.6 });
  addPickTransient(tone, sampleRate, amp * 0.3);
  return fadeOut(tone, sampleRate, 8);
}

/** Render a melody into one mono buffer of `totalSec`. */
export function melody(notes: readonly MelodyNote[], totalSec: number, sampleRate = SR, noiseDb = -80): Float32Array {
  return renderTimeline(
    notes.map((n) => ({ atSec: n.atSec, signal: pluck(n.midi, n.durSec ?? 0.35, sampleRate) })),
    totalSec,
    sampleRate,
    noiseDb,
  );
}

/** Options for {@link runCore}. */
export interface RunOptions {
  sampleRate?: number;
  channel?: 0 | 1 | 'mix';
  tuner?: boolean;
  /** Context frame of the first sample (default 0). */
  startFrame?: number;
  /** Commands sent before the quantum starting at `frame` is processed. */
  commands?: { frame: number; cmd: AnalysisCommand }[];
}

/** Feed `channels` (equal lengths) through a fresh core, quantum by quantum; returns all events. */
export function runCore(channels: readonly Float32Array[], opts: RunOptions = {}): AnalysisEvent[] {
  const sampleRate = opts.sampleRate ?? SR;
  const events: AnalysisEvent[] = [];
  const core = new AnalysisCore({ sampleRate, channel: opts.channel ?? 0, tuner: opts.tuner ?? false }, (ev) => events.push({ ...ev }));
  const start = opts.startFrame ?? 0;
  const length = channels[0]?.length ?? 0;
  const pending = [...(opts.commands ?? [])].sort((a, b) => a.frame - b.frame);
  for (let off = 0; off + QUANTUM <= length; off += QUANTUM) {
    while (pending.length && pending[0].frame <= off) core.command(pending.shift()!.cmd);
    core.process(
      channels.map((c) => c.subarray(off, off + QUANTUM)),
      start + off,
    );
  }
  return events;
}

/** Events of one type, narrowed. */
export function ofType<T extends AnalysisEvent['type']>(events: readonly AnalysisEvent[], type: T): Extract<AnalysisEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AnalysisEvent, { type: T }> => e.type === type);
}
