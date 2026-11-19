/**
 * Game session (T-031): loads the song via the worker, sets up guide/backing, transport, guitar +
 * keyboard input → judge → HUD, practice loop/trainer, saves runs/bests/progress.
 * Signature frozen by T-010. The session itself is {@link GameSessionImpl} (`./core.ts`); this module
 * wires the real services into it.
 * @module
 */
import type { BackingService, GameSession, GuideService, InputService, SessionOptions } from '@shared/services';
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
  /**
   * Abort the load (the play screen was left while loading): it then rejects with the signal's
   * reason (an `AbortError`) and never builds a session, touches the transport or opens input.
   */
  signal?: AbortSignal;
}

/**
 * Which session load last claimed each shared service (guide, backing). The services are app-wide
 * singletons; only the claimant may unload them, so a stale game (one that was left while loading,
 * or disposed after a newer game loaded) never tears down the next game's guide or backing (R2-I-01).
 */
const owners = new WeakMap<object, symbol>();

/** Unload `service` if `token` still owns it. */
function release(service: { unload(): void } | null, token: symbol): void {
  if (!service || owners.get(service) !== token) return;
  owners.delete(service);
  service.unload();
}

/** A guide that can say whether a song's load is still current (`GuideImpl.holds`). */
interface GuideHolds {
  holds?(song: unknown): boolean;
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
 * unloaded again when the session is disposed, unless a newer session has loaded them since.
 * Throws when the song cannot be loaded, and on `extras.signal` abort (checked after every step).
 */
export async function createGameSession(ctx: AppContext, opts: SessionOptions, extras: GameSessionExtras = {}): Promise<GameSessionImpl> {
  const token = Symbol(opts.songId);
  let guide: GuideService | null = null;
  let backing: BackingService | null = null;
  try {
    return await loadSession(ctx, opts, extras, token, (g) => (guide = g), (b) => (backing = b));
  } catch (err) {
    release(guide, token);
    release(backing, token);
    throw err;
  }
}

async function loadSession(
  ctx: AppContext,
  opts: SessionOptions,
  extras: GameSessionExtras,
  token: symbol,
  claimGuide: (g: GuideService) => void,
  claimBacking: (b: BackingService) => void,
): Promise<GameSessionImpl> {
  const progress = extras.onProgress ?? (() => undefined);
  const notice = extras.onNotice ?? (() => undefined);
  const signal = extras.signal;
  const check = (): void => signal?.throwIfAborted();
  check();
  progress('Loading song', null);
  const [engine, loader, meta, bundle] = await Promise.all([
    ctx.services.get('engine'),
    ctx.services.get('songLoader'),
    ctx.api.song(opts.songId),
    ctx.api.songBundle(opts.songId),
  ]);
  check();
  const song = await loader.load(bundle, opts.arrangement);
  check();
  if (song.notes.length === 0) throw new Error('This arrangement has no playable notes.');
  const settings = ctx.settings.get();
  const difficulty = meta.difficulty[opts.arrangement] ?? meta.entry.difficulty ?? null;

  const [sectionProgress, comfortTier] = await Promise.all([
    ctx.storage.getSectionProgress(opts.songId, opts.arrangement).catch(() => []),
    loadComfortTier(ctx, meta),
  ]);
  check();

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
  check();
  let guideLoaded = false;
  if (guide) {
    owners.set(guide, token);
    claimGuide(guide);
    const off = guide.onProgress((f) => progress('Rendering guide audio', f));
    try {
      await guide.load(song, bundle, speed);
      check();
      // A newer load or an unload superseded ours while it rendered: the guide is not ours to play.
      guideLoaded = owners.get(guide) === token && ((guide as GuideService & GuideHolds).holds?.(song) ?? true);
      if (!guideLoaded) {
        // Whoever superseded it owns it now.
        if (owners.get(guide) === token) owners.delete(guide);
        notice("Guide audio couldn't be prepared (another song took the guide synth).");
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      notice(`Guide audio couldn't be rendered: ${errorText(err)}`);
    } finally {
      off();
    }
  }
  const backing = await ctx.services.get('backing').catch(() => null);
  check();
  if (backing) {
    owners.set(backing, token);
    claimBacking(backing);
    try {
      const link = await ctx.storage.getAudioLink(opts.songId, opts.arrangement);
      check();
      if (link) {
        progress('Loading backing audio', null);
        await backing.load(link);
        check();
      } else backing.unload();
    } catch (err) {
      if (signal?.aborted) throw err;
      notice(`Backing audio unavailable: ${errorText(err)}`);
      backing.unload();
    }
  }

  const input = await openGuitar(ctx, extras.input ?? (ctx.flags.e2e ? 'keyboard' : settings.game.inputMode), notice);
  check();

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
      release(guide, token);
      release(backing, token);
    },
  });
}

/**
 * Start-card notice when the saved guitar input is not connected (R3-C-02). `label` is the saved
 * device's label, if any.
 */
export function guitarMissingNotice(label: string | null): string {
  const name = label ? ` “${label}”` : '';
  return `Your guitar input${name} isn’t connected — playing with the keys. Plug it in and open the song again, or choose another input in Audio setup.`;
}

/**
 * The guitar input to judge, or null for keyboard only. `auto` uses an input that is already open,
 * or opens the device the player chose before; it never prompts for a device on its own.
 *
 * Neither `auto` nor `guitar` judges a fallback input (R3-C-02): when the saved device is unplugged,
 * the input service falls back to the system default (typically the laptop microphone, which also
 * hears the guide synth). The session then plays with the keys and posts {@link guitarMissingNotice};
 * a fallback this call opened is closed again, one opened elsewhere (Audio setup) is left alone.
 * Choosing that input in Audio setup saves it and is the explicit opt-in.
 */
async function openGuitar(ctx: AppContext, mode: SessionInputMode, notice: (t: string) => void): Promise<InputService | null> {
  if (mode === 'keyboard') return null;
  const saved = ctx.settings.get().input;
  const chosen = saved.deviceId !== null;
  const existing = ctx.services.peek('input');
  if (mode === 'auto' && !existing?.current && !chosen) return null;
  try {
    const input = existing ?? (await ctx.services.get('input'));
    const openedHere = !input.current;
    if (openedHere) await input.open();
    if (input.current?.fellBackToDefault) {
      if (openedHere) input.close();
      notice(guitarMissingNotice(saved.label));
      return null;
    }
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
