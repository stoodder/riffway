/**
 * Comfort tier, recommendations and session goals (docs/progress.md § Recommendations, learning
 * research rows 1 and 10). Pure and deterministic: equal input gives equal output, independent of
 * candidate order. Every recommendation and goal carries a human-readable reason.
 * @module
 */
import type { Recommendation, RecommendationKind, RunRecord, SectionProgress, SessionGoal } from '@shared/storage';
import type { SearchResult } from '@shared/sources';
import type { Tier } from '@shared/song';
import { TRAINER } from '@core/practice';
import { DAY_MS } from './dates';
import { isFullSpeed, speedBucket } from './mastery';

/** Comfort tier for a player without qualifying runs (profile: beginner–intermediate). */
export const DEFAULT_COMFORT_TIER: Tier = 2;
/** Accuracy % at full speed that shows a tier is comfortable. */
export const COMFORT_ACCURACY = 85;
/** Distinct songs needed at a tier to call it comfortable. */
export const COMFORT_SONGS = 2;
/** Slots per kind: 60% stretch, 30% comfort/review, 10% reach. */
export const RECOMMENDATION_MIX = { stretch: 6, comfort: 3, reach: 1 } as const;
/** Tier offset from the comfort tier per slot kind. */
const TARGET_OFFSET = { stretch: 1, comfort: 0, reach: 2 } as const;
/** Scoring weights (docs/progress.md). */
const STYLE_BONUS = 0.2;
const GENRE_BONUS = 0.1;
const RECENT_PENALTY = -0.3;
const FIT_RANGE = 3;

type SlotKind = keyof typeof RECOMMENDATION_MIX;

/** Inputs for {@link recommend} and {@link sessionGoals}. */
export interface RecommendInput {
  candidates: readonly SearchResult[];
  comfortTier: Tier;
  recentRuns: readonly RunRecord[];
  dueChecks: readonly SectionProgress[];
  preferences: { style: 'pick' | 'fingerstyle'; fingerstyle: boolean; genres: readonly string[] };
  now: number;
}

/**
 * Highest tier with ≥ 85% accuracy at 100% speed on ≥ 2 distinct songs; {@link DEFAULT_COMFORT_TIER}
 * when no tier qualifies. Loop runs (partial songs) and songs of unknown tier do not count.
 */
export function comfortTier(runs: readonly RunRecord[], tierOfSong: (songId: string) => Tier | null): Tier {
  const songsPerTier = new Map<Tier, Set<string>>();
  for (const r of runs) {
    if (r.loop || !isFullSpeed(r.speed) || r.accuracy < COMFORT_ACCURACY) continue;
    const tier = tierOfSong(r.songId);
    if (tier === null) continue;
    const songs = songsPerTier.get(tier) ?? new Set<string>();
    songs.add(r.songId);
    songsPerTier.set(tier, songs);
  }
  let best: Tier | null = null;
  for (const [tier, songs] of songsPerTier) if (songs.size >= COMFORT_SONGS && (best === null || tier > best)) best = tier;
  return best ?? DEFAULT_COMFORT_TIER;
}

/** A candidate that can be recommended (has a tier, a playable arrangement and usable rhythm). */
interface Eligible {
  song: SearchResult;
  tier: Tier;
}

interface Scored extends Eligible {
  score: number;
  fit: number;
  notes: string[];
}

/** Eligible candidates, de-duplicated by id and sorted by id (order-independent output). */
function eligibleCandidates(candidates: readonly SearchResult[]): Eligible[] {
  const byId = new Map<string, Eligible>();
  for (const song of candidates) {
    if (song.tier === null || song.availability !== 'playable' || song.rhythm === 'needs-alignment') continue;
    if (song.defaultArrangement < 0 || byId.has(song.id)) continue;
    byId.set(song.id, { song, tier: song.tier });
  }
  return [...byId.values()].sort((a, b) => compareIds(a.song.id, b.song.id));
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Song ids with a run that ended in the 24 h before `now`. */
function recentlyPlayed(runs: readonly RunRecord[], now: number): Set<string> {
  return new Set(runs.filter((r) => r.endedAt > now - DAY_MS && r.startedAt <= now).map((r) => r.songId));
}

/** Score a candidate against a target tier: fit + preference bonus + freshness penalty. */
function scoreFor(e: Eligible, target: number, input: RecommendInput, recent: Set<string> | null): Scored {
  const notes: string[] = [];
  const fit = Math.max(0, 1 - Math.abs(e.tier - target) / FIT_RANGE);
  let score = fit;
  if (e.song.tags.style.includes(input.preferences.style)) {
    score += STYLE_BONUS;
    notes.push(`suits your ${input.preferences.style === 'pick' ? 'pick' : 'fingerstyle'} playing`);
  }
  const genres = e.song.tags.genre.filter((g) => input.preferences.genres.includes(g));
  if (genres.length > 0) {
    score += GENRE_BONUS;
    notes.push(genres.join('/'));
  }
  if (recent?.has(e.song.id)) {
    score += RECENT_PENALTY;
    notes.push('played in the last 24 h');
  }
  return { ...e, fit, score, notes };
}

/** Best first: score, then closeness to the target, then id. */
function byRank(target: number) {
  return (a: Scored, b: Scored): number =>
    b.score - a.score || Math.abs(a.tier - target) - Math.abs(b.tier - target) || compareIds(a.song.id, b.song.id);
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** "one above your comfort tier (3)", "at your comfort tier (3)", … */
function tierRelation(tier: Tier, comfort: Tier): string {
  const d = tier - comfort;
  if (d === 0) return `at your comfort tier (${comfort})`;
  const n = NUMBER_WORDS[Math.abs(d)] ?? String(Math.abs(d));
  return `${n} ${d > 0 ? 'above' : 'below'} your comfort tier (${comfort})`;
}

const KIND_LEAD: Record<SlotKind, string> = {
  stretch: 'Stretch pick',
  comfort: 'Comfort pick',
  reach: 'Reach goal — try a single section',
};

function reasonFor(kind: SlotKind, s: Scored, comfort: Tier): string {
  return [`${KIND_LEAD[kind]}: tier ${s.tier}, ${tierRelation(s.tier, comfort)}`, ...s.notes].join(' · ');
}

/**
 * Recommend up to 10 songs: 6 stretch (comfort + 1), 3 comfort or review, 1 reach (comfort + 2,
 * suggested as a single section). Next-day checks that are due fill the comfort slots first as
 * `review` items (with `sectionIdx`). Each slot takes the best-scoring unused candidate for its target
 * tier (`fit = 1 − |tier − target| / 3`, +0.2 preferred style, +0.1 preferred genre, −0.3 if played in
 * the last 24 h unless it is a review); candidates three or more tiers from the target never fill a
 * slot, so a small library yields fewer items. Each song appears at most once. Output order: stretch,
 * review, comfort, reach. Deterministic for equal input.
 */
export function recommend(input: RecommendInput): Recommendation[] {
  const comfort = input.comfortTier;
  const eligible = eligibleCandidates(input.candidates);
  const byId = new Map(eligible.map((e) => [e.song.id, e]));
  const recent = recentlyPlayed(input.recentRuns, input.now);
  const used = new Set<string>();

  const reviews: Recommendation[] = [];
  for (const p of dueChecksInOrder(input.dueChecks, input.now)) {
    if (reviews.length >= RECOMMENDATION_MIX.comfort) break;
    const e = byId.get(p.songId);
    if (!e || used.has(p.songId)) continue;
    used.add(p.songId);
    const s = scoreFor(e, comfort + TARGET_OFFSET.comfort, input, null);
    reviews.push(
      item(s, 'review', p.arrangement, `Next-day check due: one clean run of section ${p.sectionIdx + 1} at full speed locks it in`, p.sectionIdx),
    );
  }

  const pick = (kind: SlotKind, count: number): Recommendation[] => {
    const target = comfort + TARGET_OFFSET[kind];
    const ranked = eligible
      .filter((e) => !used.has(e.song.id))
      .map((e) => scoreFor(e, target, input, recent))
      .filter((s) => s.fit > 0)
      .sort(byRank(target))
      .slice(0, count);
    for (const s of ranked) used.add(s.song.id);
    return ranked.map((s) => item(s, kind, s.song.defaultArrangement, reasonFor(kind, s, comfort)));
  };

  const stretch = pick('stretch', RECOMMENDATION_MIX.stretch);
  const comfortItems = pick('comfort', RECOMMENDATION_MIX.comfort - reviews.length);
  const reach = pick('reach', RECOMMENDATION_MIX.reach);
  return [...stretch, ...reviews, ...comfortItems, ...reach];
}

function item(s: Scored, kind: RecommendationKind, arrangement: number, reason: string, sectionIdx?: number): Recommendation {
  const rec: Recommendation = { songId: s.song.id, arrangement, kind, tier: s.tier, score: round3(s.score), reason };
  if (sectionIdx !== undefined) rec.sectionIdx = sectionIdx;
  return rec;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Due checks, earliest first (ties by key), `nextCheckAt ≤ now` only. */
function dueChecksInOrder(checks: readonly SectionProgress[], now: number): SectionProgress[] {
  return checks
    .filter((p) => p.nextCheckAt !== undefined && p.nextCheckAt <= now && p.lockedInAt === undefined)
    .sort(
      (a, b) =>
        (a.nextCheckAt ?? 0) - (b.nextCheckAt ?? 0) ||
        compareIds(a.songId, b.songId) ||
        a.arrangement - b.arrangement ||
        a.sectionIdx - b.sectionIdx,
    );
}

/**
 * Up to 3 process goals for the session, for the player to pick one: (1) the earliest next-day check
 * that is due, (2) the weakest section of the most recently played stretch song (tier above comfort),
 * (3) a stretch recommendation not played yet. Fingerstyle songs are left out unless the player
 * enabled "Fingerstyle" in preferences. Deterministic for equal input.
 */
export function sessionGoals(input: RecommendInput): SessionGoal[] {
  const songs = new Map<string, SearchResult>();
  for (const c of input.candidates) if (!songs.has(c.id)) songs.set(c.id, c);
  const allowed = (songId: string): boolean => {
    const s = songs.get(songId);
    return input.preferences.fingerstyle || !s || !s.tags.style.includes('fingerstyle');
  };
  const title = (songId: string): string => `“${songs.get(songId)?.title ?? songId}”`;
  const goals: SessionGoal[] = [];

  const due = dueChecksInOrder(input.dueChecks, input.now).filter((p) => allowed(p.songId));
  const check = due[0];
  if (check) {
    const more = due.length > 1 ? ` (+${due.length - 1} more due)` : '';
    goals.push({
      kind: 'next-day-check',
      label: `Next-day check: play section ${check.sectionIdx + 1} of ${title(check.songId)} clean at full speed${more}`,
      songId: check.songId,
      arrangement: check.arrangement,
      sectionIdx: check.sectionIdx,
      targetSpeed: 1,
    });
  }

  const weakest = weakestStretchSection(input, allowed);
  if (weakest) {
    const pct = Math.min(100, speedBucket(weakest.speed));
    goals.push({
      kind: 'weakest-section',
      label: `Get section ${weakest.sectionIdx + 1} of ${title(weakest.songId)} clean at ${pct}%`,
      songId: weakest.songId,
      arrangement: weakest.arrangement,
      sectionIdx: weakest.sectionIdx,
      targetSpeed: pct / 100,
    });
  }

  const played = new Set(input.recentRuns.map((r) => r.songId));
  const fresh = recommend(input).find(
    (r) => r.kind === 'stretch' && !played.has(r.songId) && allowed(r.songId) && goals.every((g) => g.songId !== r.songId),
  );
  if (fresh) {
    const pct = Math.round(TRAINER.start * 100);
    goals.push({
      kind: 'new-stretch',
      label: `Start ${title(fresh.songId)}: one clean pass at ${pct}%`,
      songId: fresh.songId,
      arrangement: fresh.arrangement,
      targetSpeed: TRAINER.start,
    });
  }
  return goals;
}

/** Weakest judged section of the most recent run on a song above the comfort tier. */
function weakestStretchSection(
  input: RecommendInput,
  allowed: (songId: string) => boolean,
): { songId: string; arrangement: number; sectionIdx: number; speed: number } | null {
  const tiers = new Map<string, Tier>();
  for (const c of input.candidates) if (c.tier !== null && !tiers.has(c.id)) tiers.set(c.id, c.tier);
  const runs = [...input.recentRuns].sort((a, b) => b.startedAt - a.startedAt || compareIds(a.songId, b.songId));
  for (const r of runs) {
    const tier = tiers.get(r.songId);
    if (tier === undefined || tier <= input.comfortTier || !allowed(r.songId)) continue;
    const judged = r.sections.filter((s) => s.notes > 0);
    if (judged.length === 0) continue;
    const weakest = judged.reduce((w, s) => (s.accuracy < w.accuracy || (s.accuracy === w.accuracy && s.idx < w.idx) ? s : w));
    return { songId: r.songId, arrangement: r.arrangement, sectionIdx: weakest.idx, speed: r.speed };
  }
  return null;
}
