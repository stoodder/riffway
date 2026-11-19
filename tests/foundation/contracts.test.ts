import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, defaultSettings } from '@shared/settings';
import { NotImplementedError, isNotImplemented, notImplemented } from '@shared/errors';
import { SOURCE_IDS, type Song } from '@shared/song';
import { OUTCOMES } from '@shared/judge';
import { DB_NAME, DB_VERSION } from '@shared/storage';
import { midiToName, onsetGroups, validateSong } from '@core/model';
import { loadSong } from '@core/import/load-song';
import { ImportError, isImportError } from '@core/import/errors';
import { WINDOWS } from '@core/judge/constants';
import { WEIGHTS } from '@core/difficulty/constants';

describe('shared contracts', () => {
  it('DEFAULT_SETTINGS matches the documented defaults and is deep-frozen', () => {
    expect(DEFAULT_SETTINGS.keyboard.lanes).toEqual(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6']);
    expect(DEFAULT_SETTINGS.practice.countInBars).toBe(1);
    expect(DEFAULT_SETTINGS.game.strictOctave).toBe(false);
    expect(DEFAULT_SETTINGS.goals).toEqual({ dailyMinutes: 15, weeklyDays: 4 });
    expect(DEFAULT_SETTINGS.tuner.a4).toBe(440);
    expect(Object.isFrozen(DEFAULT_SETTINGS.mixer)).toBe(true);
    const copy = defaultSettings();
    copy.mixer.master = 0.1;
    expect(DEFAULT_SETTINGS.mixer.master).toBe(0.8);
  });

  it('exposes the documented constants', () => {
    expect(SOURCE_IDS).toContain('songsterr');
    expect(OUTCOMES).toEqual(['Perfect', 'Great', 'Good', 'WrongNote', 'Miss']);
    expect(DB_NAME).toBe('riffway');
    expect(DB_VERSION).toBe(1);
    expect(WINDOWS).toEqual({ perfect: 0.035, great: 0.07, good: 0.12 });
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('loadSong (the isomorphic entry point) turns alphaTex into a valid Song', () => {
    const tex = '\\title "Contract"\n\\tempo 120\n.\n:4 0.6 2.5 3.3 0.1';
    const song = loadSong({ fileName: 'contract.atex', data: new TextEncoder().encode(tex) }, { id: 'local:contract' });
    expect(song).toMatchObject({ schema: 1, id: 'local:contract', arrangement: 0, meta: { title: 'Contract', rhythm: 'exact' } });
    expect(song.notes.map((n) => [n.string, n.fret, midiToName(n.midi)])).toEqual([[6, 0, 'E2'], [5, 2, 'B2'], [3, 3, 'A#3'], [1, 0, 'E4']]);
    expect(song.notes.map((n) => n.time)).toEqual([0, 0.5, 1, 1.5]);
    expect(validateSong(song)).toEqual([]);
  });

  it('notImplemented throws an error naming the feature and the owning task', () => {
    let caught: unknown;
    try {
      notImplemented('laterFeature', 'T-999');
    } catch (err) {
      caught = err;
    }
    expect(isNotImplemented(caught)).toBe(true);
    expect(caught).toBeInstanceOf(NotImplementedError);
    expect(caught).toMatchObject({ feature: 'laterFeature', task: 'T-999', message: 'laterFeature is not implemented yet (T-999)' });
    expect(isNotImplemented(new Error('x'))).toBe(false);
  });

  it('ImportError carries code and diagnostics', () => {
    const err = new ImportError('syntax', 'bad tex', [{ severity: 'error', code: 'AT201', message: 'x', line: 3, column: 7 }]);
    expect(isImportError(err)).toBe(true);
    expect(err.diagnostics[0]?.line).toBe(3);
  });
});

describe('shared core helpers (T-010)', () => {
  const note = (id: number, time: number, string: 1 | 2 | 3 | 4 | 5 | 6, extra: Partial<Song['notes'][number]> = {}) => ({
    id, time, dur: 0.25, string, fret: 0, midi: 40, bar: 0, tech: {}, ...extra,
  });

  it('onsetGroups groups chords and near-simultaneous onsets, skipping tied destinations', () => {
    const groups = onsetGroups({
      notes: [note(0, 0, 6), note(1, 0.005, 5), note(2, 0.5, 4, { chordId: 1 }), note(3, 0.52, 3, { chordId: 1 }), note(4, 1, 4, { tiedFrom: 2 })],
    });
    expect(groups.map((g) => g.notes.map((n) => n.id))).toEqual([[1, 0], [3, 2]]); // notes sorted by string (1 = high e first)
    expect(groups.every((g) => g.chord)).toBe(true);
  });

  it('midiToName uses scientific pitch (60 = C4)', () => {
    expect(midiToName(40)).toBe('E2');
    expect(midiToName(55)).toBe('G3');
    expect(midiToName(64)).toBe('E4');
  });
});
