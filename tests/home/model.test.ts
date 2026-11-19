import { describe, expect, it } from 'vitest';
import { isoWeekAt, previousIsoWeek } from '@core/progress';
import type { SongCacheEntry } from '@shared/storage';
import {
  arrKey,
  buildChecklist,
  buildChecks,
  buildContinue,
  buildDaily,
  buildGoals,
  buildHomeModel,
  buildRecent,
  buildRecommendations,
  buildStats,
  buildWeek,
  reasonText,
  relativeDay,
  sectionCountOf,
  songLookup,
  starterSongs,
} from '../../src/ui/screens/home/model';
import { DAY, homeInput, HOUR, NOW, progress, report, result, run, section, streak } from './fixtures';

const days = (...list: [string, number][]) => list.map(([date, min]) => ({ date, activeSec: min * 60, runs: 1 }));

function cache(songId: string, sections: number): SongCacheEntry {
  return {
    songId,
    meta: result(songId, songId),
    difficulty: report(Array.from({ length: sections }, (_, i) => section(i, ['Intro', 'Verse 2', 'Outro'][i] ?? `S${i}`, 3))),
    lastPlayedAt: null,
    favourite: false,
  };
}

describe('setup checklist', () => {
  it('lists input → tune → calibrate → first song, pointing the last step at the easiest starter', () => {
    const c = buildChecklist(homeInput());
    expect(c.steps.map((s) => s.id)).toEqual(['input', 'tune', 'calibrate', 'first-song']);
    expect(c.doneCount).toBe(0);
    expect(c.visible).toBe(true);
    expect(c.steps[3]!.action.to).toEqual({ screen: 'song', params: { id: 'starter:open', arr: '0' } });
    expect(c.steps.slice(0, 3).every((s) => s.action.to.screen === 'audio-setup')).toBe(true);
  });

  it('ticks steps from settings, runs and the "I’m tuned" mark, and hides when complete or dismissed', () => {
    const input = homeInput({ checklist: { tunedMarked: true, hidden: false } });
    input.settings.input = { deviceId: 'dev', label: 'Scarlett', channel: 0 };
    let c = buildChecklist(input);
    expect(c.steps.filter((s) => s.done).map((s) => s.id)).toEqual(['input', 'tune']);
    expect(c.steps[0]!.detail).toBe('Using Scarlett');
    input.settings.calibration.method = 'play-to-click';
    c = buildChecklist({ ...input, runs: [run()] });
    expect(c.complete).toBe(true);
    expect(c.visible).toBe(false);
    expect(buildChecklist(homeInput({ checklist: { tunedMarked: false, hidden: true } })).visible).toBe(false);
  });

  it('counts tuning as done after a guitar run or a calibration', () => {
    expect(buildChecklist(homeInput({ runs: [run({ inputSource: 'guitar' })] })).steps[1]!.done).toBe(true);
    const calibrated = homeInput();
    calibrated.settings.calibration.method = 'tap-to-click';
    expect(buildChecklist(calibrated).steps[1]!.done).toBe(true);
  });
});

describe('weekly streak card', () => {
  // NOW is Thursday 2026-11-19: Mon 16 … Sun 22.
  it('marks practice days (≥ 5 min), today and future days', () => {
    const w = buildWeek(homeInput({ practiceDays: days(['2026-11-16', 20], ['2026-11-17', 3], ['2026-11-19', 6], ['2026-11-12', 30]), streak: streak({ current: 2, best: 5 }) }));
    expect(w.days.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
    expect(w.days.map((d) => d.practiced)).toEqual([true, false, false, true, false, false, false]);
    expect(w.days.findIndex((d) => d.today)).toBe(3);
    expect(w.days.filter((d) => d.future)).toHaveLength(3);
    expect(w.practiced).toBe(2);
    expect([w.current, w.best]).toEqual([2, 5]);
    expect(w.headline).toBe('2 weeks and counting');
    expect(w.message).toBe('2 more practice days this week keeps it growing.');
  });

  it('celebrates a met week and explains a bonus (repair) week', () => {
    const met = buildWeek(homeInput({ streak: streak({ current: 1, best: 1, lastEvaluatedWeek: isoWeekAt(NOW) }) }));
    expect(met.met).toBe(true);
    expect(met.headline).toBe('This week counts!');
    const bonus = buildWeek(homeInput({ practiceDays: days(['2026-11-16', 10], ['2026-11-17', 10], ['2026-11-18', 10]), streak: streak({ current: 3, best: 3, repairWeek: previousIsoWeek(isoWeekAt(NOW)) }) }));
    expect(bonus.repairing).toBe(true);
    expect(bonus.needed).toBe(6);
    expect(bonus.headline).toBe('Bonus week');
    expect(bonus.message).toBe('Practise 6 days this week to carry your 3 weeks forward. 3 done so far.');
  });

  it('never talks about losing a streak, even when the week can no longer be met', () => {
    const cases = [
      streak({ current: 4, best: 6, freezes: 1, weekTarget: 7 }),
      streak({ current: 4, best: 6, freezes: 0, weekTarget: 7 }),
      streak({ current: 0, best: 6, weekTarget: 7 }),
      streak({ current: 2, repairWeek: previousIsoWeek(isoWeekAt(NOW)), weekTarget: 6 }),
    ];
    const texts = cases.map((s) => buildWeek(homeInput({ streak: s }))).map((w) => `${w.headline} ${w.message}`);
    expect(texts[0]).toContain('A freeze covers it automatically');
    expect(texts[1]).toContain('A bonus week next week carries your streak forward');
    expect(texts[2]).toContain('A fresh week starts on Monday');
    for (const t of texts) expect(t).not.toMatch(/lost|lose|broke|break your|reset|miss(ed)? your/i);
  });
});

describe('daily goal', () => {
  const at = (min: number) => buildDaily(homeInput({ practiceDays: days(['2026-11-19', min]) }));
  it('nudges toward a practice day, then the goal, then a break', () => {
    expect(buildDaily(homeInput()).message).toBe('Even 5 minutes makes today a practice day.');
    expect(at(3).message).toBe('2 more min makes today a practice day.');
    expect(at(9)).toMatchObject({ minutes: 9, goalMinutes: 15, practiceDay: true, message: 'Today counts as a practice day. 6 min to your goal.' });
    expect(at(9).fraction).toBeCloseTo(0.6);
    expect(at(15).message).toBe('Daily goal done. Nice work!');
    expect(at(50).message).toMatch(/break/);
  });
});

describe('continue where you left off', () => {
  const base = (p: ReturnType<typeof progress>[]) =>
    homeInput({
      runs: [run({ songId: 'starter:hall', speed: 0.85, accuracy: 89, endedAt: NOW - HOUR })],
      progress: new Map([[arrKey('starter:hall', 0), p]]),
      songCache: new Map([['starter:hall', cache('starter:hall', 3)]]),
    });

  it('offers a due next-day check first', () => {
    const c = buildContinue(base([progress({ sectionIdx: 0 }), progress({ sectionIdx: 2, masteredAt: NOW - DAY, nextCheckAt: NOW - HOUR })]), songLookup(homeInput().candidates, new Map()))!;
    expect(c.primary.label).toBe('Take the check');
    expect(c.primary.to).toEqual({ screen: 'game', params: { id: 'starter:hall', arr: '0', mode: 'practice', section: '2', speed: '1' } });
    expect(c.checkSection).toBe(2);
    expect(c.last).toBe('Practice at 85% · 89% accuracy · today');
  });

  it('else picks the weakest unmastered section at its trainer speed, with section names from the cache', () => {
    const input = base([progress({ sectionIdx: 0, bestAccuracy: 95 }), progress({ sectionIdx: 1, bestAccuracy: 70, trainer: { speed: 0.75, failStreak: 1 } })]);
    const c = buildContinue(input, songLookup(input.candidates, input.songCache))!;
    expect(c.next).toBe('Next up: Verse 2 at 75%');
    expect(c.primary.to.params).toMatchObject({ mode: 'practice', section: '1', speed: '0.75' });
    expect(c.mastery).toEqual({ mastered: 0, total: 3 });
    expect(c.title).toBe('In the Hall of the Mountain King');
  });

  it('suggests a full play once every section is mastered', () => {
    const p = [0, 1, 2].map((i) => progress({ sectionIdx: i, masteredAt: NOW - HOUR, nextCheckAt: NOW + 8 * HOUR }));
    const input = base(p);
    const c = buildContinue(input, songLookup(input.candidates, input.songCache))!;
    expect(c.primary).toMatchObject({ label: 'Play it through' });
    expect(c.primary.to.params.mode).toBe('play');
  });

  it('is null before the first run', () => {
    expect(buildContinue(homeInput(), songLookup(null, new Map()))).toBeNull();
  });
});

describe('recommendations', () => {
  it('groups 6/3/1 with kind badges, readable reasons and routes', () => {
    const extra = ([3, 3, 3, 3, 4, 4, 6] as const).map((tier, i) => result(`local:x${i}`, `Extra ${i}`, { source: 'local', tier, rating: tier }));
    const model = buildHomeModel(
      homeInput({
        candidates: [...homeInput().candidates!, ...extra],
        runs: [run({ songId: 'starter:ode', endedAt: NOW - 3 * DAY, startedAt: NOW - 3 * DAY - 1000 })],
        checks: [progress({ songId: 'starter:ode', sectionIdx: 1, masteredAt: NOW - DAY, nextCheckAt: NOW - HOUR })],
      }),
    );
    expect(model.recommendations.map((g) => g.id)).toEqual(['stretch', 'comfort', 'reach']);
    const stretch = model.recommendations[0]!;
    expect(stretch.items).toHaveLength(6);
    expect(model.recommendations[1]!.items).toHaveLength(3);
    expect(stretch.items.every((i) => i.badge === 'Stretch' && !i.reason.startsWith('Stretch pick'))).toBe(true);
    expect(stretch.items[0]!.reason).toMatch(/^Tier 3, one above your comfort tier \(2\)/);
    expect(stretch.items[0]!.to.screen).toBe('song');
    const review = model.recommendations.find((g) => g.id === 'comfort')!.items.find((i) => i.rec.kind === 'review')!;
    expect(review.badge).toBe('Next-day check');
    expect(review.to).toEqual({ screen: 'game', params: { id: 'starter:ode', arr: '0', mode: 'practice', section: '1', speed: '1' } });
    expect(model.recommendations.find((g) => g.id === 'reach')?.items[0]?.badge).toBe('Reach · one section');
  });

  it('drops empty groups and strips only a short lead phrase', () => {
    expect(buildRecommendations([], songLookup(null, new Map()))).toEqual([]);
    expect(reasonText('Stretch pick: tier 4, one above')).toBe('Tier 4, one above');
    expect(reasonText('no lead here')).toBe('No lead here');
  });
});

describe('next-day checks, recent results, stats', () => {
  it('splits due checks from those opening tomorrow', () => {
    const input = homeInput({
      checks: [
        progress({ songId: 'starter:hall', sectionIdx: 1, masteredAt: NOW - DAY, nextCheckAt: NOW - HOUR }),
        progress({ songId: 'starter:ode', sectionIdx: 0, masteredAt: NOW - HOUR, nextCheckAt: NOW + 9 * HOUR }),
      ],
    });
    const c = buildChecks(input, songLookup(input.candidates, new Map()));
    expect(c.due.map((d) => [d.title, d.section])).toEqual([['In the Hall of the Mountain King', 'Section 2']]);
    expect(c.tomorrow).toBe(1);
  });

  it('lists the latest runs with links to their results', () => {
    const runs = [run({ speed: 0.7, accuracy: 77.6, mode: 'play', loop: { startBar: 0, endBar: 4 }, endedAt: NOW - 2 * DAY }), run({ clean: true })];
    const r = buildRecent(runs, songLookup(homeInput().candidates, new Map()), NOW);
    expect(r[0]).toMatchObject({ title: 'In the Hall of the Mountain King', speedPct: 70, accuracy: 78, looped: true, when: 'Tue, Nov 17' });
    expect(r[0]!.to).toEqual({ screen: 'results', params: { runId: String(runs[0]!.id) } });
    expect(r[1]!.clean).toBe(true);
  });

  it('counts repertoire as arrangements with every section locked in', () => {
    const locked = (songId: string, idx: number) => progress({ songId, sectionIdx: idx, masteredAt: 1, lockedInAt: 2 });
    const input = homeInput({
      runs: [run({ clean: true }), run()],
      progress: new Map([
        [arrKey('starter:ode', 0), [locked('starter:ode', 0), locked('starter:ode', 1)]],
        [arrKey('starter:hall', 0), [locked('starter:hall', 0), progress({ sectionIdx: 1, masteredAt: 1 })]],
      ]),
      songCache: new Map([
        ['starter:ode', cache('starter:ode', 2)],
        ['starter:hall', cache('starter:hall', 3)],
      ]),
    });
    const s = buildStats(input, songLookup(input.candidates, input.songCache), 2);
    expect(s).toEqual({ repertoire: 1, masteredSections: 4, lockedSections: 3, comfortTier: 2, cleanRuns: 1, songsPlayed: 1 });
  });

  it('bounds the section count by the report and the progress seen', () => {
    expect(sectionCountOf(null, [])).toBe(0);
    expect(sectionCountOf(report([section(0, 'A', 2), section(2, 'C', 2)]), [progress({ sectionIdx: 4 })])).toBe(5);
  });
});

describe('model assembly', () => {
  it('flags first run, starter-only libraries and an unreachable server', () => {
    const first = buildHomeModel(homeInput());
    expect(first.firstRun).toBe(true);
    expect(first.starterOnly).toBe(true);
    expect(first.starters.map((s) => s.id)).toEqual(['starter:open', 'starter:ode', 'starter:scar', 'starter:hall', 'starter:alt']);
    expect(first.continueItem).toBeNull();
    const down = buildHomeModel(homeInput({ candidates: null, runs: [run()] }));
    expect(down.serverDown).toBe(true);
    expect(down.recommendations).toEqual([]);
    expect(down.continueItem?.title).toBe('Unknown song');
    const own = buildHomeModel(homeInput({ candidates: [result('local:x', 'Mine', { source: 'local' })] }));
    expect(own.starterOnly).toBe(false);
  });

  it('only lists playable starters, easiest first', () => {
    const list = starterSongs([result('starter:b', 'B', { tier: 2 }), result('starter:a', 'A', { tier: 2 }), result('starter:n', 'N', { tier: 1, availability: 'needs-rhythm' }), result('local:z', 'Z', { tier: 1, source: 'local' })]);
    expect(list.map((s) => s.id)).toEqual(['starter:a', 'starter:b']);
  });

  it('marks the goal picked today and builds practice routes', () => {
    const goals = buildGoals(
      [{ kind: 'weakest-section', label: 'Get section 2 clean at 80%', songId: 'starter:hall', arrangement: 0, sectionIdx: 1, targetSpeed: 0.8 }],
      { date: '2026-11-19', kind: 'weakest-section', songId: 'starter:hall' },
      NOW,
    );
    expect(goals[0]).toMatchObject({ title: 'Fix the tricky bit', picked: true });
    expect(goals[0]!.to.params).toEqual({ id: 'starter:hall', arr: '0', mode: 'practice', section: '1', speed: '0.8' });
    expect(buildGoals(goals.map((g) => g.goal), { date: '2026-11-18', kind: 'weakest-section', songId: 'starter:hall' }, NOW)[0]!.picked).toBe(false);
  });

  it('labels days relative to now', () => {
    expect(relativeDay(NOW - HOUR, NOW)).toBe('today');
    expect(relativeDay(NOW - DAY, NOW)).toBe('yesterday');
    expect(relativeDay(NOW - 3 * DAY, NOW)).toBe('Mon, Nov 16');
    expect(relativeDay(NOW + 10 * HOUR, NOW)).toBe('tomorrow');
  });
});
