/**
 * Results helpers (timing tendency, weakest section, next steps, rebuilding from a stored run, the
 * hand-off) and run bookkeeping helpers (section stats/coverage, section events, the progress book).
 */
import { describe, expect, it } from 'vitest';
import type { Judgement, TimingHistogram } from '@shared/judge';
import type { RunRecord, SectionProgress } from '@shared/storage';
import {
  completedSections,
  sectionEvents,
  sectionEventText,
  SectionProgressBook,
  sectionStats,
  sectionTargetCounts,
} from '../../src/game/session/progress';
import { nextSteps, recallResult, rememberResult, resultFromRecord, resultKey, timingTendency, weakestOf, type RunResult } from '../../src/game/session/results';
import { highwayJudgement, outcomeDetail } from '../../src/ui/screens/game/hud';
import { makeSong } from './helpers';

function hist(entries: [number, number][]): TimingHistogram {
  const bins = new Array<number>(24).fill(0);
  for (const [ms, n] of entries) bins[Math.floor((ms + 120) / 10)] += n;
  return { binMs: 10, minMs: -120, bins };
}

const j = (over: Partial<Judgement>): Judgement => ({
  noteIds: [0],
  outcome: 'Perfect',
  deltaMs: 0,
  timing: null,
  expectedMidi: 64,
  chord: false,
  songTime: 0,
  ctxTime: 0,
  final: true,
  pass: 0,
  ...over,
});

describe('timing tendency', () => {
  it('reads early, late, centred and too-few-samples', () => {
    expect(timingTendency(hist([[-40, 10]])).label).toBe('early');
    expect(timingTendency(hist([[-40, 10]])).text).toContain('35 ms ahead');
    expect(timingTendency(hist([[30, 9]])).label).toBe('late');
    expect(timingTendency(hist([[0, 10], [-10, 10]])).label).toBe('centred');
    expect(timingTendency(hist([[50, 3]])).label).toBe('unknown');
  });
});

describe('results helpers', () => {
  it('weakest section is the lowest accuracy, earliest on ties, ignoring empty sections', () => {
    expect(weakestOf([{ idx: 0, accuracy: 80, notes: 4 }, { idx: 1, accuracy: 60, notes: 4 }, { idx: 2, accuracy: 60, notes: 4 }])).toBe(1);
    expect(weakestOf([{ idx: 0, accuracy: 0, notes: 0 }])).toBeNull();
  });

  it('next steps: loop the weakest, speed up after clean below 100%, mastery at 100%, slow down when rough', () => {
    const sections = [{ idx: 0, name: 'Verse', notes: 10, hits: 6, accuracy: 60 }];
    const rough = nextSteps({ accuracy: 60, clean: false, speed: 1, sections, weakestSection: 0, mode: 'play' });
    expect(rough.map((s) => s.kind)).toEqual(['loop-weakest', 'slow-down', 'replay']);
    expect(rough[0]?.game).toEqual({ mode: 'practice', section: 0 });
    expect(rough[1]?.game.speed).toBe(0.9);
    const cleanSlow = nextSteps({ accuracy: 95, clean: true, speed: 0.8, sections: [], weakestSection: null, mode: 'practice' });
    expect(cleanSlow.map((s) => s.kind)).toEqual(['speed-up', 'replay']);
    expect(cleanSlow[0]?.title).toBe('Try it at 85%');
    const cleanFull = nextSteps({ accuracy: 98, clean: true, speed: 1, sections: [], weakestSection: null, mode: 'play' });
    expect(cleanFull[0]?.kind).toBe('mastery');
  });

  it('rebuilds a result from a stored run and hands results over by key', () => {
    const record: RunRecord = {
      id: 7,
      songId: 's',
      arrangement: 0,
      startedAt: 1,
      endedAt: 2,
      speed: 0.8,
      mode: 'play',
      score: 1000,
      accuracy: 75,
      stars: 2,
      maxCombo: 9,
      counts: { Perfect: 5, Great: 1, Good: 0, WrongNote: 1, Miss: 1 },
      sections: [{ idx: 0, notes: 4, hits: 4, accuracy: 100 }, { idx: 1, notes: 4, hits: 2, accuracy: 50 }],
      histogram: hist([[0, 6]]),
      clean: false,
      inputSource: 'keyboard',
      activeSec: 30,
    };
    const best = { songId: 's', arrangement: 0, speedBucket: 80, score: 1000, accuracy: 75, stars: 2 as const, runId: 7, at: 2 };
    const r = resultFromRecord(record, { title: 'T', artist: null, sectionName: (i) => `S${i}`, best });
    expect(r).toMatchObject({ runId: 7, judgedNotes: 8, weakestSection: 1, newBest: true, completed: true, timingScore: null });
    expect(r.sections[1]?.name).toBe('S1');
    expect(resultKey(r)).toBe('7');
    const unsaved: RunResult = { ...r, runId: null, endedAt: 42 };
    expect(rememberResult(unsaved)).toBe('unsaved-42');
    expect(recallResult('unsaved-42')).toBe(unsaved);
    expect(recallResult('nope')).toBeNull();
  });
});

describe('run bookkeeping', () => {
  const song = makeSong(
    [{ time: 0.5 }, { time: 1 }, { time: 2.5 }, { time: 3 }, { time: 3.5 }],
    { bars: 2, sections: [['A', 0, 1], ['B', 1, 2]] },
  );

  it('section stats and coverage from the judgement log', () => {
    expect(sectionTargetCounts(song)).toEqual([2, 3]);
    const log = [
      j({ noteIds: [0], songTime: 0.5 }),
      j({ noteIds: [1], songTime: 1, outcome: 'Miss', deltaMs: null }),
      j({ noteIds: [2], songTime: 2.5 }),
      j({ noteIds: [3], songTime: 3, outcome: 'WrongNote', final: false }),
    ];
    const stats = sectionStats(song, log);
    expect(stats.map((s) => [s.idx, s.judgedNotes, s.accuracy])).toEqual([
      [0, 2, 50],
      [1, 1, 100],
    ]);
    // Only section A was played completely.
    expect(completedSections(song, log).map((s) => s.idx)).toEqual([0]);
  });

  it('section events: clean, mastered, locked in, failed check, plateau', () => {
    const base: SectionProgress = {
      songId: 's',
      arrangement: 0,
      sectionIdx: 0,
      cleanRuns: 1,
      cleanRunsAt100: 1,
      lastSpeed: 1,
      trainer: { speed: 1, failStreak: 0 },
      bestAccuracy: 95,
      passesSinceGain: 0,
    };
    expect(sectionEvents(base, { ...base, masteredAt: 10 }, true, 10)).toEqual(['clean', 'mastered']);
    const due = { ...base, masteredAt: 1, nextCheckAt: 5 };
    expect(sectionEvents(due, { ...due, lockedInAt: 10 }, true, 10)).toEqual(['clean', 'locked-in']);
    const { masteredAt: _m, nextCheckAt: _n, ...failed } = due;
    expect(sectionEvents(due, failed, false, 10)).toEqual(['check-failed']);
    expect(sectionEvents(base, { ...base, passesSinceGain: 6 }, false, 10)).toEqual(['plateau']);
    expect(sectionEventText('Verse', 'mastered')).toContain('Verse mastered');
  });

  it('the progress book chains updates in memory and writes them in order', async () => {
    const writes: SectionProgress[] = [];
    const book = new SectionProgressBook(
      { putSectionProgress: async (p) => void writes.push(p) },
      { songId: 's', arrangement: 0, sessionId: 'x', comfortTier: 2, sectionTier: () => 3, sectionName: () => 'Verse' },
      [],
    );
    book.apply({ sectionIdx: 0, accuracy: 100, clean: true, speed: 1, at: 1 });
    const second = book.apply({ sectionIdx: 0, accuracy: 100, clean: true, speed: 1, at: 2 });
    expect(second.events).toEqual(['clean', 'mastered']);
    expect(second.sessionCleanAt100).toBe(2);
    await book.flush();
    expect(writes.map((w) => w.cleanRuns)).toEqual([1, 2]);
  });
});

describe('HUD feedback detail', () => {
  it('minimal hides sub-labels, standard shows early/late and the played note, detailed adds ms', () => {
    const late = j({ outcome: 'Good', deltaMs: 92, timing: 'late' });
    const wrong = j({ outcome: 'WrongNote', playedMidi: 67 });
    expect(outcomeDetail(late, 'minimal')).toBe('');
    expect(outcomeDetail(late, 'standard')).toBe('late');
    expect(outcomeDetail(late, 'detailed')).toBe('late · +92 ms');
    expect(outcomeDetail(j({ deltaMs: -12 }), 'detailed')).toBe('-12 ms');
    expect(outcomeDetail(wrong, 'standard')).toBe('played G4');
    expect(highwayJudgement(wrong, 'minimal').playedMidi).toBeUndefined();
    expect(highwayJudgement(late, 'minimal').timing).toBeNull();
    expect(highwayJudgement(late, 'standard')).toBe(late);
  });
});
