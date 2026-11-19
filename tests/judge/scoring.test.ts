import { describe, expect, it } from 'vitest';
import type { InputEvent, Judgement } from '@shared/judge';
import {
  analysisToInputEvent,
  createJudge,
  frameToEventCtx,
  gradeFor,
  inputHorizon,
  keyboardEventCtx,
  multiplierFor,
  passStats,
  starsFor,
  timingLabelFor,
} from '@core/judge';
import { INPUT_LAG_SEC, WINDOWS } from '@core/judge/constants';
import { TestClock, makeSong, onset } from './helpers';

const E4 = 64;

describe('multiplier, stars, grades', () => {
  it.each([
    [0, 1], [9, 1], [10, 2], [19, 2], [20, 3], [29, 3], [30, 4], [500, 4],
  ] as const)('combo %d → ×%d', (combo, mult) => {
    expect(multiplierFor(combo)).toBe(mult);
  });

  it.each([
    [0, 0], [49.99, 0], [50, 1], [69.9, 1], [70, 2], [80, 3], [89.99, 3], [90, 4], [96.99, 4], [97, 5], [100, 5],
  ] as const)('accuracy %d%% → %d stars', (acc, stars) => {
    expect(starsFor(acc)).toBe(stars);
  });

  it.each([
    [0.035, 'Perfect', null], [0.036, 'Great', null], [0.07, 'Great', null], [0.071, 'Good', 'late'],
    [-0.071, 'Good', 'early'], [0.12, 'Good', 'late'], [0.121, null, 'late'],
  ] as const)('Δ %d s → %s / %s', (delta, grade, label) => {
    expect(gradeFor(delta, WINDOWS)).toBe(grade);
    expect(timingLabelFor(delta, WINDOWS)).toBe(label);
  });
});

/** A song of `n` notes, one per 0.5 s from t = 1. */
const stream = (n: number, sections?: [string, number, number][]) =>
  makeSong(Array.from({ length: n }, (_, i) => ({ time: 1 + i * 0.5, midi: E4 })), sections ? { sections } : {});

describe('combo, score, accuracy, timing score', () => {
  it('score = Σ base × multiplier at the moment of the hit (×2 from the 11th consecutive hit)', () => {
    const clock = new TestClock();
    const judge = createJudge(stream(12), { clock });
    for (let i = 0; i < 12; i++) judge.push(onset(1 + i * 0.5, E4));
    const st = judge.state();
    expect(st.combo).toBe(12);
    expect(st.multiplier).toBe(2);
    expect(st.score).toBe(10 * 100 + 2 * 200);
  });

  it('WrongNote and Miss reset the combo; strays do not', () => {
    const clock = new TestClock();
    const judge = createJudge(stream(6), { clock });
    judge.push(onset(1, E4));
    judge.push(onset(1.5, E4));
    judge.push(onset(1.75, 70)); // stray between notes
    expect(judge.state().combo).toBe(2);
    judge.push(onset(2, 70)); // WrongNote
    expect(judge.state().combo).toBe(0);
    judge.push(onset(2.5, E4));
    judge.advance(3.2); // note at 3.0 missed
    expect(judge.state()).toMatchObject({ combo: 0, maxCombo: 2 });
  });

  it('combo is kept in note order: a Miss closing after a later hit does not erase that hit', () => {
    const clock = new TestClock();
    const judge = createJudge(makeSong([{ time: 1, midi: E4 }, { time: 1.06, midi: 67 }, { time: 1.5, midi: E4 }]), { clock });
    judge.push(onset(0.5, 70)); // stray, nothing open yet
    judge.push(onset(1.06, 67)); // note 1 hit while note 0 is still open
    expect(judge.state().combo).toBe(1);
    judge.advance(1.13); // note 0 closes as a Miss
    expect(judge.state().combo).toBe(1);
    judge.push(onset(1.5, E4));
    expect(judge.state().combo).toBe(2);
  });

  it('accuracy counts every chord note; timing score averages 1 / 0.75 / 0.5 per hit', () => {
    const clock = new TestClock();
    const song = makeSong([
      { time: 1, midi: 45, string: 5, chordId: 1 },
      { time: 1, midi: 52, string: 4, chordId: 1 },
      { time: 2, midi: E4 },
      { time: 3, midi: E4 },
    ]);
    const judge = createJudge(song, { clock });
    judge.push(onset(1.05, 45)); // Great chord (2 notes)
    judge.push(onset(2.1, E4)); // Good
    judge.advance(4); // note at 3 Miss
    const st = judge.state();
    expect(st.judgedNotes).toBe(4);
    expect(st.accuracy).toBe(75);
    expect(st.timingScore).toBeCloseTo((0.75 + 0.5) / 2, 12);
    expect(st.counts).toEqual({ Perfect: 0, Great: 2, Good: 1, WrongNote: 0, Miss: 1 });
  });
});

describe('run summary', () => {
  it('histogram, per-section stats, weakest section, stars and clean flag', () => {
    const clock = new TestClock();
    // 8 notes in section A (bars 0–1), 8 in section B (bars 2–3).
    const song = makeSong(
      Array.from({ length: 16 }, (_, i) => ({ time: i < 8 ? 0.2 + i * 0.45 : 4.2 + (i - 8) * 0.45, midi: E4 })),
      { sections: [['A', 0, 2], ['B', 2, 4]], bars: 4 },
    );
    const judge = createJudge(song, { clock });
    const deltas = [0, 0.012, -0.02, 0.04, -0.05, 0.08, -0.1, 0.119];
    song.notes.slice(0, 8).forEach((n, i) => judge.push(onset(n.time + (deltas[i] as number), E4)));
    song.notes.slice(8, 15).forEach((n) => judge.push(onset(n.time, E4)));
    const sum = judge.finish(10);
    expect(sum.judgedNotes).toBe(16);
    expect(sum.counts).toEqual({ Perfect: 10, Great: 2, Good: 3, WrongNote: 0, Miss: 1 });
    expect(sum.accuracy).toBeCloseTo(93.75, 10);
    expect(sum.stars).toBe(4);
    expect(sum.clean).toBe(true);
    expect(sum.sections).toEqual([
      { idx: 0, notes: 8, hits: 8, accuracy: 100 },
      { idx: 1, notes: 8, hits: 7, accuracy: 87.5 },
    ]);
    expect(sum.weakestSection).toBe(1);
    expect(sum.histogram.binMs).toBe(10);
    expect(sum.histogram.minMs).toBe(-120);
    expect(sum.histogram.bins).toHaveLength(24);
    expect(sum.histogram.bins.reduce((a, b) => a + b, 0)).toBe(15);
    expect(sum.histogram.bins[12]).toBe(8); // [0, 10) ms: eight on-time hits
    expect(sum.histogram.bins[13]).toBe(1); // +12 ms
    expect(sum.histogram.bins[2]).toBe(1); // −100 ms
    expect(sum.histogram.bins[23]).toBe(1); // +119 ms
    expect(sum.histogram.bins[0]).toBe(0);
    expect(sum.maxCombo).toBe(15);
  });

  it('three non-hits in a row make a run unclean even at ≥ 90 % accuracy', () => {
    const clock = new TestClock();
    const song = stream(30);
    const judge = createJudge(song, { clock });
    song.notes.forEach((n, i) => {
      if (i >= 10 && i < 13) return;
      judge.push(onset(n.time, E4));
    });
    const sum = judge.finish(20);
    expect(sum.accuracy).toBe(90);
    expect(sum.clean).toBe(false);
  });

  it('two non-hits in a row at 90 % is clean; an empty run is not', () => {
    const clock = new TestClock();
    const song = stream(20);
    const judge = createJudge(song, { clock });
    song.notes.forEach((n, i) => {
      if (i === 5) judge.push(onset(n.time, 70));
      else if (i !== 6) judge.push(onset(n.time, E4));
    });
    const sum = judge.finish(20);
    expect(sum.accuracy).toBe(90);
    expect(sum.clean).toBe(true);
    expect(createJudge(song, { clock }).finish(0)).toMatchObject({ clean: false, judgedNotes: 0, accuracy: 0, stars: 0, weakestSection: null });
  });

  it('finish() finalises open windows and pending WrongNotes but leaves unreached notes unjudged', () => {
    const clock = new TestClock();
    const judge = createJudge(stream(4), { clock });
    judge.push(onset(1, E4));
    judge.push(onset(1.45, 70)); // provisional WrongNote on note 1 (window still open at 1.5)
    const sum = judge.finish(1.5);
    expect(sum.counts).toMatchObject({ Perfect: 1, WrongNote: 1, Miss: 0 });
    expect(sum.judgedNotes).toBe(2);
  });
});

describe('passStats', () => {
  it('uses the final judgement per note and filters by pass', () => {
    const base = { deltaMs: 0, timing: null, expectedMidi: E4, chord: false, ctxTime: 0, final: true } as const;
    const js: Judgement[] = [
      { ...base, noteIds: [0], outcome: 'Perfect', songTime: 1, pass: 0 },
      { ...base, noteIds: [1], outcome: 'WrongNote', songTime: 2, pass: 0, final: false },
      { ...base, noteIds: [1], outcome: 'Great', songTime: 2, pass: 0 },
      { ...base, noteIds: [0], outcome: 'Miss', songTime: 1, pass: 1, deltaMs: null },
      { ...base, noteIds: [1, 2], outcome: 'Good', songTime: 2, pass: 1, chord: true },
    ];
    expect(passStats(js, 0)).toEqual({ judgedNotes: 2, hitNotes: 2, accuracy: 100, maxConsecutiveMisses: 0, clean: true });
    expect(passStats(js, 1)).toMatchObject({ judgedNotes: 3, hitNotes: 2, maxConsecutiveMisses: 1, clean: false });
    expect(passStats(js).judgedNotes).toBe(5);
  });
});

describe('input timing helpers', () => {
  it('frame → calibrated ctx time; a follow-up pitch maps to exactly the onset time', () => {
    expect(frameToEventCtx(48000, 48000, 25)).toBeCloseTo(0.975, 12);
    const onsetEv = analysisToInputEvent({ type: 'onset', frame: 96123, midi: null, cents: 0, clarity: 0.3, rmsDb: -30 }, 48000, 31);
    const pitchEv = analysisToInputEvent({ type: 'pitch', frame: 97000, onsetFrame: 96123, midi: E4, cents: -12, clarity: 0.8 }, 48000, 31);
    expect(onsetEv).toEqual({ ctxTime: 96123 / 48000 - 0.031, kind: 'onset', clarity: 0.3, source: 'guitar' });
    expect(pitchEv?.refines).toBe(onsetEv?.ctxTime);
    expect(pitchEv).toMatchObject({ kind: 'onset', midi: E4, cents: -12 });
    const legato = analysisToInputEvent({ type: 'pitch-change', frame: 4800, midi: 66, cents: 3, clarity: 0.9 }, 48000, 0);
    expect(legato).toMatchObject({ kind: 'pitch-change', ctxTime: 0.1, midi: 66 });
    expect(analysisToInputEvent({ type: 'level', frame: 1, peakDb: -3, rmsDb: -9 }, 48000, 0)).toBeNull();
  });

  it('keyboard events map performance time onto the heard context time minus the keyboard offset', () => {
    expect(keyboardEventCtx(10_250, { contextTime: 5, performanceTime: 10_000 }, 30)).toBeCloseTo(5.22, 12);
  });

  it('input horizon subtracts the offset and the source pipeline lag', () => {
    expect(inputHorizon(10, 'guitar', 40)).toBeCloseTo(10 - 0.04 - INPUT_LAG_SEC.guitar, 12);
    expect(inputHorizon(10, 'guitar', -15)).toBeCloseTo(10 - INPUT_LAG_SEC.guitar, 12);
    expect(inputHorizon(10, 'keyboard', 20, 0.03)).toBeCloseTo(10 - 0.02 - INPUT_LAG_SEC.keyboard - 0.03, 12);
    expect(inputHorizon(10, 'test', 0)).toBe(10);
  });

  it('driving advance() with the horizon judges a late pluck that arrives after the window edge', () => {
    const clock = new TestClock();
    const judge = createJudge(makeSong([{ time: 1, midi: E4 }]), { clock });
    const offsetMs = 30;
    // Played 110 ms late; the message arrives ~70 ms after the pluck reaches the interface.
    const evCtx = 1.11;
    const arrivesAt = evCtx + offsetMs / 1000 + 0.07;
    expect(judge.advance(inputHorizon(arrivesAt - 0.005, 'guitar', offsetMs)).judgements).toHaveLength(0);
    const out = judge.push(onset(evCtx, E4, { source: 'guitar' }));
    expect(out.judgements[0]).toMatchObject({ outcome: 'Good', timing: 'late' });
  });
});

describe('determinism and performance', () => {
  /** 10k-note song and a deterministic event stream with hits, wrong notes, misses and strays. */
  function scenario() {
    const notes = Array.from({ length: 10_000 }, (_, i) => ({
      time: 1 + i * 0.09,
      midi: 52 + (i % 12),
      string: ((i % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6,
      ...(i % 50 === 0 ? { tech: { dead: true as const } } : {}),
    }));
    const song = makeSong(notes);
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const events: InputEvent[] = [];
    for (const n of song.notes) {
      const r = rand();
      if (r < 0.05) continue; // miss
      const midi = r < 0.1 ? n.midi + 1 : r < 0.12 ? n.midi - 12 : n.midi;
      events.push(onset(n.time + (rand() - 0.5) * 0.15, midi));
    }
    return { song, events };
  }

  function run() {
    const { song, events } = scenario();
    const judge = createJudge(song, { clock: new TestClock() });
    const log: unknown[] = [];
    const t0 = performance.now();
    for (const ev of events) {
      log.push(judge.push(ev));
      log.push(judge.advance(ev.ctxTime - 0.05));
    }
    const summary = judge.finish(2000);
    return { ms: performance.now() - t0, log, summary, count: events.length };
  }

  it('same input → identical judgements and summary', () => {
    const a = run();
    const b = run();
    expect(b.log).toEqual(a.log);
    expect(b.summary).toEqual(a.summary);
    expect(a.summary.judgedNotes).toBe(10_000);
  });

  it('10k events judged in < 50 ms', () => {
    run(); // warm-up (JIT)
    // Wall-clock budgets fail on a loaded machine (parallel suites): take the best of up to 12
    // runs, stopping at the first one under budget. A real regression is slow on every run.
    let best = Infinity;
    for (let i = 0; i < 12 && best >= 50; i++) best = Math.min(best, run().ms);
    expect(run().count).toBeGreaterThan(9000);
    expect(best).toBeLessThan(50);
  });
});
