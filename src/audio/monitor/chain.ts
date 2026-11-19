/**
 * The monitor audio graph on one context (docs/monitoring.md § Graph):
 *
 * ```
 * source ─▶ [splitter: pick channel] ─▶ input (mono) ─▶ amp worklet ─┬─▶ cab biquads ─▶ cabGain ─┐
 *                                                                    └─────────────▶ dryGain ───┴─▶ out ─▶ destination
 * ```
 * `out` is the open/close gain (ramp-in on open, quick fade on close); the cab is crossfaded rather
 * than rewired so preset changes never click. No analysers or look-ahead nodes are in series.
 * Works on any `BaseAudioContext`, so tests render it in an `OfflineAudioContext`.
 * @module
 */
import { PROCESSOR_NAMES } from '@shared/audio-events';
import type { InputChannel } from '@shared/settings';
import {
  CAB_LOWPASS_HZ,
  cabStages,
  type AmpConfig,
  type AmpProcessorOptions,
  type AmpWorkletCommand,
  type AmpWorkletEvent,
  type BiquadSpec,
} from '@core/dsp/amp';
import { WORKLET_URLS } from '../worklet-urls';

/** Ramp-in time when monitoring opens (s): avoids a pop and gives a feedback loop time to show. */
export const RAMP_IN_SEC = 0.3;
/** Fade time constant when monitoring closes (s). */
const CLOSE_TAU_SEC = 0.01;
/** Cab crossfade / corner glide time constant (s). */
const CAB_TAU_SEC = 0.01;

const modules = new WeakMap<BaseAudioContext, Promise<void>>();

/** Load the amp worklet module once per context. */
export function loadAmpWorklet(ctx: BaseAudioContext): Promise<void> {
  let p = modules.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(WORKLET_URLS.amp);
    p.catch(() => modules.delete(ctx));
    modules.set(ctx, p);
  }
  return p;
}

/** Web Audio's low/high-pass `Q` is a resonance in dB; peaking uses linear Q; shelves ignore it. */
function nodeQ(spec: BiquadSpec): number {
  return spec.type === 'lowpass' || spec.type === 'highpass' ? 20 * Math.log10(spec.q) : spec.q;
}

/** Initial chain settings. */
export interface MonitorChainOptions {
  config: AmpConfig;
  /** Cab low-pass corner (Hz), or null for no cab. */
  cabLowpassHz: number | null;
  /** Start open (audible). Default false. */
  open?: boolean;
}

/** One monitor graph. Create with {@link createMonitorChain}. */
export class MonitorChain {
  /** Mono entry point (sources are connected here through {@link connectSource}). */
  readonly input: GainNode;
  readonly amp: AudioWorkletNode;
  readonly out: GainNode;
  private readonly splitter: ChannelSplitterNode;
  private readonly cab: BiquadFilterNode[];
  private readonly cabGain: GainNode;
  private readonly dryGain: GainNode;
  private source: AudioNode | null = null;
  private readonly guardListeners = new Set<(ev: AmpWorkletEvent) => void>();
  private isOpen: boolean;

  constructor(
    readonly ctx: BaseAudioContext,
    destination: AudioNode,
    opts: MonitorChainOptions,
  ) {
    this.isOpen = opts.open ?? false;
    this.splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    this.input = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    const processorOptions: AmpProcessorOptions = { config: opts.config };
    this.amp = new AudioWorkletNode(ctx, PROCESSOR_NAMES.amp, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions,
    });
    this.amp.port.onmessage = (e: MessageEvent<AmpWorkletEvent>) => {
      for (const cb of [...this.guardListeners]) cb(e.data);
    };
    const cabOn = opts.cabLowpassHz !== null;
    this.cab = cabStages(opts.cabLowpassHz ?? CAB_LOWPASS_HZ).map(
      (s) => new BiquadFilterNode(ctx, { type: s.type, frequency: s.frequency, Q: nodeQ(s), gain: s.gain }),
    );
    this.cabGain = new GainNode(ctx, { gain: cabOn ? 1 : 0 });
    this.dryGain = new GainNode(ctx, { gain: cabOn ? 0 : 1 });
    this.out = new GainNode(ctx, { gain: this.isOpen ? 1 : 0 });

    this.input.connect(this.amp);
    let node: AudioNode = this.amp;
    for (const f of this.cab) node = node.connect(f);
    node.connect(this.cabGain).connect(this.out);
    this.amp.connect(this.dryGain).connect(this.out);
    this.out.connect(destination);
  }

  /** True while open (or ramping open). */
  get opened(): boolean {
    return this.isOpen;
  }

  /**
   * Connect the guitar source (replacing the previous one). `channel` picks the interface channel;
   * mono sources always use channel 0; `'mix'` downmixes all channels.
   */
  connectSource(node: AudioNode | null, channel: InputChannel = 0, channelCount = 1): void {
    if (this.source) {
      try {
        this.source.disconnect(this.input);
      } catch {
        // not connected directly
      }
      try {
        this.source.disconnect(this.splitter);
      } catch {
        // not connected through the splitter
      }
    }
    this.splitter.disconnect();
    this.source = node;
    if (!node) return;
    if (channel === 'mix' || channelCount < 2) {
      node.connect(this.input);
    } else {
      node.connect(this.splitter);
      this.splitter.connect(this.input, channel, 0);
    }
  }

  /** Update the amp and the cab. */
  configure(config: AmpConfig, cabLowpassHz: number | null): void {
    const cmd: AmpWorkletCommand = { type: 'config', config };
    this.amp.port.postMessage(cmd);
    const t = this.ctx.currentTime;
    const cabOn = cabLowpassHz !== null;
    this.cabGain.gain.setTargetAtTime(cabOn ? 1 : 0, t, CAB_TAU_SEC);
    this.dryGain.gain.setTargetAtTime(cabOn ? 0 : 1, t, CAB_TAU_SEC);
    if (cabOn) {
      for (const f of this.cab) if (f.type === 'lowpass') f.frequency.setTargetAtTime(cabLowpassHz, t, CAB_TAU_SEC);
    }
  }

  /** Open (ramp in over {@link RAMP_IN_SEC}) or close (fast fade) the monitor. */
  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    this.isOpen = open;
    const g = this.out.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    if (open) {
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(1, t + RAMP_IN_SEC);
    } else {
      g.setTargetAtTime(0, t, CLOSE_TAU_SEC);
    }
  }

  /** Clear a guard trip in the worklet and release its duck. */
  resetGuard(): void {
    const cmd: AmpWorkletCommand = { type: 'guard-reset' };
    this.amp.port.postMessage(cmd);
  }

  /** Guard trips reported by the worklet. */
  onGuard(cb: (ev: AmpWorkletEvent) => void): () => void {
    this.guardListeners.add(cb);
    return () => this.guardListeners.delete(cb);
  }

  /** Disconnect every node (the source keeps its other connections). */
  dispose(): void {
    this.connectSource(null);
    this.guardListeners.clear();
    this.amp.port.onmessage = null;
    for (const n of [this.input, this.amp, ...this.cab, this.cabGain, this.dryGain, this.out]) n.disconnect();
  }
}

/** Load the worklet (once per context) and build a chain into `destination`. */
export async function createMonitorChain(
  ctx: BaseAudioContext,
  destination: AudioNode,
  opts: MonitorChainOptions,
): Promise<MonitorChain> {
  await loadAmpWorklet(ctx);
  return new MonitorChain(ctx, destination, opts);
}
