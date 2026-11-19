/**
 * The judge state machine (docs/game-mechanics.md § Judge algorithm). Pure and deterministic: the
 * same song, config and event/advance sequence always yields the same judgements.
 *
 * Time model. Every group of the current pass resolves its target context time live through
 * `config.clock.ctxTimeAt(note.time)`, so speed changes and pauses (a non-finite mapping while
 * paused) are followed exactly. On {@link Judge.startPass} the open groups of the previous pass are
 * frozen at their last resolved target, so a loop wrap (the clock jumps back to A − pre-roll) cannot
 * move them. Windows are real seconds; the song speed never scales them.
 * @module
 */
import type {
  InputEvent,
  InputSource,
  Judge,
  JudgeConfig,
  JudgeOutput,
  JudgeState,
  Judgement,
  Outcome,
  OutcomeCounts,
  RunSummary,
  SectionRunStat,
  StrayEvent,
  TimingWindows,
} from '@shared/judge';
import type { SongClockMapping } from '@shared/clock';
import type { Song } from '@shared/song';
import {
  BASE_POINTS,
  PITCH_WAIT_SEC,
  REFINE_MATCH_SEC,
  RETRIGGER_SEC,
  TIME_EPS_SEC,
  TIMING_BIAS_ALPHA,
  TIMING_VALUE,
  WINDOWS,
} from './constants';
import {
  ComboTracker,
  accuracyOf,
  addToHistogram,
  emptyHistogram,
  gradeFor,
  isCleanRun,
  isHit,
  longestRun,
  multiplierFor,
  starsFor,
  timingLabelFor,
} from './scoring';
import { type PitchMatch, type Target, buildTargets, matchPitch } from './targets';

/** Provisional or final assignment of an event to a slot. */
interface Assignment {
  outcome: Outcome;
  ctxTime: number;
  deltaSec: number;
  playedMidi?: number;
  expectedMidi: number;
  source: InputSource;
}

/** One target in one pass. */
interface Slot {
  t: Target;
  pass: number;
  /** Pass-major note order (combo, clean-run order). */
  key: number;
  /** Last finite target context time. */
  target: number;
  /** Current-pass slots resolve live; `live` is false while the clock gives no finite time (paused). */
  live: boolean;
  /** Previous-pass slot: `target` no longer follows the clock. */
  frozen: boolean;
  /** Provisional WrongNote (hits are final immediately and leave the active set). */
  assignment: Assignment | null;
}

/** An event that was assigned to a slot (retrigger guard, late follow-up pitches). */
interface EventRecord {
  ctxTime: number;
  slot: Slot;
  hit: boolean;
  unpitched: boolean;
}

interface PassState {
  pass: number;
  seq: number;
  targets: Target[];
  cursor: number;
}

interface Candidate {
  slot: Slot;
  /** |Δ − bias|: distance after removing the player's current timing bias. */
  cost: number;
}

/** Recent event records older than this (s) are dropped. */
const RECENT_KEEP_SEC = 1;

const emptyCounts = (): OutcomeCounts => ({ Perfect: 0, Great: 0, Good: 0, WrongNote: 0, Miss: 0 });

/** {@link Judge} implementation; create with `createJudge`. */
export class JudgeImpl implements Judge {
  private readonly targets: Target[];
  private readonly clock: SongClockMapping;
  private readonly windows: TimingWindows;
  private readonly strictOctave: boolean;
  private readonly sectionCount: number;
  /** Order-key stride per pass. */
  private readonly stride: number;

  private judgeFrom: number;
  private region: { start: number; end: number } | null;
  private current: PassState;
  private active: Slot[] = [];
  private pending: InputEvent[] = [];
  private recent: EventRecord[] = [];
  private lastNow = -Infinity;
  private bias = 0;

  private readonly combo = new ComboTracker();
  private score = 0;
  private readonly counts = emptyCounts();
  private judgedNotes = 0;
  private hitNotes = 0;
  private timingSum = 0;
  private hitGroups = 0;
  private lenientChordNotes = 0;
  private strays = 0;
  private readonly histogram = emptyHistogram();
  private readonly sectionNotes = new Map<number, { notes: number; hits: number }>();
  /** Final group results in arrival order: `[key, hit]`. */
  private readonly finals: { key: number; hit: boolean }[] = [];

  constructor(song: Song, config: JudgeConfig) {
    this.targets = buildTargets(song);
    this.clock = config.clock;
    this.windows = config.windows ?? WINDOWS;
    this.strictOctave = config.strictOctave ?? false;
    this.sectionCount = song.sections.length;
    this.stride = this.targets.length + 1;
    this.judgeFrom = config.judgeFrom ?? -Infinity;
    this.region = config.region ?? null;
    this.current = this.makePass(0, 0);
  }

  push(ev: InputEvent): JudgeOutput {
    const out: JudgeOutput = { judgements: [], strays: [] };
    this.refresh();
    this.activate(Math.max(this.lastNow, ev.ctxTime));
    if (ev.refines !== undefined) this.handleRefine(ev, out);
    else if (ev.kind === 'onset' && ev.midi === undefined) this.handleUnpitched(ev, out);
    else this.handlePitched(ev, out);
    return out;
  }

  advance(nowCtx: number): JudgeOutput {
    const out: JudgeOutput = { judgements: [], strays: [] };
    this.lastNow = nowCtx;
    this.refresh();
    this.activate(nowCtx);
    this.expirePending(nowCtx, out);
    for (const slot of [...this.active]) {
      if (!this.available(slot)) continue;
      if (nowCtx <= slot.target + this.windows.good + TIME_EPS_SEC) continue;
      if (this.pending.some((p) => Math.abs(p.ctxTime - slot.target) <= this.windows.good + TIME_EPS_SEC)) continue;
      this.finalize(slot, out);
    }
    this.recent = this.recent.filter((r) => r.ctxTime >= nowCtx - RECENT_KEEP_SEC);
    return out;
  }

  state(): JudgeState {
    const combo = this.combo.combo;
    return {
      score: this.score,
      combo,
      maxCombo: this.combo.maxCombo,
      multiplier: multiplierFor(combo),
      counts: { ...this.counts },
      judgedNotes: this.judgedNotes,
      accuracy: accuracyOf(this.hitNotes, this.judgedNotes),
      timingScore: this.hitGroups > 0 ? this.timingSum / this.hitGroups : 0,
      lenientChordNotes: this.lenientChordNotes,
    };
  }

  startPass(opts: { pass: number; judgeFrom?: number; region?: { start: number; end: number } | null }): void {
    for (const slot of this.active) slot.frozen = true;
    if (opts.judgeFrom !== undefined) this.judgeFrom = opts.judgeFrom;
    if (opts.region !== undefined) this.region = opts.region;
    this.current = this.makePass(opts.pass, this.current.seq + 1);
  }

  finish(nowCtx: number): RunSummary {
    const out: JudgeOutput = { judgements: [], strays: [] };
    this.advance(nowCtx);
    this.expirePending(Infinity, out);
    for (const slot of [...this.active]) this.finalize(slot, out);
    return this.summary();
  }

  // -------------------------------------------------------------------------------------------
  // Passes and targets
  // -------------------------------------------------------------------------------------------

  private makePass(pass: number, seq: number): PassState {
    const from = this.judgeFrom - 1e-9;
    const region = this.region;
    const targets = this.targets.filter(
      (t) => t.time >= from && (region === null || (t.time >= region.start - 1e-9 && t.time < region.end - 1e-9)),
    );
    return { pass, seq, targets, cursor: 0 };
  }

  /** Re-resolve live targets of the current pass (speed change, pause/resume). */
  private refresh(): void {
    for (const slot of this.active) {
      if (slot.frozen) continue;
      const v = this.clock.ctxTimeAt(slot.t.time);
      slot.live = Number.isFinite(v);
      if (slot.live) slot.target = v;
    }
  }

  /** Open the current-pass groups whose window has opened by `now`. */
  private activate(now: number): void {
    const p = this.current;
    while (p.cursor < p.targets.length) {
      const t = p.targets[p.cursor] as Target;
      const v = this.clock.ctxTimeAt(t.time);
      if (!Number.isFinite(v) || v - this.windows.good > now + TIME_EPS_SEC) break;
      this.active.push({ t, pass: p.pass, key: p.seq * this.stride + t.index, target: v, live: true, frozen: false, assignment: null });
      p.cursor++;
    }
  }

  private available(slot: Slot): boolean {
    return slot.frozen || slot.live;
  }

  /** Open slots (not hit) whose window contains `ctxTime`. */
  private candidates(ctxTime: number): Candidate[] {
    const out: Candidate[] = [];
    for (const slot of this.active) {
      if (!this.available(slot)) continue;
      const delta = ctxTime - slot.target;
      if (Math.abs(delta) > this.windows.good + TIME_EPS_SEC) continue;
      out.push({ slot, cost: Math.abs(delta - this.bias) });
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------------------------

  private handlePitched(ev: InputEvent, out: JudgeOutput): void {
    const midi = ev.midi;
    if (midi === undefined) return;
    const cands = this.candidates(ev.ctxTime);
    let best: { c: Candidate; m: PitchMatch } | null = null;
    for (const c of cands) {
      if (ev.kind === 'pitch-change' && !c.slot.t.legato) continue;
      const m = matchPitch(c.slot.t, midi, ev.cents, this.strictOctave);
      if (m === null) continue;
      if (best === null || better(c, m.rank, best.c, best.m.rank)) best = { c, m };
    }
    const wrongTarget = best === null && ev.kind === 'onset' ? nearestUnassigned(cands) : null;
    const chosen = best?.c.slot ?? wrongTarget?.slot ?? null;
    if (this.isRetrigger(ev.ctxTime, chosen)) return;
    if (best !== null) this.assignHit(best.c.slot, ev, best.m.expectedMidi, false, out);
    else if (wrongTarget !== null) this.assignWrong(wrongTarget.slot, ev, false, out);
    else if (ev.kind === 'onset') this.stray(ev, out);
  }

  private handleUnpitched(ev: InputEvent, out: JudgeOutput): void {
    const cands = this.candidates(ev.ctxTime);
    if (cands.length === 0) {
      this.stray(ev, out);
      return;
    }
    const dead = pickBest(cands.filter((c) => c.slot.t.anyPitch));
    if (this.isRetrigger(ev.ctxTime, dead?.slot ?? nearestUnassigned(cands)?.slot ?? null)) return;
    if (dead !== null) this.assignHit(dead.slot, ev, dead.slot.t.lowestMidi, true, out);
    else this.pending.push(ev);
  }

  /** A follow-up pitch for an earlier unpitched onset. */
  private handleRefine(ev: InputEvent, out: JudgeOutput): void {
    if (ev.midi === undefined || ev.refines === undefined) return;
    const at = ev.refines;
    const pitched: InputEvent = { ...ev, ctxTime: at, kind: 'onset' };
    delete pitched.refines;
    const idx = this.pending.findIndex((p) => Math.abs(p.ctxTime - at) <= REFINE_MATCH_SEC);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
      this.handlePitched(pitched, out);
      return;
    }
    const rec = this.recent.find((r) => r.unpitched && Math.abs(r.ctxTime - at) <= REFINE_MATCH_SEC);
    if (rec === undefined) {
      this.handlePitched(pitched, out);
      return;
    }
    // The onset already has a judgement: the pitch may only complete that one (one onset, one note).
    if (rec.hit || !this.active.includes(rec.slot)) return;
    rec.unpitched = false;
    const m = matchPitch(rec.slot.t, ev.midi, ev.cents, this.strictOctave);
    if (m !== null) this.assignHit(rec.slot, pitched, m.expectedMidi, false, out);
    else this.assignWrong(rec.slot, pitched, false, out);
  }

  /** Unpitched onsets whose follow-up pitch did not arrive in time count as wrong pitch. */
  private expirePending(now: number, out: JudgeOutput): void {
    if (this.pending.length === 0) return;
    const due = this.pending.filter((p) => now >= p.ctxTime + PITCH_WAIT_SEC - TIME_EPS_SEC);
    if (due.length === 0) return;
    this.pending = this.pending.filter((p) => !due.includes(p));
    for (const ev of due) {
      const target = nearestUnassigned(this.candidates(ev.ctxTime));
      if (target !== null) this.assignWrong(target.slot, ev, true, out);
      else this.stray(ev, out);
    }
  }

  /**
   * Retrigger guard: an event within {@link RETRIGGER_SEC} of an already-assigned event is a double
   * trigger unless the song asks for notes that fast, i.e. unless the gap is at least half the
   * target spacing between the earlier event's group and the group this event would take.
   */
  private isRetrigger(ctxTime: number, chosen: Slot | null): boolean {
    let prev: EventRecord | null = null;
    for (const r of this.recent) {
      const gap = Math.abs(ctxTime - r.ctxTime);
      if (gap < RETRIGGER_SEC - TIME_EPS_SEC && (prev === null || gap < Math.abs(ctxTime - prev.ctxTime))) prev = r;
    }
    if (prev === null) return false;
    if (chosen === null) return true;
    const gap = Math.abs(ctxTime - prev.ctxTime);
    const spacing = Math.abs(chosen.target - prev.slot.target);
    return gap < spacing / 2 - TIME_EPS_SEC;
  }

  // -------------------------------------------------------------------------------------------
  // Judgements and scoring
  // -------------------------------------------------------------------------------------------

  private assignHit(slot: Slot, ev: InputEvent, expectedMidi: number, unpitched: boolean, out: JudgeOutput): void {
    const delta = ev.ctxTime - slot.target;
    const grade = gradeFor(delta, this.windows) ?? 'Good';
    slot.assignment = this.makeAssignment(grade, ev, delta, expectedMidi);
    this.remove(slot);
    this.score += BASE_POINTS[grade] * multiplierFor(this.combo.combo);
    this.combo.hit(slot.key);
    this.bias = clamp(this.bias + TIMING_BIAS_ALPHA * (delta - this.bias), this.windows.great);
    this.timingSum += TIMING_VALUE[grade];
    this.hitGroups++;
    if (slot.t.chord) this.lenientChordNotes += slot.t.noteIds.length;
    this.tally(slot, grade, delta);
    this.recent.push({ ctxTime: ev.ctxTime, slot, hit: true, unpitched });
    out.judgements.push(this.judgement(slot, slot.assignment, true));
  }

  private assignWrong(slot: Slot, ev: InputEvent, unpitched: boolean, out: JudgeOutput): void {
    const delta = ev.ctxTime - slot.target;
    const expected = slot.t.chord ? slot.t.lowestMidi : (slot.t.midis[0] ?? slot.t.lowestMidi);
    slot.assignment = this.makeAssignment('WrongNote', ev, delta, expected);
    this.combo.break(slot.key);
    if (!this.recent.some((r) => r.ctxTime === ev.ctxTime && r.slot === slot)) {
      this.recent.push({ ctxTime: ev.ctxTime, slot, hit: false, unpitched });
    }
    out.judgements.push(this.judgement(slot, slot.assignment, false));
  }

  private makeAssignment(outcome: Outcome, ev: InputEvent, deltaSec: number, expectedMidi: number): Assignment {
    const a: Assignment = { outcome, ctxTime: ev.ctxTime, deltaSec, expectedMidi, source: ev.source };
    if (ev.midi !== undefined) a.playedMidi = ev.midi;
    return a;
  }

  /** Window closed (or run finished): fix a provisional WrongNote, or record a Miss. */
  private finalize(slot: Slot, out: JudgeOutput): void {
    this.remove(slot);
    const a = slot.assignment;
    if (a !== null) {
      this.tally(slot, a.outcome, a.deltaSec);
      out.judgements.push(this.judgement(slot, a, true));
      return;
    }
    this.combo.break(slot.key);
    this.tally(slot, 'Miss', null);
    out.judgements.push({
      noteIds: [...slot.t.noteIds],
      outcome: 'Miss',
      deltaMs: null,
      timing: null,
      expectedMidi: slot.t.chord ? slot.t.lowestMidi : (slot.t.midis[0] ?? slot.t.lowestMidi),
      chord: slot.t.chord,
      songTime: slot.t.time,
      ctxTime: slot.target + this.windows.good,
      final: true,
      pass: slot.pass,
    });
  }

  /** Count a final group result. */
  private tally(slot: Slot, outcome: Outcome, deltaSec: number | null): void {
    const n = slot.t.noteIds.length;
    const hit = isHit(outcome);
    this.counts[outcome] += n;
    this.judgedNotes += n;
    if (hit) this.hitNotes += n;
    if (deltaSec !== null) addToHistogram(this.histogram, toMs(deltaSec));
    if (slot.t.section >= 0) {
      const s = this.sectionNotes.get(slot.t.section) ?? { notes: 0, hits: 0 };
      s.notes += n;
      if (hit) s.hits += n;
      this.sectionNotes.set(slot.t.section, s);
    }
    this.finals.push({ key: slot.key, hit });
  }

  private judgement(slot: Slot, a: Assignment, final: boolean): Judgement {
    const j: Judgement = {
      noteIds: [...slot.t.noteIds],
      outcome: a.outcome,
      deltaMs: toMs(a.deltaSec),
      timing: timingLabelFor(a.deltaSec, this.windows),
      expectedMidi: a.expectedMidi,
      chord: slot.t.chord,
      songTime: slot.t.time,
      ctxTime: a.ctxTime,
      final,
      pass: slot.pass,
      source: a.source,
    };
    if (a.playedMidi !== undefined) j.playedMidi = a.playedMidi;
    return j;
  }

  private stray(ev: InputEvent, out: JudgeOutput): void {
    this.strays++;
    const s: StrayEvent = { ctxTime: ev.ctxTime, songTime: this.clock.songTimeAt(ev.ctxTime), source: ev.source };
    if (ev.midi !== undefined) s.midi = ev.midi;
    out.strays.push(s);
  }

  private remove(slot: Slot): void {
    const i = this.active.indexOf(slot);
    if (i >= 0) this.active.splice(i, 1);
  }

  private summary(): RunSummary {
    const accuracy = accuracyOf(this.hitNotes, this.judgedNotes);
    const ordered = [...this.finals].sort((a, b) => a.key - b.key);
    const maxMisses = longestRun(ordered.map((f) => !f.hit));
    const sections: SectionRunStat[] = [...this.sectionNotes.entries()]
      .filter(([idx]) => idx < this.sectionCount)
      .sort(([a], [b]) => a - b)
      .map(([idx, s]) => ({ idx, notes: s.notes, hits: s.hits, accuracy: accuracyOf(s.hits, s.notes) }));
    let weakest: SectionRunStat | null = null;
    for (const s of sections) if (weakest === null || s.accuracy < weakest.accuracy) weakest = s;
    return {
      score: this.score,
      accuracy,
      timingScore: this.hitGroups > 0 ? this.timingSum / this.hitGroups : 0,
      stars: starsFor(accuracy),
      maxCombo: this.combo.maxCombo,
      counts: { ...this.counts },
      judgedNotes: this.judgedNotes,
      histogram: { ...this.histogram, bins: [...this.histogram.bins] },
      sections,
      weakestSection: weakest?.idx ?? null,
      clean: this.judgedNotes > 0 && isCleanRun(accuracy, maxMisses),
      lenientChordNotes: this.lenientChordNotes,
      strays: this.strays,
    };
  }
}

/** Candidate order: better pitch rank, then smaller bias-corrected distance, then earlier note. */
function better(a: Candidate, aRank: number, b: Candidate, bRank: number): boolean {
  if (aRank !== bRank) return aRank < bRank;
  if (Math.abs(a.cost - b.cost) > TIME_EPS_SEC) return a.cost < b.cost;
  return a.slot.key < b.slot.key;
}

function pickBest(cands: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const c of cands) if (best === null || better(c, 0, best, 0)) best = c;
  return best;
}

/** Nearest candidate without any assignment yet (a WrongNote target). */
function nearestUnassigned(cands: readonly Candidate[]): Candidate | null {
  return pickBest(cands.filter((c) => c.slot.assignment === null));
}

/** Seconds → milliseconds rounded to 1 µs (drops float noise such as 35.000000000014). */
function toMs(sec: number): number {
  return Math.round(sec * 1e6) / 1000;
}

function clamp(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}
