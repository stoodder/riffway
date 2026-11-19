/**
 * End-to-end scenario for the audio-pipeline tests (T-036): a song's notes rendered as plucked
 * strings at known context times (plus a simulated input latency), a play-to-click calibration
 * before the song, the analysis events converted with `analysisToInputEvent` and delivered to the
 * real judge on a frame loop driven by `inputHorizon` — the same path the game session uses.
 *
 * DOM-free: the Node tests feed it from {@link AnalysisCore} (with the exact quantum each event was
 * posted in), the browser tests from the real AudioWorklet on an `OfflineAudioContext`.
 */
import type { AnalysisCommand, AnalysisEvent } from '@shared/audio-events';
import type { SongClockMapping } from '@shared/clock';
import type { Judgement, Outcome, RunSummary, StrayEvent } from '@shared/judge';
import type { Song } from '@shared/song';
import { analysisToInputEvent, createJudge, gradeFor, inputHorizon } from '@core/judge';
import { WINDOWS } from '@core/judge/constants';
import { onsetGroups } from '@core/model';
import { AnalysisCore, QUANTUM } from '../../src/audio/input/analysis-core';
import { addPickTransient, fadeOut, karplusStrong, midiToHz, renderTimeline, rng } from '../helpers/signals';
import { errorStats, type ErrorStats } from './evaluate';

/** How the simulated player deviates from the score, per onset group index. */
export interface Deviation {
  /** Played this many ms after the note (negative = early). */
  timingMs?: number;
  /** Played this MIDI instead (a wrong note). */
  midi?: number;
  /** Not played at all. */
  omit?: boolean;
}

/**
 * The deviations both Ode to Joy runs use (Node core and browser worklet), by onset-group index:
 * one wrong note (+2 semitones), one omitted note, two Great (±50 ms) and three Good (+90, −100,
 * +100 ms) plucks; every other note on time.
 */
export const ODE_TO_JOY_DEVIATIONS: ReadonlyMap<number, Deviation> = new Map<number, Deviation>([
  [5, { midi: 67 }],
  [9, { omit: true }],
  [12, { timingMs: 50 }],
  [13, { timingMs: -50 }],
  [20, { timingMs: 90 }],
  [25, { timingMs: -100 }],
  [30, { timingMs: 100 }],
]);

/** Options for {@link planScenario}. */
export interface ScenarioOptions {
  sampleRate: number;
  /** Playback speed (song seconds per real second). */
  speed?: number;
  /** Input latency between the string and the worklet (s): interface + cable + driver. */
  latencySec: number;
  /** Deviations by onset-group index. */
  deviations?: ReadonlyMap<number, Deviation>;
  /** Number of calibration plucks on clicks before the song (default 8). */
  calibrationPlucks?: number;
}

/** What the judge should say about one onset group. */
export interface ExpectedGroup {
  /** Id of the group's first note (the judgement's `noteIds[0]`). */
  noteId: number;
  outcome: Outcome;
  /** The player's intended timing (ms) for hits and wrong notes; null for a Miss. */
  intendedMs: number | null;
}

/** A planned run: the song, the input signal's plucks and the expected judgement per group. */
export interface ScenarioPlan {
  song: Song;
  sampleRate: number;
  speed: number;
  latencySec: number;
  /** Context time of song time 0. */
  leadInSec: number;
  /** Context times of the calibration clicks. */
  clicks: number[];
  /** Plucks as they reach the worklet: context time (latency included) and MIDI. */
  plucks: { atSec: number; midi: number }[];
  expected: ExpectedGroup[];
  /** Total input length, s. */
  durationSec: number;
  /** `expect` hint for the song's range (the game sends one from upcoming notes). */
  hint: AnalysisCommand;
}

/** Calibration clicks: every 0.5 s from 0.5 s; the song starts 1 s after the last one. */
const CLICK_SPACING_SEC = 0.5;
/** MIDI of the calibration plucks (A2, open A string). */
const CALIBRATION_MIDI = 45;

/** Plan a run of `song` with the given deviations. Chords are played as one pluck of their lowest tone. */
export function planScenario(song: Song, opts: ScenarioOptions): ScenarioPlan {
  const speed = opts.speed ?? 1;
  const nClicks = opts.calibrationPlucks ?? 8;
  const clicks = Array.from({ length: nClicks }, (_, i) => CLICK_SPACING_SEC * (i + 1));
  const leadInSec = clicks[clicks.length - 1] + 1;
  const plucks = clicks.map((t) => ({ atSec: t + opts.latencySec, midi: CALIBRATION_MIDI }));
  const expected: ExpectedGroup[] = [];
  for (const group of onsetGroups(song)) {
    const dev = opts.deviations?.get(group.index) ?? {};
    const lowest = Math.min(...group.notes.map((n) => n.midi));
    const noteId = group.notes[0].id;
    if (dev.omit) {
      expected.push({ noteId, outcome: 'Miss', intendedMs: null });
      continue;
    }
    const timingMs = dev.timingMs ?? 0;
    const grade = gradeFor(timingMs / 1000, WINDOWS);
    if (grade === null) throw new Error(`group ${group.index}: ${timingMs} ms is outside the Good window`);
    const midi = dev.midi ?? lowest;
    expected.push({ noteId, outcome: dev.midi !== undefined ? 'WrongNote' : grade, intendedMs: timingMs });
    plucks.push({ atSec: leadInSec + group.time / speed + timingMs / 1000 + opts.latencySec, midi });
  }
  const minMidi = Math.min(...song.notes.map((n) => n.midi));
  const maxMidi = Math.max(...song.notes.map((n) => n.midi));
  return {
    song,
    sampleRate: opts.sampleRate,
    speed,
    latencySec: opts.latencySec,
    leadInSec,
    clicks,
    plucks,
    expected,
    durationSec: leadInSec + song.meta.durationSec / speed + 1,
    hint: { type: 'expect', range: { minMidi, maxMidi } },
  };
}

/**
 * Render the plan's plucks as Karplus–Strong strings with a pick transient, each muted (8 ms fade)
 * 5 ms before the next pluck or after 0.6 s, over a −70 dBFS noise floor. Every pluck gets its own
 * seeded dynamics (peak 0.08–0.5, i.e. about −22 to −6 dBFS), brightness and sustain, so the
 * detector's timing bias is not trivially identical from note to note.
 */
export function renderScenario(plan: ScenarioPlan): Float32Array {
  const sr = plan.sampleRate;
  const r = rng(0x7036);
  const notes = plan.plucks.map((p, i) => {
    const next = plan.plucks[i + 1]?.atSec ?? p.atSec + 1;
    const dur = Math.min(0.6, next - p.atSec - 0.005);
    const amp = 0.08 + 0.42 * r();
    const tone = karplusStrong(midiToHz(p.midi), dur, sr, { amp, seed: i + 1, feedback: 0.993 + 0.005 * r(), brightness: 0.35 + 0.6 * r() });
    addPickTransient(tone, sr, amp * (0.1 + 0.3 * r()), 0.5 + r(), i + 7);
    return { atSec: p.atSec, signal: fadeOut(tone, sr, 8) };
  });
  return renderTimeline(notes, plan.durationSec, sr, -70);
}

/** An analysis event with the context time it reaches the main thread (s). */
export interface TimedEvent {
  ev: AnalysisEvent;
  arrivalSec: number;
}

/**
 * Run {@link AnalysisCore} over `signal` quantum by quantum (as the worklet does) and stamp every
 * event with when it would reach the main thread: the end of the quantum that posted it plus
 * `deliverySec`.
 */
export function runCoreTimed(signal: Float32Array, sampleRate: number, commands: readonly AnalysisCommand[], deliverySec: number): TimedEvent[] {
  const out: TimedEvent[] = [];
  let postedAt = 0;
  const core = new AnalysisCore({ sampleRate, channel: 0, tuner: false }, (ev) => out.push({ ev: { ...ev }, arrivalSec: postedAt / sampleRate + deliverySec }));
  for (const cmd of commands) core.command(cmd);
  for (let off = 0; off + QUANTUM <= signal.length; off += QUANTUM) {
    postedAt = off + QUANTUM;
    core.process([signal.subarray(off, off + QUANTUM)], off);
  }
  return out;
}

/** The earliest frame an event can describe (its onset), for ordering untimed events. */
function onsetFrameOf(ev: AnalysisEvent): number {
  if (ev.type === 'pitch') return ev.onsetFrame;
  return 'frame' in ev ? ev.frame : 0;
}

/**
 * Stamp untimed events (from the browser worklet, whose posting time an offline render does not
 * reveal) with the latest time the analysis contract allows: onset + 25 ms + 2048 samples + one
 * quantum (+ 512 samples for a follow-up `pitch`; a `pitch-change` at its frame + 2048 samples).
 */
export function worstCaseArrival(events: readonly AnalysisEvent[], sampleRate: number): TimedEvent[] {
  const analysis = 0.025 + (2048 + QUANTUM) / sampleRate;
  return events.map((ev) => {
    const base = onsetFrameOf(ev) / sampleRate;
    if (ev.type === 'pitch') return { ev, arrivalSec: base + analysis + 512 / sampleRate };
    if (ev.type === 'pitch-change') return { ev, arrivalSec: base + (2048 + QUANTUM) / sampleRate };
    return { ev, arrivalSec: base + analysis };
  });
}

/**
 * Play-to-click calibration as docs/timing.md describes it: pair each click with the nearest
 * detected onset within 150 ms and take the median offset (ms). Returns null with fewer than
 * `clicks.length − 2` pairs.
 */
export function calibrateInputOffsetMs(events: readonly AnalysisEvent[], clicks: readonly number[], sampleRate: number): number | null {
  const onsets = events.filter((e): e is Extract<AnalysisEvent, { type: 'onset' }> => e.type === 'onset').map((e) => e.frame / sampleRate);
  const offsets: number[] = [];
  for (const click of clicks) {
    let best: number | null = null;
    for (const t of onsets) if (Math.abs(t - click) <= 0.15 && (best === null || Math.abs(t - click) < Math.abs(best - click))) best = t;
    if (best !== null) offsets.push((best - click) * 1000);
  }
  if (offsets.length < clicks.length - 2) return null;
  offsets.sort((a, b) => a - b);
  const mid = offsets.length >> 1;
  return offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
}

/** Result of {@link judgeRun}. */
export interface JudgedRun {
  /** Final judgement per group (by first note id). */
  judgements: Map<number, Judgement>;
  summary: RunSummary;
  strays: StrayEvent[];
  /**
   * Events that reached the main thread after the judge's horizon had already passed their
   * calibrated time + the Good window (so a late-Good hit there could have been lost).
   */
  lateArrivals: number;
}

/** Linear ctx ↔ song mapping for one pass starting at `leadInSec`. */
export function linearClock(leadInSec: number, speed: number): SongClockMapping {
  return {
    songTimeAt: (ctx) => (ctx - leadInSec) * speed,
    ctxTimeAt: (song) => leadInSec + song / speed,
  };
}

/**
 * Drive the real judge: on every display frame (60 Hz) push the events that have arrived, then
 * `advance(inputHorizon(now, 'guitar', inputOffsetMs))`; `finish()` after the last frame.
 */
export function judgeRun(
  song: Song,
  clock: SongClockMapping,
  events: readonly TimedEvent[],
  opts: { sampleRate: number; inputOffsetMs: number; endSec: number; judgeFrom?: number },
): JudgedRun {
  const judge = createJudge(song, { clock, judgeFrom: opts.judgeFrom ?? 0 });
  const judgements = new Map<number, Judgement>();
  const strays: StrayEvent[] = [];
  const queue = [...events].sort((a, b) => a.arrivalSec - b.arrivalSec);
  let next = 0;
  let lateArrivals = 0;
  let horizon = -Infinity;
  const collect = (out: { judgements: Judgement[]; strays: StrayEvent[] }): void => {
    for (const j of out.judgements) judgements.set(j.noteIds[0], j);
    strays.push(...out.strays);
  };
  const frame = 1 / 60;
  for (let now = 0; now <= opts.endSec; now += frame) {
    while (next < queue.length && queue[next].arrivalSec <= now) {
      const input = analysisToInputEvent(queue[next].ev, opts.sampleRate, opts.inputOffsetMs);
      next++;
      if (!input) continue;
      if (input.ctxTime + WINDOWS.good < horizon) lateArrivals++;
      collect(judge.push(input));
    }
    horizon = inputHorizon(now, 'guitar', opts.inputOffsetMs);
    collect(judge.advance(horizon));
  }
  const summary = judge.finish(opts.endSec + 1);
  return { judgements, summary, strays, lateArrivals };
}

/** Comparison of a judged run with the plan. */
export interface ScenarioCheck {
  /** Groups whose final outcome differs from the plan. */
  mismatches: { noteId: number; expected: Outcome; got: Outcome | 'none' }[];
  /** Judged Δ − intended timing (ms) over hits and wrong notes. */
  timingErrorMs: ErrorStats;
}

/** Compare a judged run with the plan's expectations. */
export function checkScenario(plan: ScenarioPlan, run: JudgedRun): ScenarioCheck {
  const mismatches: ScenarioCheck['mismatches'] = [];
  const errors: number[] = [];
  for (const exp of plan.expected) {
    const j = run.judgements.get(exp.noteId);
    if (!j || j.outcome !== exp.outcome) mismatches.push({ noteId: exp.noteId, expected: exp.outcome, got: j?.outcome ?? 'none' });
    if (j && j.deltaMs !== null && exp.intendedMs !== null) errors.push(j.deltaMs - exp.intendedMs);
  }
  return { mismatches, timingErrorMs: errorStats(errors) };
}
