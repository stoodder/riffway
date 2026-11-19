/**
 * Results of a finished run as the results screen shows them (docs/game-mechanics.md § Results
 * screen), the in-memory hand-off from the game screen, and pure presentation helpers: timing
 * tendency from the histogram, weakest section, and the "next up" suggestions.
 *
 * A run that was just played arrives with everything ({@link RunResult}); a results page opened later
 * (reload, history) is rebuilt from the stored `RunRecord` with {@link resultFromRecord}.
 * @module
 */
import type { BarLoop, InputSource, OutcomeCounts, Stars, TimingHistogram } from '@shared/judge';
import type { BestRecord, RunMode, RunRecord } from '@shared/storage';
import { TRAINER } from '@core/practice';
import type { SectionUpdate } from './progress';

/** One section row of the heatmap. */
export interface ResultSection {
  idx: number;
  name: string;
  notes: number;
  hits: number;
  accuracy: number;
}

/** Everything the results screen shows for one run. */
export interface RunResult {
  /** Stored run id, or null when the run could not be saved. */
  runId: number | null;
  songId: string;
  arrangement: number;
  title: string;
  artist: string | null;
  mode: RunMode;
  /** Speed fraction the run counts at. */
  speed: number;
  loop: BarLoop | null;
  /** Reached the song end (not a loop run, not ended early). */
  completed: boolean;
  score: number;
  accuracy: number;
  stars: Stars;
  maxCombo: number;
  counts: OutcomeCounts;
  judgedNotes: number;
  histogram: TimingHistogram;
  sections: ResultSection[];
  /** Section index of the weakest judged section, or null. */
  weakestSection: number | null;
  clean: boolean;
  /** 0–1, null when unknown (a run rebuilt from storage). */
  timingScore: number | null;
  lenientChordNotes: number | null;
  strays: number | null;
  inputSource: InputSource;
  activeSec: number;
  endedAt: number;
  /** Best for this speed bucket after the run (null when not eligible or unknown). */
  best: BestRecord | null;
  newBest: boolean;
  previousBestScore: number | null;
  /** Section progress changes from this run (empty when rebuilt from storage). */
  sectionUpdates: SectionUpdate[];
}

// ---------------------------------------------------------------------------------------------
// Hand-off between the game screen and the results screen
// ---------------------------------------------------------------------------------------------

const handoff = new Map<string, RunResult>();
const HANDOFF_CAP = 8;

/** Route key of a result: its run id, or `unsaved-<endedAt>` for a run that could not be saved. */
export function resultKey(result: Pick<RunResult, 'runId' | 'endedAt'>): string {
  return result.runId !== null ? String(result.runId) : `unsaved-${result.endedAt}`;
}

/** Keep a just-finished result for the results screen; returns its route key. */
export function rememberResult(result: RunResult): string {
  const key = resultKey(result);
  handoff.delete(key);
  handoff.set(key, result);
  while (handoff.size > HANDOFF_CAP) handoff.delete(handoff.keys().next().value as string);
  return key;
}

/** A result kept by {@link rememberResult}, or null. */
export function recallResult(key: string): RunResult | null {
  return handoff.get(key) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------------------------

/** Weakest section: lowest accuracy, earliest on ties (the judge's rule). Null when none. */
export function weakestOf(sections: readonly Pick<ResultSection, 'idx' | 'accuracy' | 'notes'>[]): number | null {
  let weakest: Pick<ResultSection, 'idx' | 'accuracy'> | null = null;
  for (const s of sections) if (s.notes > 0 && (weakest === null || s.accuracy < weakest.accuracy)) weakest = s;
  return weakest?.idx ?? null;
}

/** Rebuild a result from a stored run (no live extras: timing score, chord count, section updates). */
export function resultFromRecord(
  record: RunRecord,
  info: { title: string; artist: string | null; sectionName(idx: number): string; best: BestRecord | null },
): RunResult {
  const sections = record.sections.map((s) => ({ ...s, name: info.sectionName(s.idx) }));
  const judgedNotes = Object.values(record.counts).reduce((a, b) => a + b, 0);
  return {
    runId: record.id ?? null,
    songId: record.songId,
    arrangement: record.arrangement,
    title: info.title,
    artist: info.artist,
    mode: record.mode,
    speed: record.speed,
    loop: record.loop ?? null,
    completed: !record.loop,
    score: record.score,
    accuracy: record.accuracy,
    stars: record.stars,
    maxCombo: record.maxCombo,
    counts: record.counts,
    judgedNotes,
    histogram: record.histogram,
    sections,
    weakestSection: weakestOf(sections),
    clean: record.clean,
    timingScore: null,
    lenientChordNotes: null,
    strays: null,
    inputSource: record.inputSource,
    activeSec: record.activeSec,
    endedAt: record.endedAt,
    best: info.best,
    newBest: info.best !== null && record.id !== undefined && info.best.runId === record.id,
    previousBestScore: null,
    sectionUpdates: [],
  };
}

/** Early/late tendency of a run. */
export interface TimingTendency {
  /** Mean signed timing offset in ms (negative = early), from the histogram bin centres. */
  meanMs: number;
  /** Entries in the histogram. */
  samples: number;
  label: 'early' | 'late' | 'centred' | 'unknown';
  /** Player-facing sentence. */
  text: string;
}

/** Below this many entries the tendency is "unknown". */
export const TENDENCY_MIN_SAMPLES = 8;
/** A mean offset within ±this many ms counts as centred. */
export const TENDENCY_CENTRED_MS = 10;

/** Early/late tendency from the timing histogram (bin centres, 10 ms bins). */
export function timingTendency(h: TimingHistogram): TimingTendency {
  let n = 0;
  let sum = 0;
  h.bins.forEach((count, i) => {
    n += count;
    sum += count * (h.minMs + (i + 0.5) * h.binMs);
  });
  if (n < TENDENCY_MIN_SAMPLES) {
    return { meanMs: n > 0 ? sum / n : 0, samples: n, label: 'unknown', text: 'Not enough hits yet to read a timing tendency.' };
  }
  const mean = sum / n;
  const ms = Math.round(Math.abs(mean));
  if (Math.abs(mean) <= TENDENCY_CENTRED_MS) {
    return { meanMs: mean, samples: n, label: 'centred', text: 'Timing centered — no early or late tendency.' };
  }
  return mean < 0
    ? { meanMs: mean, samples: n, label: 'early', text: `You tend to play early — about ${ms} ms ahead of the beat.` }
    : { meanMs: mean, samples: n, label: 'late', text: `You tend to play late — about ${ms} ms behind the beat.` };
}

/** One "next up" suggestion on the results screen. */
export interface NextStep {
  kind: 'loop-weakest' | 'speed-up' | 'mastery' | 'replay' | 'slow-down';
  title: string;
  detail: string;
  /** Route params for the game screen. */
  game: { mode: RunMode; section?: number; speed?: number };
}

const pct = (s: number): string => `${Math.round(s * 100)}%`;

/**
 * Suggestions after a run, most useful first (at most 3): loop the weakest section when it was
 * below the clean line, speed up after a clean run below 100%, go for mastery after a clean run at
 * full speed, slow down after a rough run, else play again.
 */
export function nextSteps(r: Pick<RunResult, 'accuracy' | 'clean' | 'speed' | 'sections' | 'weakestSection' | 'mode'>): NextStep[] {
  const steps: NextStep[] = [];
  const weakest = r.weakestSection !== null ? r.sections.find((s) => s.idx === r.weakestSection) : undefined;
  if (weakest && weakest.accuracy < TRAINER.cleanAccuracy) {
    steps.push({
      kind: 'loop-weakest',
      title: `Loop ${weakest.name}`,
      detail: `${Math.round(weakest.accuracy)}% here — the speed trainer starts slow and steps up after clean loops.`,
      game: { mode: 'practice', section: weakest.idx },
    });
  }
  const speed = Math.round(r.speed * 100) / 100;
  if (r.clean && speed < TRAINER.cap) {
    const next = Math.min(TRAINER.cap, Math.round((speed + TRAINER.step) * 100) / 100);
    steps.push({
      kind: 'speed-up',
      title: `Try it at ${pct(next)}`,
      detail: `Clean at ${pct(speed)} — one notch faster keeps the challenge right.`,
      game: { mode: r.mode, speed: next },
    });
  } else if (r.clean) {
    steps.push({
      kind: 'mastery',
      title: 'Go for mastery',
      detail: 'Two clean runs at 100% in one session master a section; it locks in after a next-day check.',
      game: { mode: r.mode, speed: 1 },
    });
  } else if (r.accuracy < TRAINER.failAccuracy && speed > TRAINER.floor) {
    const next = Math.max(TRAINER.floor, Math.round((speed - 0.1) * 100) / 100);
    steps.push({
      kind: 'slow-down',
      title: `Play it at ${pct(next)}`,
      detail: 'A slower tempo builds the clean version faster than repeating it at full speed.',
      game: { mode: r.mode, speed: next },
    });
  }
  steps.push({ kind: 'replay', title: 'Play again', detail: `Same song at ${pct(speed)}.`, game: { mode: r.mode, speed } });
  return steps.slice(0, 3);
}
