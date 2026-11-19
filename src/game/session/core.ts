/**
 * The game session (T-031): one song on the engine's transport, every input source → one judge per
 * run → HUD listeners, practice loop / speed trainer, and the run bookkeeping when a run ends.
 * It is driven exactly as docs/game-mechanics.md § Driving the judge describes:
 *
 * - **One judge per run** (a fresh `play()` from stopped until song end, finish or quit), created
 *   right before the run's `play()`, with the engine's pass-aware `SongClock`.
 * - **Passes.** Every transport `ClockChange` whose `pass` differs from the judge's calls
 *   `startPass({pass, region})` synchronously in the handler (loop wraps, seeks, jumps). A loop change
 *   within a pass calls `startPass` with the same pass and the new region.
 * - **`advance(horizon)`** on every tick (also while paused) with the input horizon — the earliest of
 *   the active sources' `inputHorizon()` — never `ctx.currentTime`.
 * - **Song end** waits until the horizon has passed the end plus the Good window (late input for
 *   the last notes can still land), then `finish()`es and saves the run.
 *
 * Inputs: the guitar (`InputService.onInput`, calibrated in the input service; `expect` hints for
 * the upcoming pitch range), keyboard mode ({@link GameSessionImpl.keyPress}, D6) and the e2e test
 * hook ({@link GameSessionImpl.injectTest}) all reach {@link GameSessionImpl.input}.
 *
 * Browser-free: the engine, services and timer are injected ({@link SessionDeps}), so the whole
 * session runs in Node tests on a real `TransportCore` with a fake clock. `createSession`
 * (`./index.ts`) wires the real services.
 * @module
 */
import type { ClockChange, SongClock, Transport, TransportLoop, Unsubscribe } from '@shared/clock';
import type {
  BarLoop,
  InputEvent,
  InputSource,
  Judge,
  JudgeOutput,
  Judgement,
  JudgeState,
  PracticeMessage,
  RunSummary,
  StrayEvent,
  TimingWindows,
  TrainerState,
} from '@shared/judge';
import type { BackingService, GameSession, GuideService, InputService, SessionState } from '@shared/services';
import type { SettingsStore } from '@shared/settings';
import type { DifficultyReport, Song } from '@shared/song';
import type { IndexEntry } from '@shared/sources';
import type { RunMode, SectionProgress, StorageService } from '@shared/storage';
import { createJudge, inputHorizon, passStats, type PassClockMapping } from '@core/judge';
import { sectionAt } from '@core/model';
import { initialTrainerState, toTransportLoop, trainerStep } from '@core/practice';
import { guideShouldMute } from '../../audio/backing';
import { windowsFor } from './leniency';
import { expectedRangeAt, laneIndex, laneMidi, sameRange, type LaneIndex, type LanePress, type MidiRange } from '../input';
import {
  completedSections,
  persistRun,
  recordPracticeTime,
  SectionProgressBook,
  sectionEventText,
  type SavedRun,
  type SectionUpdate,
  touchSongCache,
} from './progress';
import { rememberResult, type RunResult } from './results';

/** Speed range of the transport (fractions). */
export const SESSION_SPEED_MIN = 0.4;
export const SESSION_SPEED_MAX = 1.1;
/** Tick period of the session timer (ms). */
export const SESSION_TICK_MS = 20;
/** How often the guitar `expect` hint is refreshed (ctx seconds). */
export const EXPECT_REFRESH_SEC = 0.2;
/** Extra wait after the Good window before a finished pass / the song end is evaluated (s). */
export const SETTLE_MARGIN_SEC = 0.01;

/** The part of the audio engine the session uses (`AudioEngine` satisfies it). */
export interface SessionEngine {
  readonly clock: SongClock;
  readonly transport: Transport;
  /** `performance.now()` ms → context time in the heard domain (keyboard events). */
  perfToCtxTime(perfTimeMs: number): number;
  readonly ctx: { readonly currentTime: number; readonly outputLatency?: number };
}

/** Periodic driver (default: `setInterval` every {@link SESSION_TICK_MS}). */
export interface SessionTicker {
  start(tick: () => void): void;
  stop(): void;
}

/** Everything a session needs. */
export interface SessionDeps {
  song: Song;
  songId: string;
  arrangement: number;
  mode: RunMode;
  title: string;
  artist: string | null;
  engine: SessionEngine;
  settings: Pick<SettingsStore, 'get' | 'subscribe'>;
  /** Null: nothing is saved (tests, storage unavailable). */
  storage: StorageService | null;
  /** Loaded guide synth, or null when unavailable. */
  guide: Pick<GuideService, 'setSpeed' | 'setMuted'> | null;
  /** Backing service (its `link` decides guide muting), or null. */
  backing: Pick<BackingService, 'link'> | null;
  /** Open guitar input, or null (keyboard only). */
  input: Pick<InputService, 'onInput' | 'expect'> | null;
  difficulty: DifficultyReport | null;
  entry: IndexEntry | null;
  comfortTier: number;
  /** Stored section progress of this arrangement. */
  sectionProgress: readonly SectionProgress[];
  /** Practice-session id (mastery counts clean runs at 100% within one session). */
  sessionId: string;
  /** Initial speed fraction. */
  speed: number;
  /** Start with this section looped. */
  loopSection?: number;
  speedTrainer: boolean;
  ticker?: SessionTicker;
  /** Epoch ms (run timestamps). */
  now?: () => number;
  /** Called once from `dispose()` (unload guide/backing). */
  onDispose?: () => void | Promise<void>;
}

/** e2e injection (`window.__riffwayTest.inject`). */
export interface TestInjection {
  lane: 1 | 2 | 3 | 4 | 5 | 6;
  songTime: number;
  wrongPitch?: boolean;
}

/** How a run ended. */
type RunEnd = 'completed' | 'finished' | 'quit';

/** One run: a fresh `play()` until song end, finish or quit. */
interface Run {
  readonly judge: Judge;
  /** Timing windows of this run (settings `game.timingLeniency` when it started). */
  readonly windows: TimingWindows;
  judgePass: number;
  readonly judgements: Judgement[];
  strays: number;
  readonly startedAt: number;
  activeSec: number;
  lastCtx: number;
  /** Slowest speed played (a run counts at its slowest speed). */
  minSpeed: number;
  hadLoop: boolean;
  /** Latest playing speed per pass. */
  readonly passSpeed: Map<number, number>;
  /** Bar loop in effect when each pass started. */
  readonly passLoop: Map<number, BarLoop | null>;
  /** Passes to evaluate (speed trainer, section progress) once their notes are final. */
  readonly pendingEvals: { pass: number; at: number }[];
  /** Ctx time of the song end, once reached. */
  endCtx: number | null;
  done: boolean;
  readonly sourceCounts: Record<InputSource, number>;
  readonly sectionUpdates: SectionUpdate[];
}

const EMPTY_STATE: JudgeState = {
  score: 0,
  combo: 0,
  maxCombo: 0,
  multiplier: 1,
  counts: { Perfect: 0, Great: 0, Good: 0, WrongNote: 0, Miss: 0 },
  judgedNotes: 0,
  accuracy: 0,
  timingScore: 0,
  lenientChordNotes: 0,
};

/** Default ticker: `setInterval` (keeps running at ~1 Hz in a hidden tab). */
function intervalTicker(): SessionTicker {
  let id: ReturnType<typeof setInterval> | null = null;
  return {
    start(tick) {
      if (id === null) id = setInterval(tick, SESSION_TICK_MS);
    },
    stop() {
      if (id !== null) clearInterval(id);
      id = null;
    },
  };
}

const clampSpeed = (s: number): number => Math.min(SESSION_SPEED_MAX, Math.max(SESSION_SPEED_MIN, Math.round(s * 100) / 100));
const pct = (s: number): string => `${Math.round(s * 100)}%`;

/** A running game; see the module doc. */
export class GameSessionImpl implements GameSession {
  readonly song: Song;
  readonly mode: RunMode;
  readonly songId: string;
  readonly arrangement: number;
  readonly title: string;
  readonly artist: string | null;
  /** The result of the last finished run (set before `onRunEnd` fires). */
  lastResult: RunResult | null = null;

  private readonly deps: SessionDeps;
  private readonly engine: SessionEngine;
  private readonly lanes: LaneIndex;
  private readonly book: SectionProgressBook;
  private readonly ticker: SessionTicker;
  private readonly now: () => number;
  private readonly unsubs: Unsubscribe[] = [];
  private readonly judgementListeners = new Set<(j: Judgement) => void>();
  private readonly strayListeners = new Set<(s: StrayEvent) => void>();
  private readonly messageListeners = new Set<(m: PracticeMessage) => void>();
  private readonly stateListeners = new Set<(s: SessionState) => void>();
  private readonly runEndListeners = new Set<(summary: RunSummary, runId: number | null) => void>();
  private _state: SessionState = 'ready';
  private run: Run | null = null;
  private lastJudgeState: JudgeState = EMPTY_STATE;
  /** Judgements of the current (or last) run, for the test hook. */
  private runLog: Judgement[] = [];
  private barLoop: BarLoop | null = null;
  private _speedTrainer: boolean;
  private _countInBars: number;
  private _metronome: boolean;
  private guideMutedOverride: boolean | null = null;
  private trainer: TrainerState;
  private readonly testQueue: TestInjection[] = [];
  private expectRange: MidiRange | null = null;
  private lastExpectAt = -Infinity;
  private hasEnded = false;
  private disposed = false;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.song = deps.song;
    this.mode = deps.mode;
    this.songId = deps.songId;
    this.arrangement = deps.arrangement;
    this.title = deps.title;
    this.artist = deps.artist;
    this.engine = deps.engine;
    this.lanes = laneIndex(deps.song);
    this.ticker = deps.ticker ?? intervalTicker();
    this.now = deps.now ?? Date.now;
    this._speedTrainer = deps.speedTrainer;
    this._countInBars = deps.settings.get().practice.countInBars;
    this._metronome = deps.settings.get().practice.metronome;
    this.trainer = { speed: deps.speed, failStreak: 0 };
    this.book = new SectionProgressBook(
      deps.storage,
      {
        songId: deps.songId,
        arrangement: deps.arrangement,
        sessionId: deps.sessionId,
        comfortTier: deps.comfortTier,
        sectionTier: (idx) => this.sectionTier(idx),
        sectionName: (idx) => this.sectionName(idx),
      },
      deps.sectionProgress,
    );

    const t = this.engine.transport;
    t.stop();
    t.load({ durationSec: this.song.meta.durationSec, bars: this.song.timing.bars });
    t.setSpeed(clampSpeed(deps.speed));
    if (deps.loopSection !== undefined) {
      const section = this.song.sections[deps.loopSection];
      if (section) this.setLoopBars(section.startBar, section.endBar);
    }
    this.unsubs.push(t.onChange((c) => this.onClockChange(c)));
    this.unsubs.push(t.onEnded(() => this.onEnded()));
    let prevMetronome = this._metronome;
    this.unsubs.push(
      deps.settings.subscribe((s) => {
        // The engine follows `practice.metronome`; mirror it.
        if (s.practice.metronome !== prevMetronome) this._metronome = s.practice.metronome;
        prevMetronome = s.practice.metronome;
        this.applyGuideMute();
      }),
    );
    if (deps.input) this.unsubs.push(deps.input.onInput((ev) => this.input(ev)));
    this.applyGuideMute();
    this.ticker.start(() => this.tick());
  }

  // -------------------------------------------------------------------------------------------
  // GameSession: read-only state
  // -------------------------------------------------------------------------------------------

  get state(): SessionState {
    return this._state;
  }

  get clock(): SongClock {
    return this.engine.clock;
  }

  get transport(): Transport {
    return this.engine.transport;
  }

  get speed(): number {
    return this.engine.transport.speed;
  }

  get loop(): TransportLoop | null {
    return this.engine.transport.loop;
  }

  get speedTrainer(): boolean {
    return this._speedTrainer;
  }

  /** The bar loop in effect, or null. */
  get barLoopRange(): BarLoop | null {
    return this.barLoop;
  }

  /** True while a guitar input feeds the judge. */
  get hasGuitar(): boolean {
    return this.deps.input !== null;
  }

  /** True while a run is in progress (from `play()` until its results). */
  get running(): boolean {
    return this.run !== null && !this.run.done;
  }

  get countInBars(): number {
    return this._countInBars;
  }

  get metronome(): boolean {
    return this._metronome;
  }

  get trainerState(): TrainerState {
    return { ...this.trainer };
  }

  judgeState(): JudgeState {
    return this.run ? this.run.judge.state() : this.lastJudgeState;
  }

  /** Every judgement emitted in the current (or last) run, provisional ones included. */
  judgements(): readonly Judgement[] {
    return this.runLog;
  }

  // -------------------------------------------------------------------------------------------
  // GameSession: controls
  // -------------------------------------------------------------------------------------------

  play(): void {
    if (this.disposed || this._state === 'error') return;
    if (this.run === null) {
      this.startRun();
      return;
    }
    if (this._state === 'paused') {
      this.engine.transport.play({ countInBars: this._countInBars });
      this.syncState();
    }
  }

  pause(): void {
    if (this.run && !this.run.done && this.engine.transport.state !== 'paused' && this.engine.transport.state !== 'stopped') {
      this.engine.transport.pause();
      this.syncState();
    }
  }

  restart(): void {
    if (this.disposed) return;
    this.discardRun();
    this.engine.transport.stop();
    this.startRun();
  }

  seek(songTime: number): void {
    if (!Number.isFinite(songTime)) return;
    this.engine.transport.seek(Math.max(0, Math.min(songTime, this.song.meta.durationSec)));
    this.syncState();
  }

  async setSpeed(speed: number): Promise<void> {
    const s = clampSpeed(speed);
    let ready: Promise<void> | undefined;
    if (this.deps.guide) {
      ready = this.deps.guide.setSpeed(s);
      // Rejections are reported below; keep an unhandled-rejection guard for the transport's copy.
      ready.catch(() => undefined);
    }
    this.engine.transport.setSpeed(s, ready ? { ready } : {});
    this.refreshLoopPreroll(s);
    if (!ready) return;
    try {
      await ready;
    } catch (err) {
      if (err instanceof Error && err.name === 'GuideSupersededError') return;
      this.emitMessage({ kind: 'info', text: `Couldn't prepare the guide at ${pct(s)}; keeping the current speed.` });
    }
  }

  setLoopBars(startBar: number, endBar: number): void {
    const n = this.song.timing.bars.length;
    if (n === 0) return;
    const a = Math.min(Math.max(Math.round(startBar), 0), n - 1);
    const b = Math.min(Math.max(Math.round(endBar), a + 1), n);
    this.barLoop = { startBar: a, endBar: b };
    if (this.run) this.run.hadLoop = true;
    this.engine.transport.setLoop(toTransportLoop(this.song, this.barLoop, this.speed));
    this.applyRegionToCurrentPass();
    const section = this.loopSectionIdx();
    const label = section !== null ? this.sectionName(section) : `bars ${a + 1}–${b}`;
    if (section !== null && this._speedTrainer && !this.run) this.trainer = this.trainerFor(section);
    this.emitMessage({ kind: 'loop', text: `Looping ${label}` });
  }

  clearLoop(): void {
    if (!this.barLoop && !this.engine.transport.loop) return;
    this.barLoop = null;
    this.engine.transport.setLoop(null);
    this.applyRegionToCurrentPass();
    this.emitMessage({ kind: 'loop', text: 'Loop off' });
  }

  setSpeedTrainer(on: boolean): void {
    this._speedTrainer = on;
    const section = this.loopSectionIdx();
    if (on && section !== null) this.trainer = this.trainerFor(section);
  }

  setCountInBars(bars: number): void {
    this._countInBars = Math.min(2, Math.max(0, Math.round(bars)));
  }

  setMetronome(on: boolean): void {
    this._metronome = on;
    this.engine.transport.setMetronome(on);
  }

  setGuideMuted(muted: boolean): void {
    this.guideMutedOverride = muted;
    this.applyGuideMute();
  }

  // -------------------------------------------------------------------------------------------
  // Listeners
  // -------------------------------------------------------------------------------------------

  onJudgement(cb: (j: Judgement) => void): Unsubscribe {
    this.judgementListeners.add(cb);
    return () => this.judgementListeners.delete(cb);
  }

  onStray(cb: (s: StrayEvent) => void): Unsubscribe {
    this.strayListeners.add(cb);
    return () => this.strayListeners.delete(cb);
  }

  onMessage(cb: (m: PracticeMessage) => void): Unsubscribe {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  onStateChange(cb: (s: SessionState) => void): Unsubscribe {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onRunEnd(cb: (summary: RunSummary, runId: number | null) => void): Unsubscribe {
    this.runEndListeners.add(cb);
    return () => this.runEndListeners.delete(cb);
  }

  // -------------------------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------------------------

  /** Feed an input event (guitar, keyboard and test hook all arrive here). Ignored outside a run. */
  input(ev: InputEvent): void {
    const run = this.run;
    if (!run || run.done) return;
    run.sourceCounts[ev.source]++;
    this.dispatch(run, run.judge.push(ev));
  }

  /**
   * Keyboard mode (D6): a lane key press at `timeStampMs` (`performance.now()` clock) becomes an
   * onset in the heard domain minus the keyboard calibration offset, pitched like the nearest note
   * on that lane (Shift: +1 semitone). Returns the event fed to the judge (null outside a run).
   */
  keyPress(press: LanePress): InputEvent | null {
    if (!this.run || this.run.done) return null;
    const offsetMs = this.deps.settings.get().calibration.keyboardOffsetMs;
    const ctxTime = this.engine.perfToCtxTime(press.timeStampMs) - offsetMs / 1000;
    const songTime = this.engine.clock.songTimeAt(ctxTime);
    const midi = laneMidi(this.song, this.lanes, press.lane, songTime, this.run.windows.good * this.speed, press.wrongPitch);
    const ev: InputEvent = { ctxTime, kind: 'onset', midi, cents: 0, clarity: 1, source: 'keyboard' };
    this.input(ev);
    return ev;
  }

  /**
   * e2e hook: an event on `lane` at exactly `songTime` in the current pass, through the same judge
   * path (`source: 'test'`). It is queued until the pass reaches that time (immediately when it
   * already has), so a test can script a whole song up front.
   */
  injectTest(args: TestInjection): void {
    if (!Number.isFinite(args.songTime)) throw new RangeError('inject: songTime must be finite');
    let i = this.testQueue.length;
    while (i > 0 && (this.testQueue[i - 1] as TestInjection).songTime > args.songTime) i--;
    this.testQueue.splice(i, 0, { ...args });
    this.flushTestQueue(this.engine.ctx.currentTime);
  }

  // -------------------------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------------------------

  /** End the run now and save it ("End run" in practice): resolves with the result. */
  async finish(): Promise<RunResult | null> {
    return this.finalize('finished');
  }

  /** Quit the run without scoring it (active time is still recorded). */
  async quit(): Promise<void> {
    await this.finalize('quit');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.run && !this.run.done) await this.finalize('quit');
    this.disposed = true;
    this.ticker.stop();
    for (const u of this.unsubs.splice(0)) u();
    this.engine.transport.stop();
    this.deps.input?.expect(null);
    this.judgementListeners.clear();
    this.strayListeners.clear();
    this.messageListeners.clear();
    this.stateListeners.clear();
    this.runEndListeners.clear();
    await this.deps.onDispose?.();
  }

  /** One timer tick: test injections, active time, `advance(horizon)`, pass evaluations, song end, hints. */
  tick(): void {
    if (this.disposed) return;
    const now = this.engine.ctx.currentTime;
    this.flushTestQueue(now);
    const run = this.run;
    if (run && !run.done) {
      const ts = this.engine.transport.state;
      if (ts === 'playing' || ts === 'count-in') run.activeSec += Math.min(0.5, Math.max(0, now - run.lastCtx));
      run.lastCtx = now;
      const horizon = this.horizon(now);
      this.dispatch(run, run.judge.advance(horizon));
      this.evaluatePasses(run, horizon);
      if (run.endCtx !== null && horizon >= run.endCtx + run.windows.good + SETTLE_MARGIN_SEC) void this.finalize('completed');
    }
    this.updateExpect(now);
  }

  private startRun(): void {
    const t = this.engine.transport;
    let from: number | undefined;
    if (t.state !== 'stopped') {
      from = this.engine.clock.nowSong();
      t.stop();
    }
    const s = this.deps.settings.get();
    const windows = windowsFor(s.game.timingLeniency);
    const judge = createJudge(this.song, { clock: this.engine.clock, windows, strictOctave: s.game.strictOctave, region: this.region() });
    const now = this.engine.ctx.currentTime;
    this.runLog = [];
    this.hasEnded = false;
    this.lastResult = null;
    this.run = {
      judge,
      windows,
      judgePass: 0,
      judgements: this.runLog,
      strays: 0,
      startedAt: this.now(),
      activeSec: 0,
      lastCtx: now,
      minSpeed: t.speed,
      hadLoop: this.barLoop !== null,
      passSpeed: new Map([[0, t.speed]]),
      passLoop: new Map([[0, this.barLoop]]),
      pendingEvals: [],
      endCtx: null,
      done: false,
      sourceCounts: { guitar: 0, keyboard: 0, test: 0 },
      sectionUpdates: [],
    };
    const section = this.loopSectionIdx();
    if (section !== null && this._speedTrainer) this.trainer = this.trainerFor(section);
    const loop = t.loop;
    if (loop) from = loop.start - loop.preroll;
    t.play({ ...(from !== undefined ? { from } : {}), countInBars: this._countInBars });
    this.syncState();
    const storage = this.deps.storage;
    if (storage) {
      touchSongCache(storage, this.songId, this.deps.entry, this.now()).catch((err: unknown) => console.warn('Riffway: could not update the recent songs', err));
    }
  }

  /** Drop the current run unscored (restart): its active time still counts as practice. */
  private discardRun(): void {
    const run = this.run;
    if (!run || run.done) return;
    run.done = true;
    this.run = null;
    this.recordTimeOnly(run);
  }

  private recordTimeOnly(run: Run): void {
    const storage = this.deps.storage;
    if (!storage || run.activeSec <= 0) return;
    void recordPracticeTime(storage, this.now(), run.activeSec, 0, this.deps.settings.get().goals.weeklyDays).catch((err: unknown) =>
      console.warn('Riffway: could not save practice time', err),
    );
  }

  private async finalize(kind: RunEnd): Promise<RunResult | null> {
    const run = this.run;
    if (!run || run.done) return null;
    run.done = true;
    const now = this.engine.ctx.currentTime;
    const summary = run.judge.finish(this.horizon(now));
    this.lastJudgeState = run.judge.state();
    this.run = null;
    this.hasEnded = true;
    if (kind !== 'completed') this.engine.transport.stop();
    this.syncState();
    if (kind === 'quit' || summary.judgedNotes === 0) {
      this.recordTimeOnly(run);
      this.emitRunEnd(summary, null);
      return null;
    }
    const completed = kind === 'completed' && !run.hadLoop;
    if (!run.hadLoop) {
      for (const s of completedSections(this.song, run.judgements)) {
        run.sectionUpdates.push(this.book.apply({ sectionIdx: s.idx, accuracy: s.accuracy, clean: s.clean, speed: run.minSpeed, at: this.now() }));
      }
    }
    const endedAt = this.now();
    const inputSource = (['guitar', 'keyboard', 'test'] as const).reduce((a, b) => (run.sourceCounts[b] > run.sourceCounts[a] ? b : a), 'keyboard' as InputSource);
    let saved: SavedRun | null = null;
    if (this.deps.storage) {
      try {
        saved = await persistRun(this.deps.storage, {
          songId: this.songId,
          arrangement: this.arrangement,
          mode: this.mode,
          summary,
          startedAt: run.startedAt,
          endedAt,
          speed: run.minSpeed,
          loop: this.barLoop,
          completed,
          inputSource,
          activeSec: run.activeSec,
          weekTarget: this.deps.settings.get().goals.weeklyDays,
          entry: this.deps.entry,
        });
        await this.book.flush();
      } catch (err) {
        console.error('Riffway: could not save the run', err);
        this.emitMessage({ kind: 'info', text: 'This run could not be saved.' });
      }
    }
    const result: RunResult = {
      runId: saved?.runId ?? null,
      songId: this.songId,
      arrangement: this.arrangement,
      title: this.title,
      artist: this.artist,
      mode: this.mode,
      speed: run.minSpeed,
      loop: this.barLoop,
      completed,
      score: summary.score,
      accuracy: summary.accuracy,
      stars: summary.stars,
      maxCombo: summary.maxCombo,
      counts: summary.counts,
      judgedNotes: summary.judgedNotes,
      histogram: summary.histogram,
      sections: summary.sections.map((s) => ({ ...s, name: this.sectionName(s.idx) })),
      weakestSection: summary.weakestSection,
      clean: summary.clean,
      timingScore: summary.timingScore,
      lenientChordNotes: summary.lenientChordNotes,
      strays: summary.strays,
      inputSource,
      activeSec: run.activeSec,
      endedAt,
      best: saved?.best ?? null,
      newBest: saved?.newBest ?? false,
      previousBestScore: saved?.previousBestScore ?? null,
      sectionUpdates: run.sectionUpdates,
    };
    this.lastResult = result;
    rememberResult(result);
    this.emitRunEnd(summary, result.runId);
    return result;
  }

  // -------------------------------------------------------------------------------------------
  // Transport events
  // -------------------------------------------------------------------------------------------

  private onClockChange(change: ClockChange): void {
    const run = this.run;
    if (run && !run.done) {
      if (change.pass !== run.judgePass) {
        const prev = run.judgePass;
        run.judge.startPass({ pass: change.pass, region: this.region() });
        run.judgePass = change.pass;
        run.passLoop.set(change.pass, this.barLoop);
        if (change.reason === 'loop-wrap' && run.passLoop.get(prev)) {
          run.pendingEvals.push({ pass: prev, at: change.anchor.anchorCtxTime + run.windows.good + SETTLE_MARGIN_SEC });
        }
      }
      const speed = change.anchor.speed;
      if (speed > 0 && change.state !== 'paused' && change.state !== 'stopped') {
        run.passSpeed.set(change.pass, speed);
        run.minSpeed = Math.min(run.minSpeed, speed);
      }
    }
    this.syncState();
  }

  private onEnded(): void {
    const run = this.run;
    if (run && !run.done && run.endCtx === null) run.endCtx = this.engine.ctx.currentTime;
  }

  /** Apply the current loop region to the pass in progress (`setLoop` keeps the pass). */
  private applyRegionToCurrentPass(): void {
    const run = this.run;
    if (!run || run.done) return;
    run.hadLoop = run.hadLoop || this.barLoop !== null;
    run.passLoop.set(run.judgePass, this.barLoop);
    run.judge.startPass({ pass: run.judgePass, region: this.region() });
  }

  private region(): { start: number; end: number } | null {
    const loop = this.engine.transport.loop;
    return loop ? { start: loop.start, end: loop.end } : null;
  }

  /** The loop's pre-roll depends on speed (2 bars below 60%): re-apply it when it changes. */
  private refreshLoopPreroll(speed: number): void {
    if (!this.barLoop) return;
    const next = toTransportLoop(this.song, this.barLoop, speed);
    const cur = this.engine.transport.loop;
    if (!cur || Math.abs(cur.preroll - next.preroll) > 1e-9) this.engine.transport.setLoop(next);
  }

  // -------------------------------------------------------------------------------------------
  // Practice: per-pass evaluation (speed trainer, section progress)
  // -------------------------------------------------------------------------------------------

  private evaluatePasses(run: Run, horizon: number): void {
    while (run.pendingEvals.length > 0 && horizon >= (run.pendingEvals[0] as { at: number }).at) {
      const { pass } = run.pendingEvals.shift() as { pass: number };
      const stats = passStats(run.judgements, pass);
      if (stats.judgedNotes === 0) continue;
      const speed = run.passSpeed.get(pass) ?? this.speed;
      const loop = run.passLoop.get(pass) ?? null;
      const section = loop ? this.sectionOfLoop(loop) : null;
      let failStreak = this.trainer.failStreak;
      if (section !== null) failStreak = this.book.get(section)?.trainer.failStreak ?? 0;
      const step = trainerStep({ speed, failStreak }, stats.accuracy, stats.clean);
      let nextSpeed = step.state.speed;
      if (section !== null) {
        const update = this.book.apply({ sectionIdx: section, accuracy: stats.accuracy, clean: stats.clean, speed, at: this.now() });
        run.sectionUpdates.push(update);
        nextSpeed = update.nextSpeed;
        for (const ev of update.events) {
          if (ev === 'mastered' || ev === 'locked-in' || ev === 'check-failed') this.emitMessage({ kind: 'info', text: sectionEventText(update.name, ev) });
          if (ev === 'plateau') this.emitMessage({ kind: 'plateau', text: sectionEventText(update.name, ev) });
        }
      }
      this.trainer = { speed: nextSpeed, failStreak: step.state.failStreak };
      this.emitMessage({ kind: 'loop', text: `Loop: ${Math.round(stats.accuracy)}%${stats.clean ? ' · clean' : ''} at ${pct(speed)}` });
      if (this._speedTrainer) {
        if (step.message) this.emitMessage({ kind: 'trainer', text: step.message });
        if (Math.abs(nextSpeed - this.speed) > 1e-6) void this.setSpeed(nextSpeed);
      }
    }
  }

  /** Trainer state to start a section loop with: stored progress, else the tier-based start. */
  private trainerFor(section: number): TrainerState {
    const stored = this.book.get(section);
    if (stored) return { ...stored.trainer };
    return initialTrainerState(this.sectionTier(section), this.deps.comfortTier);
  }

  private loopSectionIdx(): number | null {
    return this.barLoop ? this.sectionOfLoop(this.barLoop) : null;
  }

  /** The section a bar loop covers exactly, else null. */
  private sectionOfLoop(loop: BarLoop): number | null {
    const idx = this.song.sections.findIndex((s) => s.startBar === loop.startBar && s.endBar === loop.endBar);
    return idx >= 0 ? idx : null;
  }

  private sectionTier(idx: number): number {
    const report = this.deps.difficulty;
    const sec = report?.sections.find((s) => s.sectionIndex === idx);
    return sec?.tier ?? report?.tier ?? this.deps.comfortTier;
  }

  /** Display name of a section ("Section 3" when unnamed). */
  sectionName(idx: number): string {
    const name = this.song.sections[idx]?.name?.trim();
    return name ? name : `Section ${idx + 1}`;
  }

  /** Section index at a song time (−1 before the first). */
  sectionAtTime(songTime: number): number {
    return sectionAt(this.song, songTime);
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /** Earliest input horizon of the active sources (docs/game-mechanics.md § Driving the judge). */
  private horizon(now: number): number {
    const cal = this.deps.settings.get().calibration;
    let h = inputHorizon(now, 'keyboard', cal.keyboardOffsetMs, this.engine.ctx.outputLatency ?? 0);
    if (this.deps.input) h = Math.min(h, inputHorizon(now, 'guitar', cal.inputOffsetMs));
    return h;
  }

  /**
   * Pass now playing: the transport's (`TransportCore.pass`) when it exposes it, else the judge's.
   * Right after a loop wrap begins the transport is on the new pass up to one scheduler tick before
   * the wrap is announced and the judge switches.
   */
  private playingPass(run: Run): number {
    const p = (this.engine.transport as Transport & { readonly pass?: unknown }).pass;
    return typeof p === 'number' ? Math.max(p, run.judgePass) : run.judgePass;
  }

  private flushTestQueue(now: number): void {
    const run = this.run;
    if (!run || run.done) return;
    const pass = this.playingPass(run);
    // Wait until the judge is on the pass being played (the wrap is announced within one tick).
    if (pass !== run.judgePass) return;
    const clock = this.engine.clock as SongClock & Partial<PassClockMapping>;
    while (this.testQueue.length > 0) {
      const next = this.testQueue[0] as TestInjection;
      const t = clock.ctxTimeInPass ? clock.ctxTimeInPass(next.songTime, pass) : clock.ctxTimeAt(next.songTime);
      if (t === -Infinity) {
        // This pass never plays it (skipped by a seek, or before the pass start).
        this.testQueue.shift();
        continue;
      }
      if (!Number.isFinite(t) || t > now) return;
      this.testQueue.shift();
      const midi = laneMidi(this.song, this.lanes, next.lane, next.songTime, run.windows.good * this.speed, next.wrongPitch ?? false);
      this.input({ ctxTime: t, kind: 'onset', midi, cents: 0, clarity: 1, source: 'test' });
    }
  }

  private updateExpect(now: number): void {
    const input = this.deps.input;
    if (!input || now - this.lastExpectAt < EXPECT_REFRESH_SEC) return;
    this.lastExpectAt = now;
    const range = expectedRangeAt(this.song, this.engine.clock.nowSong());
    if (sameRange(range, this.expectRange)) return;
    this.expectRange = range;
    input.expect(range);
  }

  private applyGuideMute(): void {
    const guide = this.deps.guide;
    if (!guide) return;
    const auto = guideShouldMute(this.deps.settings.get(), this.deps.backing?.link ?? null);
    guide.setMuted(this.guideMutedOverride ?? auto);
  }

  private dispatch(run: Run, out: JudgeOutput): void {
    for (const j of out.judgements) {
      run.judgements.push(j);
      for (const cb of [...this.judgementListeners]) cb(j);
    }
    for (const s of out.strays) {
      run.strays++;
      for (const cb of [...this.strayListeners]) cb(s);
    }
  }

  private syncState(): void {
    let next: SessionState;
    if (this._state === 'error') return;
    const ts = this.engine.transport.state;
    if (this.run && !this.run.done) next = ts === 'stopped' ? this._state : ts;
    else next = this.hasEnded ? 'ended' : 'ready';
    if (next === this._state) return;
    this._state = next;
    for (const cb of [...this.stateListeners]) cb(next);
  }

  private emitMessage(m: PracticeMessage): void {
    for (const cb of [...this.messageListeners]) cb(m);
  }

  private emitRunEnd(summary: RunSummary, runId: number | null): void {
    for (const cb of [...this.runEndListeners]) cb(summary, runId);
  }
}
