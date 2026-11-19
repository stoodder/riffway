/**
 * `createGameSession` with a stale load (R2-I-01): leaving a play screen while it is still loading
 * aborts that load — it never builds a session, re-loads the shared transport or opens input — and
 * a stale session never unloads the shared guide / backing a newer game has loaded.
 */
import { describe, expect, it } from 'vitest';
import type { SongMeta } from '@shared/api';
import type { AudioLink } from '@shared/storage';
import type { AppContext } from '@shared/ui';
import type { Song, SongBundle } from '@shared/song';
import { createSongClock } from '../../src/audio/engine/clock';
import { TransportCore } from '../../src/audio/engine/transport';
import { createGameSession } from '../../src/game/session';
import { makeSong, MemorySettings, settle } from './helpers';

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

/** Shared guide modelled on `GuideImpl`: a load is superseded by a newer load or an unload. */
class FakeGuide {
  readonly gates: Deferred[] = [];
  unloads = 0;
  private song: Song | null = null;
  private generation = 0;
  async load(song: Song): Promise<void> {
    this.unload();
    const gen = this.generation;
    this.song = song;
    const gate = deferred();
    this.gates.push(gate);
    await gate.promise;
    if (gen !== this.generation) return;
  }
  holds(song: Song): boolean {
    return this.song === song;
  }
  unload(): void {
    this.generation++;
    this.unloads++;
    this.song = null;
  }
  setSpeed(): Promise<void> {
    return Promise.resolve();
  }
  setMuted(): void {}
  onProgress(): () => void {
    return () => undefined;
  }
}

class FakeBacking {
  link: AudioLink | null = null;
  unloads = 0;
  async load(link: AudioLink): Promise<void> {
    this.link = link;
  }
  unload(): void {
    this.unloads++;
    this.link = null;
  }
}

function rig() {
  const songs: Record<string, Song> = { a: makeSong([{ time: 2 }], { bars: 2 }), b: makeSong([{ time: 2 }], { bars: 2 }) };
  const clock = { t: 10 };
  const core = new TransportCore({ now: () => clock.t, clicks: { schedule: () => ({ cancel: () => undefined }) } });
  const loads: number[] = [];
  const origLoad = core.load.bind(core);
  core.load = (tl) => {
    loads.push(tl.durationSec);
    origLoad(tl);
  };
  const engine = {
    clock: createSongClock(core, { now: () => clock.t, outputTimestamp: () => null, perfNow: () => clock.t * 1000, outputDelay: () => 0 }, () => 0),
    transport: core,
    perfToCtxTime: (ms: number) => ms / 1000,
    ctx: { currentTime: 10, outputLatency: 0, state: 'running' },
  };
  const guide = new FakeGuide();
  const backing = new FakeBacking();
  const services: Record<string, unknown> = {
    engine,
    guide,
    backing,
    songLoader: { load: async (bundle: SongBundle) => songs[bundle.fileName]! },
  };
  const link = (songId: string): AudioLink => ({ songId, arrangement: 0, audioId: `${songId}-audio`, fileName: 'x.mp3', gainDb: 0, enabled: true, anchors: [] }) as unknown as AudioLink;
  const ctx = {
    services: { get: async (name: string) => services[name], peek: (name: string) => services[name] ?? null },
    api: {
      song: async (id: string) => ({ entry: { id, title: id, artist: null, defaultArrangement: 0, difficulty: null }, difficulty: [] }) as unknown as SongMeta,
      songBundle: async (id: string) => ({ fileName: id, data: new Uint8Array(1) }),
    },
    storage: {
      getSectionProgress: async () => [],
      listRuns: async () => [],
      getSongCache: async () => null,
      getAudioLink: async (songId: string) => link(songId),
    },
    settings: new MemorySettings(),
    flags: { e2e: true },
  } as unknown as AppContext;
  return { ctx, guide, backing, songs, loads };
}

describe('createGameSession — stale loads (R2-I-01)', () => {
  it('an aborted load builds no session and never tears down the next game’s guide or backing', async () => {
    const { ctx, guide, backing, songs, loads } = rig();
    const abortA = new AbortController();
    const a = createGameSession(ctx, { songId: 'a', arrangement: 0, mode: 'play' }, { signal: abortA.signal });
    const aDone = a.then(
      () => 'session',
      (err: unknown) => (err instanceof Error ? err.name : String(err)),
    );
    await settle();
    expect(guide.gates).toHaveLength(1);
    // Game A is left while its guide renders; game B starts and loads the shared guide.
    abortA.abort();
    const b = createGameSession(ctx, { songId: 'b', arrangement: 0, mode: 'play' });
    await settle();
    expect(guide.gates).toHaveLength(2);
    guide.gates[0]!.resolve();
    expect(await aDone).toBe('AbortError');
    const unloadsAfterA = guide.unloads;
    guide.gates[1]!.resolve();
    const sessionB = await b;
    expect(guide.holds(songs.b!)).toBe(true);
    expect(guide.unloads).toBe(unloadsAfterA);
    expect(backing.link?.songId).toBe('b');
    // Only B loaded its timeline onto the shared transport.
    expect(loads).toHaveLength(1);
    // B owns the shared services: disposing it unloads them.
    await sessionB.dispose();
    expect(guide.unloads).toBe(unloadsAfterA + 1);
    expect(backing.link).toBeNull();
  });

  it('a session whose guide load was superseded plays without the guide and says so', async () => {
    const { ctx, guide } = rig();
    const notices: string[] = [];
    const a = createGameSession(ctx, { songId: 'a', arrangement: 0, mode: 'play' }, { onNotice: (t) => notices.push(t) });
    await settle();
    // Something else takes the shared guide while A renders.
    guide.unload();
    guide.gates[0]!.resolve();
    const s = await a;
    expect(notices.some((t) => /Guide audio/.test(t))).toBe(true);
    const unloads = guide.unloads;
    await s.dispose();
    // A does not own the guide any more: its dispose leaves it alone.
    expect(guide.unloads).toBe(unloads);
  });

  it('a stale session disposed after a newer one loaded leaves the shared services alone', async () => {
    const { ctx, guide, backing } = rig();
    const a = createGameSession(ctx, { songId: 'a', arrangement: 0, mode: 'play' });
    await settle();
    guide.gates[0]!.resolve();
    const sessionA = await a;
    const b = createGameSession(ctx, { songId: 'b', arrangement: 0, mode: 'play' });
    await settle();
    guide.gates[1]!.resolve();
    await b;
    const unloads = guide.unloads;
    await sessionA.dispose();
    expect(guide.unloads).toBe(unloads);
    expect(backing.link?.songId).toBe('b');
  });
});
