/**
 * Backing player: the engine's `ScheduledSource` for backing audio. Plans stretch changes from the
 * engine's playback segments and the warp anchors (`plan.ts`), posts them to the signalsmith-stretch
 * node just in time (at most `latency + POST_MARGIN_SEC` ahead, see the posting rule in `plan.ts`),
 * and routes the node through a gain stage into the backing bus.
 *
 * Works on any `BaseAudioContext`: the live service pumps on a 25 ms timer; tests on an
 * `OfflineAudioContext` call {@link BackingPlayer.pump} at render-time suspend points and await it.
 * @module
 */
import type { PlaybackSegment, ScheduledSource } from '@shared/clock';
import type { WarpAnchor } from '@shared/storage';
import { type StretchEvent, StretchPlan } from './plan';
import { type StretchNode, createStretchNode } from './stretch';
import { DEFAULT_ANCHORS } from './warp';

/** Extra lead on top of the node's latency when posting changes (message delivery, timer jitter). */
export const POST_MARGIN_SEC = 0.05;
/** How far ahead a live re-plan (new anchors) starts. */
export const REPLAN_LEAD_SEC = 0.05;
/** Pump timer interval while changes are waiting to be posted (ms). */
export const PUMP_INTERVAL_MS = 25;
/** Gain ramp time constant for level / enable changes (s). */
const GAIN_SMOOTH_SEC = 0.01;

/** Options for {@link BackingPlayer.create}. */
export interface BackingPlayerOptions {
  ctx: BaseAudioContext;
  /** Where the player's output goes (the engine's `backing` bus). */
  destination: AudioNode;
  /** Initial anchors (default song 0 = audio 0). */
  anchors?: readonly WarpAnchor[];
  /** Post due changes from a 25 ms timer (default true). Tests pump manually. */
  autoPump?: boolean;
  /** Stretch node factory (default: the real signalsmith-stretch worklet). */
  createNode?: (ctx: BaseAudioContext) => Promise<StretchNode>;
}

const dbToGain = (db: number): number => (Number.isFinite(db) ? 10 ** (db / 20) : 1);

/** Time-stretched, warp-aligned backing playback on the engine clock. */
export class BackingPlayer implements ScheduledSource {
  readonly name = 'backing';
  private readonly plan: StretchPlan;
  private readonly gain: GainNode;
  private timer: ReturnType<typeof setInterval> | null = null;
  private gainDb = 0;
  private enabled = true;
  private disposed = false;
  private pumping: Promise<void> = Promise.resolve();

  private constructor(
    private readonly ctx: BaseAudioContext,
    private readonly node: StretchNode,
    destination: AudioNode,
    anchors: readonly WarpAnchor[],
    private readonly autoPump: boolean,
  ) {
    this.plan = new StretchPlan(anchors);
    this.gain = new GainNode(ctx, { gain: 1 });
    node.output.connect(this.gain).connect(destination);
  }

  /** Create the stretch node on `opts.ctx` and wire it to `opts.destination`. */
  static async create(opts: BackingPlayerOptions): Promise<BackingPlayer> {
    const node = await (opts.createNode ?? createStretchNode)(opts.ctx);
    return new BackingPlayer(opts.ctx, node, opts.destination, opts.anchors ?? DEFAULT_ANCHORS, opts.autoPump ?? true);
  }

  /** Latency the stretch node compensates (s). */
  get latency(): number {
    return this.node.latency;
  }

  /** How far ahead changes are posted: latency + margin (s). */
  get lead(): number {
    return this.node.latency + POST_MARGIN_SEC;
  }

  /** Planned stretch changes (diagnostics and tests). */
  get planned(): StretchEvent[] {
    return this.plan.planned;
  }

  /** Load decoded audio (must be at the context's sample rate); null removes it. */
  async setBuffer(buffer: AudioBuffer | null): Promise<void> {
    if (buffer && buffer.sampleRate !== this.ctx.sampleRate) {
      throw new Error(`Backing audio is at ${buffer.sampleRate} Hz but the context runs at ${this.ctx.sampleRate} Hz`);
    }
    await this.node.setBuffer(buffer);
  }

  /** New warp anchors: re-plans from {@link REPLAN_LEAD_SEC} ahead. */
  setAnchors(anchors: readonly WarpAnchor[]): void {
    const now = this.ctx.currentTime;
    this.plan.setAnchors(anchors, now + REPLAN_LEAD_SEC, now);
    this.kick();
  }

  /** Output level in dB (link `gainDb`). */
  setGainDb(db: number): void {
    this.gainDb = db;
    this.applyGain();
  }

  /** Audible or muted (the stretcher keeps running so re-enabling is instant and in sync). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.applyGain();
  }

  /** `ScheduledSource.schedule`: replaces everything planned from `segment.ctxStart` on. */
  schedule(segment: PlaybackSegment): void {
    if (this.disposed) return;
    this.plan.schedule(segment, this.ctx.currentTime);
    this.kick();
  }

  /** `ScheduledSource.stop`: silence from `when` (default now). */
  stop(when?: number): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.plan.stop(Math.max(now, when ?? now), now);
    this.kick();
  }

  /**
   * Post every change that is due now. Resolves when the worklet has applied them (tests await this
   * before resuming an offline render).
   */
  pump(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const now = this.ctx.currentTime;
    const due = this.plan.takeDue(now, this.lead);
    this.plan.prune(now);
    if (due.length) {
      const posted = Promise.all(due.map((ev) => this.node.schedule(ev))).then(
        () => undefined,
        () => undefined, // the node was disposed mid-flight; nothing left to schedule
      );
      this.pumping = this.pumping.then(() => posted);
    }
    if (!this.plan.hasUnposted) this.stopTimer();
    return this.pumping;
  }

  /** Disconnect and release the node. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    this.gain.disconnect();
    this.node.dispose();
  }

  private kick(): void {
    void this.pump();
    if (this.autoPump && this.plan.hasUnposted && this.timer === null) {
      this.timer = setInterval(() => void this.pump(), PUMP_INTERVAL_MS);
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private applyGain(): void {
    const target = this.enabled ? dbToGain(this.gainDb) : 0;
    this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, GAIN_SMOOTH_SEC);
  }
}
