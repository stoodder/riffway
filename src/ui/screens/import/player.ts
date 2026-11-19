/**
 * Audio for the import screen (T-028): preview playback of the aligned song and the metronome for
 * tap-along, on the shared engine's transport (AudioContext clock, docs/timing.md).
 *
 * Notes play through the guide synth (T-021) when it is available; if it cannot load (not built yet,
 * worker failure, slow render) a light built-in "pluck" voice schedules short oscillator notes on the
 * guide bus instead, so the preview always sounds. Tap times are read with
 * `engine.perfToCtxTime(event.timeStamp) − keyboardOffsetMs` → `clock.songTimeAt` (keyboard path of
 * docs/timing.md § How offsets apply to scoring).
 * @module
 */
import type { PlaybackSegment, ScheduledSource, TransportTimeline, Unsubscribe } from '@shared/clock';
import type { AudioEngine, GuideService } from '@shared/services';
import type { Song, SongBundle } from '@shared/song';
import type { AppContext } from '@shared/ui';

/** How long a guide render may take before the preview falls back to the pluck voice (ms). */
const GUIDE_TIMEOUT_MS = 8000;
/** How long an un-gestured `resume()` may take before the audio-gesture overlay is shown (ms). */
const RESUME_GRACE_MS = 300;
/** Pluck voice look-ahead (s) and timer period (ms). */
const LOOKAHEAD_S = 0.4;
const TICK_MS = 40;

/** A note the pluck voice can play. */
interface PluckNote {
  time: number;
  dur: number;
  midi: number;
}

/**
 * Minimal synth voice: a triangle oscillator with a plucked envelope per note, scheduled a little
 * ahead on `engine.buses.guide`. Implements the engine's `ScheduledSource` contract (each
 * `schedule(seg)` replaces everything from `seg.ctxStart` on).
 */
export class PluckVoice implements ScheduledSource {
  readonly name = 'import-preview';
  private seg: PlaybackSegment | null = null;
  private cursor = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly active = new Set<{ osc: OscillatorNode; gain: GainNode; start: number }>();

  constructor(
    private readonly engine: AudioEngine,
    private readonly notes: readonly PluckNote[],
  ) {}

  schedule(segment: PlaybackSegment): void {
    this.stop(segment.ctxStart);
    this.seg = segment;
    this.cursor = this.notes.findIndex((n) => n.time >= segment.songStart - 1e-6);
    if (this.cursor < 0) this.cursor = this.notes.length;
    this.tick();
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  stop(when?: number): void {
    const at = when ?? this.engine.ctx.currentTime;
    this.seg = null;
    for (const a of this.active) {
      try {
        a.osc.stop(Math.max(at, a.start));
      } catch {
        // Already stopped.
      }
    }
  }

  /** Stop everything now and release the timer. */
  dispose(): void {
    this.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const a of this.active) a.gain.disconnect();
    this.active.clear();
  }

  private tick(): void {
    const seg = this.seg;
    if (!seg) return;
    const ctx = this.engine.ctx;
    const now = ctx.currentTime;
    while (this.cursor < this.notes.length) {
      const note = this.notes[this.cursor];
      if (seg.songEnd !== undefined && note.time >= seg.songEnd) break;
      const at = seg.ctxStart + (note.time - seg.songStart) / seg.speed;
      if (seg.ctxEnd !== undefined && at >= seg.ctxEnd) break;
      if (at > now + LOOKAHEAD_S) break;
      if (at >= now - 0.01) this.play(note, Math.max(at, now), seg.speed);
      this.cursor++;
    }
  }

  private play(note: PluckNote, at: number, speed: number): void {
    const ctx = this.engine.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
    const len = Math.min(1.6, Math.max(0.12, note.dur / speed));
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.28, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0008, at + len);
    osc.connect(gain).connect(this.engine.buses.guide);
    const entry = { osc, gain, start: at };
    this.active.add(entry);
    osc.onended = () => {
      gain.disconnect();
      this.active.delete(entry);
    };
    osc.start(at);
    osc.stop(at + len + 0.02);
  }
}

/** Options for {@link ImportAudio.start}. */
export interface StartOptions {
  /** Playback speed (0.4–1.1). */
  speed: number;
  /** Song time to start from. */
  from: number;
  metronome: boolean;
  /** Count-in bars before `from`. */
  countInBars: number;
}

/** Playback controller for the import screen. One per mounted screen; `dispose()` on unmount. */
export class ImportAudio {
  private engine: AudioEngine | null = null;
  private guide: GuideService | null = null;
  /** The song the guide currently holds (re-rendered when the preview changes). */
  private guideSong: Song | null = null;
  private guideSpeed = 1;
  private pluck: { voice: PluckVoice; unregister: Unsubscribe; song: Song } | null = null;
  private unsubEnded: Unsubscribe | null = null;
  private endedCb: (() => void) | null = null;
  private disposed = false;
  private _playing = false;
  /** Which voice the last preview used (shown in the UI). */
  voice: 'guide' | 'pluck' | 'none' = 'none';

  constructor(private readonly app: AppContext) {}

  /** True between `start()` and `stop()` / the end of the song. */
  get playing(): boolean {
    return this._playing;
  }

  /** Called when playback passes the end of the song. */
  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }

  /** The engine once audio has been started (null before the first `start`). */
  get audioEngine(): AudioEngine | null {
    return this.engine;
  }

  /** Song time being heard now (for the playhead), or null when not started. */
  heardSongTime(): number | null {
    return this.engine ? this.engine.clock.heardSongTime() : null;
  }

  /**
   * Song time of a keyboard/pointer event (`event.timeStamp`, ms since time origin), corrected by
   * the keyboard latency calibration. Null before audio has started.
   */
  eventSongTime(timeStampMs: number): number | null {
    const engine = this.engine;
    if (!engine) return null;
    const offset = this.app.settings.get().calibration.keyboardOffsetMs / 1000;
    return engine.clock.songTimeAt(engine.perfToCtxTime(timeStampMs) - offset);
  }

  /**
   * Start playback over `timeline` (its bars drive the metronome). With `voice`, the song's notes
   * play too (preview); without, only the metronome (tap-along). Call from a user gesture.
   */
  async start(timeline: TransportTimeline, voice: { song: Song; bundle: SongBundle | null } | null, opts: StartOptions): Promise<void> {
    const engine = await this.ensureEngine();
    if (this.disposed) return;
    const t = engine.transport;
    t.stop();
    t.setLoop(null);
    t.load(timeline);
    t.setSpeed(opts.speed, { atNextBar: false });
    t.setMetronome(opts.metronome);
    if (voice) await this.prepareVoice(engine, voice.song, voice.bundle, opts.speed);
    else this.silenceVoices();
    if (this.disposed) return;
    this.unsubEnded ??= t.onEnded(() => {
      this._playing = false;
      this.endedCb?.();
    });
    this._playing = true;
    t.play({ from: opts.from, countInBars: opts.countInBars });
  }

  /** Stop playback (keeps the engine and a loaded guide for the next start). */
  stop(): void {
    this._playing = false;
    this.engine?.transport.stop();
  }

  /** Turn the metronome on/off during playback. */
  setMetronome(on: boolean): void {
    this.engine?.transport.setMetronome(on);
  }

  /** Stop, unload the guide, remove the pluck voice and restore transport defaults. */
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.unsubEnded?.();
    this.unsubEnded = null;
    this.dropPluck();
    this.guide?.unload();
    this.guide = null;
    this.guideSong = null;
    if (this.engine) {
      this.engine.transport.setSpeed(1, { atNextBar: false });
      this.engine.transport.setMetronome(this.app.settings.get().practice.metronome);
    }
  }

  private async ensureEngine(): Promise<AudioEngine> {
    if (this.engine) return this.engine;
    const engine = await this.app.services.get('engine');
    if (!engine.running) {
      await Promise.race([engine.resume().catch(() => undefined), new Promise((r) => setTimeout(r, RESUME_GRACE_MS))]);
      if (!engine.running) await this.app.ui.requireAudioGesture();
    }
    this.engine = engine;
    return engine;
  }

  /** Load the song into the guide (or the pluck fallback) unless it already holds it. */
  private async prepareVoice(engine: AudioEngine, song: Song, bundle: SongBundle | null, speed: number): Promise<void> {
    if (this.guide && this.guideSong === song) {
      this.dropPluck();
      this.guide.setMuted(false);
      if (this.guideSpeed !== speed) {
        await this.guide.setSpeed(speed);
        this.guideSpeed = speed;
      }
      this.voice = 'guide';
      return;
    }
    if (this.pluck?.song === song) {
      this.guide?.setMuted(true);
      this.voice = 'pluck';
      return;
    }
    this.silenceVoices();
    if (bundle && (await this.tryGuide(song, bundle, speed))) return;
    const notes = song.notes.filter((n) => n.tiedFrom === undefined).map((n) => ({ time: n.time, dur: n.dur, midi: n.midi }));
    const voice = new PluckVoice(engine, notes);
    this.pluck = { voice, unregister: engine.registerScheduledSource(voice), song };
    this.voice = 'pluck';
  }

  private async tryGuide(song: Song, bundle: SongBundle, speed: number): Promise<boolean> {
    let guide: GuideService;
    try {
      guide = this.guide ?? (await this.app.services.get('guide'));
    } catch {
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('guide render timed out')), GUIDE_TIMEOUT_MS);
    });
    try {
      await Promise.race([guide.load(song, bundle, speed), timeout]);
      guide.setMuted(false);
      this.guide = guide;
      this.guideSong = song;
      this.guideSpeed = speed;
      this.voice = 'guide';
      return true;
    } catch {
      guide.unload();
      this.guide = null;
      this.guideSong = null;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Mute the guide and drop the pluck voice (tap-along plays only the metronome). */
  private silenceVoices(): void {
    this.guide?.setMuted(true);
    this.dropPluck();
    this.voice = 'none';
  }

  private dropPluck(): void {
    if (!this.pluck) return;
    this.pluck.unregister();
    this.pluck.voice.dispose();
    this.pluck = null;
  }
}
