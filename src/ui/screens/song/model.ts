/**
 * Song page view model (T-034): pure functions from the server's `SongMeta`, the loaded `Song` (when
 * available) and stored progress to what the song page shows: meta, difficulty breakdown ("why"),
 * tuning advice, arrangements, section mastery map, bests per speed bucket and the accuracy trend.
 * No DOM, no I/O; `now` passed in.
 * @module
 */
import type { SongMeta } from '@shared/api';
import type { DifficultyFactorId, DifficultyReport, SectionDifficulty, Song, Tier } from '@shared/song';
import type { Stars } from '@shared/judge';
import type { BestRecord, RunRecord, SectionProgress } from '@shared/storage';
import type { SearchResult } from '@shared/sources';
import { describeTuning, NOTE_NAMES, STANDARD_TUNING } from '@core/model';
import { HIGHLIGHT_MIN_C, HIGHLIGHT_PHRASES } from '@core/difficulty/constants';
import { isCheckDue, songMastery } from '@core/progress';
import { playRoute, relativeDay, type RouteTarget } from '../home/model';

/** Runs drawn in the accuracy sparkline. */
export const TREND_RUNS = 12;
/** Section factors listed per section ("why"). */
const SECTION_FACTORS = 2;

// ---------------------------------------------------------------------------------------------
// Arrangements
// ---------------------------------------------------------------------------------------------

/** One arrangement choice. */
export interface ArrangementOption {
  index: number;
  name: string;
  details: string;
  playable: boolean;
  current: boolean;
  isDefault: boolean;
  rating: number | null;
  tier: Tier | null;
}

/** Playable arrangements (with the current one flagged) and how many tracks can't be played. */
export function arrangementOptions(meta: SongMeta, current: number): { options: ArrangementOption[]; unplayable: number } {
  const options = meta.arrangements
    .filter((t) => t.playable)
    .map((t) => {
      const report = meta.difficulty[t.index];
      const parts = [describeTuning(t.tuning).label];
      if (t.capo > 0) parts.push(`capo ${t.capo}`);
      if (t.noteCount !== undefined) parts.push(`${t.noteCount.toLocaleString('en-US')} notes`);
      return {
        index: t.index,
        name: t.name.trim() || `Track ${t.index + 1}`,
        details: parts.join(' · '),
        playable: true,
        current: t.index === current,
        isDefault: t.index === meta.entry.defaultArrangement,
        rating: report?.rating ?? null,
        tier: report?.tier ?? null,
      };
    });
  return { options, unplayable: meta.arrangements.length - options.length };
}

/**
 * The arrangement to show: the `arr` param when it names a playable track, else the song's default.
 * Returns -1 when nothing is playable.
 */
export function resolveArrangement(meta: SongMeta, param: string | undefined): number {
  const n = param !== undefined && /^\d+$/.test(param) ? Number(param) : NaN;
  const playable = meta.arrangements.filter((t) => t.playable).map((t) => t.index);
  if (playable.includes(n)) return n;
  if (playable.includes(meta.entry.defaultArrangement)) return meta.entry.defaultArrangement;
  return playable[0] ?? -1;
}

// ---------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------

/** One string of the target tuning, low E side first. */
export interface TuningString {
  /** String number (6 = low E … 1 = high e). */
  string: number;
  note: string;
  /** Semitones from standard (negative = tune down). */
  delta: number;
}

/** Tuning shown on the song page, with an optional retune prompt. */
export interface TuningView {
  id: string;
  label: string;
  capo: number;
  midi: number[];
  strings: TuningString[];
  /** Retune prompt; null when the guitar is probably already right. */
  prompt: { title: string; text: string } | null;
}

function shiftText(delta: number): string {
  const n = Math.abs(delta);
  const size = n === 1 ? 'a half step' : n === 2 ? 'a whole step' : `${n} semitones`;
  return `${delta < 0 ? 'down' : 'up'} ${size}`;
}

/**
 * Tuning view for `tuning` (MIDI, high → low). The retune prompt appears when the song is not in
 * standard tuning, or when the previously played song (`last`) used a different tuning.
 */
export function tuningView(tuning: readonly number[], capo: number, last: { id: string; label: string } | null): TuningView {
  const { id, label } = describeTuning(tuning);
  const strings: TuningString[] = tuning
    .map((m, i) => ({ string: i + 1, note: NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] as string, delta: tuning.length === 6 ? m - (STANDARD_TUNING[i] as number) : 0 }))
    .reverse();
  const changed = strings.filter((s) => s.delta !== 0);
  let prompt: TuningView['prompt'] = null;
  const differsFromLast = last !== null && last.id !== id;
  if (id !== 'standard' || differsFromLast) {
    const from = last ? `Your last song was in ${last.label}. ` : '';
    const steps = changed.map((s) => `string ${s.string} ${shiftText(s.delta)} to ${s.note}`);
    const how = id === 'standard' ? 'Back to E A D G B E.' : steps.length ? `From standard: ${steps.join(', ')}.` : `Tune to ${label}.`;
    prompt = { title: `Retune to ${label}`, text: `${from}${how}` };
  }
  return { id, label, capo, midi: [...tuning], strings, prompt };
}

// ---------------------------------------------------------------------------------------------
// Difficulty breakdown
// ---------------------------------------------------------------------------------------------

/** One bar in the per-section difficulty chart. */
export interface DifficultyBar {
  sectionIndex: number;
  name: string;
  rating: number;
  tier: Tier;
  /** Bar width 0–100 (rating out of 10). */
  pct: number;
  /** Top factors as phrases ("fast position shifts"). */
  why: string[];
  hardest: boolean;
}

/** Top factor phrases of one section (weighted contribution, strong factors only). */
export function sectionWhy(s: SectionDifficulty, max = SECTION_FACTORS): string[] {
  return (Object.entries(s.factors) as [DifficultyFactorId, SectionDifficulty['factors'][DifficultyFactorId]][])
    .filter(([, f]) => f.c >= HIGHLIGHT_MIN_C)
    .sort((a, b) => b[1].weight * b[1].c - a[1].weight * a[1].c || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([id]) => HIGHLIGHT_PHRASES[id]);
}

/**
 * Per-section difficulty bars. The hardest is flagged only when one section alone has the top
 * rating as shown (one decimal): two sections tied at 2.7 are not both "Hardest" (R3-U-22).
 */
export function difficultyBars(report: DifficultyReport | null): DifficultyBar[] {
  if (!report) return [];
  const shown = (r: number): string => r.toFixed(1);
  const top = shown(Math.max(0, ...report.sections.map((s) => s.rating)));
  const unique = report.sections.filter((s) => shown(s.rating) === top).length === 1;
  return report.sections.map((s) => ({
    sectionIndex: s.sectionIndex,
    name: s.name.trim() || `Section ${s.sectionIndex + 1}`,
    rating: s.rating,
    tier: s.tier,
    pct: Math.max(4, Math.min(100, s.rating * 10)),
    why: sectionWhy(s),
    hardest: unique && shown(s.rating) === top && report.sections.length > 1,
  }));
}

// ---------------------------------------------------------------------------------------------
// Sections + mastery
// ---------------------------------------------------------------------------------------------

export type SectionState = 'new' | 'practising' | 'mastered' | 'check-due' | 'locked';

/** Shown once under the mastery map while any section is new. */
export const NEW_SECTION_TIP = 'New sections: loop them slowly first. The speed trainer starts you at 70%.';

/** True when every section has the same rating as shown (one decimal), and there are several. */
export function allSectionsAlike(bars: readonly Pick<DifficultyBar, 'rating'>[]): boolean {
  return bars.length > 1 && bars.every((b) => b.rating.toFixed(1) === bars[0]!.rating.toFixed(1));
}

/** One section in the mastery map. */
export interface SectionRow {
  idx: number;
  name: string;
  start: number;
  end: number;
  /** Share of the song's length (0–1), for the map's widths. */
  share: number;
  tier: Tier | null;
  rating: number | null;
  state: SectionState;
  stateLabel: string;
  detail: string;
  /** Trainer speed or the speed to loop at. */
  loop: RouteTarget;
}

/** State names, the same words as the map's legend (R3-U-10). */
export const STATE_LABEL: Record<SectionState, string> = {
  new: 'New',
  practising: 'Practicing',
  mastered: 'Mastered',
  'check-due': 'Check due',
  locked: 'Locked in',
};

/** The report section covering song section `idx` (sections < 2 s are merged into their group). */
function reportSectionFor(report: DifficultyReport | null, idx: number): SectionDifficulty | null {
  let found: SectionDifficulty | null = null;
  for (const s of report?.sections ?? []) if (s.sectionIndex <= idx && (!found || s.sectionIndex > found.sectionIndex)) found = s;
  return found;
}

function stateOf(p: SectionProgress | undefined, now: number): SectionState {
  if (!p) return 'new';
  if (p.lockedInAt !== undefined) return 'locked';
  if (isCheckDue(p, now)) return 'check-due';
  if (p.masteredAt !== undefined) return 'mastered';
  return 'practising';
}

const pctOf = (speed: number): number => Math.round(speed * 100);

/**
 * Section rows for the mastery map. Sections come from the loaded `Song`; without it (still loading
 * or failed) the difficulty report's sections stand in.
 */
export function sectionRows(
  songId: string,
  arrangement: number,
  song: Pick<Song, 'sections' | 'meta'> | null,
  report: DifficultyReport | null,
  progress: readonly SectionProgress[],
  now: number,
): SectionRow[] {
  const base: { idx: number; name: string; start: number; end: number }[] = song
    ? song.sections.map((s, idx) => ({ idx, name: s.name, start: s.start, end: s.end }))
    : (report?.sections ?? []).map((s) => ({ idx: s.sectionIndex, name: s.name, start: s.start, end: s.end }));
  const total = base.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0) || 1;
  const byIdx = new Map(progress.map((p) => [p.sectionIdx, p]));
  return base.map((s) => {
    const p = byIdx.get(s.idx);
    const state = stateOf(p, now);
    const rs = reportSectionFor(report, s.idx);
    let detail: string;
    let speed: number | undefined;
    switch (state) {
      case 'new':
        // The tip for new sections is said once, under the map (NEW_SECTION_TIP; R3-U-10).
        detail = '';
        break;
      case 'practising':
        speed = p!.trainer.speed;
        detail = `Trainer at ${pctOf(speed)}% · ${p!.cleanRuns} clean ${p!.cleanRuns === 1 ? 'run' : 'runs'} · best ${Math.round(p!.bestAccuracy)}%`;
        break;
      case 'mastered':
        speed = 1;
        detail = `Two clean runs at full speed. The next-day check opens ${p!.nextCheckAt !== undefined ? relativeDay(p!.nextCheckAt, now) : 'tomorrow'}.`;
        break;
      case 'check-due':
        speed = 1;
        detail = 'One clean run at full speed locks it in.';
        break;
      case 'locked':
        speed = 1;
        detail = `Locked in ${relativeDay(p!.lockedInAt!, now)}. Keep it warm with a full play.`;
        break;
    }
    return {
      idx: s.idx,
      name: s.name.trim() || `Section ${s.idx + 1}`,
      start: s.start,
      end: s.end,
      share: Math.max(0, s.end - s.start) / total,
      tier: rs?.tier ?? null,
      rating: rs?.rating ?? null,
      state,
      stateLabel: STATE_LABEL[state],
      detail,
      loop: playRoute(songId, arrangement, 'practice', { section: s.idx, ...(speed !== undefined ? { speed } : {}) }),
    };
  });
}

/** Mastery summary line for the map header. */
export function masterySummary(rows: readonly SectionRow[], progress: readonly SectionProgress[]): { mastered: number; locked: number; total: number; repertoire: boolean } {
  const m = songMastery(progress, rows.length);
  return { mastered: m.masteredSections, locked: m.lockedInSections, total: rows.length, repertoire: m.repertoire };
}

// ---------------------------------------------------------------------------------------------
// Bests + trend
// ---------------------------------------------------------------------------------------------

/** One speed bucket's best. */
export interface BestView {
  bucket: number;
  label: string;
  full: boolean;
  accuracy: number;
  score: number;
  stars: Stars;
  when: string;
  runId: number;
}

/** Bests sorted fastest first. */
export function bestsView(bests: readonly BestRecord[], now: number): BestView[] {
  return [...bests]
    .sort((a, b) => b.speedBucket - a.speedBucket)
    .map((b) => ({
      bucket: b.speedBucket,
      label: `${b.speedBucket}%`,
      full: b.speedBucket >= 100,
      accuracy: Math.round(b.accuracy),
      score: b.score,
      stars: b.stars,
      when: relativeDay(b.at, now),
      runId: b.runId,
    }));
}

/**
 * Accuracy trend (oldest → newest) over the latest runs, with an accessible summary and the chart's
 * lower bound (10% steps, at least 15 points below the lowest value and the 90% clean-run line, so
 * small gains are visible instead of a flat line near the top).
 */
export function accuracyTrend(runs: readonly RunRecord[], count = TREND_RUNS): { values: number[]; label: string; min: number } {
  const values = runs
    .slice(0, count)
    .map((r) => Math.round(r.accuracy))
    .reverse();
  const min = Math.max(0, Math.floor((Math.min(90, ...values) - 15) / 10) * 10);
  if (values.length === 0) return { values, label: 'No runs yet', min };
  const first = values[0] as number;
  const last = values[values.length - 1] as number;
  const label =
    values.length === 1
      ? `One run so far: ${last}% accuracy`
      : `Accuracy over your last ${values.length} runs: ${first}% to ${last}% (best ${Math.max(...values)}%)`;
  return { values, label, min };
}

// ---------------------------------------------------------------------------------------------
// Song cache projection
// ---------------------------------------------------------------------------------------------

/** Project `SongMeta` to the `SearchResult` stored in the song cache (home screen titles/tiers). */
export function toSearchResult(meta: SongMeta): SearchResult {
  const e = meta.entry;
  const result: SearchResult = {
    id: e.id,
    source: e.source,
    title: e.title,
    fileName: e.fileName,
    tier: e.difficulty?.tier ?? null,
    rating: e.difficulty?.rating ?? null,
    ratingProvisional: e.difficulty?.provisional ?? e.rhythm === 'needs-alignment',
    tuningId: e.tuningId,
    tuningLabel: e.tuningLabel,
    tags: e.tags,
    rhythm: e.rhythm,
    availability: e.error || e.defaultArrangement < 0 ? 'needs-import' : e.rhythm === 'needs-alignment' ? 'needs-rhythm' : 'playable',
    arrangements: e.tracks.filter((t) => t.playable).length,
    defaultArrangement: e.defaultArrangement,
    durationSec: e.durationSec,
    score: 0,
  };
  if (e.artist) result.artist = e.artist;
  if (e.composer) result.composer = e.composer;
  if (e.error) result.error = e.error;
  return result;
}
