/**
 * The monitor graph in real Web Audio (`OfflineAudioContext`): added delay, preset levels, worklet ≡
 * Node DSP, mute, ramp-in, channel selection and the in-worklet feedback guard.
 */
import { describe, expect, it } from 'vitest';
import { PROCESSOR_NAMES } from '@shared/audio-events';
import type { AmpPresetId } from '@shared/settings';
import { AMP_PRESETS, AmpEngine, type AmpConfig, type AmpWorkletEvent } from '@core/dsp/amp';
import { RAMP_IN_SEC, createMonitorChain, loadAmpWorklet } from '../../src/audio/monitor/chain';
import { noise, pluckedTone, sine } from '../helpers/signals';
import { db, rms, xcorrLagFine } from './helpers';

const SR = 48000;

/** Render `input` (mono, or one array per channel) through a chain with `preset`; returns channel 0. */
async function renderChain(
  input: Float32Array | Float32Array[],
  preset: AmpPresetId,
  opts: { open?: boolean; channel?: 0 | 1 | 'mix'; config?: Partial<AmpConfig>; onGuard?: (ev: AmpWorkletEvent) => void } = {},
): Promise<Float32Array> {
  const chans = Array.isArray(input) ? input : [input];
  const length = chans[0]!.length;
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: SR });
  const p = AMP_PRESETS[preset];
  const chain = await createMonitorChain(ctx, ctx.destination, {
    config: { ...p.amp, ...opts.config },
    cabLowpassHz: p.cabLowpassHz,
    open: opts.open ?? true,
  });
  if (opts.onGuard) chain.onGuard(opts.onGuard);
  const buf = new AudioBuffer({ numberOfChannels: chans.length, length, sampleRate: SR });
  chans.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  const src = new AudioBufferSourceNode(ctx, { buffer: buf });
  chain.connectSource(src, opts.channel ?? 0, chans.length);
  src.start(0);
  return (await ctx.startRendering()).getChannelData(0);
}

describe('monitor chain (OfflineAudioContext)', () => {
  it('adds < 1 ms of delay with the full chain (amp + cab), and none in DI', async () => {
    const x = new Float32Array(SR / 2);
    x.set(noise(SR / 4, 0.05, 12), 2400);
    for (const id of ['clean', 'crunch', 'overdrive'] as const) {
      const y = await renderChain(x, id);
      const lagMs = (xcorrLagFine(x, y, 240) / SR) * 1000;
      expect(lagMs).toBeGreaterThan(0);
      expect(lagMs).toBeLessThan(1);
    }
    const di = await renderChain(x, 'di');
    expect(xcorrLagFine(x, di, 240)).toBe(0);
  });

  it('presets produce the expected levels for a −12 dBFS pluck; DI is transparent', async () => {
    const x = pluckedTone(196, 1.5, SR, { amp: 10 ** (-12 / 20) });
    const inDb = db(rms(x));
    const out: Record<string, number> = {};
    for (const id of ['clean', 'crunch', 'overdrive', 'di'] as const) out[id] = db(rms(await renderChain(x, id)));
    expect(out.di).toBeCloseTo(inDb, 2);
    for (const id of ['clean', 'crunch', 'overdrive'] as const) {
      expect(out[id]!).toBeGreaterThan(inDb - 8);
      expect(out[id]!).toBeLessThan(inDb + 4);
    }
  });

  it('the amp worklet produces the same samples as the Node DSP', async () => {
    const x = pluckedTone(147, 0.5, SR, { amp: 0.3 });
    const config = AMP_PRESETS.overdrive.amp;
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: x.length, sampleRate: SR });
    await loadAmpWorklet(ctx);
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAMES.amp, {
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { config },
    });
    const buf = new AudioBuffer({ numberOfChannels: 1, length: x.length, sampleRate: SR });
    buf.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    src.connect(node).connect(ctx.destination);
    src.start(0);
    const got = (await ctx.startRendering()).getChannelData(0);
    const want = new Float32Array(x.length);
    const amp = new AmpEngine(SR, config);
    for (let i = 0; i < x.length; i += 128) amp.process(x.subarray(i, i + 128), want.subarray(i, i + 128), 128);
    let maxDiff = 0;
    for (let i = 0; i < x.length; i++) maxDiff = Math.max(maxDiff, Math.abs(got[i]! - want[i]!));
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it('closed = exact silence', async () => {
    const y = await renderChain(sine(220, 0.3, SR, 0.5), 'overdrive', { open: false });
    expect(y.every((v) => v === 0)).toBe(true);
  });

  it('ramps in over RAMP_IN_SEC when opened', async () => {
    const length = SR;
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: SR });
    const chain = await createMonitorChain(ctx, ctx.destination, { config: AMP_PRESETS.di.amp, cabLowpassHz: null });
    const src = new ConstantSourceNode(ctx, { offset: 0.5 });
    chain.connectSource(src);
    src.start(0);
    chain.setOpen(true);
    expect(chain.opened).toBe(true);
    const y = (await ctx.startRendering()).getChannelData(0);
    expect(y[0]).toBeCloseTo(0, 3);
    expect(y[Math.round((RAMP_IN_SEC / 2) * SR)]).toBeCloseTo(0.25, 2);
    expect(y[Math.round((RAMP_IN_SEC + 0.05) * SR)]).toBeCloseTo(0.5, 6);
  });

  it('monitors the selected interface channel', async () => {
    const tone = sine(440, 0.3, SR, 0.25);
    const silent = new Float32Array(tone.length);
    const ch1 = await renderChain([silent, tone], 'di', { channel: 1 });
    expect(rms(ch1)).toBeCloseTo(rms(tone), 4);
    const ch0 = await renderChain([silent, tone], 'di', { channel: 0 });
    expect(rms(ch0)).toBe(0);
    const mix = await renderChain([silent, tone], 'di', { channel: 'mix' });
    expect(rms(mix)).toBeCloseTo(rms(tone) / 2, 4);
  });

  it('the worklet ducks itself by ≈ 30 dB and reports when feedback builds up', async () => {
    // A 2.2 kHz howl rising from −40 to −6 dBFS RMS over 0.5 s, then held.
    const x = sine(2200, 2, SR, Math.SQRT2);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      x[i] = x[i]! * 10 ** ((t < 0.5 ? -40 + 68 * t : -6) / 20);
    }
    const events: AmpWorkletEvent[] = [];
    const y = await renderChain(x, 'clean', { onGuard: (ev) => events.push(ev) });
    await new Promise((r) => setTimeout(r, 50)); // port messages arrive after rendering
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe('feedback');
    const tripSec = events[0]!.frame / SR;
    expect(tripSec).toBeGreaterThan(0.6);
    expect(tripSec).toBeLessThan(0.9);
    const before = rms(y, Math.round((tripSec - 0.15) * SR), Math.round((tripSec - 0.05) * SR));
    const after = rms(y, Math.round((tripSec + 0.1) * SR), Math.round((tripSec + 0.3) * SR));
    expect(db(after / before)).toBeLessThan(-25);
  });
});
