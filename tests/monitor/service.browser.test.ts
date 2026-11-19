/**
 * The monitoring service on a real engine (`AudioContext`) with a fake input service: speaker guard,
 * presets/params → settings, latency estimate, opening the input on enable, and the feedback guard
 * muting the monitor bus until the player re-enables.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Unsubscribe } from '@shared/clock';
import type { AudioDeviceInfo, AudioEngine, InputOpenResult, InputService, MonitorGuardEvent, MonitorService } from '@shared/services';
import type { DeepPartial, Settings } from '@shared/settings';
import { AMP_PRESETS } from '@core/dsp/amp';
import { createEngine } from '../../src/audio/engine';
import { createMonitor } from '../../src/audio/monitor';
import { latencyBreakdown } from '../../src/audio/monitor/latency';
import { memorySettings } from './helpers';

const SPEAKERS: AudioDeviceInfo = { deviceId: 'default', label: 'Default - MacBook Pro Speakers (Built-in)', groupId: 'g1', kind: 'audiooutput' };
const PHONES: AudioDeviceInfo = { deviceId: 'phones', label: 'External Headphones', groupId: 'g2', kind: 'audiooutput' };

/** A fake input whose "guitar" is an oscillator (gain-controlled) on the engine's context. */
class FakeInput implements InputService {
  current: InputOpenResult | null = null;
  opens = 0;
  osc: OscillatorNode | null = null;
  gain: GainNode | null = null;
  private readonly deviceCbs = new Set<() => void>();
  constructor(
    private readonly engine: AudioEngine,
    readonly outputs: AudioDeviceInfo[],
  ) {}
  async listInputs(): Promise<AudioDeviceInfo[]> {
    return [];
  }
  async listOutputs(): Promise<AudioDeviceInfo[]> {
    return this.outputs;
  }
  async open(): Promise<InputOpenResult> {
    this.opens++;
    const ctx = this.engine.ctx;
    this.osc = new OscillatorNode(ctx, { frequency: 1800 });
    this.gain = new GainNode(ctx, { gain: 0 });
    this.osc.connect(this.gain);
    this.osc.start();
    this.current = {
      device: { deviceId: 'usb', label: 'USB Guitar', groupId: 'g3', kind: 'audioinput' },
      sampleRate: ctx.sampleRate,
      channelCount: 1,
      latency: 0.004,
      processingWarnings: [],
      fellBackToDefault: false,
    };
    for (const cb of this.deviceCbs) cb();
    return this.current;
  }
  close(): void {
    this.osc?.stop();
    this.current = null;
    this.gain = null;
  }
  getInputNode(): AudioNode | null {
    return this.gain;
  }
  onInput(): Unsubscribe {
    return () => undefined;
  }
  onAnalysis(): Unsubscribe {
    return () => undefined;
  }
  expect(): void {}
  setTunerMode(): void {}
  onDevicesChanged(cb: () => void): Unsubscribe {
    this.deviceCbs.add(cb);
    return () => this.deviceCbs.delete(cb);
  }
  devicesChanged(): void {
    for (const cb of this.deviceCbs) cb();
  }
  /** Rebuild the "graph" on the engine's current context **without** announcing it (as the real service does). */
  rewireSilently(): void {
    const level = this.gain?.gain.value ?? 0;
    this.osc?.stop();
    const ctx = this.engine.ctx;
    this.osc = new OscillatorNode(ctx, { frequency: 1800 });
    this.gain = new GainNode(ctx, { gain: level });
    this.osc.connect(this.gain);
    this.osc.start();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** RMS (dBFS) at the monitor bus, measured over ~100 ms. */
async function busDb(engine: AudioEngine): Promise<number> {
  const an = new AnalyserNode(engine.ctx, { fftSize: 4096 });
  engine.buses.monitor.connect(an);
  await sleep(120);
  const buf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(buf);
  engine.buses.monitor.disconnect(an);
  let s = 0;
  for (const v of buf) s += v * v;
  return 10 * Math.log10(s / buf.length + 1e-20);
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function setup(initial: DeepPartial<Settings> = {}, outputs = [SPEAKERS, PHONES]) {
  const settings = memorySettings(initial);
  const engine = await createEngine({ settings });
  await engine.resume();
  const input = new FakeInput(engine, outputs);
  const monitor = (await createMonitor(engine, input, settings)) as MonitorService & { dispose(): void };
  const events: MonitorGuardEvent[] = [];
  monitor.onGuard((ev) => events.push(ev));
  cleanup.push(async () => {
    monitor.dispose();
    input.close();
    await engine.dispose();
  });
  return { settings, engine, input, monitor, events };
}

describe('monitor service', () => {
  it('starts muted on laptop speakers and opens after "Turn on anyway" (persisted per sinkId)', async () => {
    const { settings, engine, input, monitor, events } = await setup();
    expect(events).toEqual([{ type: 'speaker-muted', sinkLabel: SPEAKERS.label }]);
    await monitor.setEnabled(true);
    expect(input.opens).toBe(1); // enabling opened the input
    input.gain!.gain.value = 0.1;
    expect(await busDb(engine)).toBeLessThan(-100);

    await monitor.allowSpeakers('', true);
    expect(settings.get().monitor.allowSpeakers['']).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'restored' });
    await sleep(400); // ramp-in
    expect(await busDb(engine)).toBeGreaterThan(-60);

    // A late subscriber gets no stale notice.
    const late: MonitorGuardEvent[] = [];
    monitor.onGuard((ev) => late.push(ev));
    expect(late).toEqual([]);
  });

  it('is audible on headphones without asking', async () => {
    const { engine, input, monitor, events } = await setup({ output: { sinkId: 'phones' } });
    expect(events).toEqual([]);
    await monitor.setEnabled(true);
    input.gain!.gain.value = 0.1;
    await sleep(400);
    expect(await busDb(engine)).toBeGreaterThan(-60);
    expect(monitor.enabled).toBe(true);
    await monitor.setEnabled(false);
    await sleep(100);
    expect(await busDb(engine)).toBeLessThan(-100);
  });

  it('re-checks the speaker guard when the output changes', async () => {
    const { settings, events } = await setup({ output: { sinkId: 'phones' } });
    await settings.update({ output: { sinkId: '' } });
    await sleep(20);
    expect(events).toEqual([{ type: 'speaker-muted', sinkLabel: SPEAKERS.label }]);
    await settings.update({ output: { sinkId: 'phones' } });
    await sleep(20);
    expect(events.at(-1)).toEqual({ type: 'restored' });
  });

  it('setPreset stores the preset defaults; setParams stores knob changes', async () => {
    const { settings, monitor } = await setup({ output: { sinkId: 'phones' } });
    monitor.setPreset('overdrive');
    await sleep(0);
    const od = AMP_PRESETS.overdrive.amp;
    expect(settings.get().monitor).toMatchObject({
      preset: 'overdrive',
      drive: od.drive,
      tone: { low: od.low, mid: od.mid, high: od.high },
      level: od.level,
    });
    monitor.setParams({ drive: 5, mid: -2 });
    await sleep(0);
    expect(settings.get().monitor).toMatchObject({ preset: 'overdrive', drive: 5, tone: { low: od.low, mid: -2, high: od.high } });
  });

  it('estimates latency from the input read-back and the context (DSP part 0 in DI)', async () => {
    const { monitor, settings } = await setup({ output: { sinkId: 'phones' } });
    await monitor.setEnabled(true);
    const est = latencyBreakdown(monitor.latency());
    expect(est.inputMs).toBeCloseTo(4, 6);
    expect(est.processingMs).toBeGreaterThan(128 / 48 + 0.3);
    expect(est.totalMs).toBeGreaterThan(est.inputMs + est.processingMs);
    monitor.setPreset('di');
    await sleep(0);
    expect(latencyBreakdown(monitor.latency()).processingMs).toBeCloseTo(128 / 48, 6);
    await settings.update({ calibration: { method: 'play-to-click', inputOffsetMs: 37 } });
    expect(monitor.latency().calibratedOffsetMs).toBe(37);
  });

  it('feedback guard: ducks and mutes the monitor until re-enabled', async () => {
    const { engine, input, monitor, events } = await setup({ output: { sinkId: 'phones' } });
    await monitor.setEnabled(true);
    await sleep(350);
    // Howl: silence → loud pure tone.
    const g = input.gain!.gain;
    g.setValueAtTime(0.003, engine.ctx.currentTime);
    g.exponentialRampToValueAtTime(0.7, engine.ctx.currentTime + 0.3);
    const deadline = performance.now() + 3000;
    while (!events.some((e) => e.type === 'feedback-ducked') && performance.now() < deadline) await sleep(20);
    expect(events).toContainEqual({ type: 'feedback-ducked' });
    await sleep(100);
    expect(await busDb(engine)).toBeLessThan(-100);
    // A late subscriber learns about the current state at once.
    const late: MonitorGuardEvent[] = [];
    monitor.onGuard((ev) => late.push(ev));
    expect(late).toEqual([{ type: 'feedback-ducked' }]);

    g.cancelScheduledValues(engine.ctx.currentTime);
    g.setValueAtTime(0.05, engine.ctx.currentTime);
    await monitor.setEnabled(true);
    expect(events.at(-1)).toEqual({ type: 'restored' });
    await sleep(450);
    expect(await busDb(engine)).toBeGreaterThan(-60);
  });

  it('rebuilds on a context change and reconnects the input', async () => {
    // Headphones as the system default (the engine re-applies a chosen sinkId on rebuild).
    const { engine, input, monitor, events } = await setup({}, [{ ...PHONES, deviceId: 'default' }]);
    expect(events).toEqual([]);
    await monitor.setEnabled(true);
    await engine.setSampleRate(44100);
    await sleep(50);
    // The fake input re-opens on the new context, as the real input service does.
    input.close();
    await input.open();
    input.gain!.gain.value = 0.1;
    await sleep(450);
    expect(await busDb(engine)).toBeGreaterThan(-60);
  });

  it('re-reads getInputNode() when the input rewires on a new context after the chain is rebuilt', async () => {
    const { engine, input, monitor } = await setup({}, [{ ...PHONES, deviceId: 'default' }]);
    await monitor.setEnabled(true);
    input.gain!.gain.value = 0.1;
    await engine.setSampleRate(44100);
    // The input's graph lands on the new context only after the monitor chain was rebuilt, unannounced.
    await sleep(150);
    input.rewireSilently();
    await sleep(500);
    expect(input.getInputNode()?.context).toBe(engine.ctx);
    expect(await busDb(engine)).toBeGreaterThan(-60);
  });
});
