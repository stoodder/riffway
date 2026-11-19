/**
 * Session test rig: a fake engine around the REAL `TransportCore` + `SongClock` on a fake context
 * clock, a manual ticker, settings in memory and (optionally) real IndexedDB storage via
 * `fake-indexeddb`. Time advances in 5 ms steps; the transport ticks every 25 ms and the session
 * every 20 ms, like the live timers.
 */
import type { SongClock } from '@shared/clock';
import type { PracticeMessage, RunSummary } from '@shared/judge';
import type { InputService } from '@shared/services';
import { defaultSettings, type DeepPartial, type Settings } from '@shared/settings';
import type { Bar, Note, Section, Song, StringNumber } from '@shared/song';
import type { StorageService } from '@shared/storage';
import { createSongClock } from '../../src/audio/engine/clock';
import { TransportCore } from '../../src/audio/engine/transport';
import { GameSessionImpl, type SessionDeps, type SessionTicker } from '../../src/game/session/core';
import { mergeSettings, openStorage } from '../../src/storage';

export interface NoteSpec {
  time: number;
  string?: StringNumber;
  fret?: number;
  chordId?: number;
}

/**
 * A 4/4 song at 120 BPM (2 s bars), standard tuning. `midi` follows `tuning + fret`.
 * Sections `[name, startBar, endBar]`.
 */
export function makeSong(specs: NoteSpec[], opts: { bars: number; sections?: [string, number, number][]; capo?: number }): Song {
  const tuning = [64, 59, 55, 50, 45, 40];
  const capo = opts.capo ?? 0;
  const bars: Bar[] = Array.from({ length: opts.bars }, (_, i) => ({
    index: i,
    time: i * 2,
    dur: 2,
    num: 4,
    den: 4,
    beats: [0, 0.5, 1, 1.5].map((b) => i * 2 + b),
  }));
  const sorted = [...specs].sort((a, b) => a.time - b.time || (a.string ?? 1) - (b.string ?? 1));
  const notes: Note[] = sorted.map((s, id) => {
    const string = s.string ?? 1;
    const fret = s.fret ?? 0;
    const n: Note = {
      id,
      time: s.time,
      dur: 0.2,
      string,
      fret,
      midi: (tuning[string - 1] as number) + capo + fret,
      bar: Math.min(opts.bars - 1, Math.floor(s.time / 2)),
      tech: {},
    };
    if (s.chordId !== undefined) n.chordId = s.chordId;
    return n;
  });
  const sections: Section[] = (opts.sections ?? [['Whole', 0, opts.bars]]).map(([name, startBar, endBar]) => ({
    name,
    startBar,
    endBar,
    start: startBar * 2,
    end: endBar * 2,
  }));
  return {
    schema: 1,
    id: 'test:song',
    arrangement: 0,
    meta: {
      title: 'Test Song',
      source: { source: 'local' },
      tags: { style: [], genre: [], skills: [] },
      tuning,
      capo,
      durationSec: opts.bars * 2,
      rhythm: 'exact',
      tracks: [],
    },
    timing: { tempos: [{ time: 0, bpm: 120 }], bars },
    sections,
    notes,
    chords: [],
  };
}

/** Settings store in memory. */
export class MemorySettings {
  private value: Settings;
  private readonly subs = new Set<(s: Settings) => void>();
  constructor(patch: DeepPartial<Settings> = {}) {
    this.value = mergeSettings(defaultSettings(), { practice: { countInBars: 0 }, ...patch });
  }
  get(): Settings {
    return this.value;
  }
  subscribe(cb: (s: Settings) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  update(patch: DeepPartial<Settings>): void {
    this.value = mergeSettings(this.value, patch);
    for (const cb of this.subs) cb(this.value);
  }
}

/** Ticker driven by the rig. */
export class ManualTicker implements SessionTicker {
  cb: (() => void) | null = null;
  start(tick: () => void): void {
    this.cb = tick;
  }
  stop(): void {
    this.cb = null;
  }
}

/** Fake guide recording calls. */
export class FakeGuide {
  muted = false;
  speeds: number[] = [];
  setSpeed(speed: number): Promise<void> {
    this.speeds.push(speed);
    return Promise.resolve();
  }
  setMuted(m: boolean): void {
    this.muted = m;
  }
}

/** Fake guitar input: emit calibrated events, record `expect` hints. */
export class FakeInput {
  readonly hints: ({ minMidi: number; maxMidi: number } | null)[] = [];
  private cb: Parameters<InputService['onInput']>[0] | null = null;
  onInput(cb: Parameters<InputService['onInput']>[0]): () => void {
    this.cb = cb;
    return () => {
      this.cb = null;
    };
  }
  expect(range: { minMidi: number; maxMidi: number } | null): void {
    this.hints.push(range);
  }
  emit(ctxTime: number, midi: number): void {
    this.cb?.({ ctxTime, kind: 'onset', midi, cents: 0, clarity: 0.9, source: 'guitar' });
  }
}

export interface RigOptions {
  song: Song;
  settings?: DeepPartial<Settings>;
  storage?: StorageService | null;
  deps?: Partial<SessionDeps>;
  speed?: number;
}

/** A session on a real transport with a fake context clock. */
export class Rig {
  readonly clock = { t: 100 };
  readonly core: TransportCore;
  readonly songClock: SongClock;
  readonly ticker = new ManualTicker();
  readonly settings: MemorySettings;
  readonly session: GameSessionImpl;
  readonly messages: PracticeMessage[] = [];
  readonly runEnds: { summary: RunSummary; runId: number | null }[] = [];
  private nextTransportTick: number;
  private nextSessionTick: number;
  wall = Date.UTC(2026, 10, 19, 18, 0, 0);

  constructor(opts: RigOptions) {
    this.settings = new MemorySettings(opts.settings);
    this.core = new TransportCore(
      { now: () => this.clock.t, clicks: { schedule: () => ({ cancel: () => undefined }) } },
      { countInBars: this.settings.get().practice.countInBars },
    );
    this.songClock = createSongClock(
      this.core,
      { now: () => this.clock.t, outputTimestamp: () => null, perfNow: () => this.clock.t * 1000, outputDelay: () => 0 },
      () => 0,
    );
    const clock = this.clock;
    const engine = {
      clock: this.songClock,
      transport: this.core,
      perfToCtxTime: (ms: number) => ms / 1000,
      ctx: {
        get currentTime() {
          return clock.t;
        },
        outputLatency: 0,
      },
    };
    this.session = new GameSessionImpl({
      song: opts.song,
      songId: 'test:song',
      arrangement: 0,
      mode: 'play',
      title: 'Test Song',
      artist: null,
      engine,
      settings: this.settings,
      storage: opts.storage ?? null,
      guide: null,
      backing: null,
      input: null,
      difficulty: null,
      entry: null,
      comfortTier: 2,
      sectionProgress: [],
      sessionId: 'session-1',
      speed: opts.speed ?? 1,
      speedTrainer: false,
      ticker: this.ticker,
      now: () => this.wall + (this.clock.t - 100) * 1000,
      ...opts.deps,
    });
    this.session.onMessage((m) => this.messages.push(m));
    this.session.onRunEnd((summary, runId) => this.runEnds.push({ summary, runId }));
    this.nextTransportTick = this.clock.t;
    this.nextSessionTick = this.clock.t;
  }

  /** Advance the fake clock by `sec`, ticking transport (25 ms) and session (20 ms). */
  advance(sec: number): void {
    const end = this.clock.t + sec;
    while (this.clock.t < end - 1e-9) {
      this.clock.t = Math.min(end, this.clock.t + 0.005);
      if (this.clock.t >= this.nextTransportTick) {
        this.core.tick();
        this.nextTransportTick += 0.025;
      }
      if (this.clock.t >= this.nextSessionTick) {
        this.ticker.cb?.();
        this.nextSessionTick += 0.02;
      }
    }
  }

  /** Advance until `pred()` or `maxSec` elapsed. */
  until(pred: () => boolean, maxSec = 60): void {
    const end = this.clock.t + maxSec;
    while (!pred() && this.clock.t < end) this.advance(0.005);
  }

  /** Context time at which the current pass plays song time `t`. */
  ctxOf(songTime: number): number {
    return this.core.ctxTimeInPass(songTime, this.core.pass);
  }
}

/** Real IndexedDB storage on `fake-indexeddb` (import `fake-indexeddb/auto` in the test file). */
export function testStorage(): ReturnType<typeof openStorage> {
  return openStorage({ dbName: `riffway-session-${Math.random().toString(36).slice(2)}` });
}

/** Wait for queued promise callbacks (saves). */
export async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
