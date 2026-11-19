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
  /** Display name of a section ("Intro"), when known; goals fall back to "section 2". */
  sectionName?: (songId: string, sectionIdx: number) => string | undefined;
}

/** How the comfort tier was reached (for "why is it still 2?" copy). */
export interface ComfortTierDetail {
  tier: Tier;
  /** `default`: no qualifying run; `one-song`: one strong song at `tier + 1`; `two-songs`: the full rule. */
  basis: 'default' | 'one-song' | 'two-songs';
  /** Distinct songs with a qualifying run (any tier). */
  qualifyingSongs: number;
}

/**
 * The comfort tier and its basis. A tier is comfortable with ≥ 85% accuracy at 100% speed on
 * ≥ 2 distinct songs of that tier. One such song at tier T already shows the tier below is
 * comfortable (T − 1), so a strong run on a harder song raises the estimate at once instead of
 * waiting for a second song. Never below {@link DEFAULT_COMFORT_TIER}. Loop runs (partial songs) and
 * songs of unknown tier do not count.
 */
export function comfortTierDetail(runs: readonly RunRecord[], tierOfSong: (songId: string) => Tier | null): ComfortTierDetail {
  const songsPerTier = new Map<Tier, Set<string>>();
  const qualifying = new Set<string>();
  for (const r of runs) {
    if (r.loop || !isFullSpeed(r.speed) || r.accuracy < COMFORT_ACCURACY) continue;
    const tier = tierOfSong(r.songId);
    if (tier === null) continue;
    qualifying.add(r.songId);
    const songs = songsPerTier.get(tier) ?? new Set<string>();
    songs.add(r.songId);
    songsPerTier.set(tier, songs);
  }
  let detail: ComfortTierDetail = { tier: DEFAULT_COMFORT_TIER, basis: 'default', qualifyingSongs: qualifying.size };
  for (const [tier, songs] of songsPerTier) {
    const candidate = songs.size >= COMFORT_SONGS ? tier : ((tier - 1) as Tier);
    if (candidate > detail.tier || (candidate === detail.tier && songs.size >= COMFORT_SONGS && detail.basis !== 'two-songs')) {
      detail = { tier: candidate, basis: songs.size >= COMFORT_SONGS ? 'two-songs' : 'one-song', qualifyingSongs: qualifying.size };
    }
  }
  return detail;
}

/**
 * Comfort tier: see {@link comfortTierDetail} (highest tier with ≥ 85% at 100% on ≥ 2 distinct
 * songs, or one below a tier with one such song; {@link DEFAULT_COMFORT_TIER} otherwise).
 */
export function comfortTier(runs: readonly RunRecord[], tierOfSong: (songId: string) => Tier | null): Tier {
  return comfortTierDetail(runs, tierOfSong).tier;
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

/**
 * The label a song gets from its tier alone, so the badge always agrees with the reason: one tier
 * above comfort is a stretch, two or more a reach, at or below comfort a comfort pick. Slots are
 * filled by target tier, but a small library fills them from neighbouring tiers; this keeps a tier-2
 * song in a "stretch" slot from being called a stretch for a tier-2 player.
 */
export function kindForTier(tier: Tier, comfort: Tier): SlotKind {
  const d = tier - comfort;
  return d >= 2 ? 'reach' : d === 1 ? 'stretch' : 'comfort';
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
      item(s, 'review', p.arrangement, `Next-day check due: one clean run of ${sectionLabel(input, p.songId, p.sectionIdx)} at full speed locks it in`, p.sectionIdx),
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
    return ranked.map((s) => {
      const label = kindForTier(s.tier, comfort);
      return item(s, label, s.song.defaultArrangement, reasonFor(label, s, comfort));
    });
  };

  const picked = [
    ...pick('stretch', RECOMMENDATION_MIX.stretch),
    ...pick('comfort', RECOMMENDATION_MIX.comfort - reviews.length),
    ...pick('reach', RECOMMENDATION_MIX.reach),
  ];
  const ofKind = (kind: SlotKind): Recommendation[] => picked.filter((r) => r.kind === kind);
  return [...ofKind('stretch'), ...reviews, ...ofKind('comfort'), ...ofKind('reach')];
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

/** Session goals offered per session (learning research row 1: choose one of three). */
export const SESSION_GOAL_COUNT = 3;

/** `“Intro”` when the section has a name, else `section 2`. */
function sectionLabel(input: RecommendInput, songId: string, sectionIdx: number): string {
  const name = input.sectionName?.(songId, sectionIdx)?.trim();
  return name ? `“${name}”` : `section ${sectionIdx + 1}`;
}

/**
 * {@link SESSION_GOAL_COUNT} process goals for the session, for the player to pick one: (1) the
 * earliest next-day check that is due, (2) the weakest section of the most recently played stretch
 * song (tier above comfort), (3) a stretch recommendation not played yet. Missing slots are filled
 * with the weakest unclean section of other recently played songs, then with more unplayed
 * recommendations (stretch first, then comfort picks as a warm-up), so the player always has a choice
 * when the library allows it. Sections are named when `sectionName` knows them. Fingerstyle songs are
 * left out unless the player enabled "Fingerstyle" in preferences. Deterministic for equal input.
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
  const free = (songId: string): boolean => goals.every((g) => g.songId !== songId);

  const due = dueChecksInOrder(input.dueChecks, input.now).filter((p) => allowed(p.songId));
  const check = due[0];
  if (check) {
    const more = due.length > 1 ? ` (+${due.length - 1} more due)` : '';
    goals.push({
      kind: 'next-day-check',
      label: `Next-day check: play ${sectionLabel(input, check.songId, check.sectionIdx)} of ${title(check.songId)} clean at full speed${more}`,
      songId: check.songId,
      arrangement: check.arrangement,
      sectionIdx: check.sectionIdx,
      targetSpeed: 1,
    });
  }

  const weakestGoal = (w: WeakSection): SessionGoal => {
    const pct = Math.min(100, speedBucket(w.speed));
    return {
      kind: 'weakest-section',
      label: `Get ${sectionLabel(input, w.songId, w.sectionIdx)} of ${title(w.songId)} clean at ${pct}%`,
      songId: w.songId,
      arrangement: w.arrangement,
      sectionIdx: w.sectionIdx,
      targetSpeed: pct / 100,
    };
  };
  const weakest = weakSections(input, (songId, tier) => tier > input.comfortTier && allowed(songId))[0];
  if (weakest) goals.push(weakestGoal(weakest));

  const played = new Set(input.recentRuns.map((r) => r.songId));
  const recs = recommend(input).filter((r) => !played.has(r.songId) && allowed(r.songId));
  const startGoal = (r: Recommendation, warmUp: boolean): SessionGoal => {
    const pct = Math.round(TRAINER.start * 100);
    return {
      kind: 'new-stretch',
      label: warmUp ? `Warm up with ${title(r.songId)}: one clean pass at ${pct}%` : `Start ${title(r.songId)}: one clean pass at ${pct}%`,
      songId: r.songId,
      arrangement: r.arrangement,
      targetSpeed: TRAINER.start,
    };
  };
  const fresh = recs.find((r) => r.kind === 'stretch' && free(r.songId));
  if (fresh) goals.push(startGoal(fresh, false));

  // Fill the remaining slots: other unclean sections first, then more new songs.
  for (const w of weakSections(input, (songId) => allowed(songId) && free(songId))) {
    if (goals.length >= SESSION_GOAL_COUNT) break;
    if (free(w.songId) && w.accuracy < TRAINER.cleanAccuracy) goals.push(weakestGoal(w));
  }
  const byKind = (kind: RecommendationKind): Recommendation[] => recs.filter((r) => r.kind === kind);
  for (const r of [...byKind('stretch'), ...byKind('comfort'), ...byKind('reach')]) {
    if (goals.length >= SESSION_GOAL_COUNT) break;
    if (free(r.songId)) goals.push(startGoal(r, r.kind === 'comfort'));
  }
  return goals.slice(0, SESSION_GOAL_COUNT);
}

/** The weakest judged section of a run. */
interface WeakSection {
  songId: string;
  arrangement: number;
  sectionIdx: number;
  speed: number;
  accuracy: number;
}

/**
 * The weakest judged section of the latest run of each song (most recent song first) whose song
 * passes `accept(songId, tier)`; songs without a known tier are skipped.
 */
function weakSections(input: RecommendInput, accept: (songId: string, tier: Tier) => boolean): WeakSection[] {
  const tiers = new Map<string, Tier>();
  for (const c of input.candidates) if (c.tier !== null && !tiers.has(c.id)) tiers.set(c.id, c.tier);
  const runs = [...input.recentRuns].sort((a, b) => b.startedAt - a.startedAt || compareIds(a.songId, b.songId));
  const seen = new Set<string>();
  const out: WeakSection[] = [];
  for (const r of runs) {
    if (seen.has(r.songId)) continue;
    const tier = tiers.get(r.songId);
    if (tier === undefined || !accept(r.songId, tier)) continue;
    const judged = r.sections.filter((s) => s.notes > 0);
    if (judged.length === 0) continue;
    seen.add(r.songId);
    const w = judged.reduce((a, s) => (s.accuracy < a.accuracy || (s.accuracy === a.accuracy && s.idx < a.idx) ? s : a));
    out.push({ songId: r.songId, arrangement: r.arrangement, sectionIdx: w.idx, speed: r.speed, accuracy: w.accuracy });
  }
  return out;
}
