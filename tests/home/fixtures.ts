/** Record and context factories for the home + song screen tests (T-034). */
import type { SongMeta } from '@shared/api';
import { defaultSettings } from '@shared/settings';
import type { DifficultyFactorId, DifficultyReport, SectionDifficulty, Song, Tier, TrackInfo } from '@shared/song';
import type { SearchResult } from '@shared/sources';
import type { RunRecord, SectionProgress, StreakState } from '@shared/storage';
import type { HomeInput } from '../../src/ui/screens/home/model';

/** Fixed "now": Thursday 2026-11-19 20:00 local time. */
export const NOW = new Date(2026, 10, 19, 20, 0, 0).getTime();
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function result(id: string, title: string, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    id,
    source: 'starter',
    title,
    fileName: `${title}.atex`,
    tier: 3,
    rating: 3.2,
    ratingProvisional: false,
    tuningId: 'standard',
    tuningLabel: 'Standard',
    tags: { style: ['pick'], genre: ['rock'], skills: [] },
    rhythm: 'exact',
    availability: 'playable',
    arrangements: 1,
    defaultArrangement: 0,
    durationSec: 75,
    score: 0,
    ...extra,
  };
}

let runId = 0;
export function run(over: Partial<RunRecord> = {}): RunRecord {
  runId += 1;
  const startedAt = over.startedAt ?? NOW - HOUR;
  return {
    id: runId,
    songId: 'starter:hall',
    arrangement: 0,
    startedAt,
    endedAt: startedAt + 120_000,
    speed: 0.8,
    mode: 'practice',
    score: 1000,
    accuracy: 85,
    stars: 3,
    maxCombo: 20,
    counts: { Perfect: 10, Great: 5, Good: 3, WrongNote: 1, Miss: 1 },
    sections: [],
    histogram: { binMs: 10, minMs: -120, bins: new Array<number>(24).fill(0) },
    clean: false,
    inputSource: 'keyboard',
    activeSec: 120,
    ...over,
  };
}

export function progress(over: Partial<SectionProgress> = {}): SectionProgress {
  return {
    songId: 'starter:hall',
    arrangement: 0,
    sectionIdx: 0,
    cleanRuns: 1,
    cleanRunsAt100: 0,
    lastSpeed: 0.8,
    trainer: { speed: 0.85, failStreak: 0 },
    bestAccuracy: 88,
    passesSinceGain: 0,
    ...over,
  };
}

export function streak(over: Partial<StreakState> = {}): StreakState {
  return { weekTarget: 4, current: 0, best: 0, freezes: 0, weeksTowardFreeze: 0, lastEvaluatedWeek: null, ...over };
}

const FACTOR_IDS: DifficultyFactorId[] = ['density', 'tempo', 'shifts', 'span', 'skipping', 'techniques', 'chords'];
const WEIGHTS: Record<DifficultyFactorId, number> = { density: 0.35, tempo: 0.15, shifts: 0.15, span: 0.1, skipping: 0.1, techniques: 0.1, chords: 0.05 };

export function section(idx: number, name: string, rating: number, c: Partial<Record<DifficultyFactorId, number>> = {}): SectionDifficulty {
  const factors = Object.fromEntries(FACTOR_IDS.map((id) => [id, { measure: 0, c: c[id] ?? 0.1, weight: WEIGHTS[id] }])) as SectionDifficulty['factors'];
  return { sectionIndex: idx, name, start: idx * 10, end: idx * 10 + 10, rating, tier: Math.round(rating) as Tier, raw: rating / 10, factors };
}

export function report(sections: SectionDifficulty[], rating = 4.3): DifficultyReport {
  return {
    version: 1,
    rating,
    tier: Math.round(rating) as Tier,
    tierName: 'Developing',
    provisional: false,
    sections,
    skills: ['position-shifts'],
    highlights: ['fast position shifts'],
  };
}

export function track(index: number, name: string, extra: Partial<TrackInfo> = {}): TrackInfo {
  return { index, name, strings: 6, tuning: [64, 59, 55, 50, 45, 40], capo: 0, playable: true, noteCount: 120, ...extra };
}

export function songMeta(id: string, title: string, over: { tracks?: TrackInfo[]; report?: DifficultyReport | null; entry?: Partial<SongMeta['entry']> } = {}): SongMeta {
  const tracks = over.tracks ?? [track(0, 'Lead')];
  const rep = over.report === undefined ? report([section(0, 'Intro', 2.5), section(1, 'Riff', 4.8, { shifts: 0.9, density: 0.7 }), section(2, 'Outro', 3)]) : over.report;
  return {
    entry: {
      id,
      source: 'starter',
      path: `${id.split(':')[1]}.atex`,
      fileName: `${id.split(':')[1]}.atex`,
      format: 'alphatex',
      mtimeMs: 0,
      size: 100,
      sha1: 'a'.repeat(40),
      title,
      composer: 'Edvard Grieg',
      tracks,
      defaultArrangement: 0,
      tuning: tracks[0]!.tuning,
      tuningId: 'standard',
      tuningLabel: 'Standard',
      capo: 0,
      bpm: 120,
      durationSec: 30,
      rhythm: 'exact',
      difficulty: rep,
      tags: { style: ['pick'], genre: ['classical'], skills: ['chords'] },
      hasMidi: false,
      hasSidecar: false,
      ...over.entry,
    },
    arrangements: tracks,
    difficulty: rep ? Object.fromEntries(tracks.filter((t) => t.playable).map((t) => [t.index, rep])) : {},
    files: { main: `/api/songs/${encodeURIComponent(id)}/file` },
  };
}

/** A minimal `Song` with three sections (what the sections map reads). */
export function song(id: string, arrangement = 0): Song {
  const sections = [
    { name: 'Intro', startBar: 0, endBar: 2, start: 0, end: 8 },
    { name: 'Riff', startBar: 2, endBar: 6, start: 8, end: 24 },
    { name: 'Outro', startBar: 6, endBar: 7, start: 24, end: 30 },
  ];
  return {
    schema: 1,
    id,
    arrangement,
    meta: {
      title: 'Song',
      source: { source: 'starter', path: 'x.atex' },
      tags: { style: ['pick'], genre: [], skills: [] },
      tuning: [64, 59, 55, 50, 45, 40],
      capo: 0,
      durationSec: 30,
      rhythm: 'exact',
      tracks: [track(0, 'Lead')],
    },
    timing: { tempos: [{ time: 0, bpm: 120 }], bars: [] },
    sections,
    notes: [],
    chords: [],
  };
}

/** A `HomeInput` with sensible defaults. */
export function homeInput(over: Partial<HomeInput> = {}): HomeInput {
  return {
    now: NOW,
    settings: defaultSettings(),
    candidates: [
      result('starter:open', 'Open Strings', { tier: 1, rating: 1.3, tags: { style: ['pick'], genre: ['exercise'], skills: [] } }),
      result('starter:ode', 'Ode to Joy', { tier: 2, rating: 1.9, composer: 'Beethoven' }),
      result('starter:hall', 'In the Hall of the Mountain King', { tier: 4, rating: 4.3, composer: 'Edvard Grieg' }),
      result('starter:scar', 'Scarborough Fair', { tier: 3, rating: 3.3 }),
      result('starter:alt', 'Alternate Picking Builder', { tier: 5, rating: 5.1 }),
    ],
    runs: [],
    checks: [],
    practiceDays: [],
    streak: streak(),
    songCache: new Map(),
    progress: new Map(),
    checklist: { tunedMarked: false, hidden: false },
    focus: null,
    ...over,
  };
}
