// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, PasteRequest } from '@shared/api';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { RhythmSidecar } from '@shared/song';
import type { AppContext, ScreenHandle } from '@shared/ui';
import { mount } from '../../src/ui/screens/import';
import { ARPEGGIO, WITH_JUNK } from './tabs';

const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Song time the fake engine reports for the next keyboard/pointer event. */
let nextTapTime = 0;

function fakeEngine() {
  const transport = {
    stop: vi.fn(),
    setLoop: vi.fn(),
    load: vi.fn(),
    setSpeed: vi.fn(),
    setMetronome: vi.fn(),
    play: vi.fn(),
    onEnded: vi.fn(() => () => undefined),
  };
  return {
    running: true,
    resume: vi.fn(async () => undefined),
    transport,
    clock: { heardSongTime: () => 0, songTimeAt: (ctxTime: number) => ctxTime },
    perfToCtxTime: () => nextTapTime,
    registerScheduledSource: vi.fn(() => () => undefined),
    buses: { guide: {} },
    ctx: { currentTime: 0 },
  };
}

interface Harness {
  ctx: AppContext;
  api: { paste: ReturnType<typeof vi.fn>; putSidecar: ReturnType<typeof vi.fn>; song: ReturnType<typeof vi.fn>; songBundle: ReturnType<typeof vi.fn> };
  navigate: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  engine: ReturnType<typeof fakeEngine>;
}

function harness(): Harness {
  const engine = fakeEngine();
  const api = {
    paste: vi.fn(async (req: PasteRequest) => ({ id: 'local:abc', path: `${req.title}.txt` })),
    putSidecar: vi.fn(async (_id: string, sc: RhythmSidecar) => sc),
    song: vi.fn(),
    songBundle: vi.fn(),
  };
  const navigate = vi.fn();
  const toast = vi.fn();
  const confirm = vi.fn(async () => true);
  const ctx = {
    api: api as unknown as ApiClient,
    settings: { get: () => DEFAULT_SETTINGS },
    services: {
      get: vi.fn(async (id: string) => {
        if (id === 'engine') return engine;
        throw new Error(`${id} unavailable in tests`);
      }),
      peek: () => null,
    },
    router: { navigate, href: (screen: string, params: Record<string, string> = {}) => `#/${screen}${params.id ? `/${params.id}` : ''}` },
    ui: { toast, confirm, requireAudioGesture: vi.fn(async () => undefined) },
    flags: { e2e: false, dev: false },
  } as unknown as AppContext;
  return { ctx, api, navigate, toast, confirm, engine };
}

describe('import screen', () => {
  let root: HTMLElement;
  let handle: ScreenHandle | null = null;

  beforeEach(() => {
    root = document.createElement('main');
    document.body.replaceChildren(root);
    nextTapTime = 0;
  });
  afterEach(() => {
    handle?.unmount();
    handle = null;
  });

  const $ = <T extends Element = HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return el;
  };
  const byLabel = (text: string): HTMLButtonElement => {
    const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
    if (!btn) throw new Error(`no button ${text}`);
    return btn;
  };
  const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const paste = async (text: string): Promise<void> => {
    type($<HTMLTextAreaElement>('textarea'), text);
    await flush(200);
  };
  const inputs = (): HTMLInputElement[] => Array.from(root.querySelectorAll<HTMLInputElement>('input.imp-input'));

  it('paste → live preview → snap-to-grid → save writes the tab and its sidecar', async () => {
    const t = harness();
    handle = await mount(root, t.ctx, {});
    expect($('h1').textContent).toBe('Import a tab');
    expect(byLabel('Save to library').disabled).toBe(true);
    const ug = $<HTMLAnchorElement>('a.imp-ug');
    expect(ug.target).toBe('_blank');
    expect(ug.rel).toContain('noopener');

    await paste(ARPEGGIO);
    const summary = $('.imp-summary').textContent ?? '';
    expect(summary).toContain('TuningStandard');
    expect(summary).toContain('Bars2');
    expect(summary).toContain('Onsets16');
    expect(root.querySelectorAll('.imp-line--staff')).toHaveLength(6);
    expect($('.imp-seg__item').textContent).toBe('Auto (1/8)');
    expect(byLabel('Save to library').disabled).toBe(true); // no title yet

    const [title, artist] = inputs();
    type(title, 'Arpeggio');
    type(artist, 'Riffway');
    expect(ug.href).toContain('value=Riffway%20Arpeggio');
    expect($('.imp-save-note').textContent).toContain('Riffway - Arpeggio.txt');
    const save = byLabel('Save to library');
    expect(save.disabled).toBe(false);

    save.click();
    await flush(10);
    expect(t.api.paste).toHaveBeenCalledTimes(1);
    const req = t.api.paste.mock.calls[0][0] as PasteRequest;
    expect(req).toMatchObject({ title: 'Arpeggio', artist: 'Riffway', text: ARPEGGIO });
    expect(req.sidecar).toMatchObject({ schema: 1, bpm: 80, timeSig: [4, 4], grid: 8, method: 'snap' });
    expect(req.sidecar?.onsets).toHaveLength(16);
    expect(req.sidecar?.onsets[1]).toBeCloseTo(0.375);
    expect(t.navigate).toHaveBeenCalledWith('#/song/local:abc');
    expect(t.toast).toHaveBeenCalledWith(expect.stringContaining('Saved'), { kind: 'success' });
  });

  it('BPM, time signature, grid and tuning overrides end up in the saved text and sidecar', async () => {
    const t = harness();
    handle = await mount(root, t.ctx, { q: 'Query title' });
    await paste(ARPEGGIO);
    const [title, , capo, bpm] = inputs();
    expect(title.value).toBe('Query title');
    type(bpm, '120');
    type(capo, '2');
    const tuning = root.querySelector<HTMLSelectElement>('select')!;
    tuning.value = 'drop-d';
    tuning.dispatchEvent(new Event('change'));
    const grid16 = root.querySelector<HTMLInputElement>('input[type="radio"][value="16"]')!;
    grid16.checked = true;
    grid16.dispatchEvent(new Event('change'));
    byLabel('Save to library').click();
    await flush(10);
    const req = t.api.paste.mock.calls[0][0] as PasteRequest;
    expect(req.text.startsWith('Tuning: D A D G B E\nCapo: 2\nTempo: Q=120\n\n')).toBe(true);
    expect(req.sidecar).toMatchObject({ bpm: 120, grid: 16 });
    expect(req.sidecar?.onsets[8]).toBeCloseTo(2);
  });

  it('shows unparsed lines and warnings with line numbers; a warning selects its line', async () => {
    const t = harness();
    handle = await mount(root, t.ctx, {});
    await paste(WITH_JUNK);
    expect(Array.from(root.querySelectorAll('.imp-line--bad')).map((l) => (l as HTMLElement).dataset.line)).toEqual(['11', '12']);
    const lineBtn = Array.from(root.querySelectorAll<HTMLButtonElement>('.imp-warning__line')).find((b) => b.textContent === 'Line 12')!;
    lineBtn.click();
    const ta = $<HTMLTextAreaElement>('textarea');
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('B|---1---1---1---1-|');
    // Header title was picked up for the title field.
    expect(inputs()[0].value).toBe('Test Riff');
    expect(byLabel('Save to library').disabled).toBe(false);
  });

  it('tap-along: metronome starts, Space taps map to onsets, undo works, save stores the taps', async () => {
    const t = harness();
    handle = await mount(root, t.ctx, {});
    await paste(ARPEGGIO);
    type(inputs()[0], 'Tapped');
    byLabel('Tap along').click();
    byLabel('Start tapping').click();
    await flush(10);
    expect(t.engine.transport.setMetronome).toHaveBeenCalledWith(true);
    expect(t.engine.transport.setSpeed).toHaveBeenCalledWith(0.75, { atNextBar: false });
    expect(t.engine.transport.play).toHaveBeenCalledWith({ from: 0, countInBars: 1 });
    expect(byLabel('Save to library').disabled).toBe(true);

    const press = (key: string, time: number): void => {
      nextTapTime = time;
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : key, bubbles: true }));
    };
    press(' ', -2); // count-in: ignored
    press(' ', 0.02);
    press(' ', 0.5);
    press(' ', 0.51); // bounce: ignored
    press('Backspace', 0);
    expect($('.imp-tap-status').textContent).toContain('1 of 16');
    for (let i = 1; i < 16; i++) press(' ', i * 0.4);
    expect(t.toast).toHaveBeenCalledWith(expect.stringContaining('All 16 onsets tapped'), { kind: 'success' });
    expect(t.engine.transport.stop).toHaveBeenCalled();

    byLabel('Save to library').click();
    await flush(10);
    const req = t.api.paste.mock.calls[0][0] as PasteRequest;
    expect(req.sidecar?.method).toBe('tap');
    expect(req.sidecar?.onsets).toEqual([0.02, ...Array.from({ length: 15 }, (_, i) => Math.round((i + 1) * 0.4 * 1e6) / 1e6)]);
  });

  it('asks before saving an incomplete tap-along', async () => {
    const t = harness();
    t.confirm.mockResolvedValueOnce(false);
    handle = await mount(root, t.ctx, {});
    await paste(ARPEGGIO);
    type(inputs()[0], 'Half');
    byLabel('Tap along').click();
    byLabel('Start tapping').click();
    await flush(10);
    nextTapTime = 0;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('.imp-tap-status').textContent).toContain('the rest are estimated');
    byLabel('Save to library').click();
    await flush(10);
    expect(t.confirm).toHaveBeenCalled();
    expect(t.api.paste).not.toHaveBeenCalled();
  });

  it('align mode (?song=) loads a library tab read-only and saves only the sidecar', async () => {
    const t = harness();
    t.api.song.mockResolvedValue({ entry: { id: 'local:abc', format: 'ascii', title: 'Riff', artist: 'Band' } });
    t.api.songBundle.mockResolvedValue({ fileName: 'Band - Riff.txt', data: new TextEncoder().encode(ARPEGGIO) });
    handle = await mount(root, t.ctx, { song: 'local:abc' });
    expect($('h1').textContent).toBe('Align rhythm');
    expect($<HTMLTextAreaElement>('textarea').readOnly).toBe(true);
    expect(root.querySelector('a.imp-ug')).toBeNull();
    byLabel('Save rhythm').click();
    await flush(10);
    expect(t.api.putSidecar).toHaveBeenCalledWith('local:abc', expect.objectContaining({ method: 'snap', grid: 8 }));
    expect((t.api.putSidecar.mock.calls[0][1] as RhythmSidecar).onsets).toHaveLength(16);
    expect(t.navigate).toHaveBeenCalledWith('#/song/local:abc');
  });

  it('align mode prefills from an existing sidecar and explains non-ASCII songs', async () => {
    const t = harness();
    const saved: RhythmSidecar = { schema: 1, bpm: 90, timeSig: [3, 4], grid: 16, onsets: Array.from({ length: 16 }, (_, i) => i * 0.3), method: 'tap', savedAt: 1 };
    t.api.song.mockResolvedValue({ entry: { id: 'local:abc', format: 'ascii', title: 'Riff' } });
    t.api.songBundle.mockResolvedValue({ fileName: 'Riff.txt', data: new TextEncoder().encode(ARPEGGIO), sidecar: saved });
    handle = await mount(root, t.ctx, { song: 'local:abc' });
    expect(inputs()[0].value).toBe('90');
    expect($('.imp-tap-status').textContent).toContain('All 16 onsets tapped');
    handle.unmount();

    t.api.song.mockResolvedValue({ entry: { id: 'local:gp', format: 'gp', title: 'Exact' } });
    t.api.songBundle.mockResolvedValue({ fileName: 'Exact.gp', data: new Uint8Array([1]) });
    handle = await mount(root, t.ctx, { song: 'local:gp' });
    expect($('h1').textContent).toBe('This song already has its rhythm');
  });
});
