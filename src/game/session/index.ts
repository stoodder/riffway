/**
 * Game session (T-031): loads the song via the worker, sets up guide/backing, transport, guitar +
 * keyboard input → judge → HUD, practice loop/trainer, saves runs/bests/progress.
 * Signature frozen by T-010. The session itself is {@link GameSessionImpl} (`./core.ts`); this module
 * wires the real services into it.
 * @module
 */
import type { GameSession, InputService, SessionOptions } from '@shared/services';
import type { GameInputMode } from '@shared/settings';
import type { SongMeta } from '@shared/api';
import type { Tier } from '@shared/song';
import type { AppContext } from '@shared/ui';
import { comfortTier as comfortTierOf } from '@core/progress';
import { initialTrainerState } from '@core/practice';
import { GameSessionImpl } from './core';

export { GameSessionImpl, SESSION_SPEED_MAX, SESSION_SPEED_MIN, type SessionDeps, type SessionEngine, type SessionTicker, type TestInjection } from './core';
export { clearActiveSession, getActiveSession, onActiveSession, setActiveSession } from './active';
export { LENIENCY_SCALE, windowsFor } from './leniency';
export * from './progress';
export * from './results';

/** Which inputs feed the judge (settings `game.inputMode`; see {@link GameInputMode}). */
export type SessionInputMode = GameInputMode;

/** Extra options of {@link createGameSession} (beyond the frozen {@link SessionOptions}). */
export interface GameSessionExtras {
  /**
   * `keyboard`: keyboard only. `guitar`: open the guitar input (keyboard still works).
   * `auto`: use the guitar when it is open or a device was chosen before. Default: settings
   * `game.inputMode` (`keyboard` with `?e2e=1`).
   */
  input?: SessionInputMode;
  /** Loading progress for the UI (`fraction` 0–1, null when indeterminate). */
  onProgress?(label: string, fraction: number | null): void;
  /** Non-fatal problems (no guitar, guide or backing unavailable). */
  onNotice?(text: string): void;
}

/** One practice session per page load (mastery counts clean runs at 100% within one session). */
const APP_SESSION_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s-${Date.now()}`;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Create a game session with default extras (see {@link createGameSession}). */
export async function createSession(ctx: AppContext, opts: SessionOptions): Promise<GameSession> {
  return createGameSession(ctx, opts);
}

/**
 * Load everything a game needs and create the session: song meta + bundle (server), the `Song`
 * (song worker), the guide render at the start speed, the backing link (if any), the guitar input
 * (per `extras.input`), stored section progress and the comfort tier. The guide and backing are
 * unloaded again when the session is disposed. Throws when the song cannot be loaded.
 */
export async function createGameSession(ctx: AppContext, opts: SessionOptions, extras: GameSessionExtras = {}): Promise<GameSessionImpl> {
  const progress = extras.onProgress ?? (() => undefined);
  const notice = extras.onNotice ?? (() => undefined);
  progress('Loading song', null);
  const [engine, loader, meta, bundle] = await Promise.all([
    ctx.services.get('engine'),
    ctx.services.get('songLoader'),
    ctx.api.song(opts.songId),
    ctx.api.songBundle(opts.songId),
  ]);
  const song = await loader.load(bundle, opts.arrangement);
  if (song.notes.length === 0) throw new Error('This arrangement has no playable notes.');
  const settings = ctx.settings.get();
  const difficulty = meta.difficulty[opts.arrangement] ?? meta.entry.difficulty ?? null;

  const [sectionProgress, comfortTier] = await Promise.all([
    ctx.storage.getSectionProgress(opts.songId, opts.arrangement).catch(() => []),
    loadComfortTier(ctx, meta),
  ]);

  // Start speed: explicit, else the speed trainer's speed for a looped section, else 100%.
  let speed = opts.speed ?? 1;
  const trainerOn = opts.speedTrainer ?? (opts.mode === 'practice' && settings.practice.speedTrainer);
  if (opts.speed === undefined && opts.loopSection !== undefined && trainerOn) {
    const stored = sectionProgress.find((p) => p.sectionIdx === opts.loopSection);
    const sectionTier = difficulty?.sections.find((s) => s.sectionIndex === opts.loopSection)?.tier ?? difficulty?.tier ?? comfortTier;
    speed = stored ? stored.trainer.speed : initialTrainerState(sectionTier, comfortTier).speed;
  }

  // Guide synth (fallback audio) and backing track.
  const guide = await ctx.services.get('guide').catch((err: unknown) => {
    notice(`Guide synth unavailable: ${errorText(err)}`);
    return null;
  });
  let guideLoaded = false;
  if (guide) {
    const off = guide.onProgress((f) => progress('Rendering guide audio', f));
    try {
      await guide.load(song, bundle, speed);
      guideLoaded = true;
    } catch (err) {
      notice(`Guide audio couldn't be rendered: ${errorText(err)}`);
    } finally {
      off();
    }
  }
  const backing = await ctx.services.get('backing').catch(() => null);
  if (backing) {
    try {
      const link = await ctx.storage.getAudioLink(opts.songId, opts.arrangement);
      if (link) {
        progress('Loading backing audio', null);
        await backing.load(link);
      } else backing.unload();
    } catch (err) {
      notice(`Backing audio unavailable: ${errorText(err)}`);
      backing.unload();
    }
  }

  const input = await openGuitar(ctx, extras.input ?? (ctx.flags.e2e ? 'keyboard' : settings.game.inputMode), notice);

  return new GameSessionImpl({
    song,
    songId: opts.songId,
    arrangement: opts.arrangement,
    mode: opts.mode,
    title: song.meta.title || meta.entry.title,
    artist: song.meta.artist ?? meta.entry.artist ?? null,
    engine,
    settings: ctx.settings,
    storage: ctx.storage,
    guide: guideLoaded ? guide : null,
    backing,
    input,
    difficulty,
    entry: meta.entry,
    comfortTier,
    sectionProgress,
    sessionId: APP_SESSION_ID,
    speed,
    ...(opts.loopSection !== undefined ? { loopSection: opts.loopSection } : {}),
    speedTrainer: trainerOn,
    onDispose: () => {
      if (guideLoaded) guide?.unload();
      backing?.unload();
    },
  });
}

/**
 * The guitar input to judge, or null for keyboard only. `auto` uses an input that is already open,
 * or opens the device the player chose before; it never prompts for a device on its own.
 */
async function openGuitar(ctx: AppContext, mode: SessionInputMode, notice: (t: string) => void): Promise<InputService | null> {
  if (mode === 'keyboard') return null;
  const chosen = ctx.settings.get().input.deviceId !== null;
  const existing = ctx.services.peek('input');
  if (mode === 'auto' && !existing?.current && !chosen) return null;
  try {
    const input = existing ?? (await ctx.services.get('input'));
    if (!input.current) await input.open();
    // Monitoring follows its settings once the input is open.
    void ctx.services.get('monitor').catch((err: unknown) => console.warn('Riffway: monitoring unavailable', err));
    return input;
  } catch (err) {
    notice(`Guitar input unavailable (${errorText(err)}) — playing in keyboard mode.`);
    return null;
  }
}

/** The player's comfort tier from stored runs (docs/progress.md § Recommendations). */
async function loadComfortTier(ctx: AppContext, meta: SongMeta): Promise<Tier> {
  try {
    const runs = await ctx.storage.listRuns({ limit: 1000 });
    const tiers = new Map<string, Tier | null>();
    tiers.set(meta.entry.id, meta.entry.difficulty?.tier ?? null);
    for (const id of new Set(runs.map((r) => r.songId))) {
      if (tiers.has(id)) continue;
      const cached = await ctx.storage.getSongCache(id);
      tiers.set(id, cached?.meta.tier ?? cached?.difficulty?.tier ?? null);
    }
    return comfortTierOf(runs, (id) => tiers.get(id) ?? null);
  } catch {
    return comfortTierOf([], () => null);
  }
}
