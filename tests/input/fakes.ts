/**
 * Fakes for the input service tests (T-022): media devices with plug/unplug, streams whose track
 * read-back is scripted, an engine whose context can be recreated, an in-memory settings store and
 * an analysis graph whose port the test drives.
 */
import type { AnalysisCommand, AnalysisEvent, AnalysisProcessorOptions } from '@shared/audio-events';
import type { AudioEngine } from '@shared/services';
import { type DeepPartial, type Settings, type SettingsStore, defaultSettings } from '@shared/settings';
import type { AnalysisGraph, AnalysisPort, InputServiceDeps } from '../../src/audio/input/service';

export interface FakeDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  /** Track read-back for streams of this device. */
  settings?: MediaTrackSettings;
}

export class FakeTrack extends EventTarget {
  stopped = false;
  constructor(
    readonly deviceId: string,
    private readonly readback: MediaTrackSettings,
  ) {
    super();
  }
  getSettings(): MediaTrackSettings {
    return { deviceId: this.deviceId, ...this.readback };
  }
  stop(): void {
    this.stopped = true;
  }
  /** Simulate an unplug. */
  end(): void {
    this.dispatchEvent(new Event('ended'));
  }
}

export class FakeStream {
  constructor(readonly track: FakeTrack) {}
  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

export class FakeMediaDevices extends EventTarget {
  granted = false;
  devices: FakeDevice[];
  readonly requests: MediaStreamConstraints[] = [];
  readonly streams: FakeStream[] = [];
  /** Next getUserMedia rejects with this (once). */
  failNext: Error | null = null;

  constructor(devices: FakeDevice[]) {
    super();
    this.devices = devices;
  }

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return this.devices.map(
      (d) =>
        ({
          deviceId: this.granted ? d.deviceId : '',
          label: this.granted ? d.label : '',
          groupId: '',
          kind: d.kind,
          toJSON: () => ({}),
        }) as MediaDeviceInfo,
    );
  }

  async getUserMedia(c: MediaStreamConstraints): Promise<MediaStream> {
    this.requests.push(c);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.granted = true;
    const audio = c.audio === true ? {} : (c.audio as MediaTrackConstraints);
    const wanted = (audio.deviceId as { exact?: string } | undefined)?.exact;
    const dev = this.devices.find((d) => d.kind === 'audioinput' && (wanted === undefined || d.deviceId === wanted));
    if (!dev) throw Object.assign(new Error('not found'), { name: 'OverconstrainedError' });
    const stream = new FakeStream(new FakeTrack(dev.deviceId, dev.settings ?? { sampleRate: 48000, channelCount: 1 }));
    this.streams.push(stream);
    return stream as unknown as MediaStream;
  }

  /** Replace the device list and fire `devicechange`. */
  setDevices(devices: FakeDevice[]): void {
    this.devices = devices;
    this.dispatchEvent(new Event('devicechange'));
  }
}

export class FakePort implements AnalysisPort {
  readonly sent: AnalysisCommand[] = [];
  onmessage: ((ev: MessageEvent<AnalysisEvent>) => void) | null = null;
  postMessage(cmd: AnalysisCommand): void {
    this.sent.push(cmd);
  }
  /** Deliver a worklet event to the service. */
  emit(ev: AnalysisEvent): void {
    this.onmessage?.({ data: ev } as MessageEvent<AnalysisEvent>);
  }
}

export interface FakeGraph extends AnalysisGraph {
  readonly port: FakePort;
  readonly ctx: AudioContext;
  readonly opts: AnalysisProcessorOptions;
  disposed: boolean;
}

export function fakeDeps(media: FakeMediaDevices): InputServiceDeps & { graphs: FakeGraph[] } {
  const graphs: FakeGraph[] = [];
  return {
    graphs,
    mediaDevices: media as unknown as InputServiceDeps['mediaDevices'],
    async createGraph(ctx, stream, opts) {
      void stream;
      const g: FakeGraph = {
        ctx,
        opts,
        port: new FakePort(),
        source: { fake: 'source', ctx } as unknown as AudioNode,
        disposed: false,
        dispose() {
          g.disposed = true;
        },
      };
      graphs.push(g);
      return g;
    },
  };
}

export class FakeEngine {
  ctx: AudioContext;
  readonly listeners = new Set<(ctx: AudioContext) => void>();
  sinkId = '';
  constructor(sampleRate = 48000) {
    this.ctx = fakeContext(sampleRate);
  }
  async setSampleRate(sr: number): Promise<void> {
    if (sr === this.ctx.sampleRate) return;
    this.ctx = fakeContext(sr);
    for (const cb of [...this.listeners]) cb(this.ctx);
  }
  onContextChange(cb: (ctx: AudioContext) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  async setSinkId(id: string): Promise<void> {
    this.sinkId = id;
  }
  running = true;
  resumes = 0;
  async resume(): Promise<void> {
    this.resumes++;
    this.running = true;
  }
  asEngine(): AudioEngine {
    return this as unknown as AudioEngine;
  }
}

function fakeContext(sampleRate: number): AudioContext {
  return { sampleRate, currentTime: 1.5 } as AudioContext;
}

/** In-memory settings store with deep merge. */
export function memorySettings(initial: DeepPartial<Settings> = {}): SettingsStore & { updates: DeepPartial<Settings>[] } {
  let value = merge(defaultSettings(), initial);
  const subs = new Set<(s: Settings) => void>();
  const updates: DeepPartial<Settings>[] = [];
  return {
    updates,
    get: () => value,
    async update(patch) {
      updates.push(patch);
      value = merge(structuredClone(value), patch);
      for (const cb of subs) cb(value);
      return value;
    },
    async replace(next) {
      value = structuredClone(next);
      for (const cb of subs) cb(value);
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

function merge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return (patch === undefined ? base : patch) as T;
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(out[k], v);
  return out as T;
}
