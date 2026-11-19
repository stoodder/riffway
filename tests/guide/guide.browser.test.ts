/**
 * Guide synth end to end in Chrome (T-021): the real song worker (Vite module worker, soundfont
 * fetched from our own origin), the < 2 s render target for a 3-minute song, and the guide service
 * on a live engine (audio on the guide bus, mute, speed change, progress, the render plan).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AudioEngine } from '@shared/services';
import type { Song, SongBundle } from '@shared/song';
import odeToJoy from '../../starter/ode-to-joy.atex?raw';
import { createEngine } from '../../src/audio/engine';
import { type PcmChunk, GuideImpl, SongWorkerClient, createSongLoader, spawnSongWorker } from '../../src/audio/guide';
import { ISOLATED_TEX, longTex, texBundle } from './fixtures';

const SR = 48000;

function rms(analyser: AnalyserNode): number {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  return Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
}

/** Highest RMS seen while polling for `ms`. */
async function peakRms(analyser: AnalyserNode, ms: number): Promise<number> {
  let peak = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    peak = Math.max(peak, rms(analyser));
    await new Promise((r) => setTimeout(r, 20));
  }
  return peak;
}

function renderAll(client: SongWorkerClient, speed: number, fromSec = 0): Promise<PcmChunk[]> {
  const chunks: PcmChunk[] = [];
  const h = client.render({ speed, sampleRate: SR, fromSec }, (c) => chunks.push(c));
  return h.done.then(() => chunks);
}

describe('song worker in Chrome', () => {
  let client: SongWorkerClient | null = null;
  afterEach(() => {
    client?.terminate();
    client = null;
  });

  it('createSongLoader parses a starter song in the worker', async () => {
    const loader = await createSongLoader();
    const song = await loader.load({ fileName: 'ode-to-joy.atex', data: new TextEncoder().encode(odeToJoy) }, 0);
    expect(song.meta.title).toBe('Ode to Joy');
    expect(song.notes.length).toBeGreaterThan(50);
  });

  it('renders a 3-minute song in under 2 s', async () => {
    client = new SongWorkerClient(spawnSongWorker());
    // Warm up: soundfont fetch + parse and module compilation are one-off costs.
    await client.load(texBundle(ISOLATED_TEX), 0);
    await renderAll(client, 1);
    const song = await client.load(texBundle(longTex(3)), 0);
    expect(song.meta.durationSec).toBeCloseTo(180, 6);
    const t0 = performance.now();
    const chunks = await renderAll(client, 1);
    const ms = performance.now() - t0;
    console.log(`guide render: 180 s of audio in ${ms.toFixed(0)} ms in a Chrome worker (${(180000 / ms).toFixed(0)}× real time)`);
    expect(ms).toBeLessThan(2000);
    const samples = chunks.reduce((n, c) => n + c.left.length, 0);
    expect(samples / SR).toBeCloseTo(180, 1);
    // 5 s chunks, transferred (detached here only if re-sent; check they arrived intact).
    expect(chunks[0]?.left.length).toBe(5 * SR);
    expect(chunks[0]?.left.some((x) => Math.abs(x) > 0.01)).toBe(true);
  });
});

describe('guide service on a live engine', () => {
  let engine: AudioEngine | null = null;
  let guide: GuideImpl | null = null;
  afterEach(async () => {
    guide?.dispose();
    guide = null;
    await engine?.dispose();
    engine = null;
  });

  async function setup(bundle: SongBundle): Promise<{ analyser: AnalyserNode; song: Song }> {
    engine = await createEngine({ sampleRate: SR, levels: { master: 1, monitor: 1, backing: 1, guide: 1, metronome: 0 } });
    await engine.resume();
    const loader = await createSongLoader();
    const song = await loader.load(bundle, 0);
    guide = new GuideImpl(engine);
    const analyser = new AnalyserNode(engine.ctx, { fftSize: 2048 });
    engine.buses.guide.connect(analyser);
    engine.transport.load({ durationSec: song.meta.durationSec, bars: song.timing.bars });
    engine.transport.setMetronome(false);
    await guide.load(song, bundle, 1);
    return { analyser, song };
  }

  it('plays on the guide bus, mutes, and re-renders on a speed change', async () => {
    const { analyser, song } = await setup({ fileName: 'ode-to-joy.atex', data: new TextEncoder().encode(odeToJoy) });
    const e = engine!;
    const g = guide!;
    const from = song.timing.bars[3]!.time;
    e.transport.play({ from, countInBars: 0 });
    expect(await peakRms(analyser, 600)).toBeGreaterThan(0.01);
    expect(g.guidePlayer.activeVoices).toBeGreaterThan(0);

    g.setMuted(true);
    expect(g.muted).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(await peakRms(analyser, 200)).toBeLessThan(1e-3);
    g.setMuted(false);

    const progress: number[] = [];
    g.onProgress((f) => progress.push(f));
    const ready = g.setSpeed(0.5);
    e.transport.setSpeed(0.5, { ready });
    await ready;
    // The re-render starts at the bar under the playhead: two renders (that bar → end, then 0 → bar).
    const pieces = g.guidePlayer.piecesFor(0.5);
    expect(pieces.map((p) => [p.songFrom, p.songTo])).toEqual([
      [song.timing.bars[3]!.time, song.meta.durationSec],
      [0, song.timing.bars[3]!.time],
    ]);
    await new Promise((r) => setTimeout(r, 1500));
    expect(e.transport.speed).toBe(0.5);
    expect(g.guidePlayer.playingSpeed).toBe(0.5);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]!)).toBe(true);
    expect(await peakRms(analyser, 400)).toBeGreaterThan(0.01);
  });

  it('renders a loop region first when a loop is set', async () => {
    await setup(texBundle(longTex(1)));
    const e = engine!;
    const g = guide!;
    // Loop bars 20–22 (2 s per bar at 120 BPM): the 70% render starts at the pre-roll bar.
    e.transport.setLoop({ start: 40, end: 44, preroll: 2 });
    await g.setSpeed(0.7);
    const [first] = g.guidePlayer.piecesFor(0.7);
    expect(first!.songFrom).toBe(38);
    expect(first!.renderedTo).toBeGreaterThan(38);
    g.unload();
    expect(g.guidePlayer.piecesFor(0.7)).toEqual([]);
  });
});
