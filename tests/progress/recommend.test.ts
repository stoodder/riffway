import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@shared/sources';
import type { RunRecord, SectionProgress } from '@shared/storage';
import type { Tier } from '@shared/song';
import { comfortTier, DEFAULT_COMFORT_TIER, recommend, sessionGoals, type RecommendInput } from '@core/progress';

const NOW = new Date(2026, 10, 19, 18).getTime();
const HOUR = 3_600_000;

function song(id: string, tier: Tier | null, over: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    source: 'starter',
    title: `Song ${id}`,
    fileName: `${id}.atex`,
    tier,
    rating: tier,
    ratingProvisional: false,
    tuningId: 'standard',
    tuningLabel: 'Standard',
    tags: { style: [], genre: [], skills: [] },
    rhythm: 'exact',
    availability: 'playable',
    arrangements: 1,
    defaultArrangement: 0,
    durationSec: 120,
    score: 0,
    ...over,
  };
}

function runOf(songId: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 1,
    songId,
    arrangement: 0,
    startedAt: NOW - 48 * HOUR,
    endedAt: NOW - 48 * HOUR + 120_000,
    speed: 1,
    mode: 'play',
    score: 1000,
    accuracy: 90,
    stars: 4,
    maxCombo: 20,
    counts: { Perfect: 10, Great: 5, Good: 3, WrongNote: 1, Miss: 1 },
    sections: [],
    histogram: { binMs: 10, minMs: -120, bins: [] },
    clean: true,
    inputSource: 'keyboard',
    activeSec: 120,
    ...over,
  };
}

function due(songId: string, sectionIdx: number, nextCheckAt: number): SectionProgress {
  return {
    songId,
    arrangement: 0,
    sectionIdx,
    cleanRuns: 4,
    cleanRunsAt100: 2,
    lastSpeed: 1,
    trainer: { speed: 1, failStreak: 0 },
    masteredAt: nextCheckAt - 10 * HOUR,
    nextCheckAt,
    bestAccuracy: 95,
    passesSinceGain: 0,
  };
}

/** 8 songs at each tier 1–8, ids `t<tier>-<n>`. */
const LIBRARY: SearchResult[] = Array.from({ length: 8 }, (_, t) =>
  Array.from({ length: 8 }, (_, n) => song(`t${t + 1}-${n}`, (t + 1) as Tier)),
).flat();

function input(over: Partial<RecommendInput> = {}): RecommendInput {
  return {
    candidates: LIBRARY,
    comfortTier: 3,
    recentRuns: [],
    dueChecks: [],
    preferences: { style: 'pick', fingerstyle: false, genres: ['rock', 'metal', 'recognizable'] },
    now: NOW,
    ...over,
  };
}

describe('comfortTier', () => {
  const tiers: Record<string, Tier> = { a: 3, b: 3, c: 4, d: 4, e: 5 };
  const tierOf = (id: string): Tier | null => tiers[id] ?? null;

  it(`defaults to ${DEFAULT_COMFORT_TIER} without qualifying runs`, () => {
    expect(comfortTier([], tierOf)).toBe(DEFAULT_COMFORT_TIER);
    expect(comfortTier([runOf('a')], tierOf)).toBe(DEFAULT_COMFORT_TIER);
  });

  it('is the highest tier with ≥ 85% at 100% on ≥ 2 distinct songs', () => {
    const runs = [runOf('a'), runOf('b'), runOf('c'), runOf('d', { accuracy: 85 }), runOf('e')];
    expect(comfortTier(runs, tierOf)).toBe(4);
  });

  it('ignores slower runs, low accuracy, loops, repeats of one song and unknown songs', () => {
    const runs = [
      runOf('a'),
      runOf('b'),
      runOf('c'),
      runOf('c', { startedAt: NOW }),
      runOf('d', { speed: 0.95 }),
      runOf('d', { accuracy: 84.9 }),
      runOf('d', { loop: { startBar: 0, endBar: 4 } }),
      runOf('zzz'),
      runOf('yyy'),
    ];
    expect(comfortTier(runs, tierOf)).toBe(3);
  });
});

describe('recommend', () => {
  it('fills 10 slots as 6 stretch / 3 comfort / 1 reach at comfort +1 / 0 / +2', () => {
    const recs = recommend(input());
    expect(recs).toHaveLength(10);
    expect(recs.map((r) => r.kind)).toEqual([...Array(6).fill('stretch'), ...Array(3).fill('comfort'), 'reach']);
    expect(recs.filter((r) => r.kind === 'stretch').every((r) => r.tier === 4)).toBe(true);
    expect(recs.filter((r) => r.kind === 'comfort').every((r) => r.tier === 3)).toBe(true);
    expect(recs.find((r) => r.kind === 'reach')?.tier).toBe(5);
    expect(new Set(recs.map((r) => r.songId)).size).toBe(10);
  });

  it('explains every item', () => {
    const recs = recommend(input());
    for (const r of recs) expect(r.reason).toMatch(/tier \d/);
    expect(recs[0]?.reason).toBe('Stretch pick: tier 4, one above your comfort tier (3)');
    expect(recs.find((r) => r.kind === 'comfort')?.reason).toBe('Comfort pick: tier 3, at your comfort tier (3)');
    expect(recs.find((r) => r.kind === 'reach')?.reason).toBe('Reach goal — try a single section: tier 5, two above your comfort tier (3)');
  });

  it('is deterministic and independent of candidate order', () => {
    const a = recommend(input());
    const shuffled = [...LIBRARY].reverse().sort((x, y) => (x.id.length * 7 + x.id.charCodeAt(3)) % 5 - (y.id.length * 7 + y.id.charCodeAt(3)) % 5);
    expect(recommend(input({ candidates: shuffled }))).toEqual(a);
    expect(recommend(input())).toEqual(a);
  });

  it('prefers the player style and genres, and says so', () => {
    const fav = song('t4-zz', 4, { tags: { style: ['pick'], genre: ['metal', 'jazz'], skills: [] } });
    const recs = recommend(input({ candidates: [...LIBRARY, fav] }));
    expect(recs[0]?.songId).toBe('t4-zz');
    expect(recs[0]?.score).toBeCloseTo(1.3);
    expect(recs[0]?.reason).toContain('suits your pick playing');
    expect(recs[0]?.reason).toContain('metal');
    expect(recs[0]?.reason).not.toContain('jazz');
  });

  it('penalises songs played in the last 24 h (and says so)', () => {
    const lib = [song('a', 4), song('b', 4), song('c', 3)];
    const recs = recommend(input({ candidates: lib, recentRuns: [runOf('a', { startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR })] }));
    const stretch = recs.filter((r) => r.kind === 'stretch');
    expect(stretch.map((r) => r.songId)).toEqual(['b', 'a', 'c']);
    expect(stretch[1]?.score).toBeCloseTo(0.7);
    expect(stretch[1]?.reason).toContain('played in the last 24 h');
    const old = recommend(input({ candidates: lib, recentRuns: [runOf('a', { startedAt: NOW - 30 * HOUR, endedAt: NOW - 25 * HOUR })] }));
    expect(old.filter((r) => r.kind === 'stretch').map((r) => r.songId)).toEqual(['a', 'b', 'c']);
  });

  it('puts due next-day checks into the comfort slots as review items, exempt from the 24 h penalty', () => {
    const recs = recommend(
      input({
        dueChecks: [due('t2-1', 3, NOW - HOUR), due('t3-5', 0, NOW - 2 * HOUR), due('t3-6', 1, NOW + HOUR)],
        recentRuns: [runOf('t2-1', { startedAt: NOW - 20 * HOUR, endedAt: NOW - 19 * HOUR })],
      }),
    );
    const reviews = recs.filter((r) => r.kind === 'review');
    expect(reviews.map((r) => [r.songId, r.sectionIdx])).toEqual([
      ['t3-5', 0],
      ['t2-1', 3],
    ]);
    expect(reviews[1]?.reason).toBe('Next-day check due: one clean run of section 4 at full speed locks it in');
    expect(reviews[1]?.score).toBeCloseTo(2 / 3);
    expect(recs.filter((r) => r.kind === 'comfort')).toHaveLength(1);
    expect(recs).toHaveLength(10);
  });

  it('skips songs without rhythm, tier or a playable arrangement', () => {
    const lib = [
      song('needs', 4, { rhythm: 'needs-alignment', availability: 'needs-rhythm' }),
      song('import', 4, { availability: 'needs-import' }),
      song('none', null),
      song('noarr', 4, { defaultArrangement: -1 }),
      song('ok', 4),
    ];
    expect(recommend(input({ candidates: lib })).map((r) => r.songId)).toEqual(['ok']);
  });

  it('fills from neighbouring tiers in a small library but never three tiers off', () => {
    const lib = [song('t1', 1), song('t3', 3), song('t5', 5), song('t7', 7), song('t8', 8)];
    const recs = recommend(input({ candidates: lib }));
    expect(recs.map((r) => [r.kind, r.songId])).toEqual([
      ['stretch', 't3'],
      ['stretch', 't5'],
      ['comfort', 't1'],
      ['reach', 't7'],
    ]);
    expect(recs[0]?.reason).toContain('at your comfort tier (3)');
    expect(recs[2]?.reason).toContain('two below your comfort tier (3)');
  });
});

describe('sessionGoals', () => {
  it('offers the next-day check, the weakest stretch section and a new stretch song', () => {
    const lastStretch = runOf('t4-2', {
      startedAt: NOW - 3 * HOUR,
      speed: 0.8,
      sections: [
        { idx: 0, notes: 20, hits: 19, accuracy: 95 },
        { idx: 1, notes: 20, hits: 14, accuracy: 70 },
        { idx: 2, notes: 0, hits: 0, accuracy: 0 },
      ],
    });
    const goals = sessionGoals(
      input({
        dueChecks: [due('t3-1', 2, NOW - HOUR), due('t3-2', 0, NOW - 2 * HOUR)],
        recentRuns: [lastStretch, runOf('t2-0', { startedAt: NOW - HOUR, sections: [{ idx: 0, notes: 5, hits: 1, accuracy: 20 }] })],
      }),
    );
    expect(goals).toEqual([
      {
        kind: 'next-day-check',
        label: 'Next-day check: play section 1 of “Song t3-2” clean at full speed (+1 more due)',
        songId: 't3-2',
        arrangement: 0,
        sectionIdx: 0,
        targetSpeed: 1,
      },
      {
        kind: 'weakest-section',
        label: 'Get section 2 of “Song t4-2” clean at 80%',
        songId: 't4-2',
        arrangement: 0,
        sectionIdx: 1,
        targetSpeed: 0.8,
      },
      { kind: 'new-stretch', label: 'Start “Song t4-0”: one clean pass at 70%', songId: 't4-0', arrangement: 0, targetSpeed: 0.7 },
    ]);
  });

  it('leaves out fingerstyle songs unless enabled', () => {
    const lib = [song('f', 4, { tags: { style: ['fingerstyle'], genre: [], skills: [] } }), song('p', 4)];
    const runs = [runOf('f', { sections: [{ idx: 0, notes: 4, hits: 2, accuracy: 50 }] })];
    const off = sessionGoals(input({ candidates: lib, recentRuns: runs, dueChecks: [due('f', 0, NOW - HOUR)] }));
    expect(off.map((g) => [g.kind, g.songId])).toEqual([['new-stretch', 'p']]);
    const on = sessionGoals(
      input({ candidates: lib, recentRuns: runs, dueChecks: [due('f', 0, NOW - HOUR)], preferences: { ...input().preferences, fingerstyle: true } }),
    );
    expect(on.map((g) => [g.kind, g.songId])).toEqual([
      ['next-day-check', 'f'],
      ['weakest-section', 'f'],
      ['new-stretch', 'p'],
    ]);
  });

  it('returns no goals for an empty library and no history', () => {
    expect(sessionGoals(input({ candidates: [] }))).toEqual([]);
  });
});
