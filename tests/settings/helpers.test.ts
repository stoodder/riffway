// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '@shared/settings';
import { emptyStores } from '../../src/storage/export';
import { neighbour, STEP_IDS, stepFromParam, stepStatuses, summaryRows, formatOffset } from '../../src/ui/screens/audio-setup/steps';
import { countRows, storeCounts } from '../../src/ui/screens/settings/data';
import { formatNoteSpeed, genreLabel, toggleGenre } from '../../src/ui/screens/settings/gameplay';
import { calibrationSummary, relativeDays } from '../../src/ui/screens/settings/input';
import { assignKey, isDefaultKeys, keyLabel, reservedReason, type LaneKeys } from '../../src/ui/screens/settings/keys';
import { classtabProgress, classtabSummary, validateImportSubfolder } from '../../src/ui/screens/settings/library';
import { tabFromParams } from '../../src/ui/screens/settings';
import { readyClassTab } from './fake';

const DEFAULT_KEYS: LaneKeys = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'];

describe('key map helpers', () => {
  it('labels key codes', () => {
    expect(['Digit1', 'KeyJ', 'Numpad4', 'Semicolon', 'ArrowLeft', 'Quote', 'F13x'].map(keyLabel)).toEqual(['1', 'J', 'Num 4', ';', '←', "'", 'F13x']);
  });

  it('refuses keys the game, the browser or the wrong-pitch modifier use', () => {
    for (const code of ['Escape', 'Space', 'Tab', 'Enter', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'F5', 'Unidentified', '']) {
      expect(reservedReason(code), code).not.toBeNull();
    }
    expect(reservedReason('ShiftLeft')).toMatch(/wrong note/);
    for (const code of ['Digit7', 'KeyA', 'Semicolon', 'Numpad1', 'ArrowUp']) expect(reservedReason(code), code).toBeNull();
  });

  it('assigns a free key and swaps a key that another lane uses', () => {
    expect(assignKey(DEFAULT_KEYS, 0, 'KeyJ')).toEqual(['KeyJ', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6']);
    expect(assignKey(DEFAULT_KEYS, 0, 'Digit3')).toEqual(['Digit3', 'Digit2', 'Digit1', 'Digit4', 'Digit5', 'Digit6']);
    expect(assignKey(DEFAULT_KEYS, 2, 'Digit3')).toEqual(DEFAULT_KEYS);
    expect(() => assignKey(DEFAULT_KEYS, 6, 'KeyA')).toThrow(RangeError);
    expect(isDefaultKeys(DEFAULT_KEYS)).toBe(true);
    expect(isDefaultKeys(assignKey(DEFAULT_KEYS, 5, 'KeyL'))).toBe(false);
  });
});

describe('gameplay helpers', () => {
  it('formats note speed and genres', () => {
    expect(formatNoteSpeed(1)).toBe('1.00×');
    expect(formatNoteSpeed(1.25)).toBe('1.25×');
    expect(genreLabel('recognizable')).toBe('Recognisable tunes');
    expect(genreLabel('rock')).toBe('Rock');
  });

  it('toggles genres keeping known ones in order and custom ones after', () => {
    expect(toggleGenre(['rock', 'metal'], 'blues', true)).toEqual(['rock', 'metal', 'blues']);
    expect(toggleGenre(['shoegaze', 'metal'], 'rock', true)).toEqual(['rock', 'metal', 'shoegaze']);
    expect(toggleGenre(['rock', 'metal', 'recognizable'], 'metal', false)).toEqual(['rock', 'recognizable']);
    expect(toggleGenre(['rock'], 'rock', true)).toEqual(['rock']);
  });
});

describe('library helpers', () => {
  it('validates the drop subfolder', () => {
    expect(validateImportSubfolder('')).toBeNull();
    expect(validateImportSubfolder('  ')).toBeNull();
    expect(validateImportSubfolder('Imported')).toBeNull();
    expect(validateImportSubfolder('Imported/2026')).toBeNull();
    expect(validateImportSubfolder('/Users/me/x')).toMatch(/inside the library/);
    expect(validateImportSubfolder('~/x')).toMatch(/inside the library/);
    expect(validateImportSubfolder('C:\\x')).toMatch(/inside the library/);
    expect(validateImportSubfolder('a/../../b')).toMatch(/no “..”/);
    expect(validateImportSubfolder('a\u0007b')).toMatch(/invalid characters/);
  });

  it('summarises ClassTab status', () => {
    const ready = classtabSummary(readyClassTab());
    expect(ready.badge).toEqual({ text: 'Ready', tone: 'success' });
    expect(ready.lines[0]).toBe('3,976 tabs · 2,341 MIDI files');
    expect(ready.lines[1]).toBe('Rhythm: 1,921 from MIDI · 432 from the beat ruler · 1,616 need alignment');
    expect(ready.lines[2]).toMatch(/^Last checked 19 Nov 2026, .* · zip dated 1 Nov 2026/);
    const none = classtabSummary({ ...readyClassTab(), state: 'not-downloaded', lastRefresh: null, tabs: 0 });
    expect(none.badge.text).toBe('Not downloaded');
    expect(none.lines).toHaveLength(1);
    expect(none.lines[0]).toMatch(/Not downloaded yet/);
    const err = classtabSummary({ ...readyClassTab(), state: 'error', error: 'HTTP 503' });
    expect(err.badge.tone).toBe('danger');
    expect(err.lines.at(-1)).toBe('Last refresh failed: HTTP 503');
  });

  it('describes ClassTab progress events', () => {
    const p = (ev: Omit<Parameters<typeof classtabProgress>[0], 'type'>) => classtabProgress({ type: 'classtab.progress', ...ev });
    expect(p({ phase: 'checking' })).toEqual({ text: 'Checking classtab.org for an update…', fraction: null, finished: false });
    expect(p({ phase: 'downloading', bytes: 7_340_032, totalBytes: 14_680_064 })).toEqual({ text: 'Downloading… 7.0 of 14.0 MB', fraction: 0.5, finished: false });
    expect(p({ phase: 'downloading', bytes: 1_048_576 }).text).toBe('Downloading… 1.0 MB');
    expect(p({ phase: 'extracting' }).finished).toBe(false);
    expect(p({ phase: 'indexing' }).text).toBe('Indexing tabs…');
    expect(p({ phase: 'done' })).toMatchObject({ finished: true, fraction: 1 });
    expect(p({ phase: 'not-modified' }).text).toMatch(/already have the latest/);
    expect(p({ phase: 'error', message: 'timeout' })).toEqual({ text: 'Refresh failed: timeout', fraction: null, finished: true });
  });
});

describe('input and data helpers', () => {
  it('summarises calibration', () => {
    const now = new Date(2026, 10, 19, 20).getTime();
    expect(calibrationSummary(defaultSettings().calibration, now)).toMatchObject({ calibrated: false, status: 'Not calibrated yet' });
    const cal = { ...defaultSettings().calibration, method: 'play-to-click' as const, inputOffsetMs: 41.6, keyboardOffsetMs: -3, measuredAt: new Date(2026, 10, 18, 9).getTime(), spreadMs: 4.2 };
    const sum = calibrationSummary(cal, now);
    expect(sum.status).toBe('Calibrated by playing along to clicks · yesterday');
    expect(sum.lines).toEqual([
      { label: 'Guitar offset', value: '+42 ms' },
      { label: 'Keyboard offset', value: '−3 ms' },
      { label: 'Visual offset', value: '0 ms' },
      { label: 'Spread', value: '±4 ms' },
    ]);
    expect(relativeDays(now - 3_600_000, now)).toBe('today');
    expect(relativeDays(new Date(2026, 10, 12, 23).getTime(), now)).toBe('7 days ago');
  });

  it('counts stores in display order', () => {
    const stores = { ...emptyStores(), practiceDays: [{ date: '2026-11-19', activeSec: 600, runs: 2 }] };
    const rows = countRows(storeCounts(stores));
    expect(rows.map((r) => r.label)).toEqual(['Runs', 'Personal bests', 'Section progress', 'Practice days', 'Streak', 'Songs played', 'Backing-audio links', 'Rhythm alignments']);
    expect(rows.find((r) => r.key === 'practiceDays')?.count).toBe(1);
  });

  it('reads the tab param', () => {
    expect(tabFromParams({})).toBe('gameplay');
    expect(tabFromParams({ tab: 'data' })).toBe('data');
    expect(tabFromParams({ tab: 'nope' })).toBe('gameplay');
  });
});

describe('audio setup steps', () => {
  const with_ = (patch: (s: Settings) => void): Settings => {
    const s = defaultSettings();
    patch(s);
    return s;
  };

  it('orders the guided flow and reads the step param', () => {
    expect(STEP_IDS).toEqual(['input', 'tuner', 'monitor', 'calibration', 'done']);
    expect(stepFromParam(undefined)).toBe('input');
    expect(stepFromParam('calibration')).toBe('calibration');
    expect(stepFromParam('bogus')).toBe('input');
    expect(neighbour('input', -1)).toBeNull();
    expect(neighbour('input', 1)).toBe('tuner');
    expect(neighbour('done', 1)).toBeNull();
    expect(neighbour('done', -1)).toBe('calibration');
  });

  it('derives statuses from settings', () => {
    const fresh = stepStatuses(defaultSettings());
    expect(fresh.input).toEqual({ tone: 'todo', text: 'Not connected yet' });
    expect(fresh.monitor).toEqual({ tone: 'done', text: 'On · Clean' });
    expect(fresh.calibration).toEqual({ tone: 'todo', text: 'Not calibrated' });
    expect(fresh.done.tone).toBe('todo');
    const set = stepStatuses(
      with_((s) => {
        s.input.label = 'USB Audio CODEC';
        s.monitor = { ...s.monitor, enabled: false };
        s.calibration = { ...s.calibration, method: 'play-to-click', inputOffsetMs: 38.4 };
      }),
    );
    expect(set.input).toEqual({ tone: 'done', text: 'USB Audio CODEC' });
    expect(set.monitor).toEqual({ tone: 'optional', text: 'Off' });
    expect(set.calibration).toEqual({ tone: 'done', text: '+38 ms offset' });
    expect(set.done).toEqual({ tone: 'done', text: 'Ready to play' });
    expect(stepStatuses(with_((s) => (s.calibration.method = 'estimated'))).calibration.tone).toBe('warning');
    expect(stepStatuses(with_((s) => (s.calibration = { ...s.calibration, method: 'tap-to-click', keyboardOffsetMs: -12 }))).calibration.text).toBe('−12 ms offset');
  });

  it('builds the summary rows', () => {
    expect(summaryRows(defaultSettings()).map((r) => [r.label, r.value, r.step])).toEqual([
      ['Guitar input', 'Not connected yet', 'input'],
      ['Output', 'System default', 'input'],
      ['Monitoring', 'On · Clean amp', 'monitor'],
      ['Latency calibration', 'Not calibrated', 'calibration'],
    ]);
    const rows = summaryRows(
      with_((s) => {
        s.input = { deviceId: 'abc', label: 'USB Audio CODEC', channel: 'mix' };
        s.output = { sinkId: 'hp', label: 'External Headphones' };
        s.monitor = { ...s.monitor, preset: 'overdrive' };
        s.calibration = { ...s.calibration, method: 'play-to-click', inputOffsetMs: 40, keyboardOffsetMs: 12, spreadMs: 3.6 };
      }),
    );
    expect(rows.map((r) => r.value)).toEqual(['USB Audio CODEC (channels 1 + 2)', 'External Headphones', 'On · Overdrive amp', 'Guitar +40 ms · keyboard +12 ms · spread ±4 ms']);
    expect(formatOffset(0.4)).toBe('0 ms');
  });
});
