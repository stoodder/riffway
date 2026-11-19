/**
 * Engine timing in real Web Audio: the transport + click voice + mixer render into an
 * `OfflineAudioContext`, driven by ticks at render-time suspend points (what the look-ahead timer
 * does live). Click onsets are detected in the rendered PCM and compared to the analytic grid.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TransportTimeline } from '@shared/clock';
import type { AudioEngine } from '@shared/services';
import { type Settings, defaultSettings } from '@shared/settings';
import { createEngine } from '../../src/audio/engine';
import { createClickPlayer } from '../../src/audio/engine/metronome';
import { createMixer } from '../../src/audio/engine/mixer';
import { TransportCore, type TransportOptions } from '../../src/audio/engine/transport';
import { makeTimeline } from './helpers';

const SR = 48000;
const LEAD = 0.05;
/** Tick every 10 render quanta (≈ 26.7 ms), like the 25 ms timer. */
const TICK_FRAMES = 1280;
const ALL_ONE = { master: 1, monitor: 1, backing: 1, guide: 1, metronome: 0.5 };

interface Onset {
  frame: number;
  accent: boolean;
}

/** Click onsets: first sample above threshold after ≥ 50 ms of quiet. Accent clicks start louder. */
function detectOnsets(pcm: Float32Array): Onset[] {
  const out: Onset[] = [];
  let last = -Infinity;
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]!) > 0.02 && i - last > 0.05 * SR) {
      out.push({ frame: i, accent: Math.abs(pcm[i]!) > 0.4 });
      last = i;
    } else if (Math.abs(pcm[i]!) > 0.02) last = i;
  }
  return out;
}

/**
 * Render `seconds` of the transport. `setup` runs before rendering (ctx time 0); `at(t, core)` runs at
 * every tick point before the tick.
 */
async function render(
  seconds: number,
  timeline: TransportTimeline,
  setup: (core: TransportCore) => void,
  at: (t: number, core: TransportCore) => void = () => undefined,
  opts: TransportOptions = { countInBars: 0 },
): Promise<{ onsets: Onset[]; core: TransportCore }> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: Math.round(seconds * SR), sampleRate: SR });
  const mixer = createMixer(ctx, ALL_ONE);
  const clicks = createClickPlayer(ctx, mixer.buses.metronome);
  const core = new TransportCore({ now: () => ctx.currentTime, clicks }, opts);
  core.load(timeline);
  setup(core);
  core.tick();
  for (let f = TICK_FRAMES; f < ctx.length; f += TICK_FRAMES) {
    void ctx.suspend(f / SR).then(() => {
      at(ctx.currentTime, core);
      core.tick();
      void ctx.resume();
    });
  }
  const pcm = (await ctx.startRendering()).getChannelData(0);
  return { onsets: detectOnsets(pcm), core };
}

/** Assert onsets equal the expected context times to within one sample. */
function expectClicksAt(onsets: Onset[], expected: { when: number; accent: boolean }[]): void {
  expect(onsets.map((o) => o.accent)).toEqual(expected.map((e) => e.accent));
  onsets.forEach((o, i) => expect(Math.abs(o.frame - expected[i]!.when * SR)).toBeLessThanOrEqual(1));
}

describe('engine timing (OfflineAudioContext)', () => {
  it('clicks land on exact sample positions across tempo and meter changes', async () => {
    const tl = makeTimeline([
      { bpm: 120, num: 4, bars: 2 },
      { bpm: 90, num: 3, bars: 2 },
      { bpm: 160, num: 6, den: 8, bars: 1 },
    ]);
    const speed = 0.8;
    const { onsets } = await render(tl.durationSec / speed + 0.3, tl, (core) => {
      core.setSpeed(speed);
      core.play({ from: 0 });
    });
    const expected = tl.bars.flatMap((b) => b.beats.map((t, j) => ({ when: LEAD + t / speed, accent: j === 0 })));
    expect(onsets).toHaveLength(expected.length);
    expectClicksAt(onsets, expected);
  });

  it('loop wrap is seamless: no gap, no duplicate click, constant spacing', async () => {
    const tl = makeTimeline([{ bpm: 120, num: 4, bars: 8 }]);
    const speed = 0.9;
    const { onsets, core } = await render(7, tl, (c) => {
      c.setSpeed(speed);
      c.setLoop({ start: 2, end: 4, preroll: 2 });
      c.play({ from: 0 });
    });
    // Each pass plays song 0..4 (8 beats); the beat phase continues across wraps.
    const beat = 0.5 / speed;
    const expected = Array.from({ length: Math.floor((7 - LEAD) / beat) + 1 }, (_, k) => ({ when: LEAD + k * beat, accent: k % 4 === 0 }));
    expect(onsets).toHaveLength(expected.length);
    expectClicksAt(onsets, expected);
    expect(core.segments.some((s) => s.pass >= 1)).toBe(true);
  });

  it('count-in plays bars × beats clicks (metronome off) with an accent per bar', async () => {
    const tl = makeTimeline([{ bpm: 100, num: 3, bars: 4 }]);
    let playedAt = -1;
    const { onsets } = await render(
      6,
      tl,
      (c) => c.setMetronome(false),
      (t, c) => {
        if (playedAt < 0 && t >= 0.1) {
          playedAt = t;
          c.play({ from: 0, countInBars: 2 });
        }
      },
      { countInBars: 1 },
    );
    expectClicksAt(
      onsets,
      Array.from({ length: 6 }, (_, k) => ({ when: playedAt + LEAD + k * 0.6, accent: k % 3 === 0 })),
    );
  });

  it('speed change is continuous: applies at the next bar line on the exact sample', async () => {
    const tl = makeTimeline([{ bpm: 120, num: 4, bars: 6 }]);
    let changed = false;
    const { onsets } = await render(
      7,
      tl,
      (c) => c.play({ from: 0 }),
      (t, c) => {
        if (!changed && t >= 0.6) {
          changed = true;
          c.setSpeed(0.5);
        }
      },
    );
    // 100% until song 2 (ctx 2.05), then 50%: one beat per second from the downbeat on.
    const expected = [
      ...Array.from({ length: 4 }, (_, k) => ({ when: LEAD + 0.5 * k, accent: k === 0 })),
      ...Array.from({ length: 5 }, (_, k) => ({ when: 2.05 + k, accent: k % 4 === 0 })),
    ];
    expectClicksAt(onsets, expected);
  });
});

describe('mixer and safety limiter (OfflineAudioContext)', () => {
  const impulse = async (amp: number, levels = ALL_ONE) => {
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 4800, sampleRate: SR });
    const mixer = createMixer(ctx, levels);
    const buf = ctx.createBuffer(1, 1, SR);
    buf.getChannelData(0)[0] = amp;
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    src.connect(mixer.buses.guide);
    src.start(1000 / SR);
    return (await ctx.startRendering()).getChannelData(0);
  };

  it('is transparent and adds zero latency below −1 dBFS', async () => {
    const out = await impulse(0.5);
    expect(out[999]).toBe(0);
    expect(out[1000]).toBeCloseTo(0.5, 5);
    expect(out[1001]).toBe(0);
  });

  it('never exceeds 0 dBFS and mutes at level 0', async () => {
    expect(Math.abs((await impulse(3))[1000]!)).toBeLessThanOrEqual(1);
    expect(Math.abs((await impulse(-8))[1000]!)).toBeLessThanOrEqual(1);
    const muted = await impulse(0.5, { ...ALL_ONE, guide: 0 });
    expect(muted.every((v) => v === 0)).toBe(true);
  });
});

describe('createEngine (realtime AudioContext)', () => {
  let engine: AudioEngine | null = null;
  afterEach(async () => {
    await engine?.dispose();
    engine = null;
  });

  it('runs the transport on the context clock and re-issues scheduled sources', async () => {
    engine = await createEngine({ sampleRate: 48000 });
    await engine.resume();
    expect(engine.running).toBe(true);
    expect(engine.ctx.sampleRate).toBe(48000);
    expect(Object.keys(engine.buses).sort()).toEqual(['backing', 'guide', 'master', 'metronome', 'monitor']);
    engine.setLevel('guide', 0.25);
    const scheduled: number[] = [];
    engine.registerScheduledSource({ name: 'probe', schedule: (s) => scheduled.push(s.ctxStart), stop: () => undefined });
    engine.transport.load(makeTimeline([{ bpm: 120, num: 4, bars: 4 }]));
    const before = engine.ctx.currentTime;
    engine.transport.play({ from: 0, countInBars: 0 });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toBeCloseTo(before + LEAD, 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(engine.clock.state).toBe('playing');
    const song = engine.clock.nowSong();
    expect(song).toBeGreaterThan(0.1);
    expect(engine.clock.heardSongTime()).toBeLessThanOrEqual(song + 1e-9);
    expect(Number.isFinite(engine.perfToCtxTime(performance.now()))).toBe(true);
    engine.transport.pause();
    expect(engine.clock.state).toBe('paused');
  });

  it('setSampleRate recreates the context, keeps the position and notifies', async () => {
    engine = await createEngine({ sampleRate: 48000 });
    await engine.resume();
    engine.transport.load(makeTimeline([{ bpm: 120, num: 4, bars: 4 }]));
    engine.transport.seek(3);
    const seen: AudioContext[] = [];
    engine.onContextChange((c) => seen.push(c));
    await engine.setSampleRate(44100);
    expect(seen).toHaveLength(1);
    expect(engine.ctx.sampleRate).toBe(44100);
    expect(engine.clock.nowSong()).toBe(3);
    expect(engine.buses.master.context).toBe(engine.ctx);
  });

  it('follows the settings store: mixer levels and metronome', async () => {
    let current: Settings = defaultSettings();
    current.mixer.guide = 0.3;
    const subs = new Set<(s: Settings) => void>();
    const settings = {
      get: () => current,
      subscribe: (cb: (s: Settings) => void) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    };
    engine = await createEngine({ settings });
    expect(engine.buses.guide.gain.value).toBeCloseTo(0.3, 6);
    current = structuredClone(current);
    current.practice.metronome = false;
    current.calibration.visualOffsetMs = 40;
    current.mixer.metronome = 0;
    for (const cb of subs) cb(current);
    engine.transport.load(makeTimeline([{ bpm: 120, num: 4, bars: 4 }]));
    engine.transport.play({ from: 0, countInBars: 0 });
    await new Promise((r) => setTimeout(r, 50));
    expect((engine.transport as TransportCore).scheduledClickTimes()).toEqual([]);
    await engine.dispose();
    expect(subs.size).toBe(0);
    engine = null;
  });

  it('follows mixerMute (muted bus at 0, level kept) and practice.metronomeAccent', async () => {
    let current: Settings = defaultSettings();
    current.mixerMute.backing = true;
    current.practice.metronomeAccent = false;
    const subs = new Set<(s: Settings) => void>();
    const settings = { get: () => current, subscribe: (cb: (s: Settings) => void) => (subs.add(cb), () => subs.delete(cb)) };
    engine = await createEngine({ settings });
    expect(engine.buses.backing.gain.value).toBe(0);
    current = structuredClone(current);
    current.mixerMute.backing = false;
    for (const cb of subs) cb(current);
    await new Promise((r) => setTimeout(r, 60));
    expect(engine.buses.backing.gain.value).toBeCloseTo(current.mixer.backing, 1);

    // Accent off: every click uses the same (beat) buffer; on: downbeats use another.
    const buffers = new Set<AudioBuffer | null>();
    const Native = globalThis.AudioBufferSourceNode;
    class Spy extends Native {
      constructor(ctx: BaseAudioContext, opts?: AudioBufferSourceOptions) {
        super(ctx, opts);
        buffers.add(opts?.buffer ?? null);
      }
    }
    globalThis.AudioBufferSourceNode = Spy;
    try {
      await engine.resume();
      engine.transport.load(makeTimeline([{ bpm: 240, num: 4, bars: 8 }]));
      engine.transport.play({ from: 0, countInBars: 0 });
      await new Promise((r) => setTimeout(r, 250));
      expect(buffers.size).toBe(1);
      engine.transport.stop();
      current = structuredClone(current);
      current.practice.metronomeAccent = true;
      for (const cb of subs) cb(current);
      buffers.clear();
      engine.transport.play({ from: 0, countInBars: 0 });
      await new Promise((r) => setTimeout(r, 250));
      expect(buffers.size).toBe(2);
    } finally {
      globalThis.AudioBufferSourceNode = Native;
    }
  });
});
