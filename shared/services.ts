/**
 * Browser-side service contracts shared across tasks. **Browser-only** (uses Web Audio / DOM
 * types); never import from `server/` or `src/core/`.
 *
 * Services are created lazily through the service registry (`src/app/services.ts`) and reached
 * from screens/panels via `ctx.services.get('<id>')` (see `shared/ui.ts` `ServiceMap`).
 *
 * | Service | Implemented by | Factory module |
 * |---|---|---|
 * | `engine` ({@link AudioEngine}) | T-016 | `src/audio/engine/index.ts` |
 * | `input` ({@link InputService}) | T-022 | `src/audio/input/index.ts` |
 * | `monitor` ({@link MonitorService}) | T-023 | `src/audio/monitor/index.ts` |
 * | `guide` ({@link GuideService}) | T-021 | `src/audio/guide/index.ts` |
 * | `songLoader` ({@link SongLoader}) | T-021 | `src/audio/guide/index.ts` |
 * | `backing` ({@link BackingService}) | T-027 | `src/audio/backing/index.ts` |
 * | {@link GameSession} (per game, not a service) | T-031 | `src/game/session/index.ts` |
 * | {@link Highway} (per game) | T-024 | `src/game/highway/index.ts` |
 * @module
 */
import type { AnalysisEvent, AmpParams } from './audio-events';
import type { ScheduledSource, SongClock, Transport, TransportLoop, Unsubscribe } from './clock';
import type { InputEvent, Judgement, JudgeState, PracticeMessage, RunSummary, StrayEvent } from './judge';
import type { AmpPresetId, MixerLevels } from './settings';
import type { HandPositionAnalysis, Song, SongBundle } from './song';
import type { AudioLink, RunMode } from './storage';

/** Mixer buses (docs/monitoring.md): each is a `GainNode` → master → safety limiter → destination. */
export type MixerBus = keyof MixerLevels;

/** Options for `createEngine()`. */
export interface EngineOptions {
  /** Match the input device's sample rate so Chrome does not resample (default 48000). */
  sampleRate?: number;
  /** Output device (`setSinkId`); `''` = default. */
  sinkId?: string;
}

/** The audio engine (T-016): one `AudioContext`, clock, transport, scheduler, metronome, mixer. */
export interface AudioEngine {
  /** Created with `{latencyHint: 0, sampleRate}`. */
  readonly ctx: AudioContext;
  readonly clock: SongClock;
  readonly transport: Transport;
  /** Connect sources to these (`monitor`, `backing`, `guide`, `metronome`); `master` feeds the limiter. */
  readonly buses: Readonly<Record<MixerBus, GainNode>>;
  /** Resume the context (call from a user gesture). Resolves when running. */
  resume(): Promise<void>;
  /** True once the context is running. */
  readonly running: boolean;
  /** Recreate the context at another sample rate (input device changed). Re-wires buses; sources must reconnect. */
  setSampleRate(sampleRate: number): Promise<void>;
  setSinkId(sinkId: string): Promise<void>;
  /** Bus level 0–1 (persisted by the caller). Mute = 0; never disconnects. */
  setLevel(bus: MixerBus, level: number): void;
  /** Long-audio hook: re-issued on play, seek, speed change and loop wrap. */
  registerScheduledSource(source: ScheduledSource): Unsubscribe;
  /** Map `performance.now()`-based event timestamps to ctx time (keyboard events, docs/timing.md). */
  perfToCtxTime(perfTimeMs: number): number;
  /** Fired when the context is recreated (sample-rate change); reconnect nodes. */
  onContextChange(cb: (ctx: AudioContext) => void): Unsubscribe;
  dispose(): Promise<void>;
}

/** An audio device (input or output). */
export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  groupId: string;
  kind: 'audioinput' | 'audiooutput';
}

/** Result of opening an input (read-back of `track.getSettings()`). */
export interface InputOpenResult {
  device: AudioDeviceInfo;
  sampleRate: number;
  channelCount: number;
  /** `track.getSettings().latency` in s, if reported. */
  latency: number | null;
  /** Processing flags that read back `true` despite the constraints (UI warns). */
  processingWarnings: ('echoCancellation' | 'noiseSuppression' | 'autoGainControl')[];
  /** "Your guitar input wasn't found" fallback happened. */
  fellBackToDefault: boolean;
}

/** Analysis event converted to context seconds (uncalibrated; calibration uses this). */
export type TimedAnalysisEvent = AnalysisEvent & { ctxTime: number };

/** Guitar input (T-022): devices, analysis worklet bridge, level meter and tuner feed. */
export interface InputService {
  listInputs(): Promise<AudioDeviceInfo[]>;
  listOutputs(): Promise<AudioDeviceInfo[]>;
  /** Open (or re-open) an input; default = settings choice, else USB-label match, else default. */
  open(deviceId?: string): Promise<InputOpenResult>;
  close(): void;
  readonly current: InputOpenResult | null;
  /** Source node for monitoring (T-023); null when closed. */
  getInputNode(): AudioNode | null;
  /** Calibrated judge events (`inputOffsetMs` applied). */
  onInput(cb: (ev: InputEvent) => void): Unsubscribe;
  /** Raw analysis events in ctx seconds, **uncalibrated** (level, tuner, onsets for calibration). */
  onAnalysis(cb: (ev: TimedAnalysisEvent) => void): Unsubscribe;
  /** Expected pitch range of upcoming notes (null = E2–E6). */
  expect(range: { minMidi: number; maxMidi: number } | null): void;
  /** Continuous tuner frames on/off. */
  setTunerMode(on: boolean): void;
  /** Fired on `devicechange` and re-open. */
  onDevicesChanged(cb: () => void): Unsubscribe;
}

/** Monitoring latency estimate (docs/monitoring.md). */
export interface LatencyEstimate {
  /** ≈ (input + base + output latency + 128/sr) × 1000. */
  monitorMs: number;
  band: 'great' | 'playable' | 'noticeable';
  /** Calibrated offset, when available ("calibrated offset" label). */
  calibratedOffsetMs: number | null;
  parts: { inputMs: number; baseMs: number; outputMs: number; quantumMs: number };
}

/** Feedback/speaker guard notices. */
export type MonitorGuardEvent =
  | { type: 'speaker-muted'; sinkLabel: string }
  | { type: 'feedback-ducked' }
  | { type: 'restored' };

/** Monitoring + amp sim (T-023). */
export interface MonitorService {
  readonly enabled: boolean;
  setEnabled(on: boolean): Promise<void>;
  setPreset(preset: AmpPresetId): void;
  setParams(params: Partial<AmpParams>): void;
  latency(): LatencyEstimate;
  /** "Turn on anyway" on laptop speakers (persisted per sinkId). */
  allowSpeakers(sinkId: string, allow: boolean): Promise<void>;
  onGuard(cb: (ev: MonitorGuardEvent) => void): Unsubscribe;
}

/** Loads a `Song` in the song worker (same `loadSong` as the server). */
export interface SongLoader {
  load(bundle: SongBundle, arrangement: number): Promise<Song>;
}

/** Guide synth (T-021): offline alphaSynth render scheduled on the guide bus. */
export interface GuideService {
  /** Load a song (bundle is needed for alphaTab sources: MIDI via `MidiFileGenerator`). Renders at `speed`. */
  load(song: Song, bundle: SongBundle, speed: number): Promise<void>;
  /** Re-render at a new speed; resolves when enough is rendered to continue (first ~5 s). */
  setSpeed(speed: number): Promise<void>;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  /** Render progress 0–1 for the current speed. */
  onProgress(cb: (fraction: number) => void): Unsubscribe;
  unload(): void;
}

/** Backing audio (T-027): attach, align (warp anchors), time-stretched playback. */
export interface BackingService {
  /** Upload a file the user owns and create a link with a single zero-offset anchor. */
  attach(file: File, songId: string, arrangement: number): Promise<AudioLink>;
  /** Load the link's audio for playback with the current song. */
  load(link: AudioLink): Promise<void>;
  /** Update anchors/gain (alignment panel); persists the link. */
  update(link: AudioLink): Promise<void>;
  detach(songId: string, arrangement: number): Promise<void>;
  setEnabled(on: boolean): void;
  readonly link: AudioLink | null;
  /** Decoded audio (waveform display). */
  readonly buffer: AudioBuffer | null;
  unload(): void;
}

/** Options for starting a game session (T-031). */
export interface SessionOptions {
  songId: string;
  arrangement: number;
  mode: RunMode;
  /** Initial speed fraction. */
  speed?: number;
  /** Practice: start with this section looped. */
  loopSection?: number;
  /** Speed trainer on (practice). */
  speedTrainer?: boolean;
}

/** Session lifecycle state. */
export type SessionState = 'loading' | 'ready' | 'count-in' | 'playing' | 'paused' | 'ended' | 'error';

/** A running game (T-031). The practice panel (T-032) drives it through this interface. */
export interface GameSession {
  readonly song: Song;
  readonly mode: RunMode;
  readonly state: SessionState;
  readonly clock: SongClock;
  readonly transport: Transport;
  readonly speed: number;
  readonly loop: TransportLoop | null;
  /** Live score/combo/accuracy. */
  judgeState(): JudgeState;
  play(): void;
  pause(): void;
  restart(): void;
  seek(songTime: number): void;
  /** Speed fraction 0.4–1.1 (re-renders the guide; bar-aligned while playing). */
  setSpeed(speed: number): Promise<void>;
  /** Snapped loop over sections/bars; null clears. */
  setLoopBars(startBar: number, endBar: number): void;
  clearLoop(): void;
  setSpeedTrainer(on: boolean): void;
  readonly speedTrainer: boolean;
  setCountInBars(bars: number): void;
  setMetronome(on: boolean): void;
  setGuideMuted(muted: boolean): void;
  onJudgement(cb: (j: Judgement) => void): Unsubscribe;
  onStray(cb: (s: StrayEvent) => void): Unsubscribe;
  onMessage(cb: (m: PracticeMessage) => void): Unsubscribe;
  onStateChange(cb: (s: SessionState) => void): Unsubscribe;
  /** Fired at song end / quit with the saved run id. */
  onRunEnd(cb: (summary: RunSummary, runId: number | null) => void): Unsubscribe;
  /** Feed an input event (keyboard mode / test hook use the same path as the guitar). */
  input(ev: InputEvent): void;
  dispose(): Promise<void>;
}

/** Highway options (T-024). */
export interface HighwayOptions {
  /** Scroll speed multiplier (settings `game.noteSpeed`). */
  noteSpeed: number;
  handCues: boolean;
  /** Precomputed positions/cues (T-013 `computePositions`). */
  positions?: HandPositionAnalysis;
  /** Loop region to shade. */
  loop?: TransportLoop | null;
}

/** Canvas highway renderer (T-024). Reads `clock.heardSongTime()` only; never advances time. */
export interface Highway {
  /** Start the rAF loop. */
  start(): void;
  stop(): void;
  /** Draw one frame at `perfNow` (tests / manual stepping). Returns draw time in ms. */
  drawFrame(perfNow: number): number;
  /** Hit feedback for a judgement (flash, particles, outcome text, "played G3"). */
  feedback(j: Judgement): void;
  /** Faint tick for a stray onset. */
  stray(s: StrayEvent): void;
  setCombo(combo: number, multiplier: number): void;
  setOptions(opts: Partial<HighwayOptions>): void;
  /** Re-measure after a layout change (DPR aware). */
  resize(): void;
  dispose(): void;
}
