/**
 * The guitar-input service (`InputService`, `@shared/services`): opens the chosen device with the
 * constraints from `./constraints`, wires it into the analysis worklet on the engine's context and
 * fans worklet events out as context-time analysis events and calibrated judge events.
 *
 * Lifecycle (docs/audio-input.md § Device selection and persistence):
 * - `open()` unlocks device labels (one throwaway `getUserMedia`) when the browser hides them, picks
 *   the device with {@link chooseInput}, opens it, reads back `track.getSettings()`, matches the
 *   engine's sample rate to the track, and persists the choice (not when it fell back).
 * - Unplugging ends the track: the input closes, `current` becomes null and listeners hear about it.
 *   On `devicechange` (debounced) a closed-by-unplug or fallback input re-opens as soon as the saved
 *   device is back.
 * - The engine may recreate its context (sample-rate change); the graph is rebuilt on the new one.
 *
 * Browser APIs are injected ({@link InputServiceDeps}) so the logic runs against fakes in Node tests;
 * `createInputService` in `./index.ts` supplies the real ones.
 * @module
 */
import type { AnalysisCommand, AnalysisEvent, AnalysisProcessorOptions } from '@shared/audio-events';
import type { Unsubscribe } from '@shared/clock';
import type { InputEvent } from '@shared/judge';
import type {
  AudioDeviceInfo,
  AudioEngine,
  InputOpenResult,
  InputService,
  TimedAnalysisEvent,
} from '@shared/services';
import type { InputChannel, Settings, SettingsStore } from '@shared/settings';
import { analysisToInputEvent } from '@core/judge';
import { effectiveChannel, inputConstraints, readTrackSettings } from './constraints';
import { chooseInput, labelsHidden, savedDevicePresent, toDeviceInfos, type InputChoice } from './devices';

/** `devicechange` bursts (Chrome fires several per plug) are coalesced over this many ms. */
export const DEVICE_CHANGE_DEBOUNCE_MS = 300;

/** The part of a worklet `MessagePort` the service uses. */
export interface AnalysisPort {
  postMessage(cmd: AnalysisCommand): void;
  onmessage: ((ev: MessageEvent<AnalysisEvent>) => void) | null;
}

/** Nodes built for one stream on one context. */
export interface AnalysisGraph {
  /** The input's source node (monitoring taps it). */
  readonly source: AudioNode;
  readonly port: AnalysisPort;
  /** Disconnect everything and close the port. */
  dispose(): void;
}

/** Browser APIs used by the service. */
export interface InputServiceDeps {
  mediaDevices: Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia' | 'addEventListener' | 'removeEventListener'>;
  /** Load the worklet (once per context) and build source → analysis node. */
  createGraph(ctx: AudioContext, stream: MediaStream, opts: AnalysisProcessorOptions): Promise<AnalysisGraph>;
}

/** `InputService` plus teardown (used by tests and hot reload). */
export interface DisposableInputService extends InputService {
  dispose(): void;
}

type Listener<T> = (value: T) => void;

/** Error names from `getUserMedia` that mean "this device id is gone". */
const DEVICE_GONE_ERRORS = new Set(['OverconstrainedError', 'NotFoundError', 'NotReadableError']);

/** Create the service on top of `engine` and `settings`. */
export function createInputServiceWith(
  engine: AudioEngine,
  settings: SettingsStore,
  deps: InputServiceDeps,
): DisposableInputService {
  return new InputServiceImpl(engine, settings, deps);
}

class InputServiceImpl implements DisposableInputService {
  current: InputOpenResult | null = null;

  private stream: MediaStream | null = null;
  private channelCount = 1;
  private graph: AnalysisGraph | null = null;
  private graphCtx: AudioContext | null = null;
  private wiring: { ctx: AudioContext; promise: Promise<void> } | null = null;
  /** The player wants input (opened and not closed); drives re-open after unplug. */
  private wanted = false;
  private expectRange: { minMidi: number; maxMidi: number } | null = null;
  private tuner = false;
  private channelSetting: InputChannel;
  private queue: Promise<unknown> = Promise.resolve();
  private deviceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly inputListeners = new Set<Listener<InputEvent>>();
  private readonly analysisListeners = new Set<Listener<TimedAnalysisEvent>>();
  private readonly deviceListeners = new Set<() => void>();
  private readonly unsubs: Unsubscribe[] = [];
  private readonly onDeviceChange = (): void => this.scheduleDeviceCheck();

  constructor(
    private readonly engine: AudioEngine,
    private readonly settings: SettingsStore,
    private readonly deps: InputServiceDeps,
  ) {
    this.channelSetting = settings.get().input.channel;
    deps.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
    this.unsubs.push(
      () => deps.mediaDevices.removeEventListener('devicechange', this.onDeviceChange),
      engine.onContextChange(() => {
        if (this.stream) this.wire().catch((err: unknown) => console.error('Riffway: could not reconnect the input', err));
      }),
      settings.subscribe((s) => this.onSettings(s)),
    );
  }

  async listInputs(): Promise<AudioDeviceInfo[]> {
    return toDeviceInfos(await this.deps.mediaDevices.enumerateDevices(), 'audioinput');
  }

  async listOutputs(): Promise<AudioDeviceInfo[]> {
    return toDeviceInfos(await this.deps.mediaDevices.enumerateDevices(), 'audiooutput');
  }

  open(deviceId?: string): Promise<InputOpenResult> {
    return this.serial(() => this.doOpen(deviceId));
  }

  close(): void {
    this.wanted = false;
    this.teardown();
    this.notifyDevices();
  }

  getInputNode(): AudioNode | null {
    return this.graph?.source ?? null;
  }

  onInput(cb: (ev: InputEvent) => void): Unsubscribe {
    this.inputListeners.add(cb);
    return () => this.inputListeners.delete(cb);
  }

  onAnalysis(cb: (ev: TimedAnalysisEvent) => void): Unsubscribe {
    this.analysisListeners.add(cb);
    return () => this.analysisListeners.delete(cb);
  }

  expect(range: { minMidi: number; maxMidi: number } | null): void {
    this.expectRange = range ? { minMidi: range.minMidi, maxMidi: range.maxMidi } : null;
    this.graph?.port.postMessage({ type: 'expect', range: this.expectRange });
  }

  setTunerMode(on: boolean): void {
    this.tuner = on;
    this.postConfig();
  }

  onDevicesChanged(cb: () => void): Unsubscribe {
    this.deviceListeners.add(cb);
    return () => this.deviceListeners.delete(cb);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wanted = false;
    if (this.deviceTimer) clearTimeout(this.deviceTimer);
    for (const u of this.unsubs.splice(0)) u();
    this.teardown();
    this.inputListeners.clear();
    this.analysisListeners.clear();
    this.deviceListeners.clear();
  }

  // ---------------------------------------------------------------------------------------------

  /** Run opens/re-opens one at a time. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doOpen(deviceId: string | undefined): Promise<InputOpenResult> {
    if (this.disposed) throw new Error('The input service was disposed');
    this.wanted = true;
    let inputs = await this.listInputs();
    if (inputs.length === 0 || labelsHidden(inputs) || inputs.every((d) => d.deviceId === '')) {
      await this.unlockLabels();
      inputs = await this.listInputs();
    }
    let choice: InputChoice | null;
    if (deviceId !== undefined) {
      const device = inputs.find((d) => d.deviceId === deviceId);
      if (!device) throw new Error('That input is not connected any more. Pick another one.');
      choice = { device, by: 'requested', fellBack: false };
    } else {
      choice = chooseInput(inputs, this.settings.get().input);
    }
    if (!choice) throw new Error('No audio inputs found. Plug in your guitar cable and try again.');

    this.teardown();
    let stream: MediaStream;
    try {
      stream = await this.deps.mediaDevices.getUserMedia(inputConstraints(choice.device.deviceId));
    } catch (err) {
      const fallback = inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
      if (deviceId !== undefined || !isDeviceGone(err) || fallback.deviceId === choice.device.deviceId) throw err;
      choice = { device: fallback, by: 'default', fellBack: true };
      stream = await this.deps.mediaDevices.getUserMedia(inputConstraints(fallback.deviceId));
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stopStream(stream);
      throw new Error('The input delivered no audio track.');
    }
    const readback = readTrackSettings(track.getSettings());
    this.stream = stream;
    this.channelCount = readback.channelCount;
    track.addEventListener('ended', () => this.onTrackEnded(stream));

    try {
      if (readback.sampleRate !== null && readback.sampleRate !== this.engine.ctx.sampleRate) {
        await this.engine.setSampleRate(readback.sampleRate);
      }
      await this.wire();
    } catch (err) {
      this.teardown();
      throw err;
    }

    const device = choice.device;
    this.current = {
      device,
      sampleRate: readback.sampleRate ?? this.engine.ctx.sampleRate,
      channelCount: readback.channelCount,
      latency: readback.latency,
      processingWarnings: readback.processingWarnings,
      fellBackToDefault: choice.fellBack,
    };
    if (!choice.fellBack) await this.persistChoice(device);
    this.notifyDevices();
    return this.current;
  }

  /** One throwaway permission request so `enumerateDevices` returns ids and labels. */
  private async unlockLabels(): Promise<void> {
    const probe = await this.deps.mediaDevices.getUserMedia({ audio: true, video: false });
    stopStream(probe);
  }

  private async persistChoice(device: AudioDeviceInfo): Promise<void> {
    const saved = this.settings.get().input;
    if (saved.deviceId === device.deviceId && saved.label === device.label) return;
    try {
      await this.settings.update({ input: { deviceId: device.deviceId, label: device.label } });
    } catch (err) {
      console.error('Riffway: could not save the input choice', err);
    }
  }

  /** Build the graph on the engine's current context (idempotent per context). */
  private wire(): Promise<void> {
    const ctx = this.engine.ctx;
    if (this.graph && this.graphCtx === ctx) return Promise.resolve();
    if (this.wiring && this.wiring.ctx === ctx) return this.wiring.promise;
    const stream = this.stream;
    if (!stream) return Promise.resolve();
    this.graph?.dispose();
    this.graph = null;
    this.graphCtx = null;
    const promise = this.deps
      .createGraph(ctx, stream, { channel: effectiveChannel(this.channelSetting, this.channelCount), tuner: this.tuner })
      .then((graph) => {
        if (this.stream !== stream || this.engine.ctx !== ctx) {
          graph.dispose();
          return;
        }
        graph.port.onmessage = (e) => this.dispatch(e.data, ctx);
        if (this.expectRange) graph.port.postMessage({ type: 'expect', range: this.expectRange });
        this.graph = graph;
        this.graphCtx = ctx;
      })
      .finally(() => {
        if (this.wiring?.promise === promise) this.wiring = null;
      });
    this.wiring = { ctx, promise };
    return promise;
  }

  private teardown(): void {
    this.graph?.dispose();
    this.graph = null;
    this.graphCtx = null;
    this.wiring = null;
    if (this.stream) stopStream(this.stream);
    this.stream = null;
    this.current = null;
  }

  private onTrackEnded(stream: MediaStream): void {
    if (this.stream !== stream) return;
    this.teardown();
    this.notifyDevices();
  }

  private scheduleDeviceCheck(): void {
    if (this.deviceTimer) clearTimeout(this.deviceTimer);
    this.deviceTimer = setTimeout(() => {
      this.deviceTimer = null;
      void this.checkDevices();
    }, DEVICE_CHANGE_DEBOUNCE_MS);
  }

  /** After `devicechange`: drop a vanished input, re-open the saved one when it is back. */
  private async checkDevices(): Promise<void> {
    if (this.disposed) return;
    try {
      const inputs = await this.listInputs();
      const cur = this.current;
      if (cur && !inputs.some((d) => d.deviceId === cur.device.deviceId)) this.teardown();
      const saved = this.settings.get().input;
      const back = this.wanted && savedDevicePresent(inputs, saved);
      if (back && (!this.current || this.current.fellBackToDefault)) {
        await this.open().catch((err: unknown) => console.warn('Riffway: could not re-open the guitar input', err));
        return;
      }
    } catch (err) {
      console.warn('Riffway: device check failed', err);
    }
    this.notifyDevices();
  }

  private onSettings(s: Settings): void {
    if (s.input.channel === this.channelSetting) return;
    this.channelSetting = s.input.channel;
    this.postConfig();
  }

  private postConfig(): void {
    this.graph?.port.postMessage({
      type: 'config',
      channel: effectiveChannel(this.channelSetting, this.channelCount),
      tuner: this.tuner,
    });
  }

  private dispatch(ev: AnalysisEvent, ctx: AudioContext): void {
    const sampleRate = ctx.sampleRate;
    const timed: TimedAnalysisEvent = { ...ev, ctxTime: ev.type === 'ready' ? ctx.currentTime : ev.frame / sampleRate };
    for (const cb of this.analysisListeners) safeCall(cb, timed);
    if (this.inputListeners.size === 0) return;
    const input = analysisToInputEvent(ev, sampleRate, this.settings.get().calibration.inputOffsetMs);
    if (input) for (const cb of this.inputListeners) safeCall(cb, input);
  }

  private notifyDevices(): void {
    for (const cb of this.deviceListeners) safeCall(cb, undefined);
  }
}

function isDeviceGone(err: unknown): boolean {
  return typeof err === 'object' && err !== null && DEVICE_GONE_ERRORS.has((err as { name?: string }).name ?? '');
}

function stopStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}

function safeCall<T>(cb: (v: T) => void, v: T): void {
  try {
    cb(v);
  } catch (err) {
    console.error('Riffway: input listener failed', err);
  }
}
