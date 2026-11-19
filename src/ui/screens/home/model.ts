/**
 * Home dashboard view model (T-034): pure functions from stored progress + the library listing to
 * what the home screen shows. No DOM, no I/O, `now` passed in, so every rule is unit-tested in Node.
 *
 * What it encodes (docs/progress.md, docs/research/learning.md):
 * - First run (no runs yet): setup checklist (input → tune → calibrate → first starter song) and the
 *   easiest starter songs.
 * - "Continue where you left off": the latest run's song and its next section to work on.
 * - Session goals (3 process goals), recommendations (6 stretch / 3 review-comfort / 1 reach) with
 *   readable reasons, next-day checks due now and tomorrow.
 * - Weekly streak (current and best side by side, week dots, freezes) and the daily goal ring.
 *   Copy is informational and forward-looking: no "streak lost", no guilt.
 * - Recent results and the repertoire count (songs with every section locked in).
 * @module
 */
import type { RouteParams, ScreenId } from '@shared/ui';
import type { Settings } from '@shared/settings';
import type { SearchResult } from '@shared/sources';
import type { DifficultyReport, Tier } from '@shared/song';
import type {
  PracticeDay,
  Recommendation,
  RecommendationKind,
  RunMode,
  RunRecord,
  SectionProgress,
  SessionGoal,
  SongCacheEntry,
  StreakState,
} from '@shared/storage';
import type { Stars } from '@shared/judge';
import {
  addDays,
  comfortTier,
  GRACE_EXTRA_DAYS,
  isCheckDue,
  isoWeekAt,
  localDate,
  MAX_FREEZES,
  mondayOf,
  previousIsoWeek,
  PRACTICE_DAY_SEC,
  recommend,
  sessionGoals,
  songMastery,
  speedBucket,
} from '@core/progress';

/** A screen + params; the view turns it into an href with the router. */
export interface RouteTarget {
  screen: ScreenId;
  params: RouteParams;
}

/** Everything the home screen reads, gathered by the screen (I/O) and handed to {@link buildHomeModel}. */
export interface HomeInput {
  now: number;
  settings: Settings;
  /** Library listing (`GET /api/search`), or null when the server could not be reached. */
  candidates: readonly SearchResult[] | null;
  /** Every stored run, newest first. */
  runs: readonly RunRecord[];
  /** Sections with `nextCheckAt` up to two days ahead (`listDueChecks(now + 2 days)`). */
  checks: readonly SectionProgress[];
  practiceDays: readonly PracticeDay[];
  /** Streak already evaluated up to `now`. */
  streak: StreakState;
  /** Cached song info by song id (titles/difficulty when a song is not in the listing). */
  songCache: ReadonlyMap<string, SongCacheEntry>;
  /** Section progress per arrangement key ({@link arrKey}) for every played arrangement. */
  progress: ReadonlyMap<string, readonly SectionProgress[]>;
  /** Per-viewer checklist state (localStorage). */
  checklist: { tunedMarked: boolean; hidden: boolean };
  /** The goal picked today, if any (localStorage). */
  focus: FocusPick | null;
}

/** The session goal the player picked today. */
export interface FocusPick {
  date: string;
  kind: SessionGoal['kind'];
  songId: string;
}

/** Key for per-arrangement maps. */
export function arrKey(songId: string, arrangement: number): string {
  return `${songId}#${arrangement}`;
}

// ---------------------------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------------------------

export type ChecklistStepId = 'input' | 'tune' | 'calibrate' | 'first-song';

/** One setup step. */
export interface ChecklistStep {
  id: ChecklistStepId;
  title: string;
  detail: string;
  done: boolean;
  action: { label: string; to: RouteTarget };
}

/** Setup checklist (shown until complete or hidden). */
export interface Checklist {
  steps: ChecklistStep[];
  doneCount: number;
  complete: boolean;
  visible: boolean;
}

/** "Continue where you left off". */
export interface ContinueItem {
  songId: string;
  arrangement: number;
  title: string;
  by: string | null;
  tier: Tier | null;
  rating: number | null;
  /** "Practice at 80% · 87% accuracy · yesterday". */
  last: string;
  /** "Next up: Verse 2 at 85%" or "Every section mastered — play it through". */
  next: string;
  /** Sections mastered of the known total ("3 of 5 sections mastered"), when known. */
  mastery: { mastered: number; total: number } | null;
  /** Section whose next-day check the primary action takes, if any. */
  checkSection: number | null;
  primary: { label: string; to: RouteTarget };
  songPage: RouteTarget;
}

/** One day dot in the week strip. */
export interface WeekDay {
  date: string;
  /** "M", "T", … */
  letter: string;
  /** "Monday" (accessible name). */
  name: string;
  practiced: boolean;
  minutes: number;
  today: boolean;
  future: boolean;
}

/** Weekly streak card. */
export interface WeekView {
  days: WeekDay[];
  practiced: number;
  /** Practice days this week needs (target, or target + 2 in a bonus/repair week). */
  needed: number;
  target: number;
  current: number;
  best: number;
  freezes: number;
  maxFreezes: number;
  /** This week already counts toward the streak. */
  met: boolean;
  /** Repair ("bonus") week after a missed week without a freeze. */
  repairing: boolean;
  headline: string;
  message: string;
}

/** Daily goal ring. */
export interface DailyView {
  minutes: number;
  goalMinutes: number;
  fraction: number;
  practiceDay: boolean;
  message: string;
}

/** A session goal with its launch route. */
export interface GoalItem {
  goal: SessionGoal;
  title: string;
  detail: string;
  picked: boolean;
  to: RouteTarget;
}

/** A recommendation row with display fields. */
export interface RecItem {
  rec: Recommendation;
  title: string;
  by: string | null;
  rating: number | null;
  /** Kind badge text ("Stretch", "Next-day check", …). */
  badge: string;
  /** Reason without its lead phrase, sentence-cased. */
  reason: string;
  to: RouteTarget;
}

/** Recommendation group (stretch / review & comfort / reach). */
export interface RecGroup {
  id: 'stretch' | 'comfort' | 'reach';
  title: string;
  blurb: string;
  items: RecItem[];
}

/** One recent run. */
export interface RecentItem {
  runId: number;
  songId: string;
  title: string;
  when: string;
  mode: RunMode;
  speedPct: number;
  accuracy: number;
  stars: Stars;
  clean: boolean;
  looped: boolean;
  to: RouteTarget;
}

/** A due next-day check. */
export interface CheckItem {
  songId: string;
  arrangement: number;
  sectionIdx: number;
  title: string;
  section: string;
  to: RouteTarget;
}

/** Progress stats. */
export interface StatsView {
  repertoire: number;
  masteredSections: number;
  lockedSections: number;
  comfortTier: Tier;
  cleanRuns: number;
  songsPlayed: number;
}

/** The whole home screen. */
export interface HomeModel {
  firstRun: boolean;
  serverDown: boolean;
  /** Only starter songs in the library (no own tabs yet). */
  starterOnly: boolean;
  checklist: Checklist;
  starters: SearchResult[];
  continueItem: ContinueItem | null;
  week: WeekView;
  daily: DailyView;
  goals: GoalItem[];
  recommendations: RecGroup[];
  checks: { due: CheckItem[]; tomorrow: number };
  recent: RecentItem[];
  stats: StatsView;
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Starter songs shown on first run. */
export const STARTER_COUNT = 6;
/** Recent results listed. */
export const RECENT_COUNT = 5;
/** A long session (learning research row 11): suggest a break rather than more. */
export const LONG_SESSION_MIN = 45;

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const route = (screen: ScreenId, params: RouteParams = {}): RouteTarget => ({ screen, params });

/** Song page route. */
export function songRoute(songId: string, arrangement: number): RouteTarget {
  return route('song', { id: songId, arr: String(arrangement) });
}

/** Game route (`mode`, optional looped `section` and start `speed` fraction). */
export function playRoute(songId: string, arrangement: number, mode: RunMode, opts: { section?: number; speed?: number } = {}): RouteTarget {
  const params: RouteParams = { id: songId, arr: String(arrangement), mode };
  if (opts.section !== undefined) params.section = String(opts.section);
  if (opts.speed !== undefined) params.speed = String(Math.round(opts.speed * 100) / 100);
  return route('game', params);
}

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

/** Title / artist / tier lookup over the listing with the song cache as fallback. */
export interface SongLookup {
  title(songId: string): string;
  by(songId: string): string | null;
  tier(songId: string): Tier | null;
  rating(songId: string): number | null;
  difficulty(songId: string): DifficultyReport | null;
}

/** Build a {@link SongLookup}. Unknown songs read as "Unknown song" (e.g. a deleted file). */
export function songLookup(candidates: readonly SearchResult[] | null, cache: ReadonlyMap<string, SongCacheEntry>): SongLookup {
  const byId = new Map<string, SearchResult>();
  for (const c of candidates ?? []) if (!byId.has(c.id)) byId.set(c.id, c);
  const meta = (id: string): SearchResult | undefined => byId.get(id) ?? cache.get(id)?.meta;
  return {
    title: (id) => meta(id)?.title ?? 'Unknown song',
    by: (id) => {
      const m = meta(id);
      return m?.artist ?? m?.composer ?? null;
    },
    tier: (id) => meta(id)?.tier ?? cache.get(id)?.difficulty?.tier ?? null,
    rating: (id) => meta(id)?.rating ?? cache.get(id)?.difficulty?.rating ?? null,
    difficulty: (id) => cache.get(id)?.difficulty ?? null,
  };
}

/** Section display name from a difficulty report (exact index match), else "Section N". */
export function sectionName(report: DifficultyReport | null, idx: number): string {
  const s = report?.sections.find((x) => x.sectionIndex === idx);
  return s?.name?.trim() || `Section ${idx + 1}`;
}

/**
 * Lower bound of an arrangement's section count: from the difficulty report (its last section's
 * index; trailing sections shorter than 2 s merge into the previous one) and the highest section
 * with progress. 0 when neither is known.
 */
export function sectionCountOf(report: DifficultyReport | null, progress: readonly SectionProgress[]): number {
  const fromReport = report?.sections.reduce((m, s) => Math.max(m, s.sectionIndex + 1), 0) ?? 0;
  const fromProgress = progress.reduce((m, p) => Math.max(m, p.sectionIdx + 1), 0);
  return Math.max(fromReport, fromProgress);
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

const DATE_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** "today", "yesterday", "tomorrow", "Mon, Nov 16" for an epoch-ms time relative to `now` (local days). */
export function relativeDay(at: number, now: number): string {
  const day = localDate(at);
  const today = localDate(now);
  if (day === today) return 'today';
  if (day === addDays(today, -1)) return 'yesterday';
  if (day === addDays(today, 1)) return 'tomorrow';
  return DATE_FMT.format(new Date(at));
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sentenceCase(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

const pct = (speed: number): number => speedBucket(speed);

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

/** Easiest playable starter songs (tier, then title). */
export function starterSongs(candidates: readonly SearchResult[] | null, count = STARTER_COUNT): SearchResult[] {
  return (candidates ?? [])
    .filter((c) => c.source === 'starter' && c.availability === 'playable' && c.defaultArrangement >= 0)
    .sort((a, b) => (a.tier ?? 11) - (b.tier ?? 11) || a.title.localeCompare(b.title))
    .slice(0, count);
}

/** Setup checklist: input → tune → calibrate → first starter song. */
export function buildChecklist(input: Pick<HomeInput, 'settings' | 'runs' | 'checklist' | 'candidates'>): Checklist {
  const { settings, runs } = input;
  const calibrated = settings.calibration.method !== 'none';
  const guitarRun = runs.some((r) => r.inputSource === 'guitar');
  const first = starterSongs(input.candidates, 1)[0];
  const setup = route('audio-setup');
  const steps: ChecklistStep[] = [
    {
      id: 'input',
      title: 'Pick your guitar input',
      detail: settings.input.label ? `Using ${settings.input.label}` : 'Choose your audio interface and check the level meter.',
      done: settings.input.deviceId !== null,
      action: { label: 'Choose input', to: setup },
    },
    {
      id: 'tune',
      title: 'Tune up',
      detail: 'Riffway judges pitch, so start in tune. The tuner listens to your input.',
      done: input.checklist.tunedMarked || calibrated || guitarRun,
      action: { label: 'Open tuner', to: setup },
    },
    {
      id: 'calibrate',
      title: 'Calibrate latency',
      detail: calibrated ? 'Timing offsets are set.' : 'Play along with a click for 20 seconds so hits line up exactly.',
      done: calibrated,
      action: { label: 'Calibrate', to: setup },
    },
    {
      id: 'first-song',
      title: 'Play your first song',
      detail: first ? `“${first.title}” is a friendly first pick.` : 'Pick any song from the library.',
      done: runs.length > 0,
      action: first ? { label: 'Let’s go', to: songRoute(first.id, first.defaultArrangement) } : { label: 'Open library', to: route('library') },
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const complete = doneCount === steps.length;
  return { steps, doneCount, complete, visible: !complete && !input.checklist.hidden };
}

/** The ISO week strip (Monday → Sunday) with practice days and today marked. */
export function buildWeek(input: Pick<HomeInput, 'now' | 'practiceDays' | 'streak'>): WeekView {
  const today = localDate(input.now);
  const monday = mondayOf(today);
  const byDate = new Map(input.practiceDays.map((d) => [d.date, d.activeSec]));
  const days: WeekDay[] = DAY_LETTERS.map((letter, i) => {
    const date = addDays(monday, i);
    const sec = byDate.get(date) ?? 0;
    return {
      date,
      letter,
      name: DAY_NAMES[i] as string,
      practiced: sec >= PRACTICE_DAY_SEC,
      minutes: Math.floor(sec / 60),
      today: date === today,
      future: date > today,
    };
  });
  const s = input.streak;
  const week = isoWeekAt(input.now);
  const practiced = days.filter((d) => d.practiced).length;
  const repairing = s.repairWeek !== undefined && s.repairWeek === previousIsoWeek(week);
  const needed = s.weekTarget + (repairing ? GRACE_EXTRA_DAYS : 0);
  const met = s.lastEvaluatedWeek === week;
  const left = Math.max(0, needed - practiced);
  const daysLeft = days.filter((d) => d.today || d.future).length;

  let headline: string;
  let message: string;
  if (met) {
    headline = s.current === 1 ? 'This week counts!' : `${s.current} weeks strong`;
    message = 'This week is in the bag. Any extra day is a bonus for your hands, not your streak.';
  } else if (repairing) {
    headline = 'Bonus week';
    message = `Practise ${plural(needed, 'day')} this week to carry your ${plural(s.current, 'week')} forward. ${practiced} done so far.`;
  } else if (s.current > 0) {
    headline = `${plural(s.current, 'week')} and counting`;
    message = `${plural(left, 'more practice day')} this week keeps it growing.`;
  } else {
    headline = practiced > 0 ? 'Streak in progress' : 'Start a streak';
    message =
      practiced > 0
        ? `${practiced} of ${needed} practice days this week. ${plural(left, 'more day')} starts your streak.`
        : `Practise ${needed} days this week (5 minutes each) to start a weekly streak.`;
  }
  if (!met && left > daysLeft) {
    // The target can't be reached any more this week: say what happens next, never what is lost.
    if (s.current > 0 && s.freezes > 0) message = 'Short week? A freeze covers it automatically. Every session still counts for your hands.';
    else if (s.current > 0 && !repairing) message = 'Short week? A bonus week next week carries your streak forward.';
    else message = 'Every session still builds your skills. A fresh week starts on Monday.';
  }
  return {
    days,
    practiced,
    needed,
    target: s.weekTarget,
    current: s.current,
    best: s.best,
    freezes: s.freezes,
    maxFreezes: MAX_FREEZES,
    met,
    repairing,
    headline,
    message,
  };
}

/** Today's minutes against the daily goal. */
export function buildDaily(input: Pick<HomeInput, 'now' | 'practiceDays' | 'settings'>): DailyView {
  const today = localDate(input.now);
  const sec = input.practiceDays.find((d) => d.date === today)?.activeSec ?? 0;
  const minutes = Math.floor(sec / 60);
  const goalMinutes = input.settings.goals.dailyMinutes;
  const dayMin = PRACTICE_DAY_SEC / 60;
  let message: string;
  if (minutes >= LONG_SESSION_MIN) message = 'Great session. A break now helps it sink in — see you tomorrow.';
  else if (minutes >= goalMinutes) message = 'Daily goal done. Nice work!';
  else if (sec >= PRACTICE_DAY_SEC) message = `Today counts as a practice day. ${goalMinutes - minutes} min to your goal.`;
  else if (minutes > 0) message = `${dayMin - minutes} more min makes today a practice day.`;
  else message = `Even ${dayMin} minutes makes today a practice day.`;
  return { minutes, goalMinutes, fraction: goalMinutes > 0 ? minutes / goalMinutes : 0, practiceDay: sec >= PRACTICE_DAY_SEC, message };
}

/** "Practice at 80% · 87% accuracy · yesterday". */
function describeRun(r: RunRecord, now: number): string {
  const what = r.mode === 'play' ? (r.loop ? 'Loop' : 'Full play') : 'Practice';
  return `${what} at ${pct(r.speed)}% · ${Math.round(r.accuracy)}% accuracy · ${relativeDay(r.endedAt, now)}`;
}

/** The latest run's song and what to do next on it. */
export function buildContinue(input: HomeInput, lookup: SongLookup): ContinueItem | null {
  const last = input.runs[0];
  if (!last) return null;
  const { songId, arrangement } = last;
  const progress = input.progress.get(arrKey(songId, arrangement)) ?? [];
  const report = lookup.difficulty(songId);
  const total = sectionCountOf(report, progress);
  const m = total > 0 ? songMastery(progress, total) : null;

  const due = progress.filter((p) => isCheckDue(p, input.now)).sort((a, b) => a.sectionIdx - b.sectionIdx)[0];
  const open = progress
    .filter((p) => p.masteredAt === undefined && p.lockedInAt === undefined)
    .sort((a, b) => a.bestAccuracy - b.bestAccuracy || a.sectionIdx - b.sectionIdx)[0];

  let next: string;
  let primary: ContinueItem['primary'];
  if (due) {
    next = `Next-day check: play ${sectionName(report, due.sectionIdx)} clean at full speed to lock it in`;
    primary = { label: 'Take the check', to: playRoute(songId, arrangement, 'practice', { section: due.sectionIdx, speed: 1 }) };
  } else if (open) {
    const speed = open.trainer.speed;
    next = `Next up: ${sectionName(report, open.sectionIdx)} at ${pct(speed)}%`;
    primary = { label: 'Continue practising', to: playRoute(songId, arrangement, 'practice', { section: open.sectionIdx, speed }) };
  } else if (m?.mastered) {
    next = m.repertoire ? 'In your repertoire. Play it for someone!' : 'Every section mastered. Play it through at full speed.';
    primary = { label: 'Play it through', to: playRoute(songId, arrangement, 'play', { speed: 1 }) };
  } else {
    next = `Pick up at ${pct(last.speed)}%`;
    primary = { label: 'Continue', to: playRoute(songId, arrangement, last.mode, { speed: last.speed }) };
  }
  return {
    songId,
    arrangement,
    title: lookup.title(songId),
    by: lookup.by(songId),
    tier: lookup.tier(songId),
    rating: lookup.rating(songId),
    last: describeRun(last, input.now),
    next,
    mastery: m ? { mastered: m.masteredSections, total: m.sectionCount } : null,
    checkSection: due ? due.sectionIdx : null,
    primary,
    songPage: songRoute(songId, arrangement),
  };
}

const KIND_BADGE: Record<RecommendationKind, string> = {
  stretch: 'Stretch',
  comfort: 'Comfort',
  review: 'Next-day check',
  reach: 'Reach · one section',
};

/** Strip the lead phrase ("Stretch pick: ") from a recommendation reason; the badge says it. */
export function reasonText(reason: string): string {
  const i = reason.indexOf(': ');
  return sentenceCase(i >= 0 && i < 48 ? reason.slice(i + 2) : reason);
}

/** Recommendations grouped for display (empty groups dropped). */
export function buildRecommendations(recs: readonly Recommendation[], lookup: SongLookup): RecGroup[] {
  const item = (rec: Recommendation): RecItem => ({
    rec,
    title: lookup.title(rec.songId),
    by: lookup.by(rec.songId),
    rating: lookup.rating(rec.songId),
    badge: KIND_BADGE[rec.kind],
    reason: reasonText(rec.reason),
    to:
      rec.kind === 'review' && rec.sectionIdx !== undefined
        ? playRoute(rec.songId, rec.arrangement, 'practice', { section: rec.sectionIdx, speed: 1 })
        : songRoute(rec.songId, rec.arrangement),
  });
  const groups: RecGroup[] = [
    {
      id: 'stretch',
      title: 'Stretch picks',
      blurb: 'One step above your comfort zone: hard but doable, where learning is fastest.',
      items: recs.filter((r) => r.kind === 'stretch').map(item),
    },
    {
      id: 'comfort',
      title: 'Review & comfort',
      blurb: 'Lock in what you know and keep it fresh.',
      items: recs.filter((r) => r.kind === 'review' || r.kind === 'comfort').map(item),
    },
    {
      id: 'reach',
      title: 'Reach goal',
      blurb: 'Try one section, slowly.',
      items: recs.filter((r) => r.kind === 'reach').map(item),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

const GOAL_TITLE: Record<SessionGoal['kind'], string> = {
  'next-day-check': 'Lock it in',
  'weakest-section': 'Fix the tricky bit',
  'new-stretch': 'Start something new',
};

/** Session goals with launch routes; the goal picked today is flagged. */
export function buildGoals(goals: readonly SessionGoal[], focus: FocusPick | null, now: number): GoalItem[] {
  const today = localDate(now);
  return goals.map((goal) => ({
    goal,
    title: GOAL_TITLE[goal.kind],
    detail: goal.label,
    picked: focus !== null && focus.date === today && focus.kind === goal.kind && focus.songId === goal.songId,
    to: playRoute(goal.songId, goal.arrangement, 'practice', {
      ...(goal.sectionIdx !== undefined ? { section: goal.sectionIdx } : {}),
      ...(goal.targetSpeed !== undefined ? { speed: goal.targetSpeed } : {}),
    }),
  }));
}

/** Due next-day checks (earliest first) and how many come due by tomorrow night. */
export function buildChecks(input: Pick<HomeInput, 'checks' | 'now'>, lookup: SongLookup): HomeModel['checks'] {
  const pending = input.checks.filter((p) => p.masteredAt !== undefined && p.lockedInAt === undefined && p.nextCheckAt !== undefined);
  const due = pending
    .filter((p) => isCheckDue(p, input.now))
    .sort((a, b) => (a.nextCheckAt ?? 0) - (b.nextCheckAt ?? 0) || a.songId.localeCompare(b.songId) || a.sectionIdx - b.sectionIdx)
    .map((p) => ({
      songId: p.songId,
      arrangement: p.arrangement,
      sectionIdx: p.sectionIdx,
      title: lookup.title(p.songId),
      section: sectionName(lookup.difficulty(p.songId), p.sectionIdx),
      to: playRoute(p.songId, p.arrangement, 'practice', { section: p.sectionIdx, speed: 1 }),
    }));
  return { due, tomorrow: pending.length - due.length };
}

/** The latest runs. */
export function buildRecent(runs: readonly RunRecord[], lookup: SongLookup, now: number): RecentItem[] {
  return runs
    .filter((r): r is RunRecord & { id: number } => r.id !== undefined)
    .slice(0, RECENT_COUNT)
    .map((r) => ({
      runId: r.id,
      songId: r.songId,
      title: lookup.title(r.songId),
      when: relativeDay(r.endedAt, now),
      mode: r.mode,
      speedPct: pct(r.speed),
      accuracy: Math.round(r.accuracy),
      stars: r.stars,
      clean: r.clean,
      looped: r.loop !== undefined,
      to: route('results', { runId: String(r.id) }),
    }));
}

/** Repertoire and mastery totals. */
export function buildStats(input: HomeInput, lookup: SongLookup, comfort: Tier): StatsView {
  let repertoire = 0;
  let masteredSections = 0;
  let lockedSections = 0;
  for (const [key, progress] of input.progress) {
    const songId = key.slice(0, key.lastIndexOf('#'));
    const m = songMastery(progress, sectionCountOf(lookup.difficulty(songId), progress));
    if (m.repertoire) repertoire += 1;
    masteredSections += m.masteredSections;
    lockedSections += m.lockedInSections;
  }
  return {
    repertoire,
    masteredSections,
    lockedSections,
    comfortTier: comfort,
    cleanRuns: input.runs.filter((r) => r.clean).length,
    songsPlayed: new Set(input.runs.map((r) => r.songId)).size,
  };
}

/** Build the whole home view model. Deterministic for equal input. */
export function buildHomeModel(input: HomeInput): HomeModel {
  const lookup = songLookup(input.candidates, input.songCache);
  const comfort = comfortTier(input.runs, (id) => lookup.tier(id));
  const prefs = input.settings.preferences;
  const recInput = {
    candidates: input.candidates ?? [],
    comfortTier: comfort,
    recentRuns: input.runs,
    dueChecks: input.checks,
    preferences: { style: prefs.style, fingerstyle: prefs.fingerstyle, genres: prefs.genres },
    now: input.now,
  };
  const candidates = input.candidates ?? [];
  return {
    firstRun: input.runs.length === 0,
    serverDown: input.candidates === null,
    starterOnly: candidates.length > 0 && candidates.every((c) => c.source === 'starter'),
    checklist: buildChecklist(input),
    starters: starterSongs(input.candidates),
    continueItem: buildContinue(input, lookup),
    week: buildWeek(input),
    daily: buildDaily(input),
    goals: buildGoals(sessionGoals(recInput), input.focus, input.now),
    recommendations: buildRecommendations(recommend(recInput), lookup),
    checks: buildChecks(input, lookup),
    recent: buildRecent(input.runs, lookup, input.now),
    stats: buildStats(input, lookup, comfort),
  };
}
