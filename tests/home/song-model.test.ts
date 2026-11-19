import { describe, expect, it } from 'vitest';
import {
  accuracyTrend,
  arrangementOptions,
  bestsView,
  allSectionsAlike,
  difficultyBars,
  masterySummary,
  resolveArrangement,
  sectionRows,
  STATE_LABEL,
  sectionWhy,
  toSearchResult,
  tuningView,
} from '../../src/ui/screens/song/model';
import { sparklinePoints } from '../../src/ui/screens/home/viz';
import { DAY, HOUR, NOW, progress, report, run, section, song, songMeta, track } from './fixtures';

const DROP_D = [64, 59, 55, 50, 45, 38];
const STANDARD = [64, 59, 55, 50, 45, 40];

describe('arrangements', () => {
  const meta = songMeta('local:abc', 'Twin', {
    tracks: [track(0, 'Rhythm'), track(1, 'Bass', { strings: 4, playable: false, unsupportedReason: 'bass' }), track(2, 'Lead', { capo: 2, tuning: DROP_D })],
  });

  it('lists playable tracks with details and counts the rest', () => {
    const { options, unplayable } = arrangementOptions(meta, 2);
    expect(options.map((o) => [o.index, o.name, o.details, o.current, o.isDefault])).toEqual([
      [0, 'Rhythm', 'Standard · 120 notes', false, true],
      [2, 'Lead', 'Drop D · capo 2 · 120 notes', true, false],
    ]);
    expect(unplayable).toBe(1);
  });

  it('resolves the arr param to a playable track, else the default', () => {
    expect(resolveArrangement(meta, '2')).toBe(2);
    expect(resolveArrangement(meta, '1')).toBe(0);
    expect(resolveArrangement(meta, 'x')).toBe(0);
    expect(resolveArrangement(meta, undefined)).toBe(0);
    expect(resolveArrangement(songMeta('a:b', 'X', { tracks: [track(0, 'Bass', { playable: false })] }), '0')).toBe(-1);
  });
});

describe('tuning', () => {
  it('prompts a retune to Drop D with the changed string', () => {
    const t = tuningView(DROP_D, 0, null);
    expect(t.label).toBe('Drop D');
    expect(t.prompt).toEqual({ title: 'Retune to Drop D', text: 'From standard: string 6 down a whole step to D.' });
    expect(t.strings.map((s) => [s.string, s.note, s.delta])).toEqual([
      [6, 'D', -2],
      [5, 'A', 0],
      [4, 'D', 0],
      [3, 'G', 0],
      [2, 'B', 0],
      [1, 'E', 0],
    ]);
  });

  it('mentions the last song’s tuning and prompts back to standard', () => {
    expect(tuningView(DROP_D, 0, { id: 'standard', label: 'Standard' }).prompt?.text).toBe('Your last song was in Standard. From standard: string 6 down a whole step to D.');
    expect(tuningView(STANDARD, 0, { id: 'drop-d', label: 'Drop D' }).prompt).toEqual({ title: 'Retune to Standard', text: 'Your last song was in Drop D. Back to E A D G B E.' });
  });

  it('stays quiet for standard tuning after a standard song', () => {
    expect(tuningView(STANDARD, 0, null).prompt).toBeNull();
    expect(tuningView(STANDARD, 3, { id: 'standard', label: 'Standard' }).prompt).toBeNull();
  });
});

describe('difficulty breakdown', () => {
  it('builds per-section bars with the strongest factors and flags the hardest', () => {
    const bars = difficultyBars(report([section(0, 'Intro', 2.5), section(1, 'Riff', 4.8, { shifts: 0.9, density: 0.7, chords: 0.95 })]));
    expect(bars.map((b) => [b.name, b.pct, b.hardest])).toEqual([
      ['Intro', 25, false],
      ['Riff', 48, true],
    ]);
    expect(bars[1]!.why).toEqual(['dense, fast notes', 'fast position shifts']);
    expect(sectionWhy(section(0, 'Quiet', 1))).toEqual([]);
    expect(difficultyBars(null)).toEqual([]);
  });

  it('flags no section as hardest when the top rating is shared, and says they are alike (R3-U-22)', () => {
    // 2.71 and 2.68 both read 2.7.
    const tied = difficultyBars(report([section(0, 'Intro', 2.71), section(1, 'Riff', 2.68)]));
    expect(tied.map((b) => b.hardest)).toEqual([false, false]);
    expect(allSectionsAlike(tied)).toBe(true);
    const threeWay = difficultyBars(report([section(0, 'A', 3), section(1, 'B', 4.2), section(2, 'C', 4.2)]));
    expect(threeWay.map((b) => b.hardest)).toEqual([false, false, false]);
    expect(allSectionsAlike(threeWay)).toBe(false);
    expect(allSectionsAlike(difficultyBars(report([section(0, 'Solo', 3)])))).toBe(false);
  });
});

describe('sections and mastery', () => {
  const rep = report([section(0, 'Intro', 2.5), section(1, 'Riff', 4.8)]);

  it('derives each section’s state, detail and loop route from progress', () => {
    const rows = sectionRows(
      'starter:hall',
      0,
      song('starter:hall'),
      rep,
      [
        progress({ sectionIdx: 0, masteredAt: NOW - 2 * DAY, lockedInAt: NOW - DAY }),
        progress({ sectionIdx: 1, cleanRuns: 2, bestAccuracy: 81.4, trainer: { speed: 0.8, failStreak: 0 } }),
      ],
      NOW,
    );
    expect(rows.map((r) => [r.name, r.state, r.tier])).toEqual([
      ['Intro', 'locked', 3],
      ['Riff', 'practising', 5],
      ['Outro', 'new', 5],
    ]);
    expect(rows.map((r) => r.share)).toEqual([8 / 30, 16 / 30, 6 / 30]);
    expect(rows[1]!.detail).toBe('Trainer at 80% · 2 clean runs · best 81%');
    expect(rows[1]!.loop).toEqual({ screen: 'game', params: { id: 'starter:hall', arr: '0', mode: 'practice', section: '1', speed: '0.8' } });
    expect(rows[2]!.loop.params.speed).toBeUndefined();
    expect(rows[0]!.detail).toBe('Locked in yesterday. Keep it warm with a full play.');
    // One name per state, the legend's (R3-U-10); new rows carry no repeated tip (it is said once).
    expect(rows.map((r) => r.stateLabel)).toEqual(['Locked in', 'Practicing', 'New']);
    expect(rows[2]!.detail).toBe('');
    expect(STATE_LABEL.new).toBe('New');
  });

  it('shows a mastered section’s check opening, then due', () => {
    const p = progress({ sectionIdx: 0, masteredAt: NOW - HOUR, nextCheckAt: NOW + 8 * HOUR });
    const [mastered] = sectionRows('s', 0, song('s'), rep, [p], NOW);
    expect(mastered).toMatchObject({ state: 'mastered', stateLabel: 'Mastered' });
    expect(mastered!.detail).toContain('opens tomorrow');
    const [due] = sectionRows('s', 0, song('s'), rep, [p], NOW + DAY);
    expect(due).toMatchObject({ state: 'check-due', detail: 'One clean run at full speed locks it in.' });
    expect(due!.loop.params.speed).toBe('1');
  });

  it('falls back to the report’s sections before the song has loaded', () => {
    const rows = sectionRows('s', 0, null, rep, [], NOW);
    expect(rows.map((r) => [r.idx, r.name])).toEqual([
      [0, 'Intro'],
      [1, 'Riff'],
    ]);
    expect(masterySummary(rows, [progress({ sectionIdx: 0, lockedInAt: 1, masteredAt: 1 }), progress({ sectionIdx: 1, lockedInAt: 1 })])).toEqual({
      mastered: 2,
      locked: 2,
      total: 2,
      repertoire: true,
    });
  });
});

describe('bests and trend', () => {
  it('sorts bests fastest first and marks full speed', () => {
    const v = bestsView(
      [
        { songId: 's', arrangement: 0, speedBucket: 70, score: 900, accuracy: 77.6, stars: 3, runId: 4, at: NOW - 2 * DAY },
        { songId: 's', arrangement: 0, speedBucket: 100, score: 1500, accuracy: 91, stars: 4, runId: 9, at: NOW - HOUR },
      ],
      NOW,
    );
    expect(v.map((b) => [b.label, b.full, b.accuracy, b.when])).toEqual([
      ['100%', true, 91, 'today'],
      ['70%', false, 78, 'Tue, Nov 17'],
    ]);
  });

  it('turns runs (newest first) into an oldest-first trend with a readable label and a useful floor', () => {
    const t = accuracyTrend([run({ accuracy: 91 }), run({ accuracy: 84.6 }), run({ accuracy: 72 })]);
    expect(t.values).toEqual([72, 85, 91]);
    expect(t.label).toBe('Accuracy over your last 3 runs: 72% to 91% (best 91%)');
    expect(t.min).toBe(50);
    expect(accuracyTrend([run({ accuracy: 95 })]).label).toBe('One run so far: 95% accuracy');
    expect(accuracyTrend([]).values).toEqual([]);
  });

  it('lays sparkline points left to right with higher values higher', () => {
    const pts = sparklinePoints([0, 50, 100], { width: 108, height: 58, min: 0, max: 100, pad: 4 });
    expect(pts).toEqual([
      [4, 54],
      [54, 29],
      [104, 4],
    ]);
    expect(sparklinePoints([120], { width: 50, height: 20, min: 0, max: 100, pad: 0 })).toEqual([[50, 0]]);
  });
});

describe('song cache projection', () => {
  it('projects SongMeta to the SearchResult the home screen reads', () => {
    const r = toSearchResult(songMeta('starter:hall', 'Hall'));
    expect(r).toMatchObject({ id: 'starter:hall', title: 'Hall', composer: 'Edvard Grieg', tier: 4, rating: 4.3, availability: 'playable', arrangements: 1 });
    expect(toSearchResult(songMeta('x:y', 'Y', { entry: { rhythm: 'needs-alignment' } })).availability).toBe('needs-rhythm');
    expect(toSearchResult(songMeta('x:z', 'Z', { entry: { error: 'bad' } })).availability).toBe('needs-import');
  });
});
