// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RhythmSidecar } from '@shared/song';
import type { ExportFile } from '@shared/storage';
import type { ScreenHandle } from '@shared/ui';
import { openStorage, serializeBackup } from '../../src/storage';
import { mount } from '../../src/ui/screens/settings';
import { makeBest, makeRun } from '../storage/fixtures';
import { createFakeServer, fakeContext, FakeEventSource, type FakeCtx, type FakeServer } from './fake';

const SIDECAR: RhythmSidecar = { schema: 1, bpm: 96, timeSig: [4, 4], grid: 8, onsets: [0, 0.3125, 0.625], method: 'snap', savedAt: 1_000 };

describe('settings screen', () => {
  let server: FakeServer;
  let fake: FakeCtx;
  let el: HTMLElement;
  let handle: ScreenHandle | null;
  const extra: { close(): void }[] = [];

  async function start(params: Record<string, string> = {}): Promise<ScreenHandle> {
    handle = await mount(el, fake.ctx, params);
    return handle;
  }
  const q = <T extends Element = HTMLElement>(sel: string): T => {
    const found = el.querySelector<T>(sel);
    if (!found) throw new Error(`no ${sel}`);
    return found;
  };
  const tab = (label: string): void => {
    const btn = Array.from(el.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => t.textContent === label);
    if (!btn) throw new Error(`no tab ${label}`);
    btn.click();
  };
  const switchFor = (label: string): HTMLButtonElement => {
    const field = Array.from(el.querySelectorAll('.rw-toggle')).find((f) => f.querySelector('.rw-field__label')?.textContent?.startsWith(label));
    if (!field) throw new Error(`no toggle ${label}`);
    return field.querySelector('button[role="switch"]') as HTMLButtonElement;
  };
  const radio = (value: string): HTMLInputElement => q<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
  const choose = (input: HTMLInputElement): void => {
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const button = (label: string): HTMLButtonElement => {
    const b = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((x) => x.textContent?.trim() === label && !x.hidden);
    if (!b) throw new Error(`no button ${label}`);
    return b;
  };

  beforeEach(async () => {
    server = createFakeServer();
    fake = await fakeContext(server);
    el = document.createElement('div');
    document.body.replaceChildren(el);
    handle = null;
  });

  afterEach(() => {
    handle?.unmount();
    fake.storage.close();
    while (extra.length) extra.pop()!.close();
    vi.restoreAllMocks();
  });

  it('shows an unavailable view instead of throwing when the context is incomplete', async () => {
    const h2 = await mount(el, {} as never, {});
    expect(q('h1').textContent).toBe('Settings');
    expect(el.textContent).toContain('missing: api, settings, storage, router, ui');
    h2.unmount();
    expect(el.childElementCount).toBe(0);
  });

  describe('gameplay and practice', () => {
    it('shows the stored values and saves every change, surviving a reload', async () => {
      await start();
      expect(q('h1').textContent).toBe('Settings');
      expect(radio('standard').checked).toBe(true);
      expect(switchFor('Hand-position cues').getAttribute('aria-checked')).toBe('true');
      expect(switchFor('Strict octave').getAttribute('aria-checked')).toBe('false');
      expect(el.querySelector('.set-windows')?.textContent).toBe('Perfect±35 msGreat±70 msGood±120 ms');

      choose(radio('detailed'));
      switchFor('Hand-position cues').click();
      switchFor('Strict octave').click();
      switchFor('Guide synth').click();
      const speed = q<HTMLInputElement>('input[type="range"]');
      speed.value = '1.5';
      speed.dispatchEvent(new Event('input'));
      speed.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(fake.ctx.settings.get().game.noteSpeed).toBe(1.5));
      expect(el.querySelector('.rw-slider__value')?.textContent).toBe('1.50×');

      tab('Practice & goals');
      const daily = Array.from(el.querySelectorAll('select')).find((s) => s.options[0]?.text === '5 minutes') as HTMLSelectElement;
      daily.value = '30';
      daily.dispatchEvent(new Event('change'));
      switchFor('Speed trainer').click();
      choose(radio('fingerstyle'));
      q<HTMLButtonElement>('.set-genre[data-genre="blues"]').click();
      await vi.waitFor(() => expect(q('.set-genre[data-genre="blues"]').getAttribute('aria-pressed')).toBe('true'));

      // Reload: a second connection to the same database sees everything.
      await vi.waitFor(async () => {
        const again = await openStorage({ dbName: fake.dbName });
        extra.push(again);
        const s = again.settings.get();
        expect(s.game).toMatchObject({ feedbackDetail: 'detailed', handCues: false, strictOctave: true, guide: false, noteSpeed: 1.5 });
        expect(s.goals.dailyMinutes).toBe(30);
        expect(s.practice.speedTrainer).toBe(false);
        expect(s.preferences).toMatchObject({ style: 'fingerstyle', genres: ['rock', 'metal', 'recognizable', 'blues'] });
      });
    });

    it('sets timing leniency (windows follow), input mode, fret numbers and the metronome accent', async () => {
      await start();
      expect(switchFor('Fret numbers').getAttribute('aria-checked')).toBe('true');
      expect(radio('auto').checked).toBe(true);
      choose(radio('relaxed'));
      await vi.waitFor(() => expect(el.querySelector('.set-windows')?.textContent).toBe('Perfect±53 msGreat±105 msGood±180 ms'));
      choose(radio('keyboard'));
      switchFor('Fret numbers').click();
      tab('Practice & goals');
      switchFor('Accent downbeats').click();
      await vi.waitFor(() => {
        const s = fake.ctx.settings.get();
        expect(s.game).toMatchObject({ timingLeniency: 'relaxed', inputMode: 'keyboard', fretNumbers: false });
        expect(s.practice.metronomeAccent).toBe(false);
      });
    });

    it('follows changes made elsewhere (import, reset)', async () => {
      await start();
      await fake.ctx.settings.update({ game: { feedbackDetail: 'minimal', strictOctave: true } });
      expect(radio('minimal').checked).toBe(true);
      expect(switchFor('Strict octave').getAttribute('aria-checked')).toBe('true');
    });

    it('keeps the selected tab in the route and follows route updates', async () => {
      await start({ tab: 'data' });
      expect(q('[role="tab"][aria-selected="true"]').textContent).toBe('Data');
      tab('Input');
      expect(fake.navigations.at(-1)).toBe('/settings?tab=input');
      tab('Gameplay');
      expect(fake.navigations.at(-1)).toBe('/settings');
      handle?.update?.({ tab: 'library' });
      expect(q('[role="tab"][aria-selected="true"]').textContent).toBe('Library & sources');
    });
  });

  describe('input', () => {
    it('shows devices and calibration, and links to audio setup', async () => {
      await fake.ctx.settings.update({ input: { label: 'USB Audio CODEC' }, calibration: { method: 'play-to-click', inputOffsetMs: 42, measuredAt: Date.now(), spreadMs: 3 } });
      await start({ tab: 'input' });
      expect(el.querySelector('.set-device')?.textContent).toContain('USB Audio CODEC');
      expect(el.querySelector('.set-device')?.textContent).toContain('System default');
      expect(q('.set-cal__status').textContent).toBe('Calibrated Calibrated by playing along to clicks · today');
      expect(q('.set-cal__list').textContent).toContain('Guitar offset+42 ms');
      const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('a.rw-btn')).map((a) => a.getAttribute('href'));
      expect(links).toEqual(['#/audio-setup?step=input', '#/audio-setup?step=calibration', '#/audio-setup?step=calibration&mode=keyboard']);
    });

    it('remaps a lane key on a key press, swapping duplicates and refusing reserved keys', async () => {
      await start({ tab: 'input' });
      const keys = (): string[] => Array.from(el.querySelectorAll('.set-keys__key')).map((k) => k.textContent ?? '');
      expect(keys()).toEqual(['1', '2', '3', '4', '5', '6']);
      const change = (lane: number): HTMLButtonElement => q<HTMLButtonElement>(`.set-keys__row[data-lane="${lane}"] button`);
      const press = (code: string): KeyboardEvent => {
        const ev = new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true });
        document.body.dispatchEvent(ev);
        return ev;
      };

      change(1).click();
      expect(keys()[0]).toBe('Press a key…');
      expect(q('.set-keys__status').textContent).toMatch(/Press the key for string 1/);
      press('Space');
      expect(q('.set-keys__status').textContent).toMatch(/Space can’t be used: Space starts and pauses/);
      expect(keys()[0]).toBe('Press a key…');
      const ev = press('KeyJ');
      expect(ev.defaultPrevented).toBe(true);
      expect(keys()).toEqual(['J', '2', '3', '4', '5', '6']);
      await vi.waitFor(() => expect(fake.ctx.settings.get().keyboard.lanes[0]).toBe('KeyJ'));

      change(6).click();
      press('Digit2');
      expect(keys()).toEqual(['J', '6', '3', '4', '5', '2']);
      expect(q('.set-keys__status').textContent).toBe('String 6 now uses 2. String 2 now uses 6.');
      await vi.waitFor(() => expect(fake.ctx.settings.get().keyboard.lanes).toEqual(['KeyJ', 'Digit6', 'Digit3', 'Digit4', 'Digit5', 'Digit2']));

      change(3).click();
      press('Escape');
      expect(keys()[2]).toBe('3');
      expect(q('.set-keys__status').textContent).toBe('Key change canceled.');
      // After cancelling, key presses are not captured.
      expect(press('KeyK').defaultPrevented).toBe(false);

      button('Restore 1–6').click();
      await vi.waitFor(() => expect(fake.ctx.settings.get().keyboard.lanes).toEqual(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6']));
      expect(keys()).toEqual(['1', '2', '3', '4', '5', '6']);
      expect(button('Restore 1–6').disabled).toBe(true);
    });
  });

  describe('library & sources', () => {
    const dir = (): HTMLInputElement => q<HTMLInputElement>('.set-folder input');
    const sub = (): HTMLInputElement => el.querySelectorAll<HTMLInputElement>('.set-folder input')[1] as HTMLInputElement;
    const submit = (): void => void q('.set-folder').dispatchEvent(new Event('submit', { cancelable: true }));
    const type = (input: HTMLInputElement, value: string): void => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };

    it('validates and saves the library folder and drop subfolder', async () => {
      await start({ tab: 'library' });
      await vi.waitFor(() => expect(dir().value).toBe('/Users/me/Music/Tabs'));
      const save = button('Save');
      expect(save.disabled).toBe(true);

      type(dir(), 'Music/Tabs');
      expect(save.disabled).toBe(false);
      submit();
      expect(el.querySelectorAll('.set-field__error')[0]?.textContent).toMatch(/Use a full path/);
      expect(dir().getAttribute('aria-invalid')).toBe('true');
      expect(server.requests.some((r) => r.startsWith('PUT'))).toBe(false);

      type(dir(), '~/Guitar/Tabs');
      expect(dir().getAttribute('aria-invalid')).toBeNull();
      type(sub(), '../outside');
      submit();
      expect(el.querySelectorAll('.set-field__error')[1]?.textContent).toMatch(/inside the library/);
      type(sub(), 'Imported');
      submit();
      await vi.waitFor(() => expect(server.requests).toContain('PUT /api/config {"libraryDir":"~/Guitar/Tabs","importSubfolder":"Imported"}'));
      await vi.waitFor(() => expect(fake.toasts.at(-1)?.message).toBe('Library folder set to ~/Guitar/Tabs. Scanning it now…'));
      expect(save.disabled).toBe(true);
    });

    it('shows the server’s refusal next to the field', async () => {
      server.configError = 'libraryDir must be an absolute path';
      await start({ tab: 'library' });
      await vi.waitFor(() => expect(dir().value).toBe('/Users/me/Music/Tabs'));
      type(dir(), '/nope');
      submit();
      await vi.waitFor(() => expect(el.querySelectorAll('.set-field__error')[0]?.textContent).toBe('libraryDir must be an absolute path'));
    });

    it('lists sources and enables or disables them', async () => {
      await start({ tab: 'library' });
      await vi.waitFor(() => expect(el.querySelectorAll('.set-source')).toHaveLength(6));
      expect(q('.set-source[data-source="classtab"]').textContent).toContain('Downloaded bundle · 3,976 indexed');
      expect(q('.set-source[data-source="songsterr"]').textContent).toContain('Link-out search');
      q<HTMLButtonElement>('.set-source[data-source="classtab"] button[role="switch"]').click();
      await vi.waitFor(() => expect(server.config.enabledSources).not.toContain('classtab'));
      expect(server.requests.at(-1)).toBe('PUT /api/config {"enabledSources":["local","starter","songsterr","ultimate-guitar","gp-pack"]}');
      await vi.waitFor(() => expect(fake.toasts.at(-1)).toEqual({ message: 'ClassTab disabled.', kind: 'success' }));
    });

    it('shows ClassTab status, refuses a too-early refresh with a reason, forces it and follows progress', async () => {
      server.refreshAnswer = { started: false, reason: 'Checked 3 h ago; refresh is limited to once a day (force to check again)' };
      await start({ tab: 'library' });
      await vi.waitFor(() => expect(q('.set-ct__badge').textContent).toBe('Ready'));
      expect(q('.set-ct__lines').textContent).toContain('3,976 tabs · 2,341 MIDI files');

      button('Check for update').click();
      await vi.waitFor(() => expect(q('.set-ct__reason').hidden).toBe(false));
      expect(q('.set-ct__reason').textContent).toMatch(/limited to once a day/);
      button('Check anyway').click();
      await vi.waitFor(() => expect(server.requests).toContain('POST /api/classtab/refresh {"force":true}'));
      await vi.waitFor(() => expect(q('.set-ct__progress-text').textContent).toBe('Starting…'));
      expect(button('Check for update').disabled).toBe(true);

      const sse = FakeEventSource.last as FakeEventSource;
      sse.emit({ type: 'classtab.progress', phase: 'downloading', bytes: 7_340_032, totalBytes: 14_680_064 });
      expect(q('.set-ct__progress-text').textContent).toBe('Downloading… 7.0 of 14.0 MB');
      expect(q<HTMLProgressElement>('.set-ct__bar').hidden).toBe(false);
      expect(q<HTMLProgressElement>('.set-ct__bar').value).toBeCloseTo(0.5);
      server.classtab = { ...server.classtab, tabs: 4000 };
      sse.emit({ type: 'classtab.progress', phase: 'done' });
      expect(q('.set-ct__progress-text').textContent).toBe('ClassTab is up to date.');
      expect(q<HTMLProgressElement>('.set-ct__bar').hidden).toBe(true);
      await vi.waitFor(() => expect(q('.set-ct__lines').textContent).toContain('4,000 tabs'));
      expect(button('Check for update').disabled).toBe(false);
    });

    it('stays usable when the outcome arrives before the refresh response', async () => {
      await start({ tab: 'library' });
      await vi.waitFor(() => expect(q('.set-ct__badge').textContent).toBe('Ready'));
      const sse = FakeEventSource.last as FakeEventSource;
      button('Check for update').click();
      sse.emit({ type: 'classtab.progress', phase: 'not-modified' });
      await vi.waitFor(() => expect(button('Check for update').disabled).toBe(false));
      expect(q('.set-ct__progress-text').textContent).toMatch(/already have the latest/);
    });

    it('offers to download ClassTab when it is missing', async () => {
      server.classtab = { ...server.classtab, state: 'not-downloaded', tabs: 0, midis: 0, lastRefresh: null };
      await start({ tab: 'library' });
      await vi.waitFor(() => expect(button('Download ClassTab')).toBeTruthy());
      expect(q('.set-ct__lines').textContent).toMatch(/Not downloaded yet/);
    });

    it('explains an unreachable server and retries', async () => {
      server.down = true;
      await start({ tab: 'library' });
      await vi.waitFor(() => expect(q('.set-banner').hidden).toBe(false));
      expect(q('.set-banner').textContent).toMatch(/Can't reach the Riffway companion server/);
      server.down = false;
      button('Try again').click();
      await vi.waitFor(() => expect(q('.set-banner').hidden).toBe(true));
      expect(dir().value).toBe('/Users/me/Music/Tabs');
    });

    it('unsubscribes from server events on unmount', async () => {
      await start({ tab: 'library' });
      const sse = FakeEventSource.last as FakeEventSource;
      handle?.unmount();
      handle = null;
      expect(sse.closed).toBe(true);
    });
  });

  describe('data', () => {
    let downloads: { name: string; text: string }[];

    beforeEach(() => {
      downloads = [];
      const blobs = new Map<string, Blob>();
      vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
        const url = `blob:test/${blobs.size}`;
        blobs.set(url, b as Blob);
        return url;
      });
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        const blob = blobs.get(this.href);
        if (blob) void blob.text().then((text) => downloads.push({ name: this.download, text }));
      });
    });

    async function seed(): Promise<void> {
      const s = fake.storage;
      const runId = await s.addRun(makeRun());
      await s.putBestIfBetter(makeBest({ runId }));
      await s.addPracticeTime('2026-11-19', 600, 1);
    }

    const pick = async (name: string, text: string): Promise<void> => {
      const input = q<HTMLInputElement>('input[type="file"]');
      const file = new File([text], name, { type: 'application/json' });
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      input.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(q('.set-preview').hidden).toBe(false));
    };
    const count = (scope: string, key: string): string => q(`${scope} [data-count="${key}"] dd`).textContent ?? '';

    it('summarises local data and exports a backup with the server’s sidecars', async () => {
      await seed();
      server.sidecars = { 'local:abc': SIDECAR };
      await start({ tab: 'data' });
      await vi.waitFor(() => expect(count('.set-counts--local', 'runs')).toBe('1'));
      expect(count('.set-counts--local', 'practiceDays')).toBe('1');

      button('Export backup').click();
      await vi.waitFor(() => expect(downloads).toHaveLength(1));
      const { name, text } = downloads[0]!;
      expect(name).toMatch(/^riffway-backup-\d{4}-\d{2}-\d{2}\.json$/);
      const file = JSON.parse(text) as ExportFile;
      expect(file.app).toBe('riffway');
      expect(file.stores.runs).toHaveLength(1);
      expect(file.server.sidecars).toEqual({ 'local:abc': SIDECAR });
      expect(q('.set-data__status').textContent).toBe(`Saved ${name}.`);
      expect(fake.toasts.at(-1)).toEqual({ message: `Backup saved as ${name}`, kind: 'success' });
    });

    it('still exports when the server is down, saying the alignments are missing', async () => {
      server.down = true;
      await start({ tab: 'data' });
      button('Export backup').click();
      await vi.waitFor(() => expect(downloads).toHaveLength(1));
      expect(q('.set-data__status').textContent).toMatch(/Rhythm alignments weren’t included: Can't reach/);
      expect(fake.toasts.at(-1)?.kind).toBe('warning');
    });

    it('shows clear errors for files it cannot import, without changing anything', async () => {
      await seed();
      await start({ tab: 'data' });
      await pick('notes.json', '{ nope');
      expect(q('.set-preview__title').textContent).toBe('This file can’t be imported');
      expect(q('.set-preview__errors').textContent).toMatch(/not valid JSON/);

      await pick('other.json', JSON.stringify({ app: 'tuxguitar' }));
      expect(q('.set-preview__errors').textContent).toBe('This file is not a Riffway backup ("app" is "tuxguitar").');

      const good = await fake.storage.exportAll();
      await pick('future.json', JSON.stringify({ ...good, schemaVersion: 99 }));
      expect(q('.set-preview__errors').textContent).toMatch(/newer version of Riffway \(schema 99\)/);

      const bad = structuredClone(good) as unknown as { stores: { runs: { accuracy: unknown }[]; practiceDays: { activeSec: unknown }[] } };
      bad.stores.runs[0]!.accuracy = 'lots';
      bad.stores.practiceDays[0]!.activeSec = -5;
      await pick('broken.json', JSON.stringify(bad));
      const errors = Array.from(el.querySelectorAll('.set-preview__errors li')).map((li) => li.textContent);
      expect(errors.length).toBe(2);
      expect(errors[0]).toMatch(/^stores\.runs\[0\]\.accuracy: /);
      expect(errors[1]).toMatch(/^stores\.practiceDays\[0\]\.activeSec: /);
      expect(q('.set-preview').textContent).toContain('2 problems were found. Nothing has been changed.');
      expect(el.querySelector('.set-preview button.rw-btn--primary')).toBeNull();
      expect((await fake.storage.listRuns()).length).toBe(1);

      button('Cancel').click();
      expect(q('.set-preview').hidden).toBe(true);
    });

    it('previews and merges a backup, keeping local settings and posting its sidecars', async () => {
      await seed();
      const backup = await fake.storage.exportAll();
      backup.settings.game.feedbackDetail = 'minimal';
      backup.stores.practiceDays.push({ date: '2026-11-18', activeSec: 900, runs: 3 });
      backup.server.sidecars = { 'local:abc': SIDECAR };
      await start({ tab: 'data' });
      await pick('riffway-backup-2026-11-19.json', serializeBackup(backup));
      expect(q('.set-preview__title').textContent).toBe('Ready to import');
      expect(q('.set-preview__meta').textContent).toContain('riffway-backup-2026-11-19.json');
      expect(count('.set-preview', 'practiceDays')).toBe('2');
      expect(count('.set-preview', 'sidecars')).toBe('1');
      expect(radio('merge').checked).toBe(true);

      button('Merge into my data').click();
      await vi.waitFor(() => expect(fake.toasts.at(-1)).toEqual({ message: 'Backup merged.', kind: 'success' }));
      expect(fake.confirms).toHaveLength(0);
      expect(server.postedSidecars).toEqual([{ 'local:abc': SIDECAR }]);
      expect((await fake.storage.listPracticeDays()).map((d) => d.date)).toEqual(['2026-11-18', '2026-11-19']);
      expect(fake.ctx.settings.get().game.feedbackDetail).toBe('standard');
      expect(q('.set-preview').hidden).toBe(true);
    });

    it('replaces only after a confirmation and restores the backup’s settings', async () => {
      const backup = await fake.storage.exportAll();
      backup.settings.game.feedbackDetail = 'detailed';
      await seed();
      await start({ tab: 'data' });
      await pick('b.json', serializeBackup(backup));
      choose(radio('replace'));
      const apply = button('Replace my data');
      expect(apply.className).toContain('rw-btn--danger');

      fake.confirmAnswer = false;
      apply.click();
      await vi.waitFor(() => expect(fake.confirms).toHaveLength(1));
      expect(fake.confirms[0]).toMatchObject({ title: 'Replace your data?', danger: true });
      expect((await fake.storage.listRuns()).length).toBe(1);

      fake.confirmAnswer = true;
      apply.click();
      await vi.waitFor(() => expect(fake.toasts.at(-1)?.message).toBe('Backup restored.'));
      expect((await fake.storage.listRuns()).length).toBe(0);
      expect(fake.ctx.settings.get().game.feedbackDetail).toBe('detailed');
      await vi.waitFor(() => expect(count('.set-counts--local', 'runs')).toBe('0'));
    });

    it('warns when progress imported but the sidecars could not be sent', async () => {
      const backup = await fake.storage.exportAll();
      backup.server.sidecars = { 'local:abc': SIDECAR };
      await start({ tab: 'data' });
      await pick('b.json', serializeBackup(backup));
      server.down = true;
      button('Merge into my data').click();
      await vi.waitFor(() => expect(fake.toasts.at(-1)?.kind).toBe('warning'));
      expect(fake.toasts.at(-1)?.message).toMatch(/^Backup merged\. Rhythm alignments weren’t restored/);
    });

    it('restores default settings and deletes all data only after confirming', async () => {
      await seed();
      await fake.ctx.settings.update({ game: { strictOctave: true } });
      await start({ tab: 'data' });

      fake.confirmAnswer = false;
      button('Delete all data…').click();
      await vi.waitFor(() => expect(fake.confirms).toHaveLength(1));
      expect(fake.confirms[0]).toMatchObject({ title: 'Delete all Riffway data?', danger: true });
      expect((await fake.storage.listRuns()).length).toBe(1);

      fake.confirmAnswer = true;
      button('Restore default settings').click();
      await vi.waitFor(() => expect(fake.ctx.settings.get().game.strictOctave).toBe(false));
      expect((await fake.storage.listRuns()).length).toBe(1);

      button('Delete all data…').click();
      await vi.waitFor(() => expect(fake.toasts.at(-1)?.message).toMatch(/All data deleted/));
      expect((await fake.storage.listRuns()).length).toBe(0);
      expect(await fake.storage.listPracticeDays()).toEqual([]);
    });
  });
});
