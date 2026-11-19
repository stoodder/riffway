/**
 * Test helpers for the practice and mixer panels (T-032): a 16-bar song, a fake `GameSession`
 * (no audio; records calls), an in-memory settings store and an `AppContext` stub.
 */
import { vi } from 'vitest';
import type { ClockChange, TransportLoop, Unsubscribe } from '@shared/clock';
import type { PracticeMessage } from '@shared/judge';
import type { AudioEngine, GameSession, SessionState } from '@shared/services';
import { DEFAULT_SETTINGS, type DeepPartial, type Settings } from '@shared/settings';
import type { Bar, Section, Song } from '@shared/song';
import type { SectionProgress } from '@shared/storage';
import type { AppContext, ServiceMap } from '@shared/ui';
import { toTransportLoop } from '@core/practice';

/** 4/4 bars of `barSec` seconds; sections as `[name, startBar, endBar]`. */
export function makeSong(barCount = 16, sections: [string, number, number][] = [['Intro', 0, 4], ['Verse', 4, 8], ['Chorus', 8, 12], ['Outro', 12, 16]], barSec = 2): Song {
  const bars: Bar[] = Array.from({ length: barCount }, (_, i) => ({
    index: i,
    time: i * barSec,
    dur: barSec,
    num: 4,
    den: 4,
    beats: [0, 1, 2, 3].map((b) => i * barSec + (b * barSec) / 4),
  }));
  const secs: Section[] = sections.map(([name, startBar, endBar]) => ({ name, startBar, endBar, start: startBar * barSec, end: endBar * barSec }));
  return {
    schema: 1,
    id: 'starter:test',
    arrangement: 0,
    meta: { durationSec: barCount * barSec },
    timing: { bars },
    sections: secs,
    notes: [],
    chords: [],
  } as unknown as Song;
}

/** A controllable fake session. */
export interface FakeSession extends GameSession {
  heard: number;
  /** When set, `setSpeed` waits for `resolveSpeed()`. */
  holdSpeed: boolean;
  resolveSpeed(): void;
  rejectSpeed(err: Error): void;
  emitMessage(m: PracticeMessage): void;
  emitState(s: SessionState): void;
  /** Settable trainer fail streak (`trainerState.failStreak`). */
  failStreak: number;
  calls: {
    setSpeed: ReturnType<typeof vi.fn>;
    setLoopBars: ReturnType<typeof vi.fn>;
    clearLoop: ReturnType<typeof vi.fn>;
    setSpeedTrainer: ReturnType<typeof vi.fn>;
    setCountInBars: ReturnType<typeof vi.fn>;
    setMetronome: ReturnType<typeof vi.fn>;
    setGuideMuted: ReturnType<typeof vi.fn>;
  };
}

export function fakeSession(
  song: Song = makeSong(),
  init: { speed?: number; trainer?: boolean; state?: SessionState; countInBars?: number; metronome?: boolean } = {},
): FakeSession {
  const messageSubs = new Set<(m: PracticeMessage) => void>();
  const stateSubs = new Set<(s: SessionState) => void>();
  const clockSubs = new Set<(c: ClockChange) => void>();
  const sub = <T>(set: Set<T>, cb: T): Unsubscribe => {
    set.add(cb);
    return () => set.delete(cb);
  };
  let speed = init.speed ?? 1;
  let loop: TransportLoop | null = null;
  let trainer = init.trainer ?? false;
  let state: SessionState = init.state ?? 'playing';
  let countInBars = init.countInBars ?? 1;
  let metronome = init.metronome ?? true;
  let pendingSpeed: { resolve: () => void; reject: (e: Error) => void } | null = null;
  const self = {
    heard: 0,
    holdSpeed: false,
    failStreak: 0,
  } as FakeSession;
  const calls = {
    setSpeed: vi.fn((s: number): Promise<void> => {
      if (!self.holdSpeed) {
        speed = s;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        pendingSpeed = {
          resolve: () => {
            speed = s;
            resolve();
          },
          reject,
        };
      });
    }),
    setLoopBars: vi.fn((a: number, b: number) => {
      loop = toTransportLoop(song, { startBar: a, endBar: b }, speed);
    }),
    clearLoop: vi.fn(() => {
      loop = null;
    }),
    setSpeedTrainer: vi.fn((on: boolean) => {
      trainer = on;
    }),
    setCountInBars: vi.fn((bars: number) => {
      countInBars = bars;
    }),
    setMetronome: vi.fn((on: boolean) => {
      metronome = on;
    }),
    setGuideMuted: vi.fn(),
  };
  const clock = {
    state: 'playing',
    get speed() {
      return speed;
    },
    anchor: { anchorCtxTime: 0, anchorSongTime: 0, speed },
    nowCtx: () => 0,
    nowSong: () => self.heard,
    heardSongTime: () => self.heard,
    songTimeAt: (t: number) => t,
    ctxTimeAt: (t: number) => t,
    onChange: (cb: (c: ClockChange) => void) => sub(clockSubs, cb),
  };
  Object.assign(self, {
    song,
    mode: 'practice',
    clock,
    transport: {},
    judgeState: () => ({}),
    play: vi.fn(),
    pause: vi.fn(),
    restart: vi.fn(),
    seek: vi.fn(),
    setSpeed: calls.setSpeed,
    setLoopBars: calls.setLoopBars,
    clearLoop: calls.clearLoop,
    setSpeedTrainer: calls.setSpeedTrainer,
    setCountInBars: calls.setCountInBars,
    setMetronome: calls.setMetronome,
    setGuideMuted: calls.setGuideMuted,
    onJudgement: () => () => undefined,
    onStray: () => () => undefined,
    onMessage: (cb: (m: PracticeMessage) => void) => sub(messageSubs, cb),
    onStateChange: (cb: (s: SessionState) => void) => sub(stateSubs, cb),
    onRunEnd: () => () => undefined,
    input: vi.fn(),
    dispose: async () => undefined,
    calls,
    resolveSpeed: () => {
      pendingSpeed?.resolve();
      pendingSpeed = null;
    },
    rejectSpeed: (err: Error) => {
      pendingSpeed?.reject(err);
      pendingSpeed = null;
    },
    emitMessage: (m: PracticeMessage) => messageSubs.forEach((cb) => cb(m)),
    emitState: (s: SessionState) => {
      state = s;
      stateSubs.forEach((cb) => cb(s));
    },
  });
  Object.defineProperties(self, {
    speed: { get: () => speed },
    loop: { get: () => loop },
    speedTrainer: { get: () => trainer },
    state: { get: () => state },
    countInBars: { get: () => countInBars },
    metronome: { get: () => metronome },
    trainerState: { get: () => ({ speed, failStreak: self.failStreak }) },
  });
  return self;
}

/** Deep merge for settings patches (arrays replaced whole). */
function merge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : v;
  }
  return out as T;
}

/** In-memory `SettingsStore` with a spy on `update`. */
export function memorySettings(initial: DeepPartial<Settings> = {}) {
  const subs = new Set<(s: Settings) => void>();
  const store = {
    current: merge(structuredClone(DEFAULT_SETTINGS) as Settings, initial),
    fail: null as Error | null,
    get: () => store.current,
    update: vi.fn(async (patch: DeepPartial<Settings>) => {
      if (store.fail) throw store.fail;
      store.current = merge(store.current, patch);
      subs.forEach((s) => s(store.current));
      return store.current;
    }),
    replace: async () => undefined,
    subscribe: (cb: (s: Settings) => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
  return store;
}

export type MemorySettings = ReturnType<typeof memorySettings>;

/** An `AppContext` with the given settings, section progress and peekable services. */
export function makeCtx(opts: { settings?: MemorySettings; progress?: SectionProgress[]; services?: Partial<ServiceMap> } = {}) {
  const settings = opts.settings ?? memorySettings();
  const toast = vi.fn();
  const services = opts.services ?? {};
  const ctx = {
    settings,
    storage: { getSectionProgress: vi.fn(async () => opts.progress ?? []) },
    services: {
      get: async (id: keyof ServiceMap) => services[id],
      peek: (id: keyof ServiceMap) => services[id] ?? null,
    },
    ui: { toast, confirm: async () => true, requireAudioGesture: async () => undefined },
    flags: { e2e: false, dev: false },
  } as unknown as AppContext;
  return { ctx, settings, toast };
}

/** A fake engine that records `setLevel`. */
export function fakeEngine() {
  const setLevel = vi.fn();
  return { engine: { setLevel } as unknown as AudioEngine, setLevel };
}

/** A section-progress row marked mastered. */
export function mastered(sectionIdx: number): SectionProgress {
  return {
    songId: 'starter:test',
    arrangement: 0,
    sectionIdx,
    cleanRuns: 2,
    cleanRunsAt100: 2,
    lastSpeed: 1,
    trainer: { speed: 1, failStreak: 0 },
    masteredAt: 1,
    bestAccuracy: 100,
    passesSinceGain: 0,
  };
}

export const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Dispatch a keydown on `window` (or on `target`, bubbling). */
export function press(code: string, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}
