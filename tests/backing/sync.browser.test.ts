/**
 * Backing audio stays on the engine's beat grid through the real signalsmith-stretch worklet.
 *
 * A generated click track (one click per tab beat, recorded with an offset and a tempo drift) is
 * warped by anchors and played by the `BackingPlayer` registered with a real `TransportCore`. The
 * offline render is driven like the live look-ahead timer: at every suspend point the transport
 * ticks and the player posts due changes. Detected click onsets are compared with the context times
 * the transport scheduled for each beat (recorded segments).
 */
import { describe, expect, it } from 'vitest';
import type { TransportTimeline } from '@shared/clock';
import type { WarpAnchor } from '@shared/storage';
import { TransportCore } from '../../src/audio/engine';
import { BackingPlayer } from '../../src/audio/backing/player';
import { audioTimeAt } from '../../src/audio/backing/warp';
import { SegmentRecorder, beatsOf, clickTrack, detectOnsets, grid } from './helpers';

const SR = 48000;
/** Tick every 10 render quanta (≈ 26.7 ms), like the 25 ms timer. */
const TICK_FRAMES = 1280;
/** Allowed |onset − scheduled beat| (ms). */
const TOLERANCE_MS = 4;

interface RenderResult {
  onsets: number[];
  expected: { ctx: number; song: number }[];
  latency: number;
}

/**
 * Render `seconds`: `audioBeats` (song beats that have a click in the recording) are placed in the
 * recording at `audioTimeAt(anchors, beat)`; `at(t, core)` runs at each tick point before the tick.
 */
async function render(opts: {
  seconds: number;
  timeline: TransportTimeline;
  anchors: WarpAnchor[];
  audioBeats: number[];
  at: (t: number, core: TransportCore) => void;
}): Promise<RenderResult> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(opts.seconds * SR), sampleRate: SR });
  const core = new TransportCore({ now: () => ctx.currentTime, clicks: { schedule: () => ({ cancel: () => undefined }) } }, { countInBars: 0, metronome: false });
  core.load(opts.timeline);
  const recorder = new SegmentRecorder(() => ctx.currentTime);
  core.addSource(recorder);
  const player = await BackingPlayer.create({ ctx, destination: ctx.destination, anchors: opts.anchors, autoPump: false });
  const clicks = clickTrack(opts.audioBeats.map((b) => audioTimeAt(opts.anchors, b)), audioTimeAt(opts.anchors, opts.timeline.durationSec) + 1, SR);
  const buffer = new AudioBuffer({ length: clicks.channels[0]!.length, sampleRate: SR, numberOfChannels: 2 });
  clicks.channels.forEach((c, i) => buffer.copyToChannel(c, i));
  await player.setBuffer(buffer);
  core.addSource(player);
  for (let f = TICK_FRAMES; f < ctx.length; f += TICK_FRAMES) {
    void ctx.suspend(f / SR).then(async () => {
      opts.at(ctx.currentTime, core);
      core.tick();
      await player.pump();
      await ctx.resume();
    });
  }
  const out = await ctx.startRendering();
  player.dispose();
  return { onsets: detectOnsets(out.getChannelData(0), SR), expected: recorder.beatTimes(beatsOf(opts.timeline)), latency: player.latency };
}

/**
 * Every expected beat from `from` on (and before the render end) has exactly one onset within
 * tolerance, and there are no other onsets after `from`.
 */
function expectAligned(r: RenderResult, from: number, until: number, audioBeats: readonly number[]): number[] {
  const expected = r.expected.filter((e) => e.ctx >= from && e.ctx < until - 0.05 && audioBeats.includes(e.song));
  const onsets = r.onsets.filter((o) => o >= from - 0.01 && o < until - 0.05);
  expect(expected.length).toBeGreaterThan(4);
  const errorsMs = expected.map((e) => {
    const nearest = onsets.reduce((best, o) => (Math.abs(o - e.ctx) < Math.abs(best - e.ctx) ? o : best), Infinity);
    return (nearest - e.ctx) * 1000;
  });
  for (const err of errorsMs) expect(Math.abs(err)).toBeLessThanOrEqual(TOLERANCE_MS);
  expect(onsets).toHaveLength(expected.length);
  return errorsMs;
}

/** A recording 0.4 s in, 2 % slower than the tab, with a slight drift after bar 4 (3 anchors). */
const DRIFT_ANCHORS: WarpAnchor[] = [
  { songTime: 0, audioTime: 0.4 },
  { songTime: 8, audioTime: 0.4 + 8 * 1.02 },
  { songTime: 16, audioTime: 0.4 + 8 * 1.02 + 8 * 0.99 },
];

describe('backing playback through the stretch worklet (OfflineAudioContext)', () => {
  for (const speed of [1, 0.7]) {
    it(`warped clicks land on the scheduled beats at ${speed * 100}% (offset, tempo drift, anchor boundary)`, async () => {
      const tl = grid(120, 8); // 16 s
      const beats = beatsOf(tl);
      let started = -1;
      const r = await render({
        seconds: 1 + 12 / speed,
        timeline: tl,
        anchors: DRIFT_ANCHORS,
        audioBeats: beats,
        at: (t, core) => {
          if (started < 0 && t >= 0.1) {
            started = t;
            core.setSpeed(speed);
            core.play({ from: 0, countInBars: 1 });
          }
        },
      });
      expect(r.latency).toBeGreaterThan(0);
      // The first beat (song 0) comes after a 1-bar count-in, well beyond the stretch latency.
      const errs = expectAligned(r, started + 0.5, 1 + 12 / speed, beats);
      const mean = errs.reduce((s, e) => s + Math.abs(e), 0) / errs.length;
      expect(mean).toBeLessThan(2.5);
      // The anchor boundary at song 8 was crossed (rate change scheduled in between).
      expect(r.expected.some((e) => e.song > 8)).toBe(true);
    });
  }

  it('loop wraps jump back in the recording without gaps or overrun (70%)', async () => {
    const tl = grid(120, 8);
    const speed = 0.7;
    // Only beats before B (song 4) exist in the recording: an overrun past B would be silent.
    const audioBeats = beatsOf(tl).filter((b) => b < 4);
    let started = -1;
    const r = await render({
      seconds: 16,
      timeline: tl,
      anchors: [{ songTime: 0, audioTime: 0.3 }],
      audioBeats,
      at: (t, core) => {
        if (started < 0 && t >= 0.1) {
          started = t;
          core.setSpeed(speed);
          core.setLoop({ start: 2, end: 4, preroll: 1 });
          core.play({ from: 2, countInBars: 1 });
        }
      },
    });
    const wraps = r.expected.filter((e, i) => i > 0 && e.song < r.expected[i - 1]!.song).length;
    expect(wraps).toBeGreaterThanOrEqual(3);
    expectAligned(r, started + 0.5, 16, audioBeats);
  });

  it('seeks and bar-aligned speed changes re-sync after the stretch latency', async () => {
    const tl = grid(100, 12); // 28.8 s
    const beats = beatsOf(tl);
    const anchors: WarpAnchor[] = [{ songTime: 0, audioTime: 1.1 }];
    let started = -1;
    let seekAt = -1;
    let speedAt = -1;
    const r = await render({
      seconds: 16,
      timeline: tl,
      anchors,
      audioBeats: beats,
      at: (t, core) => {
        if (started < 0 && t >= 0.1) {
          started = t;
          core.play({ from: 0, countInBars: 1 });
        } else if (seekAt < 0 && t >= 6.05) {
          seekAt = t;
          core.seek(14.5);
        } else if (speedAt < 0 && t >= 9.3) {
          speedAt = t;
          core.setSpeed(0.7);
        }
      },
    });
    const settle = r.latency + 0.06;
    expectAligned(r, started + 0.5, seekAt, beats);
    expectAligned(r, seekAt + settle, 16, beats);
    // The speed change landed on a bar line after the request.
    expect(r.expected.filter((e) => e.ctx > speedAt + 0.5).length).toBeGreaterThan(4);
  });
});
