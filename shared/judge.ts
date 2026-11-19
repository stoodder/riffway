/**
 * Judge, scoring and practice contracts (docs/game-mechanics.md, D5, D8, DEC-15, DEC-18, DEC-19).
 * Implemented in `src/core/judge/` and `src/core/practice/` (T-014). Pure data + pure interfaces.
 *
 * DOM-free.
 * @module
 */
import type { SongClockMapping } from './clock';
import type { Song } from './song';

/** Where an input event came from. All go through the same judge path. */
export type InputSource = 'guitar' | 'keyboard' | 'test';

/**
 * One input event, already converted to context seconds and corrected by the calibrated offset
 * (`inputOffsetMs` for guitar, `keyboardOffsetMs` for keyboard; see docs/timing.md).
 */
export interface InputEvent {
  /** Context time of the onset (s), calibration applied. */
  ctxTime: number;
  /** `onset` = new pluck; `pitch-change` = legato change without a new pluck. */
  kind: 'onset' | 'pitch-change';
  /** Detected MIDI pitch (rounded). Absent = unpitched (low clarity); a follow-up may arrive within 40 ms. */
  midi?: number;
  /** Deviation from `midi` in cents (−50…+50). */
  cents?: number;
  /** Pitch clarity 0–1 (MPM NSDF peak). */
  clarity?: number;
  source: InputSource;
  /**
   * Follow-up pitch for a previous unpitched onset (`type:'pitch'` from the worklet): set to the
   * `ctxTime` of the onset it refines. The judge updates that pending event instead of adding one.
   */
  refines?: number;
}

/** Judge outcomes (names as in the docs). */
export type Outcome = 'Perfect' | 'Great' | 'Good' | 'WrongNote' | 'Miss';

/** All outcomes, best first. */
export const OUTCOMES: readonly Outcome[] = ['Perfect', 'Great', 'Good', 'WrongNote', 'Miss'];

/** Count per outcome. */
export type OutcomeCounts = Record<Outcome, number>;

/** Early/late label; shown only when |Δ| > Great window (bandwidth feedback). */
export type TimingLabel = 'early' | 'late' | null;

/** Timing windows in **real** seconds (half-widths). Defaults: 0.035 / 0.070 / 0.120. */
export interface TimingWindows {
  perfect: number;
  great: number;
  good: number;
}

/** One judgement, emitted to the HUD/renderer and the run log. */
export interface Judgement {
  /** Notes of the onset group (all chord notes get the same outcome). */
  noteIds: number[];
  outcome: Outcome;
  /** `eventCtx − ctxTimeAt(note.time)` in ms (real time; negative = early). `null` for Miss. */
  deltaMs: number | null;
  timing: TimingLabel;
  /** MIDI the player produced (WrongNote shows "played G3"). */
  playedMidi?: number;
  /** MIDI expected: the single note, or the matched / lowest chord tone. */
  expectedMidi: number;
  /** True for a chord group judged leniently (any chord tone counts). */
  chord: boolean;
  /** Song time of the group (note time). */
  songTime: number;
  /** Context time of the matched event (or the window close for a Miss). */
  ctxTime: number;
  /**
   * `false` while provisional (a provisional WrongNote can still be upgraded to a hit before its
   * window closes); `true` once fixed (`nowCtx > ctxTimeAt(t) + good`).
   */
  final: boolean;
  /** Loop pass the judgement belongs to. */
  pass: number;
  source?: InputSource;
}

/** A stray onset (no candidate group): shown as a faint tick; not penalised, never breaks combo (DEC-19). */
export interface StrayEvent {
  ctxTime: number;
  songTime: number;
  midi?: number;
  source: InputSource;
}

/** Judge configuration. */
export interface JudgeConfig {
  /** ctx ↔ song mapping for the current pass (usually the engine's `SongClock`). */
  clock: SongClockMapping;
  /** Defaults from `src/core/judge/constants.ts`. */
  windows?: TimingWindows;
  /** Octave errors (±12) do not match when true (DEC-18; default false). */
  strictOctave?: boolean;
  /** Notes before this song time are not judged (count-in / pre-roll / start position). */
  judgeFrom?: number;
  /** Only notes in `[start, end)` are judged (loop region). */
  region?: { start: number; end: number } | null;
}

/** Output of {@link Judge.push} / {@link Judge.advance}. */
export interface JudgeOutput {
  /** New or updated judgements (provisional and final). */
  judgements: Judgement[];
  strays: StrayEvent[];
}

/** Live HUD state. */
export interface JudgeState {
  score: number;
  combo: number;
  maxCombo: number;
  /** ×1–×4: combo 0–9 → 1, 10–19 → 2, 20–29 → 3, 30+ → 4. */
  multiplier: 1 | 2 | 3 | 4;
  counts: OutcomeCounts;
  /** Notes with a final judgement. */
  judgedNotes: number;
  /** Accuracy % (DEC-15): (Perfect+Great+Good notes) / judged notes × 100. 0 when nothing judged. */
  accuracy: number;
  /** Mean of 1.0 / 0.75 / 0.5 over hits, 0–1. */
  timingScore: number;
  /** Notes judged with chord leniency so far. */
  lenientChordNotes: number;
}

/**
 * The judge: pure, deterministic. Feed events with {@link push}; call {@link advance} with the
 * current ctx time (each frame or scheduler tick) to finalise closed windows and emit Misses.
 */
export interface Judge {
  push(ev: InputEvent): JudgeOutput;
  advance(nowCtx: number): JudgeOutput;
  state(): JudgeState;
  /** Start a new loop pass (or restart): re-opens the notes in `region`, keeps the run tally. */
  startPass(opts: { pass: number; judgeFrom?: number; region?: { start: number; end: number } | null }): void;
  /** Finalise everything (song end / quit) and return the run summary. */
  finish(nowCtx: number): RunSummary;
}

/** Factory signature implemented by `src/core/judge` (T-014). */
export type CreateJudge = (song: Song, config: JudgeConfig) => Judge;

/** Star rating per run: accuracy ≥ 50 / 70 / 80 / 90 / 97 % → 1–5. */
export type Stars = 0 | 1 | 2 | 3 | 4 | 5;

/** Timing histogram, early ↔ late. */
export interface TimingHistogram {
  /** Bin width in ms (10). */
  binMs: number;
  /** Lower edge of bin 0 in ms (−120). */
  minMs: number;
  /** Counts per bin (hits and WrongNotes with a delta). */
  bins: number[];
}

/** Per-section run statistics (results heatmap, weakest section). */
export interface SectionRunStat {
  /** Index into `Song.sections`. */
  idx: number;
  notes: number;
  hits: number;
  /** % (0–100). */
  accuracy: number;
}

/** Result of a finished run (results screen, IndexedDB `runs`). */
export interface RunSummary {
  score: number;
  /** % (DEC-15). */
  accuracy: number;
  timingScore: number;
  stars: Stars;
  maxCombo: number;
  counts: OutcomeCounts;
  judgedNotes: number;
  histogram: TimingHistogram;
  sections: SectionRunStat[];
  /** Index of the weakest judged section, if any. */
  weakestSection: number | null;
  /** Clean run: accuracy ≥ 90% and no more than 2 consecutive misses. */
  clean: boolean;
  lenientChordNotes: number;
  strays: number;
}

// ---------------------------------------------------------------------------------------------
// Practice (D8): speed trainer and loops — src/core/practice (T-014)
// ---------------------------------------------------------------------------------------------

/** Persisted speed-trainer state per section. Speeds are fractions (0.7 = 70%). */
export interface TrainerState {
  speed: number;
  /** Consecutive failed runs (< 70%). */
  failStreak: number;
}

/** What the speed trainer decided after a run. */
export interface TrainerStep {
  state: TrainerState;
  /** −0.05, 0 or +0.05. */
  delta: number;
  /** Player-facing message, e.g. "Clean run! +5% → 80%" or "Slow down a notch". */
  message: string | null;
}

/** A loop in bar units (persisted on runs as `loop`). */
export interface BarLoop {
  /** First bar (inclusive). */
  startBar: number;
  /** Bar after the last bar (exclusive). */
  endBar: number;
}

/** Practice messages surfaced by the session to the practice panel. */
export interface PracticeMessage {
  kind: 'trainer' | 'loop' | 'plateau' | 'info';
  text: string;
}
