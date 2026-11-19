/**
 * Backing audio (T-027): attach a recording the user owns (`POST /api/audio`, stored by the server
 * under `<dataDir>/audio/<sha1>.<ext>`, DEC-13), keep its `AudioLink` (warp anchors, gain, enabled)
 * in IndexedDB, and play it time-stretched on the backing bus in sync with the engine clock.
 * Reached via `ctx.services.get('backing')`.
 *
 * - Warp model: `warp.ts`; tap-along fitting: `align.ts`; stretch planning: `plan.ts`;
 *   playback: `player.ts` (a `ScheduledSource` registered with the engine).
 * - Without an enabled link the guide synth plays; with one, the guide mutes when the setting
 *   `game.muteGuideWithBacking` says so ({@link guideShouldMute}).
 * @module
 */
import { AUDIO_EXTENSIONS, LIMITS, type ApiClient } from '@shared/api';
import type { Unsubscribe } from '@shared/clock';
import type { AudioEngine, BackingService } from '@shared/services';
import type { Settings } from '@shared/settings';
import type { AudioLink, StorageService } from '@shared/storage';
import { BackingPlayer, type BackingPlayerOptions } from './player';
import { DEFAULT_ANCHORS, normalizeAnchors } from './warp';

export { BackingPlayer } from './player';

/** Why a backing-audio operation failed (the message is user-facing). */
export type BackingErrorCode = 'unsupported-type' | 'too-large' | 'empty' | 'missing' | 'decode' | 'upload';

/** A user-facing backing-audio error. */
export class BackingError extends Error {
  constructor(
    readonly code: BackingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BackingError';
  }
}

/** Lower-case extension including the dot (`'Song.MP3'` → `'.mp3'`), or `''`. */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * Check a file before uploading: allowed extension (`AUDIO_EXTENSIONS`), not empty, at most
 * `LIMITS.audioBytes`. Throws {@link BackingError}. The server re-checks and sniffs the content.
 */
export function validateAudioFile(file: { name: string; size: number }): void {
  const ext = extOf(file.name);
  if (!AUDIO_EXTENSIONS.includes(ext)) {
    throw new BackingError('unsupported-type', `Unsupported audio type${ext ? ` ${ext}` : ''}: use MP3, WAV or M4A.`);
  }
  if (file.size === 0) throw new BackingError('empty', 'The audio file is empty.');
  if (file.size > LIMITS.audioBytes) {
    throw new BackingError('too-large', `The audio file is larger than ${LIMITS.audioBytes / 1024 / 1024} MB.`);
  }
}

/**
 * Whether the guide synth should be muted: the guide setting is off, or an enabled backing link is
 * playing and `game.muteGuideWithBacking` is on. With no link the guide is the fallback and plays.
 */
export function guideShouldMute(settings: Pick<Settings, 'game'>, link: Pick<AudioLink, 'enabled'> | null): boolean {
  if (!settings.game.guide) return true;
  return !!link?.enabled && settings.game.muteGuideWithBacking;
}

/** A fresh link for an uploaded file: song 0 = audio 0, 0 dB, enabled. */
export function newLink(songId: string, arrangement: number, audioId: string, fileName: string): AudioLink {
  return { songId, arrangement, audioId, fileName, anchors: DEFAULT_ANCHORS.map((a) => ({ ...a })), gainDb: 0, enabled: true };
}

const sameKey = (a: AudioLink, b: { songId: string; arrangement: number }): boolean =>
  a.songId === b.songId && a.arrangement === b.arrangement;

const isNotFound = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;

/** Test seams for {@link createBacking}. */
export interface BackingServiceOptions {
  /** Player factory override (tests). */
  createPlayer?: (opts: BackingPlayerOptions) => Promise<BackingPlayer>;
}

class Backing implements BackingService {
  private _link: AudioLink | null = null;
  private _buffer: AudioBuffer | null = null;
  private player: BackingPlayer | null = null;
  private playerCtx: BaseAudioContext | null = null;
  private unregister: Unsubscribe | null = null;
  /** Bumped by every load/unload so a slow load cannot overwrite a newer one. */
  private loadToken = 0;

  constructor(
    private readonly engine: AudioEngine,
    private readonly api: ApiClient,
    private readonly storage: StorageService,
    private readonly opts: BackingServiceOptions,
  ) {
    engine.onContextChange(() => void this.rebuildForNewContext());
  }

  get link(): AudioLink | null {
    return this._link;
  }

  get buffer(): AudioBuffer | null {
    return this._buffer;
  }

  async attach(file: File, songId: string, arrangement: number): Promise<AudioLink> {
    validateAudioFile(file);
    let res;
    try {
      res = await this.api.uploadAudio(file, file.name);
    } catch (err) {
      throw new BackingError('upload', `Could not attach the audio file: ${err instanceof Error ? err.message : String(err)}`);
    }
    const previous = await this.storage.getAudioLink(songId, arrangement);
    const link = newLink(songId, arrangement, res.audioId, res.fileName);
    await this.storage.putAudioLink(link);
    if (previous && previous.audioId !== link.audioId) await this.releaseAudio(previous.audioId);
    return link;
  }

  async load(link: AudioLink): Promise<void> {
    const token = ++this.loadToken;
    const anchors = normalizeAnchors(link.anchors);
    this._link = { ...link, anchors };
    this._buffer = null;
    const player = await this.ensurePlayer();
    if (token !== this.loadToken) return;
    await player.setBuffer(null);
    player.setAnchors(anchors);
    player.setGainDb(link.gainDb);
    player.setEnabled(link.enabled);
    const buffer = await this.decode(link.audioId);
    if (token !== this.loadToken) return;
    await player.setBuffer(buffer);
    if (token !== this.loadToken) return;
    this._buffer = buffer;
  }

  async update(link: AudioLink): Promise<void> {
    const next: AudioLink = { ...link, anchors: normalizeAnchors(link.anchors) };
    await this.storage.putAudioLink(next);
    if (this._link && sameKey(this._link, next) && this._link.audioId === next.audioId) {
      this._link = next;
      this.player?.setAnchors(next.anchors);
      this.player?.setGainDb(next.gainDb);
      this.player?.setEnabled(next.enabled);
    }
  }

  async detach(songId: string, arrangement: number): Promise<void> {
    const link = await this.storage.getAudioLink(songId, arrangement);
    await this.storage.deleteAudioLink(songId, arrangement);
    if (this._link && sameKey(this._link, { songId, arrangement })) this.unload();
    if (link) await this.releaseAudio(link.audioId);
  }

  setEnabled(on: boolean): void {
    if (!this._link) return;
    this._link = { ...this._link, enabled: on };
    this.player?.setEnabled(on);
    void this.storage.putAudioLink(this._link).catch((err: unknown) => console.warn('Could not save the backing link', err));
  }

  unload(): void {
    this.loadToken++;
    this._link = null;
    this._buffer = null;
    if (this.player) {
      this.player.stop();
      void this.player.setBuffer(null);
    }
  }

  /** Delete the server copy unless another link still uses it (content-addressed, shared). */
  private async releaseAudio(audioId: string): Promise<void> {
    const { stores } = await this.storage.exportAll();
    if (stores.audioLinks.some((l) => l.audioId === audioId)) return;
    try {
      await this.api.deleteAudio(audioId);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  private async decode(audioId: string): Promise<AudioBuffer> {
    let bytes: ArrayBuffer;
    try {
      bytes = await this.api.getAudio(audioId);
    } catch (err) {
      if (isNotFound(err)) {
        throw new BackingError('missing', 'The backing audio file is no longer on this computer. Attach it again.');
      }
      throw err;
    }
    try {
      return await this.engine.ctx.decodeAudioData(bytes);
    } catch {
      throw new BackingError('decode', 'This audio file could not be decoded.');
    }
  }

  private async ensurePlayer(): Promise<BackingPlayer> {
    const ctx = this.engine.ctx;
    if (this.player && this.playerCtx === ctx) return this.player;
    this.disposePlayer();
    const create = this.opts.createPlayer ?? ((o: BackingPlayerOptions) => BackingPlayer.create(o));
    const player = await create({ ctx, destination: this.engine.buses.backing, anchors: this._link?.anchors ?? DEFAULT_ANCHORS });
    if (this.engine.ctx !== ctx) {
      player.dispose();
      return this.ensurePlayer();
    }
    this.player = player;
    this.playerCtx = ctx;
    this.unregister = this.engine.registerScheduledSource(player);
    return player;
  }

  private disposePlayer(): void {
    this.unregister?.();
    this.unregister = null;
    this.player?.dispose();
    this.player = null;
    this.playerCtx = null;
  }

  /** The engine recreated its context (sample-rate change): rebuild the node and re-decode. */
  private async rebuildForNewContext(): Promise<void> {
    if (!this.player) return;
    this.disposePlayer();
    const link = this._link;
    if (link) await this.load(link).catch((err: unknown) => console.warn('Could not reload backing audio', err));
  }
}

/** Create the backing service on the engine's context and backing bus. */
export async function createBacking(
  engine: AudioEngine,
  api: ApiClient,
  storage: StorageService,
  opts: BackingServiceOptions = {},
): Promise<BackingService> {
  return new Backing(engine, api, storage, opts);
}
