import { describe, expect, it } from 'vitest';
import { PROCESSOR_NAMES } from '@shared/audio-events';
import { WORKLET_URLS } from '../../src/audio/worklet-urls';

describe('Web Audio in Chromium (Vitest browser mode)', () => {
  it('renders an OfflineAudioContext graph sample-accurately', async () => {
    const sr = 48000;
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: sr / 10, sampleRate: sr });
    const src = new ConstantSourceNode(ctx, { offset: 0.5 });
    src.connect(ctx.destination);
    src.start(0.05); // exactly sample 2400
    const out = (await ctx.startRendering()).getChannelData(0);
    expect(out[2399]).toBe(0);
    expect(out[2400]).toBeCloseTo(0.5, 6);
  });

  it('loads a worklet via ?worker&url (alias imports bundled) and passes audio through', async () => {
    const sr = 48000;
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1024, sampleRate: sr });
    await ctx.audioWorklet.addModule(WORKLET_URLS.noop);
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAMES.noop, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const ready = new Promise<{ type: string; sampleRate: number }>((resolve) => {
      node.port.onmessage = (e) => resolve(e.data as { type: string; sampleRate: number });
    });
    const src = new ConstantSourceNode(ctx, { offset: 0.25 });
    src.connect(node).connect(ctx.destination);
    src.start(0);
    const out = (await ctx.startRendering()).getChannelData(0);
    expect(await ready).toEqual({ type: 'ready', sampleRate: sr });
    expect(out[512]).toBeCloseTo(0.25, 6);
  });

  it('every registered worklet module loads', async () => {
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 128, sampleRate: 48000 });
    for (const url of Object.values(WORKLET_URLS)) await ctx.audioWorklet.addModule(url);
    expect(() => new AudioWorkletNode(ctx, PROCESSOR_NAMES.analysis)).not.toThrow();
    expect(() => new AudioWorkletNode(ctx, PROCESSOR_NAMES.amp)).not.toThrow();
  });
});
