/**
 * Monitoring + amp/cab sim (T-023): input → amp worklet → cab biquads → monitor bus, latency
 * estimate, speaker and runaway guards (docs/monitoring.md).
 * Signature frozen by T-010; reached via `ctx.services.get('monitor')`.
 *
 * Audible = the player enabled monitoring (`settings.monitor.enabled`) **and** an input is open **and**
 * the output is not laptop speakers (unless allowed for that `sinkId`) **and** the feedback guard has
 * not tripped. The guard runs in the worklet, which ducks its own output by 30 dB within 50 ms on the
 * audio thread; this service then mutes the monitor completely and reports `feedback-ducked` until
 * the player re-enables monitoring (`setEnabled(true)`, which ramps back in).
 * @module
 */
import type { AmpParams } from '@shared/audio-events';
import type { Unsubscribe } from '@shared/clock';
import type { AudioEngine, InputService, LatencyEstimate, MonitorGuardEvent, MonitorService } from '@shared/services';
import type { AmpPresetId, Settings, SettingsStore } from '@shared/settings';
import { AMP_LATENCY_SAMPLES, AMP_PRESETS, ampConfigFor, type AmpConfig } from '@core/dsp/amp';
import { createMonitorChain, type MonitorChain } from './chain';
import { isLaptopSpeaker, outputLabel } from './devices';
import { estimateMonitorLatency } from './latency';

export { MonitorChain, RAMP_IN_SEC, createMonitorChain, loadAmpWorklet, type MonitorChainOptions } from './chain';
export { BUILT_IN_MIC_LABEL, SPEAKER_LABEL, isBuiltInMic, isLaptopSpeaker, outputLabel } from './devices';
export {
  ASSUMED_LATENCY_SEC,
  LATENCY_BANDS,
  LATENCY_TIPS,
  estimateMonitorLatency,
  latencyBand,
  latencyBreakdown,
  type LatencyBreakdown,
  type LatencyInputs,
} from './latency';

/**
 * After a context change the input service rebuilds its graph on the new context asynchronously and
 * does not announce it, so the monitor re-reads `getInputNode()` at this interval until the node is
 * on the chain's context (or the input closes), for at most {@link INPUT_REATTACH_MAX_MS}.
 */
const INPUT_REATTACH_POLL_MS = 50;
const INPUT_REATTACH_MAX_MS = 5000;

/** Transient overrides from `setParams` that settings don't store (cleared by `setPreset`). */
type Overrides = Partial<Pick<AmpParams, 'bias' | 'bypass'>>;

/** The amp config and cab corner for the current settings. */
function configFrom(s: Settings, overrides: Overrides): { config: AmpConfig; cabLowpassHz: number | null } {
  const m = s.monitor;
  const config = { ...ampConfigFor(m.preset, m), ...overrides };
  return { config, cabLowpassHz: AMP_PRESETS[m.preset].cabLowpassHz };
}

class Monitor implements MonitorService {
  private chain: MonitorChain | null = null;
  private overrides: Overrides = {};
  private speakerBlock: { sinkId: string; label: string } | null = null;
  private ducked = false;
  private readonly listeners = new Set<(ev: MonitorGuardEvent) => void>();
  private readonly unsubs: Unsubscribe[] = [];
  private speakerCheck = 0;
  private reattachTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly engine: AudioEngine,
    private readonly input: InputService,
    private readonly settings: SettingsStore,
  ) {}

  async init(): Promise<void> {
    await this.build(this.engine.ctx);
    let prev = this.settings.get();
    this.unsubs.push(
      this.engine.onContextChange((ctx) => {
        this.build(ctx).catch((err: unknown) => console.error('Riffway: could not rebuild monitoring', err));
      }),
      this.input.onDevicesChanged(() => {
        this.attachInput();
        void this.checkSpeakers();
      }),
      this.settings.subscribe((next) => {
        const before = prev;
        prev = next;
        this.onSettings(before, next);
      }),
    );
    await this.checkSpeakers();
  }

  get enabled(): boolean {
    return this.settings.get().monitor.enabled;
  }

  async setEnabled(on: boolean): Promise<void> {
    if (on) {
      if (this.ducked) {
        this.ducked = false;
        this.chain?.resetGuard();
        this.emit({ type: 'restored' });
      }
      if (!this.input.getInputNode()) {
        await this.input.open();
        this.attachInput();
      }
    }
    await this.settings.update({ monitor: { enabled: on } });
    if (on) await this.checkSpeakers();
    this.applyOpen();
  }

  setPreset(preset: AmpPresetId): void {
    const p = AMP_PRESETS[preset].amp;
    this.overrides = {};
    this.persist({ monitor: { preset, drive: p.drive, tone: { low: p.low, mid: p.mid, high: p.high }, level: p.level } });
  }

  setParams(params: Partial<AmpParams>): void {
    if (params.bias !== undefined) this.overrides.bias = params.bias;
    if (params.bypass !== undefined) this.overrides.bypass = params.bypass;
    const tone: Partial<Settings['monitor']['tone']> = {};
    if (params.low !== undefined) tone.low = params.low;
    if (params.mid !== undefined) tone.mid = params.mid;
    if (params.high !== undefined) tone.high = params.high;
    this.persist({
      monitor: {
        ...(params.drive !== undefined ? { drive: params.drive } : {}),
        ...(params.level !== undefined ? { level: params.level } : {}),
        ...(Object.keys(tone).length ? { tone } : {}),
      },
    });
    // Overrides are not in settings, so no settings change may follow: apply now.
    this.applyConfig(this.settings.get());
  }

  latency(): LatencyEstimate {
    const ctx = this.engine.ctx;
    const s = this.settings.get();
    const bypass = configFrom(s, this.overrides).config.bypass;
    return estimateMonitorLatency({
      inputLatencySec: this.input.current?.latency ?? null,
      baseLatencySec: ctx.baseLatency,
      outputLatencySec: ctx.outputLatency,
      sampleRate: ctx.sampleRate,
      dspSamples: bypass ? 0 : AMP_LATENCY_SAMPLES,
      calibration: s.calibration,
    });
  }

  async allowSpeakers(sinkId: string, allow: boolean): Promise<void> {
    await this.settings.update({ monitor: { allowSpeakers: { [sinkId]: allow } } });
    await this.checkSpeakers();
  }

  /** Subscribe to guard notices. The current state (speaker-muted / feedback-ducked) is replayed at once. */
  onGuard(cb: (ev: MonitorGuardEvent) => void): Unsubscribe {
    this.listeners.add(cb);
    if (this.speakerBlock) cb({ type: 'speaker-muted', sinkLabel: this.speakerBlock.label });
    if (this.ducked) cb({ type: 'feedback-ducked' });
    return () => this.listeners.delete(cb);
  }

  /** Tear down (tests; the app keeps the service for its lifetime). */
  dispose(): void {
    this.stopReattach();
    for (const u of this.unsubs.splice(0)) u();
    this.chain?.dispose();
    this.chain = null;
    this.listeners.clear();
  }

  private emit(ev: MonitorGuardEvent): void {
    for (const cb of [...this.listeners]) cb(ev);
  }

  private persist(patch: Parameters<SettingsStore['update']>[0]): void {
    this.settings.update(patch).catch((err: unknown) => console.error('Riffway: could not save monitoring settings', err));
  }

  private async build(ctx: BaseAudioContext): Promise<void> {
    this.chain?.dispose();
    this.chain = null;
    const { config, cabLowpassHz } = configFrom(this.settings.get(), this.overrides);
    const chain = await createMonitorChain(ctx, this.engine.buses.monitor, { config, cabLowpassHz });
    if (ctx !== this.engine.ctx) {
      // The context changed again while the worklet loaded; the newer build wins.
      chain.dispose();
      return;
    }
    this.chain = chain;
    chain.onGuard(() => {
      if (this.ducked) return;
      this.ducked = true;
      this.emit({ type: 'feedback-ducked' });
      this.applyOpen();
    });
    this.attachInput();
    this.applyOpen();
    this.reattachWhenRewired(chain);
  }

  /**
   * Connect the current input node when it lives on the chain's context. Re-read on every
   * `onDevicesChanged` (re-open, unplug, device switch: the node is replaced) and after rebuilds.
   */
  private attachInput(): void {
    const chain = this.chain;
    if (!chain) return;
    const node = this.input.getInputNode();
    const usable = node && node.context === chain.ctx ? node : null;
    chain.connectSource(usable, this.settings.get().input.channel, this.input.current?.channelCount ?? 1);
    this.applyOpen();
  }

  /**
   * An open input whose node is still on the old context is being rewired by the input service:
   * re-read `getInputNode()` until it moves to `chain`'s context, then attach it.
   */
  private reattachWhenRewired(chain: MonitorChain): void {
    this.stopReattach();
    const deadline = Date.now() + INPUT_REATTACH_MAX_MS;
    const check = (): void => {
      this.reattachTimer = null;
      if (this.chain !== chain || !this.input.current) return;
      if (this.input.getInputNode()?.context === chain.ctx) {
        this.attachInput();
        return;
      }
      if (Date.now() < deadline) this.reattachTimer = setTimeout(check, INPUT_REATTACH_POLL_MS);
    };
    if (this.input.current && this.input.getInputNode()?.context !== chain.ctx) this.reattachTimer = setTimeout(check, INPUT_REATTACH_POLL_MS);
  }

  private stopReattach(): void {
    if (this.reattachTimer !== null) clearTimeout(this.reattachTimer);
    this.reattachTimer = null;
  }

  private applyOpen(): void {
    const chain = this.chain;
    if (!chain) return;
    const hasInput = this.input.getInputNode()?.context === chain.ctx;
    chain.setOpen(this.enabled && hasInput && !this.speakerBlock && !this.ducked);
  }

  private applyConfig(s: Settings): void {
    const { config, cabLowpassHz } = configFrom(s, this.overrides);
    this.chain?.configure(config, cabLowpassHz);
  }

  private onSettings(prev: Settings, next: Settings): void {
    const a = prev.monitor;
    const b = next.monitor;
    if (a.preset !== b.preset || a.drive !== b.drive || a.level !== b.level || a.tone.low !== b.tone.low || a.tone.mid !== b.tone.mid || a.tone.high !== b.tone.high) {
      this.applyConfig(next);
    }
    if (prev.input.channel !== next.input.channel) this.attachInput();
    if (a.enabled !== b.enabled) this.applyOpen();
    if (prev.output.sinkId !== next.output.sinkId || a.allowSpeakers !== b.allowSpeakers) void this.checkSpeakers();
  }

  /** Re-evaluate the speaker guard for the current output. */
  private async checkSpeakers(): Promise<void> {
    const run = ++this.speakerCheck;
    const s = this.settings.get();
    const sinkId = s.output.sinkId;
    const outputs = await this.input.listOutputs().catch(() => []);
    if (run !== this.speakerCheck) return; // a newer check is running
    const label = outputLabel(outputs, sinkId, s.output.label);
    const blocked = label !== null && isLaptopSpeaker(label) && !this.settings.get().monitor.allowSpeakers[sinkId];
    const was = this.speakerBlock;
    this.speakerBlock = blocked ? { sinkId, label: label! } : null;
    if (blocked && (!was || was.sinkId !== sinkId || was.label !== label)) this.emit({ type: 'speaker-muted', sinkLabel: label! });
    else if (!blocked && was) this.emit({ type: 'restored' });
    this.applyOpen();
  }
}

/**
 * Create the monitoring service: builds the chain on the engine's context (loading the amp worklet),
 * follows settings, input re-opens and context changes. Monitoring starts closed until an input is
 * open; it never opens on laptop speakers unless allowed.
 */
export async function createMonitor(engine: AudioEngine, input: InputService, settings: SettingsStore): Promise<MonitorService> {
  const monitor = new Monitor(engine, input, settings);
  await monitor.init();
  return monitor;
}
