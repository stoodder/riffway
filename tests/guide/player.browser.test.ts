/**
 * Guide player scheduling (T-021) against the engine clock in real Web Audio: the engine's
 * `TransportCore` drives a `GuidePlayer` on an `OfflineAudioContext`, ticked at render-time
 * `suspend()` points like the live look-ahead timer. Pieces hold synthetic "renders" with an
 * impulse at known song times (rendered at the piece's speed), so every output onset can be mapped
 * back through the transport's segments and must land on an impulse's song time within a sample.
 */
import { describe, expect, it } from 'vitest';
import type { PlaybackSegment, ScheduledSource, TransportTimeline } from '@shared/clock';
import { REANCHOR_LEAD_SEC, TransportCore } from '../../src/audio/engine';
import { FADE_SEC, GuidePlayer, type GuidePiece } from '../../src/audio/guide/player';

const SR = 48000;
/** Tick every 10 render quanta (≈ 26.7 ms), like the 25 ms timer. */
const TICK_FRAMES = 1280;
/** Impulses every 250 ms of song time, offset from bar lines so slice fades never touch them. */
const IMPULSE_STEP = 0.25;
const IMPULSE_OFFSET = 0.0625;
const BAR_SEC = 1;
const BARS = 8;

const TIMELINE: TransportTimeline = {
  durationSec: BARS * BAR_SEC,
  bars: Array.from({ length: BARS }, (_, i) => ({ time: i, dur: BAR_SEC, beats: [0, 0.25, 0.5, 0.75].map((b) => i + b) })),
};

/** Song times of the impulses in `[from, to)`. */
function impulsesIn(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = IMPULSE_OFFSET; t < to; t += IMPULSE_STEP) if (t >= from - 1e-9) out.push(t);
  return out;
}

/** A synthetic render of song `[from, to)` at `speed`: one decaying impulse per impulse time, in chunks. */
function addSyntheticPiece(player: GuidePlayer, speed: number, from: number, to: number, chunkSec = 0.7, renderTo = to): GuidePiece {
  const piece = player.addPiece(speed, from, to);
  appendSynthetic(player, piece, speed, from, renderTo, chunkSec);
  player.completePiece(piece);
  return piece;
}

function appendSynthetic(player: GuidePlayer, piece: GuidePiece, speed: number, from: number, to: number, chunkSec: number): void {
  const total = Math.round(((to - from) / speed) * SR);
  const pcm = new Float32Array(total);
  for (const t of impulsesIn(from, to)) {
    const at = Math.round(((t - from) / speed) * SR);
    for (let k = 0; k < 48 && at + k < total; k++) pcm[at + k] = 0.9 * Math.exp(-k / 8);
  }
  const step = Math.round(chunkSec * SR);
  for (let s = 0; s < total; s += step) {
    const len = Math.min(step, total - s);
    const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: SR });
    buf.copyToChannel(pcm.subarray(s, s + len), 0);
    buf.copyToChannel(pcm.subarray(s, s + len), 1);
    player.appendChunk(piece, buf, from + (s / SR) * speed);
  }
}

/** Records every segment handed to the player (the transport's view of the clock). */
class Recorder implements ScheduledSource {
  readonly name = 'guide';
  readonly segments: PlaybackSegment[] = [];
  readonly stops: number[] = [];
  constructor(private readonly inner: ScheduledSource) {}
  schedule(seg: PlaybackSegment): void {
    this.segments.push({ ...seg });
    this.inner.schedule(seg);
  }
  stop(when?: number): void {
    this.stops.push(when ?? Number.NaN);
    this.inner.stop(when);
  }
}

/** Song time sounding at ctx time `t` according to the recorded segments (null if silent). */
function songAt(rec: Recorder, t: number): number | null {
  let seg: PlaybackSegment | null = null;
  for (const s of rec.segments) if (s.ctxStart <= t + 1e-9) seg = s; // later schedules replace earlier ones
  if (!seg) return null;
  if (seg.ctxEnd !== undefined && t >= seg.ctxEnd) return null;
  return seg.songStart + (t - seg.ctxStart) * seg.speed;
}

/** Impulse onsets: first sample above 0.3 after ≥ 20 ms below it. */
function detectOnsets(pcm: Float32Array): number[] {
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]!) > 0.3) {
      if (i - last > 0.02 * SR) out.push(i / SR);
      last = i;
    }
  }
  return out;
}

interface Rig {
  ctx: OfflineAudioContext;
  core: TransportCore;
  player: GuidePlayer;
  rec: Recorder;
  missing: [number, number][];
}

/**
 * Render `seconds` with the player as the transport's scheduled source. `setup` runs at ctx time 0,
 * `at(t, rig)` at every tick point before the tick.
 */
async function run(
  seconds: number,
  setup: (rig: Rig) => void,
  at: (t: number, rig: Rig) => void = () => undefined,
): Promise<{ pcm: Float32Array; rig: Rig }> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: Math.round(seconds * SR), sampleRate: SR });
  const missing: [number, number][] = [];
  const player = new GuidePlayer(ctx, ctx.destination, { missing: (speed, t) => missing.push([speed, t]) });
  player.setDuration(TIMELINE.durationSec);
  const core = new TransportCore({ now: () => ctx.currentTime, clicks: { schedule: () => ({ cancel: () => undefined }) } }, { countInBars: 0, metronome: false });
  core.load(TIMELINE);
  const rec = new Recorder(player);
  core.addSource(rec);
  const rig: Rig = { ctx, core, player, rec, missing };
  setup(rig);
  core.tick();
  for (let f = TICK_FRAMES; f < ctx.length; f += TICK_FRAMES) {
    void ctx.suspend(f / SR).then(() => {
      at(ctx.currentTime, rig);
      core.tick();
      void ctx.resume();
    });
  }
  const pcm = (await ctx.startRendering()).getChannelData(0);
  return { pcm, rig };
}

/** Every onset maps (through the recorded clock) to an impulse time within one sample. Returns the song times. */
function expectOnImpulses(pcm: Float32Array, rec: Recorder): number[] {
  const onsets = detectOnsets(pcm);
  const songs = onsets.map((t) => songAt(rec, t));
  songs.forEach((s, i) => {
    expect(s, `onset at ${onsets[i]} is silent in the clock`).not.toBeNull();
    const seg = [...rec.segments].reverse().find((x) => x.ctxStart <= onsets[i]! + 1e-9)!;
    const nearest = Math.round((s! - IMPULSE_OFFSET) / IMPULSE_STEP) * IMPULSE_STEP + IMPULSE_OFFSET;
    // One output sample of error in song time is `speed / SR`.
    expect(Math.abs(s! - nearest) / seg.speed).toBeLessThanOrEqual(1.01 / SR);
  });
  return songs.map((s) => Math.round((s! - IMPULSE_OFFSET) / IMPULSE_STEP) * IMPULSE_STEP + IMPULSE_OFFSET);
}

function close(a: number[], b: number[]): void {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 6));
}

describe('GuidePlayer on the engine clock (OfflineAudioContext)', () => {
  it('plays a 100% render on the clock: onset = anchor + song time, within a sample', async () => {
    const { pcm, rig } = await run(2, (r) => {
      addSyntheticPiece(r.player, 1, 0, TIMELINE.durationSec);
      r.core.play({ from: 0 });
    });
    const onsets = detectOnsets(pcm);
    const expected = impulsesIn(0, 2 - REANCHOR_LEAD_SEC - 0.01).map((t) => REANCHOR_LEAD_SEC + t);
    expect(onsets).toHaveLength(expected.length);
    onsets.forEach((o, i) => expect(Math.abs(o - expected[i]!) * SR).toBeLessThanOrEqual(1));
    expectOnImpulses(pcm, rig.rec);
  });

  it('plays a 50% render at half speed with no pitch/rate change of the buffer', async () => {
    const { pcm, rig } = await run(3, (r) => {
      addSyntheticPiece(r.player, 0.5, 0, TIMELINE.durationSec);
      r.core.setSpeed(0.5);
      r.core.play({ from: 0 });
    });
    const onsets = detectOnsets(pcm);
    const expected = impulsesIn(0, (3 - REANCHOR_LEAD_SEC - 0.01) * 0.5).map((t) => REANCHOR_LEAD_SEC + t / 0.5);
    expect(onsets).toHaveLength(expected.length);
    onsets.forEach((o, i) => expect(Math.abs(o - expected[i]!) * SR).toBeLessThanOrEqual(1));
    expect(rig.missing).toEqual([]);
  });

  it('seek replaces everything after the re-anchor', async () => {
    let seekedAt = 0;
    const { pcm, rig } = await run(
      2.5,
      (r) => {
        addSyntheticPiece(r.player, 1, 0, TIMELINE.durationSec);
        r.core.play({ from: 0 });
      },
      (t, r) => {
        if (t >= 1 && seekedAt === 0) {
          seekedAt = t;
          r.core.seek(5);
        }
      },
    );
    const songs = expectOnImpulses(pcm, rig.rec);
    const jump = rig.rec.segments[1]!;
    expect(jump.songStart).toBe(5);
    close(songs, [...impulsesIn(0, jump.ctxStart - REANCHOR_LEAD_SEC), ...impulsesIn(5, 5 + (2.5 - jump.ctxStart) - 0.01)]);
  });

  it('loops slice the render: every pass replays A − pre-roll … B with no gap or duplicate', async () => {
    const { pcm, rig } = await run(5, (r) => {
      addSyntheticPiece(r.player, 1, 0, TIMELINE.durationSec);
      r.core.setLoop({ start: 3, end: 4, preroll: 1 });
      r.core.play({ from: 2 });
    });
    const songs = expectOnImpulses(pcm, rig.rec);
    const pass = impulsesIn(2, 4);
    // 5 s of output from ctx 0.05: four full 2 s passes would need 8 s; we get two full passes + part.
    expect(songs.slice(0, 2 * pass.length)).toEqual([...pass, ...pass].map((t) => expect.closeTo(t, 6)));
    expect(rig.rec.segments.filter((s) => s.pass > 0).length).toBeGreaterThanOrEqual(2);
    // Spans of finished passes are pruned at each wrap.
    expect(rig.player.plannedSpans).toBeLessThanOrEqual(2);
    // Wraps start exactly where the previous pass ends.
    const [p0, p1] = rig.rec.segments;
    expect(p1!.ctxStart).toBeCloseTo(p0!.ctxEnd!, 9);
  });

  it('a bar-aligned speed change switches to the render at the new speed at the bar line', async () => {
    let changed = false;
    const { pcm, rig } = await run(
      4,
      (r) => {
        addSyntheticPiece(r.player, 1, 0, TIMELINE.durationSec);
        addSyntheticPiece(r.player, 0.5, 0, TIMELINE.durationSec);
        r.core.play({ from: 0 });
      },
      (t, r) => {
        if (t >= 0.6 && !changed) {
          changed = true;
          r.core.setSpeed(0.5, { ready: Promise.resolve() });
        }
      },
    );
    const songs = expectOnImpulses(pcm, rig.rec);
    const slow = rig.rec.segments.find((s) => s.speed === 0.5)!;
    expect(slow.songStart).toBe(1); // the next bar line
    const end = 1 + (4 - slow.ctxStart) * 0.5 - 0.01;
    close(songs, impulsesIn(0, end));
    expect(rig.missing).toEqual([]);
  });

  it('switches from the head render to the priority render at their bar line', async () => {
    const { pcm, rig } = await run(4, (r) => {
      // Priority render from bar 2 to the end, head render 0 → 2 (rendered a little past 2, then cancelled).
      addSyntheticPiece(r.player, 1, 2, TIMELINE.durationSec);
      addSyntheticPiece(r.player, 1, 0, 2, 0.7, 2.6);
      r.core.play({ from: 0.5 });
    });
    const songs = expectOnImpulses(pcm, rig.rec);
    close(songs, impulsesIn(0.5, 0.5 + 4 - REANCHOR_LEAD_SEC - 0.01));
  });

  it('chunks that arrive after playback started join in progress', async () => {
    let appended = false;
    let piece: GuidePiece | null = null;
    const { pcm, rig } = await run(
      2.5,
      (r) => {
        piece = r.player.addPiece(1, 0, TIMELINE.durationSec);
        r.core.play({ from: 0 });
      },
      (t, r) => {
        if (t >= 1 && !appended) {
          appended = true;
          appendSynthetic(r.player, piece!, 1, 0, TIMELINE.durationSec, 0.5);
        }
      },
    );
    const onsets = detectOnsets(pcm);
    expect(onsets[0]!).toBeGreaterThan(1);
    const songs = expectOnImpulses(pcm, rig.rec);
    expect(songs.at(-1)!).toBeCloseTo(impulsesIn(0, 2.5 - REANCHOR_LEAD_SEC - 0.01).at(-1)!, 6);
  });

  it('asks the host for a render when a segment comes at a speed it has no piece for', async () => {
    const { rig } = await run(0.5, (r) => {
      addSyntheticPiece(r.player, 1, 0, TIMELINE.durationSec);
      r.core.setSpeed(0.7);
      r.core.play({ from: 3 });
    });
    expect(rig.missing).toEqual([[0.7, 3]]);
  });

  it('mute silences the output; pause stops it after the re-anchor lead', async () => {
    const muted = await run(1, (r) => {
      addSyntheticPiece(r.player, 1, 0, TIMELINE.durationSec);
      r.player.setMuted(true);
      r.core.play({ from: 0 });
    });
    expect(muted.rig.player.muted).toBe(true);
    expect(Math.max(...muted.pcm.map(Math.abs))).toBeLessThan(1e-3);

    let pausedAt = 0;
    const paused = await run(
      2,
      (r) => {
        addSyntheticPiece(r.player, 1, 0, TIMELINE.durationSec);
        r.core.play({ from: 0 });
      },
      (t, r) => {
        if (t >= 0.8 && pausedAt === 0) {
          pausedAt = t;
          r.core.pause();
        }
      },
    );
    const onsets = detectOnsets(paused.pcm);
    expect(onsets.at(-1)!).toBeLessThan(pausedAt + REANCHOR_LEAD_SEC + 1e-6);
    expect(paused.rig.rec.stops.length).toBeGreaterThan(0);
  });

  it('joins chunks and cut slices without clicks', async () => {
    // A continuous 220 Hz sine as the render, in 0.37 s chunks, seeked mid-way.
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 2 * SR, sampleRate: SR });
    const player = new GuidePlayer(ctx, ctx.destination, { missing: () => undefined });
    player.setDuration(8);
    const piece = player.addPiece(1, 0, 8);
    const total = 8 * SR;
    const sine = new Float32Array(total);
    for (let i = 0; i < total; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
    const step = Math.round(0.37 * SR);
    for (let s = 0; s < total; s += step) {
      const len = Math.min(step, total - s);
      const buf = new AudioBuffer({ numberOfChannels: 1, length: len, sampleRate: SR });
      buf.copyToChannel(sine.subarray(s, s + len), 0);
      player.appendChunk(piece, buf, s / SR);
    }
    player.schedule({ ctxStart: 0.0123, songStart: 0.4, speed: 1, pass: 0 });
    player.schedule({ ctxStart: 1.0071, songStart: 3.3, speed: 1, pass: 0 });
    const pcm = (await ctx.startRendering()).getChannelData(0);
    // The largest step of a 0.5-amplitude 220 Hz sine is 0.5 × 2π × 220 / 48000 ≈ 0.0144.
    let maxStep = 0;
    for (let i = 1; i < pcm.length; i++) maxStep = Math.max(maxStep, Math.abs(pcm[i]! - pcm[i - 1]!));
    expect(maxStep).toBeLessThan(0.0144 * 1.5 + 0.5 / (FADE_SEC * SR));
    // Full level between the cuts (across chunk seams and up to the re-anchor), silence before the start.
    const peak = (a: number, b: number) => Math.max(...pcm.subarray(Math.round(a * SR), Math.round(b * SR)).map(Math.abs));
    expect(peak(0, 0.012)).toBe(0);
    expect(peak(0.1, 1)).toBeGreaterThan(0.49);
    expect(peak(0.95, 1.003)).toBeGreaterThan(0.49);
    expect(peak(1.02, 2)).toBeGreaterThan(0.49);
  });
});
