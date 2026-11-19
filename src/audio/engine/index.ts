/**
 * Audio engine (T-016): one `AudioContext` (`latencyHint: 0`, matched sample rate), the song clock
 * (D5), transport, look-ahead scheduler (25 ms / 120 ms), metronome from the beat grid, and mixer
 * buses `monitor/backing/guide/metronome → master → safety limiter`. See docs/timing.md.
 * Signature frozen by T-010; reached in the app via `ctx.services.get('engine')`.
 *
 * Building blocks are exported for tests and tools that drive them on another context (e.g. an
 * `OfflineAudioContext`): {@link TransportCore}, {@link LookaheadLoop}, {@link createMixer},
 * {@link createClickPlayer}.
 * @module
 */
import type { ScheduledSource, SongClock, Unsubscribe } from '@shared/clock';
import type { AudioEngine, EngineOptions, MixerBus } from '@shared/services';
import { DEFAULT_SETTINGS, type MixerLevels, type Settings } from '@shared/settings';
import { type OutputClock, createSongClock, heardCtxTime } from './clock';
import { type ClickPlayer, createClickPlayer } from './metronome';
import { MIXER_BUSES, type Mixer, createMixer } from './mixer';
import { LookaheadLoop } from './scheduler';
import { TransportCore } from './transport';

export { beatsInRange, countInClicks, meterAt, nextBarLine, type BeatClick } from './beats';
export { SegmentTimeline, createSongClock, heardCtxTime, type OutputClock, type Segment } from './clock';
export { CLICK_VOICE, createClickPlayer, type ClickPlayer } from './metronome';
export { MIXER_BUSES, SAFETY_LIMITER, createMixer, limiterCurve, type Mixer } from './mixer';
export { LookaheadLoop, type LoopTimer, type LookaheadOptions } from './scheduler';
export {
  DEFAULT_HORIZON_SEC,
  REANCHOR_LEAD_SEC,
  SPEED_MAX,
  SPEED_MIN,
  TransportCore,
  type ClickHandle,
  type ClickSink,
  type TransportHost,
  type TransportOptions,
} from './transport';

/** Default context sample rate (most USB interfaces run at 48 kHz). */
export const DEFAULT_SAMPLE_RATE = 48000;

/** `createEngine` options: the shared {@link EngineOptions} plus a test seam for initial levels. */
export interface CreateEngineOptions extends EngineOptions {
  /** Initial levels when no settings store is given (default `DEFAULT_SETTINGS.mixer`). */
  levels?: MixerLevels;
}

/** `AudioContext.setSinkId` (Chrome 110+; not yet in TypeScript's DOM lib). */
type SinkCapableContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

/** The context's output-side clock (see {@link OutputClock}). */
function outputClockOf(getCtx: () => AudioContext): OutputClock {
  return {
    now: () => getCtx().currentTime,
    outputTimestamp: () => {
      const ctx = getCtx();
      if (ctx.state !== 'running') return null;
      const ts = ctx.getOutputTimestamp();
      return { contextTime: ts.contextTime ?? 0, performanceTime: ts.performanceTime ?? 0 };
    },
    perfNow: () => performance.now(),
    outputDelay: () => (getCtx().baseLatency || 0) + (getCtx().outputLatency || 0),
  };
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

class Engine implements AudioEngine {
  ctx: AudioContext;
  readonly clock: SongClock;
  readonly transport: TransportCore;
  private mixer: Mixer;
  private clicks: ClickPlayer;
  private readonly loop: LookaheadLoop;
  private readonly out: OutputClock = outputClockOf(() => this.ctx);
  /** Settings last applied (changes are detected against it, so unrelated updates keep live tweaks). */
  private prevSettings: Settings | null;
  private readonly contextListeners = new Set<(ctx: AudioContext) => void>();
  private readonly unsubs: Unsubscribe[] = [];
  private visualOffsetMs: number;
  private sinkId: string;
  private disposed = false;

  constructor(ctx: AudioContext, opts: CreateEngineOptions) {
    const s = opts.settings?.get();
    this.prevSettings = s ?? null;
    this.ctx = ctx;
    this.sinkId = opts.sinkId ?? s?.output.sinkId ?? '';
    this.visualOffsetMs = s?.calibration.visualOffsetMs ?? 0;
    this.mixer = createMixer(ctx, s?.mixer ?? opts.levels ?? DEFAULT_SETTINGS.mixer);
    this.clicks = createClickPlayer(ctx, this.mixer.buses.metronome);
    this.transport = new TransportCore(
      { now: () => this.ctx.currentTime, clicks: { schedule: (when, accent) => this.clicks.schedule(when, accent) } },
      {
        countInBars: s?.practice.countInBars ?? DEFAULT_SETTINGS.practice.countInBars,
        metronome: s?.practice.metronome ?? DEFAULT_SETTINGS.practice.metronome,
      },
    );
    this.clock = createSongClock(this.transport, this.out, () => this.visualOffsetMs);
    this.loop = new LookaheadLoop({
      now: () => this.ctx.currentTime,
      tick: (horizon) => {
        this.transport.tick(horizon);
        return this.transport.running;
      },
      hidden: isHidden,
    });
    this.unsubs.push(
      this.transport.onChange(() => {
        if (this.transport.running && !this.loop.running) this.loop.start();
      }),
    );
    if (opts.settings) this.unsubs.push(opts.settings.subscribe((next) => this.applySettings(next)));
    if (typeof document !== 'undefined') {
      // Catch up right away when the tab becomes visible again (timers may have been throttled).
      const onVisibility = (): void => {
        if (this.transport.running) this.loop.start();
      };
      document.addEventListener('visibilitychange', onVisibility);
      this.unsubs.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }
  }

  get buses(): Readonly<Record<MixerBus, GainNode>> {
    return this.mixer.buses;
  }

  get running(): boolean {
    return this.ctx.state === 'running';
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async setSampleRate(sampleRate: number): Promise<void> {
    if (sampleRate === this.ctx.sampleRate) return;
    const old = this.ctx;
    const songTime = this.clock.nowSong();
    const wasRunning = old.state === 'running';
    const levels = this.mixer.levels();
    this.loop.stop();
    this.clicks.dispose();
    this.mixer.dispose();
    this.ctx = createContext(sampleRate);
    this.mixer = createMixer(this.ctx, levels);
    this.clicks = createClickPlayer(this.ctx, this.mixer.buses.metronome);
    this.transport.rebase(songTime);
    await old.close();
    if (this.sinkId) await this.applySinkId(this.sinkId);
    if (wasRunning) await this.ctx.resume().catch(() => undefined);
    for (const cb of [...this.contextListeners]) cb(this.ctx);
  }

  async setSinkId(sinkId: string): Promise<void> {
    this.sinkId = sinkId;
    await this.applySinkId(sinkId);
  }

  setLevel(bus: MixerBus, level: number): void {
    this.mixer.setLevel(bus, level);
  }

  registerScheduledSource(source: ScheduledSource): Unsubscribe {
    return this.transport.addSource(source);
  }

  perfToCtxTime(perfTimeMs: number): number {
    return heardCtxTime(this.out, perfTimeMs);
  }

  onContextChange(cb: (ctx: AudioContext) => void): Unsubscribe {
    this.contextListeners.add(cb);
    return () => this.contextListeners.delete(cb);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.stop();
    for (const u of this.unsubs.splice(0)) u();
    this.transport.dispose();
    this.clicks.dispose();
    this.mixer.dispose();
    this.contextListeners.clear();
    if (this.ctx.state !== 'closed') await this.ctx.close();
  }

  private async applySinkId(sinkId: string): Promise<void> {
    const ctx = this.ctx as SinkCapableContext;
    if (typeof ctx.setSinkId !== 'function') throw new Error('This browser cannot choose an audio output device');
    await ctx.setSinkId(sinkId);
  }

  private applySettings(next: Settings): void {
    const prev = this.prevSettings ?? next;
    this.prevSettings = next;
    for (const bus of MIXER_BUSES) if (next.mixer[bus] !== prev.mixer[bus]) this.mixer.setLevel(bus, next.mixer[bus]);
    this.transport.countInBars = next.practice.countInBars;
    if (next.practice.metronome !== prev.practice.metronome) this.transport.setMetronome(next.practice.metronome);
    this.visualOffsetMs = next.calibration.visualOffsetMs;
    if (next.output.sinkId !== prev.output.sinkId && next.output.sinkId !== this.sinkId) {
      this.setSinkId(next.output.sinkId).catch((err: unknown) => console.error('Riffway: could not switch output', err));
    }
  }
}

function createContext(sampleRate: number): AudioContext {
  return new AudioContext({ latencyHint: 0, sampleRate });
}

/** Create the engine. The context starts suspended until `resume()` is called from a gesture. */
export async function createEngine(opts: CreateEngineOptions = {}): Promise<AudioEngine> {
  const ctx = createContext(opts.sampleRate ?? DEFAULT_SAMPLE_RATE);
  const engine = new Engine(ctx, opts);
  const sinkId = opts.sinkId ?? opts.settings?.get().output.sinkId ?? '';
  if (sinkId) {
    try {
      await engine.setSinkId(sinkId);
    } catch (err) {
      // The saved device is gone or unsupported: keep the default output.
      console.warn('Riffway: saved output device unavailable, using the default', err);
    }
  }
  return engine;
}
