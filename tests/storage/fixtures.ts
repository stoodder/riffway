/** Record factories and helpers for storage tests (fake-indexeddb). */
import 'fake-indexeddb/auto';
import type { AudioLink, BestRecord, RunRecord, SongCacheEntry } from '@shared/storage';
import type { SectionProgressRecord } from '@core/progress';
import { openStorage, type RiffwayStorage } from '../../src/storage';

let n = 0;
/** Open storage on a fresh, uniquely named database. */
export async function freshStorage(now = (): number => Date.UTC(2026, 10, 19, 20)): Promise<RiffwayStorage> {
  n += 1;
  return openStorage({ dbName: `riffway-test-${n}-${Math.random().toString(36).slice(2)}`, now });
}

export function makeRun(over: Partial<RunRecord> = {}): Omit<RunRecord, 'id'> {
  return {
    songId: 'starter:ode',
    arrangement: 0,
    startedAt: 1_000,
    endedAt: 61_000,
    speed: 0.7,
    mode: 'practice',
    score: 1200,
    accuracy: 91.5,
    stars: 4,
    maxCombo: 30,
    counts: { Perfect: 20, Great: 10, Good: 5, WrongNote: 1, Miss: 2 },
    sections: [
      { idx: 0, notes: 18, hits: 17, accuracy: 94.4 },
      { idx: 1, notes: 20, hits: 18, accuracy: 90 },
    ],
    histogram: { binMs: 10, minMs: -120, bins: [0, 1, 2, 5, 9, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    clean: true,
    inputSource: 'keyboard',
    activeSec: 60,
    ...over,
  };
}

export function makeBest(over: Partial<BestRecord> = {}): BestRecord {
  return { songId: 'starter:ode', arrangement: 0, speedBucket: 70, score: 1200, accuracy: 91.5, stars: 4, runId: 1, at: 61_000, ...over };
}

export function makeProgress(over: Partial<SectionProgressRecord> = {}): SectionProgressRecord {
  return {
    songId: 'starter:ode',
    arrangement: 0,
    sectionIdx: 0,
    cleanRuns: 3,
    cleanRunsAt100: 0,
    lastSpeed: 0.8,
    trainer: { speed: 0.85, failStreak: 0 },
    bestAccuracy: 94,
    passesSinceGain: 1,
    session: { id: 'sess-1', cleanRunsAt100: 0 },
    ...over,
  };
}

export function makeLink(over: Partial<AudioLink> = {}): AudioLink {
  return {
    songId: 'local:abc',
    arrangement: 0,
    audioId: 'f'.repeat(40),
    fileName: 'backing.mp3',
    anchors: [
      { songTime: 0, audioTime: 1.25 },
      { songTime: 60, audioTime: 61.5 },
    ],
    gainDb: -3,
    enabled: true,
    ...over,
  };
}

export function makeCache(over: Partial<SongCacheEntry> = {}): SongCacheEntry {
  const songId = over.songId ?? 'starter:ode';
  return {
    songId,
    meta: {
      id: songId,
      source: 'starter',
      title: 'Ode to Joy',
      composer: 'Beethoven',
      fileName: 'ode.atex',
      tier: 2,
      rating: 1.6,
      ratingProvisional: false,
      tuningId: 'standard',
      tuningLabel: 'Standard',
      tags: { style: ['pick'], genre: ['recognizable'], skills: [] },
      rhythm: 'exact',
      availability: 'playable',
      arrangements: 1,
      defaultArrangement: 0,
      durationSec: 64,
      score: 0,
    },
    difficulty: null,
    lastPlayedAt: 5_000,
    favourite: false,
    ...over,
  };
}
