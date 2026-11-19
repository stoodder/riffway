/**
 * Practice panel model (T-032): pure helpers behind the practice panel — speed range and steps,
 * A/B loop editing in bar units (snapped by `@core/practice`), loop-strip geometry, speed-trainer
 * ladder and message classification. DOM-free so it is unit-tested in Node.
 *
 * Parameters come from D8 / docs/research/learning.md (`TRAINER`, `LOOP` in `@core/practice`).
 * @module
 */
import type { TransportLoop } from '@shared/clock';
import type { BarLoop, PracticeMessage } from '@shared/judge';
import type { Bar, Section, Song } from '@shared/song';
import type { SectionProgress } from '@shared/storage';
import { TRAINER, prerollBars, snapLoop } from '@core/practice';

// ---------------------------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------------------------

/**
 * Speed range of the practice panel (fractions). The transport clamps to 40–110% (docs/timing.md
 * § Speed changes); 110% is the opt-in overspeed (D8).
 */
export const SPEED = {
  min: TRAINER.floor,
  max: TRAINER.cap,
  overspeedMax: 1.1,
  step: TRAINER.step,
} as const;

/** Round to the 1% grid the trainer uses (so 0.7 + 0.05 stays 0.75). */
export const roundSpeed = (s: number): number => Math.round(s * 100) / 100;

/** `0.75` → `"75%"`. */
export const formatSpeed = (s: number): string => `${Math.round(s * 100)}%`;

/** Highest selectable speed: 110% only with the overspeed opt-in *and* mastery. */
export function maxSpeed(overspeedAllowed: boolean): number {
  return overspeedAllowed ? SPEED.overspeedMax : SPEED.max;
}

/** Clamp `s` to `[40%, max]` on the 1% grid. */
export function clampSpeed(s: number, max: number = SPEED.max): number {
  return Math.min(max, Math.max(SPEED.min, roundSpeed(s)));
}

/**
 * One 5% step up (`dir = 1`) or down (`-1`) from `s`, landing on the 5% grid: 72% → 75% / 70%.
 * Clamped to `[40%, max]`.
 */
export function stepSpeed(s: number, dir: 1 | -1, max: number = SPEED.max): number {
  const pct = Math.round(s * 100);
  const stepPct = Math.round(SPEED.step * 100);
  const onGrid = pct % stepPct === 0;
  const next = dir > 0 ? (Math.floor(pct / stepPct) + 1) * stepPct : (onGrid ? pct - stepPct : Math.floor(pct / stepPct) * stepPct);
  return clampSpeed(next / 100, max);
}

/** Quick speed presets shown as chips (filtered to `max`). */
export function speedPresets(max: number): number[] {
  return [0.5, 0.6, 0.7, 0.85, 1, 1.1].filter((s) => s <= max + 1e-9);
}

/**
 * Whether 110% may be offered: the `practice.overspeed` opt-in is on and every section in scope
 * (those overlapping `loop`, or all sections) has been mastered (2 clean runs at 100%).
 * A song without sections counts as one section with index 0.
 */
export function overspeedAllowed(optIn: boolean, song: Song, progress: readonly SectionProgress[], loop: BarLoop | null): boolean {
  if (!optIn) return false;
  const mastered = new Set(progress.filter((p) => p.masteredAt !== undefined).map((p) => p.sectionIdx));
  const scope = sectionsInScope(song, loop);
  return scope.length > 0 && scope.every((i) => mastered.has(i));
}

function sectionsInScope(song: Song, loop: BarLoop | null): number[] {
  if (song.sections.length === 0) return [0];
  return song.sections
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !loop || (s.startBar < loop.endBar && s.endBar > loop.startBar))
    .map(({ i }) => i);
}

// ---------------------------------------------------------------------------------------------
// Bars, sections and loops
// ---------------------------------------------------------------------------------------------

/** Index of the bar containing `time` (clamped to the song; 0 before the first bar). */
export function barIndexAt(bars: readonly Bar[], time: number): number {
  if (bars.length === 0) return 0;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((bars[mid] as Bar).time <= time + 1e-9) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Song time of bar line `i` (`i = bars.length` → end of the last bar). */
export function barLineTime(bars: readonly Bar[], i: number): number {
  if (bars.length === 0) return 0;
  if (i >= bars.length) {
    const last = bars[bars.length - 1] as Bar;
    return last.time + last.dur;
  }
  return (bars[Math.max(0, i)] as Bar).time;
}

/** Transport loop (seconds) → bar loop. A and B are bar lines, so this is exact up to rounding. */
export function loopToBars(song: Song, loop: TransportLoop | null): BarLoop | null {
  const bars = song.timing.bars;
  if (!loop || bars.length === 0) return null;
  const startBar = nearestBarLine(bars, loop.start);
  const endBar = Math.max(startBar + 1, nearestBarLine(bars, loop.end));
  return { startBar: Math.min(startBar, bars.length - 1), endBar: Math.min(endBar, bars.length) };
}

function nearestBarLine(bars: readonly Bar[], time: number): number {
  const i = barIndexAt(bars, time);
  const here = barLineTime(bars, i);
  const next = barLineTime(bars, i + 1);
  return time - here <= next - time ? i : i + 1;
}

/** Index of the section containing bar `bar`, or -1. */
export function sectionIndexAtBar(sections: readonly Section[], bar: number): number {
  return sections.findIndex((s) => bar >= s.startBar && bar < s.endBar);
}

/** Index of the section exactly matching `loop`, or -1. */
export function sectionIndexOfLoop(sections: readonly Section[], loop: BarLoop | null): number {
  if (!loop) return -1;
  return sections.findIndex((s) => s.startBar === loop.startBar && s.endBar === loop.endBar);
}

/** The bar loop covering one section; songs without sections loop the bar at `fallbackBar`. */
export function sectionLoop(song: Song, sectionIdx: number, fallbackBar = 0): BarLoop | null {
  const n = song.timing.bars.length;
  if (n === 0) return null;
  const s = song.sections[sectionIdx];
  if (s) return { startBar: s.startBar, endBar: Math.max(s.startBar + 1, s.endBar) };
  const bar = Math.min(Math.max(0, fallbackBar), n - 1);
  return { startBar: bar, endBar: bar + 1 };
}

/** Editing state of the A/B loop: the applied loop plus an A marker waiting for its B. */
export interface LoopDraft {
  loop: BarLoop | null;
  /** Bar index of a pending A (set without a loop yet), else null. */
  pendingA: number | null;
}

/**
 * "Set A" at song time `t` (the position the player hears). With a loop whose B lies after `t`,
 * the loop's start moves to `t` (snapped to sections, then bars); otherwise `t` becomes a pending A.
 */
export function setLoopStart(song: Song, draft: LoopDraft, t: number): LoopDraft {
  const bars = song.timing.bars;
  if (bars.length === 0) return draft;
  if (draft.loop) {
    const endTime = barLineTime(bars, draft.loop.endBar);
    if (t < endTime) {
      const snapped = snapLoop(song, t, t).startBar;
      if (snapped < draft.loop.endBar) return { loop: { startBar: snapped, endBar: draft.loop.endBar }, pendingA: null };
    }
  }
  return { loop: draft.loop, pendingA: snapLoop(song, t, t).startBar };
}

/**
 * "Set B" at song time `t`. The start is the pending A, else the current loop's A, else the start
 * of the section (or bar) containing `t`. The range is snapped with `snapLoop` (min 1 bar).
 */
export function setLoopEnd(song: Song, draft: LoopDraft, t: number): LoopDraft {
  const bars = song.timing.bars;
  if (bars.length === 0) return draft;
  let startBar: number;
  if (draft.pendingA !== null) startBar = draft.pendingA;
  else if (draft.loop) startBar = draft.loop.startBar;
  else {
    const bar = barIndexAt(bars, t);
    const sec = song.sections[sectionIndexAtBar(song.sections, bar)];
    startBar = sec ? sec.startBar : bar;
  }
  const startTime = barLineTime(bars, startBar);
  if (t <= startTime) {
    // B before (or at) A: a one-bar loop at A keeps the player's A.
    return { loop: { startBar, endBar: Math.min(startBar + 1, bars.length) }, pendingA: null };
  }
  const snapped = snapLoop(song, startTime, t);
  return { loop: { startBar, endBar: Math.max(startBar + 1, snapped.endBar) }, pendingA: null };
}

/** Move one loop edge by `delta` bars (no section snap), keeping at least 1 bar. */
export function nudgeLoop(song: Song, loop: BarLoop, edge: 'start' | 'end', delta: number): BarLoop {
  const n = song.timing.bars.length;
  if (edge === 'start') {
    const startBar = Math.min(Math.max(0, loop.startBar + delta), loop.endBar - 1);
    return { startBar, endBar: loop.endBar };
  }
  const endBar = Math.max(loop.startBar + 1, Math.min(n, loop.endBar + delta));
  return { startBar: loop.startBar, endBar };
}

/** "Loop the previous/next section" relative to the current loop (or the bar at `t`). */
export function adjacentSectionLoop(song: Song, loop: BarLoop | null, t: number, dir: 1 | -1): BarLoop | null {
  const sections = song.sections;
  if (sections.length === 0) return null;
  const exact = sectionIndexOfLoop(sections, loop);
  let idx: number;
  if (exact >= 0) idx = exact + dir;
  else {
    const anchorBar = loop ? loop.startBar : barIndexAt(song.timing.bars, t);
    const here = sectionIndexAtBar(sections, anchorBar);
    idx = here < 0 ? (dir > 0 ? 0 : sections.length - 1) : loop ? here + (dir > 0 ? 1 : 0) : here + dir;
  }
  idx = Math.min(sections.length - 1, Math.max(0, idx));
  return sectionLoop(song, idx);
}

/** Bars in a loop and the "bars 5–8" label (1-based, inclusive). */
export function describeLoop(loop: BarLoop): { bars: number; label: string } {
  const bars = loop.endBar - loop.startBar;
  const label = bars === 1 ? `bar ${loop.startBar + 1}` : `bars ${loop.startBar + 1}–${loop.endBar}`;
  return { bars, label };
}

/** Pre-roll description for the current speed (1 bar; 2 bars below 60%). */
export function prerollText(speed: number): string {
  const n = prerollBars(speed);
  return n === 1 ? '1-bar pre-roll' : `${n}-bar pre-roll (below 60%)`;
}

// ---------------------------------------------------------------------------------------------
// Loop strip geometry
// ---------------------------------------------------------------------------------------------

/** Song time → strip fraction 0–1 (by time, so bars keep their real proportions). */
export function timeToFraction(song: Song, t: number): number {
  const total = stripDuration(song);
  return total > 0 ? Math.min(1, Math.max(0, t / total)) : 0;
}

/** Strip fraction 0–1 → song time. */
export function fractionToTime(song: Song, f: number): number {
  return Math.min(1, Math.max(0, f)) * stripDuration(song);
}

function stripDuration(song: Song): number {
  const bars = song.timing.bars;
  return bars.length > 0 ? barLineTime(bars, bars.length) : song.meta.durationSec;
}

/** Bar line indices worth drawing as ticks: every bar up to 64 bars, then every 2/4/8… */
export function barTickEvery(barCount: number): number {
  let every = 1;
  while (barCount / every > 64) every *= 2;
  return every;
}

// ---------------------------------------------------------------------------------------------
// Speed trainer
// ---------------------------------------------------------------------------------------------

/** One rung of the trainer ladder. */
export interface TrainerRung {
  speed: number;
  state: 'done' | 'current' | 'todo';
}

/**
 * The trainer ladder from the trainer's start (70%, or lower if the player is below it) to the
 * cap (100%) in 5% steps, with the current speed marked.
 */
export function trainerLadder(speed: number): TrainerRung[] {
  const cur = roundSpeed(speed);
  const from = Math.min(TRAINER.start, stepFloor(cur));
  const rungs: TrainerRung[] = [];
  for (let pct = Math.round(from * 100); pct <= Math.round(TRAINER.cap * 100); pct += Math.round(TRAINER.step * 100)) {
    const s = pct / 100;
    rungs.push({ speed: s, state: Math.abs(s - cur) < 1e-9 ? 'current' : s < cur ? 'done' : 'todo' });
  }
  if (!rungs.some((r) => r.state === 'current') && cur <= TRAINER.cap) {
    // Off-grid speed (e.g. 72%): mark the rung just below as current.
    const below = [...rungs].reverse().find((r) => r.speed < cur);
    if (below) below.state = 'current';
  }
  return rungs;
}

function stepFloor(s: number): number {
  const stepPct = Math.round(TRAINER.step * 100);
  return (Math.floor(Math.round(s * 100) / stepPct) * stepPct) / 100;
}

/** Clean runs still needed to reach 100% from `speed` (0 at or above the cap). */
export function cleanRunsToGoal(speed: number): number {
  const gap = Math.round((TRAINER.cap - roundSpeed(speed)) * 100);
  return gap <= 0 ? 0 : Math.ceil(gap / Math.round(TRAINER.step * 100));
}

/** Progress 0–1 of the trainer from its start (70%, or the floor if lower) to 100%. */
export function trainerProgress(speed: number): number {
  const from = Math.min(TRAINER.start, roundSpeed(speed));
  const span = TRAINER.cap - from;
  return span <= 0 ? 1 : Math.min(1, Math.max(0, (roundSpeed(speed) - from) / span));
}

/** What a practice message means for the panel's styling and counters. */
export type MessageTone = 'up' | 'down' | 'hold' | 'info';

/**
 * Classify a practice message. Trainer messages come from `trainerStep` (`@core/practice`):
 * "Clean run! +5% → 80%" (up), "Clean run at 100%!" (hold, at the cap),
 * "Slow down a notch → 75%" (down), "Already at 40%: …" (hold, at the floor).
 */
export function messageTone(m: PracticeMessage): MessageTone {
  if (m.kind !== 'trainer') return 'info';
  if (/^Clean run!\s*\+/.test(m.text)) return 'up';
  if (/^Slow down/.test(m.text)) return 'down';
  return 'hold';
}

/** Whether a message reports a clean run (counted in the panel's "clean runs" tally). */
export function isCleanRunMessage(m: PracticeMessage): boolean {
  return m.kind === 'trainer' && /^Clean run/.test(m.text);
}
