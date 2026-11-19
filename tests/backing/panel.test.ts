// @vitest-environment happy-dom
/**
 * Backing panel (T-027) with fake services: attach flow, waveform/summary, nudges (buttons and
 * arrow keys), tap-along → anchors, play check, guide muting, remove, and the missing-file state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine, BackingService, GuideService } from '@shared/services';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import type { Song } from '@shared/song';
import type { AudioLink } from '@shared/storage';
import type { AppContext, ServiceMap } from '@shared/ui';
import { BackingError } from '../../src/audio/backing';
import { mount } from '../../src/ui/panels/backing';
import { grid } from './helpers';

const TL = grid(120, 8);
const SONG = { meta: { durationSec: TL.durationSec }, timing: { bars: TL.bars.map((b, i) => ({ ...b, index: i, num: 4, den: 4 })) } } as unknown as Song;

/** A fake decoded buffer: one channel with a click every 0.5 s. */
const fakeBuffer = (): AudioBuffer => {
  const sr = 1000;
  const data = new Float32Array(sr * 20);
  for (let i = 0; i < 40; i++) data[i * 500] = 0.9;
  return { sampleRate: sr, length: data.length, numberOfChannels: 1, duration: 20, getChannelData: () => data } as unknown as AudioBuffer;
};

function fakeBacking() {
  const state = { link: null as AudioLink | null, buffer: null as AudioBuffer | null };
  const svc = {
    get link() {
      return state.link;
    },
    get buffer() {
      return state.buffer;
    },
    attach: vi.fn(async (file: File, songId: string, arrangement: number): Promise<AudioLink> => ({
      songId,
      arrangement,
      audioId: 'a'.repeat(40),
      fileName: file.name,
      anchors: [{ songTime: 0, audioTime: 0 }],
      gainDb: 0,
      enabled: true,
    })),
    load: vi.fn(async (link: AudioLink) => {
      state.link = link;
      state.buffer = fakeBuffer();
    }),
    update: vi.fn(async (link: AudioLink) => {
      state.link = link;
    }),
    detach: vi.fn(async () => {
      state.link = null;
      state.buffer = null;
    }),
    setEnabled: vi.fn((on: boolean) => {
      if (state.link) state.link = { ...state.link, enabled: on };
    }),
    unload: vi.fn(),
  };
  return svc;
}

function fakeEngine() {
  const tapCtxTimes: number[] = [];
  const transport = {
    stop: vi.fn(),
    load: vi.fn(),
    setMetronome: vi.fn(),
    setSpeed: vi.fn(),
    play: vi.fn(),
    onEnded: vi.fn(() => () => undefined),
  };
  const engine = {
    transport,
    clock: { heardSongTime: () => 0, songTimeAt: (t: number) => t },
    perfToCtxTime: () => tapCtxTimes.shift() ?? Number.NaN,
  };
  return { engine, transport, tapCtxTimes };
}

function memorySettings(): AppContext['settings'] & { current: Settings } {
  const subs = new Set<(s: Settings) => void>();
  const store = {
    current: structuredClone(DEFAULT_SETTINGS),
    get: () => store.current,
    update: vi.fn(async (patch: { game?: Partial<Settings['game']> }) => {
      store.current = { ...store.current, game: { ...store.current.game, ...patch.game } };
      subs.forEach((s) => s(store.current));
      return store.current;
    }),
    replace: async () => undefined,
    subscribe: (cb: (s: Settings) => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
  return store as unknown as AppContext['settings'] & { current: Settings };
}

interface Rig {
  host: HTMLElement;
  backing: ReturnType<typeof fakeBacking>;
  eng: ReturnType<typeof fakeEngine>;
  guide: { muted: boolean; setMuted: ReturnType<typeof vi.fn> };
  settings: ReturnType<typeof memorySettings>;
  toast: ReturnType<typeof vi.fn>;
  stored: AudioLink | null;
  unmount(): void;
}

const rigs: Rig[] = [];
const flush = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));
const buttonByText = (root: ParentNode, text: string): HTMLButtonElement => {
  const b = Array.from(root.querySelectorAll('button')).find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b;
};

async function rig(stored: AudioLink | null = null, opts: { loadError?: Error } = {}): Promise<Rig> {
  const backing = fakeBacking();
  if (opts.loadError) backing.load.mockRejectedValueOnce(opts.loadError);
  const eng = fakeEngine();
  const guide = { muted: false, setMuted: vi.fn((m: boolean) => (guide.muted = m)) };
  const settings = memorySettings();
  const toast = vi.fn();
  const services = { engine: eng.engine as unknown as AudioEngine, backing: backing as unknown as BackingService, guide: guide as unknown as GuideService } as Partial<ServiceMap>;
  const r: Rig = { host: document.createElement('div'), backing, eng, guide, settings, toast, stored, unmount: () => undefined };
  const ctx = {
    settings,
    storage: { getAudioLink: async () => r.stored },
    services: { get: async (id: keyof ServiceMap) => services[id], peek: (id: keyof ServiceMap) => services[id] ?? null },
    ui: { toast, confirm: async () => true, requireAudioGesture: async () => undefined },
  } as unknown as AppContext;
  document.body.append(r.host);
  const handle = await mount(r.host, ctx, { songId: 'starter:x', arrangement: 0, song: SONG });
  r.unmount = () => handle.unmount();
  rigs.push(r);
  await flush();
  return r;
}

const LINK: AudioLink = {
  songId: 'starter:x',
  arrangement: 0,
  audioId: 'b'.repeat(40),
  fileName: 'take.mp3',
  anchors: [{ songTime: 0, audioTime: 0.25 }],
  gainDb: -3,
  enabled: true,
};

afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.unmount();
    r.host.remove();
  }
});

describe('backing panel', () => {
  it('starts empty and attaches a picked file, then shows the alignment UI', async () => {
    const r = await rig();
    expect(r.host.querySelector('.rw-backing')?.getAttribute('data-state')).toBe('empty');
    expect(r.host.textContent).toContain('guide synth plays the tab');
    const input = r.host.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toContain('.m4a');
    const file = new File(['RIFF'], 'Band - Song.wav');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(r.backing.attach).toHaveBeenCalledWith(file, 'starter:x', 0);
    expect(r.backing.load).toHaveBeenCalled();
    expect(r.host.querySelector('.rw-backing')?.getAttribute('data-state')).toBe('ready');
    expect(r.host.querySelector('canvas.rw-backing__wave')).not.toBeNull();
    expect(r.host.querySelector('.rw-backing__summary')?.textContent).toContain('+0 ms');
    expect(r.toast).toHaveBeenCalledWith(expect.stringContaining('Band - Song.wav'), { kind: 'success' });
  });

  it('shows attach errors as toasts and stays empty', async () => {
    const r = await rig();
    r.backing.attach.mockRejectedValueOnce(new BackingError('unsupported-type', 'Unsupported audio type .ogg: use MP3, WAV or M4A.'));
    const input = r.host.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.ogg')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(r.toast).toHaveBeenCalledWith(expect.stringContaining('.ogg'), { kind: 'error' });
    expect(r.host.querySelector('.rw-backing')?.getAttribute('data-state')).toBe('empty');
  });

  it('nudges with buttons and arrow keys (later = earlier audio) and persists', async () => {
    const r = await rig(LINK);
    buttonByText(r.host, '+10 ms').click();
    await flush();
    expect(r.backing.update).toHaveBeenLastCalledWith(expect.objectContaining({ anchors: [{ songTime: 0, audioTime: expect.closeTo(0.24, 9) }] }));
    const canvas = r.host.querySelector<HTMLCanvasElement>('canvas')!;
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
    await flush();
    expect(r.backing.update).toHaveBeenLastCalledWith(expect.objectContaining({ anchors: [{ songTime: 0, audioTime: expect.closeTo(0.241, 9) }] }));
    expect(r.host.querySelector('.rw-backing__summary')?.textContent).toContain('+241 ms');
  });

  it('tap-along plays the backing alone from a bar early and fits offset + tempo from the taps', async () => {
    const r = await rig(LINK);
    buttonByText(r.host, 'Tap along').click();
    await flush();
    expect(r.eng.transport.setMetronome).toHaveBeenCalledWith(false);
    expect(r.eng.transport.setSpeed).toHaveBeenCalledWith(1);
    expect(r.eng.transport.play).toHaveBeenCalledWith({ from: -2, countInBars: 0 });
    expect(r.guide.muted).toBe(true);
    // The recording is 2 % slower and its bar 1 downbeat is heard at song 0.1 (audio 0.35).
    const songOfBeat = (k: number): number => 0.1 + k * 0.5 * 1.02;
    for (let k = 0; k < 12; k++) {
      r.eng.tapCtxTimes.push(songOfBeat(k));
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    }
    expect(r.host.querySelector('.rw-backing__tap-count')?.textContent).toBe('12 taps');
    buttonByText(r.host, 'Apply').click();
    await flush();
    const anchors = r.backing.update.mock.lastCall![0].anchors;
    expect(anchors).toHaveLength(2);
    expect(anchors[0].songTime).toBe(0);
    expect(anchors[0].audioTime).toBeCloseTo(0.35, 6);
    expect((anchors[1].audioTime - anchors[0].audioTime) / (anchors[1].songTime - anchors[0].songTime)).toBeCloseTo(1.02, 6);
    expect(r.eng.transport.stop).toHaveBeenCalled();
    expect(r.toast).toHaveBeenCalledWith(expect.stringContaining('Offset and tempo set from 12 taps'), { kind: 'success' });
    // Back to idle: the guide follows the auto-mute setting (on by default with backing enabled).
    expect(r.guide.muted).toBe(guideMutedByDefault());
  });

  it('play check runs backing + metronome at the chosen speed and stops', async () => {
    const r = await rig(LINK);
    const speed = Array.from(r.host.querySelectorAll('select')).find((s) => s.querySelector('option[value="0.7"]'))!;
    speed.value = '0.7';
    speed.dispatchEvent(new Event('change'));
    buttonByText(r.host, 'Play check').click();
    await flush();
    expect(r.eng.transport.load).toHaveBeenCalledWith({ durationSec: TL.durationSec, bars: SONG.timing.bars });
    expect(r.eng.transport.setMetronome).toHaveBeenCalledWith(true);
    expect(r.eng.transport.setSpeed).toHaveBeenCalledWith(0.7);
    buttonByText(r.host, 'Stop check').click();
    expect(r.eng.transport.stop).toHaveBeenCalled();
    expect(buttonByText(r.host, 'Play check')).toBeTruthy();
  });

  it('backing and guide-mute toggles drive the service, the setting and the guide', async () => {
    const r = await rig(LINK);
    const settingsDefault = guideMutedByDefault();
    expect(r.guide.muted).toBe(settingsDefault);
    const switches = Array.from(r.host.querySelectorAll<HTMLButtonElement>('button[role=switch]'));
    switches[1]!.click(); // mute guide while backing plays → off
    await flush();
    expect(r.settings.update).toHaveBeenCalledWith({ game: { muteGuideWithBacking: !DEFAULT_SETTINGS.game.muteGuideWithBacking } });
    switches[0]!.click(); // backing off → guide plays
    expect(r.backing.setEnabled).toHaveBeenCalledWith(false);
    expect(r.guide.muted).toBe(false);
  });

  it('removes the link after confirming', async () => {
    const r = await rig(LINK);
    buttonByText(r.host, 'Remove').click();
    await flush();
    expect(r.backing.detach).toHaveBeenCalledWith('starter:x', 0);
    expect(r.host.querySelector('.rw-backing')?.getAttribute('data-state')).toBe('empty');
  });

  it('shows a missing recording with re-attach and remove actions', async () => {
    const r = await rig(LINK, { loadError: new BackingError('missing', 'The backing audio file is no longer on this computer. Attach it again.') });
    expect(r.host.querySelector('.rw-backing')?.getAttribute('data-state')).toBe('error');
    expect(r.host.querySelector('[role=alert]')?.textContent).toContain('no longer on this computer');
    expect(buttonByText(r.host, 'Attach again')).toBeTruthy();
    expect(buttonByText(r.host, 'Remove')).toBeTruthy();
  });
});

function guideMutedByDefault(): boolean {
  return DEFAULT_SETTINGS.game.guide ? DEFAULT_SETTINGS.game.muteGuideWithBacking : true;
}
