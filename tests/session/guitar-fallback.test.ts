/**
 * R3-C-02: a song opened while the saved guitar input is unplugged must not silently judge another
 * input (typically the laptop's built-in microphone, which would also hear the guide synth). In
 * `auto` and `guitar` input mode the session plays with the keys and says why; the player opts in to
 * another input by choosing it in Audio setup. Drives `createGameSession` with the real input
 * service on fake media devices.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SongMeta } from '@shared/api';
import type { GameInputMode } from '@shared/settings';
import type { AppContext } from '@shared/ui';
import type { Song } from '@shared/song';
import { createSongClock } from '../../src/audio/engine/clock';
import { TransportCore } from '../../src/audio/engine/transport';
import { createInputServiceWith, type DisposableInputService } from '../../src/audio/input/service';
import { createGameSession, type GameSessionImpl } from '../../src/game/session';
import { FakeEngine, FakeMediaDevices, fakeDeps, memorySettings, type FakeDevice } from '../input/fakes';
import { makeSong } from './helpers';

const DEFAULT_MIC: FakeDevice = { deviceId: 'default', label: 'Default - MacBook Pro Microphone', kind: 'audioinput' };
const MIC: FakeDevice = { deviceId: 'mic', label: 'MacBook Pro Microphone', kind: 'audioinput' };
const CUBILUX: FakeDevice = { deviceId: 'cubilux-id', label: 'Cubilux USB Audio', kind: 'audioinput' };
const OTHER_USB: FakeDevice = { deviceId: 'zoom-id', label: 'Zoom USB Audio', kind: 'audioinput' };
const SAVED = { input: { deviceId: CUBILUX.deviceId, label: CUBILUX.label } };

let svc: DisposableInputService | null = null;
let session: GameSessionImpl | null = null;

afterEach(async () => {
  await session?.dispose();
  session = null;
  svc?.dispose();
  svc = null;
});

function rig(devices: FakeDevice[], initial: Parameters<typeof memorySettings>[0] = SAVED) {
  const media = new FakeMediaDevices(devices);
  const settings = memorySettings(initial);
  const input = createInputServiceWith(new FakeEngine(48000).asEngine(), settings, fakeDeps(media));
  svc = input;
  const song: Song = makeSong([{ time: 2 }], { bars: 2 });
  const now = { t: 10 };
  const core = new TransportCore({ now: () => now.t, clicks: { schedule: () => ({ cancel: () => undefined }) } });
  const engine = {
    clock: createSongClock(core, { now: () => now.t, outputTimestamp: () => null, perfNow: () => now.t * 1000, outputDelay: () => 0 }, () => 0),
    transport: core,
    perfToCtxTime: (ms: number) => ms / 1000,
    ctx: { currentTime: 10, outputLatency: 0, state: 'running' },
  };
  const services: Record<string, unknown> = { engine, input, monitor: {}, songLoader: { load: async () => song } };
  const ctx = {
    services: {
      get: async (name: string) => {
        if (!(name in services)) throw new Error(`${name} unavailable in this test`);
        return services[name];
      },
      peek: (name: string) => services[name] ?? null,
    },
    api: {
      song: async (id: string) => ({ entry: { id, title: id, artist: null, defaultArrangement: 0, difficulty: null }, difficulty: [] }) as unknown as SongMeta,
      songBundle: async (id: string) => ({ fileName: id, data: new Uint8Array(1) }),
    },
    storage: { getSectionProgress: async () => [], listRuns: async () => [], getSongCache: async () => null, getAudioLink: async () => null },
    settings,
    flags: { e2e: false },
  } as unknown as AppContext;
  return { ctx, media, input, settings };
}

async function open(ctx: AppContext, mode: GameInputMode): Promise<{ s: GameSessionImpl; notices: string[] }> {
  const notices: string[] = [];
  session = await createGameSession(ctx, { songId: 'a', arrangement: 0, mode: 'play' }, { input: mode, onNotice: (t) => notices.push(t) });
  return { s: session, notices: notices.filter((t) => !/guide|backing/i.test(t)) };
}

describe('saved guitar input unplugged (R3-C-02)', () => {
  for (const mode of ['auto', 'guitar'] as const) {
    it(`${mode}: plays with the keys and says so instead of judging the laptop microphone`, async () => {
      const { ctx, media, input } = rig([DEFAULT_MIC, MIC]);
      const { s, notices } = await open(ctx, mode);
      expect(s.hasGuitar).toBe(false);
      expect(notices).toEqual([
        'Your guitar input “Cubilux USB Audio” isn’t connected — playing with the keys. Plug it in and open the song again, or choose another input in Audio setup.',
      ]);
      // Nothing is left listening to the microphone.
      expect(input.current).toBeNull();
      expect(media.streams.every((st) => st.track.stopped)).toBe(true);
    });

    it(`${mode}: does not fall back to another USB-looking input either`, async () => {
      const { ctx, input } = rig([DEFAULT_MIC, OTHER_USB]);
      const { s, notices } = await open(ctx, mode);
      expect(s.hasGuitar).toBe(false);
      expect(notices).toHaveLength(1);
      expect(input.current).toBeNull();
    });

    it(`${mode}: uses the saved guitar when it is connected`, async () => {
      const { ctx, input } = rig([DEFAULT_MIC, MIC, CUBILUX]);
      const { s, notices } = await open(ctx, mode);
      expect(s.hasGuitar).toBe(true);
      expect(notices).toEqual([]);
      expect(input.current?.device.deviceId).toBe(CUBILUX.deviceId);
    });

    it(`${mode}: uses the microphone when the player chose it in Audio setup (explicit opt-in)`, async () => {
      const { ctx, input } = rig([DEFAULT_MIC, MIC], { input: { deviceId: MIC.deviceId, label: MIC.label } });
      const { s, notices } = await open(ctx, mode);
      expect(s.hasGuitar).toBe(true);
      expect(notices).toEqual([]);
      expect(input.current?.device.deviceId).toBe(MIC.deviceId);
    });
  }

  it('guitar: the saved device is listed but cannot be opened (gone) → keys, not the default input', async () => {
    const { ctx, media, input } = rig([DEFAULT_MIC, MIC, CUBILUX]);
    media.failNext = Object.assign(new Error('gone'), { name: 'NotReadableError' });
    // The first getUserMedia unlocks labels; fail the device open itself.
    media.granted = true;
    const { s, notices } = await open(ctx, 'guitar');
    expect(s.hasGuitar).toBe(false);
    expect(notices).toHaveLength(1);
    expect(input.current).toBeNull();
    expect(media.streams.every((st) => st.track.stopped)).toBe(true);
  });

  it('auto: a fallback input already open elsewhere is not judged, and is left open for its owner', async () => {
    const { ctx, input } = rig([DEFAULT_MIC, MIC]);
    const fallback = await input.open();
    expect(fallback.fellBackToDefault).toBe(true);
    const { s, notices } = await open(ctx, 'auto');
    expect(s.hasGuitar).toBe(false);
    expect(notices).toHaveLength(1);
    expect(input.current).toBe(fallback);
  });
});
