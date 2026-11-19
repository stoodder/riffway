// @vitest-environment happy-dom
/**
 * Game and results screen building blocks (R3 UX fixes, T-122): the HUD names the loop's section,
 * the chord note has a short form, coach lines sit in the HUD, the start card reminds of a capo and a
 * retune back to standard, the pause card says Esc resumes, and the results screen shows one loop
 * action plus a hit summary.
 */
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared/settings';
import type { Song } from '@shared/song';
import type { RunResult } from '../../src/game/session/results';
import { CHORD_NOTE, CHORD_NOTE_SHORT, GameHud, hudSection } from '../../src/ui/screens/game/hud';
import { keyLegend, pauseMenu, startCard, tuningReminder } from '../../src/ui/screens/game/overlays';
import type { SectionUpdate } from '../../src/game/session/progress';
import { notesSummary, progressList, sectionHeatmap } from '../../src/ui/screens/results/view';

const STANDARD = [64, 59, 55, 50, 45, 40];
const DROP_D = [64, 59, 55, 50, 45, 38];
const KEYS = defaultSettings().keyboard;

/** Four 4-second sections, like Pentatonic Box Lick (Box Run, Bend Lick, …). */
function songWithSections(): Song {
  const names = ['Box Run', 'Bend Lick', 'Triplet Run', 'Outro'];
  return { sections: names.map((name, i) => ({ name, start: i * 4, end: i * 4 + 4, startBar: i * 2, endBar: i * 2 + 2 })) } as unknown as Song;
}

describe('HUD section (R3-U-01)', () => {
  const song = songWithSections();
  const name = (i: number): string => song.sections[i]!.name;

  it('names the section at the playhead without a loop', () => {
    expect(hudSection(song, null, 0, name)).toBe('Box Run');
    expect(hudSection(song, null, 5, name)).toBe('Bend Lick');
    expect(hudSection(song, null, -1, name)).toBe('Box Run');
  });

  it('names the loop’s section on the start card, in the pre-roll and while paused there', () => {
    const loop = { start: 4 };
    // Start card (t = 0) and the 1-bar pre-roll inside Box Run's last bar.
    expect(hudSection(song, loop, 0, name)).toBe('Bend Lick');
    expect(hudSection(song, loop, 3.2, name)).toBe('Bend Lick');
    // In the pass: the playhead decides.
    expect(hudSection(song, loop, 6, name)).toBe('Bend Lick');
    expect(hudSection(song, { start: 8 }, 7.99, name)).toBe('Triplet Run');
  });

  it('is empty for a song without sections', () => {
    expect(hudSection({ sections: [] } as unknown as Song, null, 3, name)).toBe('');
  });
});

describe('game HUD', () => {
  it('has a short chord note for a narrow gutter and shows coach lines in the HUD bar (R3-U-04, R3-U-05)', () => {
    const hud = new GameHud({ title: 'Song', artist: null, mode: 'practice' }, document.createElement('div'));
    const note = hud.overlays.querySelector<HTMLElement>('.gm-chord-note')!;
    expect(note.querySelector('.gm-chord-note__full')?.textContent).toBe(CHORD_NOTE);
    expect(note.querySelector('.gm-chord-note__short')?.textContent).toBe(CHORD_NOTE_SHORT);
    expect(note.title).toBe(CHORD_NOTE);
    hud.message({ kind: 'trainer', text: 'Clean run! +5% → 80%' });
    expect(hud.bar.querySelector('.gm-song__meta .gm-coach')?.textContent).toBe('Clean run! +5% → 80%');
    expect(hud.overlays.querySelector('.gm-coach')).toBeNull();
    hud.dispose();
  });
});

describe('start card reminders (R3-U-06)', () => {
  it('reminds of a retune back to standard after a song in another tuning', () => {
    expect(tuningReminder(STANDARD, { id: 'drop-d', label: 'Drop D' })).toBe('Retune to Standard — your last song was in Drop D');
    expect(tuningReminder(STANDARD, { id: 'standard', label: 'Standard' })).toBeNull();
    expect(tuningReminder(STANDARD)).toBeNull();
    expect(tuningReminder(DROP_D, { id: 'standard', label: 'Standard' })).toBe('Drop D — tune string 6 down to D');
  });

  it('shows a capo line and the retune line on the card', () => {
    const info = { title: 'Capo Two', artist: null, mode: 'play' as const, speed: 1, loopLabel: null, guitarLabel: null, keys: KEYS, tuning: STANDARD };
    const capo = startCard({ ...info, capo: 2, lastTuning: { id: 'drop-d', label: 'Drop D' } }, () => {}, () => {}, () => {});
    expect(capo.el.querySelector('.gm-card__capo')?.textContent).toBe('Capo 2 — put your capo on fret 2');
    expect(capo.el.querySelector('.gm-card__tuning:not(.gm-card__capo)')?.textContent).toMatch(/^Retune to Standard — your last song was in Drop D/);
    const plain = startCard({ ...info, capo: 0 }, () => {}, () => {});
    expect(plain.el.querySelector('.gm-card__capo, .gm-card__tuning')).toBeNull();
  });
});

describe('pause card (R3-U-13)', () => {
  it('says Esc resumes while paused; the start card legend says Esc pauses', () => {
    const menu = pauseMenu({ resume: () => {}, restart: () => {}, tools: () => {}, finish: null, quit: () => {} }, KEYS);
    expect(menu.el.querySelector('.gm-keys__mods')?.textContent).toContain('Esc resume');
    expect(menu.el.querySelector('.gm-keys__mods')?.textContent).not.toContain('Esc pause');
    expect(keyLegend(KEYS).querySelector('.gm-keys__mods')?.textContent).toContain('Esc pause');
  });
});

/** A finished run: 17/36/22 hits, 1 wrong, 6 missed over three sections. */
function result(extra: Partial<RunResult> = {}): RunResult {
  return {
    runId: 1,
    songId: 'starter:open',
    arrangement: 0,
    title: 'Open Strings & First Frets',
    artist: null,
    mode: 'play',
    speed: 1,
    loop: null,
    completed: true,
    score: 8125,
    accuracy: 91.5,
    stars: 4,
    maxCombo: 26,
    counts: { Perfect: 17, Great: 36, Good: 22, WrongNote: 1, Miss: 6 },
    judgedNotes: 82,
    histogram: { binMs: 10, minMs: -120, bins: new Array<number>(24).fill(0) },
    sections: [
      { idx: 0, name: 'Open Strings', notes: 31, hits: 27, accuracy: 87 },
      { idx: 1, name: 'First Frets', notes: 25, hits: 23, accuracy: 92 },
    ],
    weakestSection: 0,
    clean: true,
    timingScore: 0.73,
    lenientChordNotes: null,
    strays: 0,
    inputSource: 'keyboard',
    activeSec: 60,
    endedAt: 0,
    best: null,
    newBest: false,
    previousBestScore: null,
    sectionUpdates: [],
    ...extra,
  } as RunResult;
}

describe('results (R3-U-12)', () => {
  it('summarizes the notes card', () => {
    expect(notesSummary(result())).toBe('75 of 82 notes hit. Wrong = on time but the wrong pitch; Miss = not played in its window.');
  });

  it('names the weakest section without a second loop button', () => {
    const heat = sectionHeatmap(result());
    expect(heat.querySelector('.rs-weakest')?.textContent).toBe('Weakest section: Open Strings — 87% (27/31 notes)');
    expect(heat.querySelector('button')).toBeNull();
  });

  it('says a section below 90% needs 90%+ for its own clean run', () => {
    const update = { sectionIdx: 0, name: 'Open Strings', accuracy: 87, speed: 1, nextSpeed: 1, cleanRuns: 0, sessionCleanAt100: 0, events: [] } as unknown as SectionUpdate;
    const list = progressList([update]);
    expect(list?.textContent).toBe('Open Strings: 87% — this section needs 90%+ for a clean run');
  });
});
