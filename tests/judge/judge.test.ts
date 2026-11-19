import { describe, expect, it } from 'vitest';
import type { InputEvent, Judge, JudgeOutput, Judgement, Outcome, StrayEvent } from '@shared/judge';
import { createJudge } from '@core/judge';
import { INPUT_LAG_SEC, WINDOWS } from '@core/judge/constants';
import { TestClock, finals, makeSong, onset, pitchChange, unpitched } from './helpers';

/** Collects every judgement/stray a judge emits. */
class Recorder {
  judgements: Judgement[] = [];
  strays: StrayEvent[] = [];
  constructor(readonly judge: Judge) {}
  push(ev: InputEvent): JudgeOutput {
    return this.take(this.judge.push(ev));
  }
  advance(now: number): JudgeOutput {
    return this.take(this.judge.advance(now));
  }
  private take(out: JudgeOutput): JudgeOutput {
    this.judgements.push(...out.judgements);
    this.strays.push(...out.strays);
    return out;
  }
  final(noteId: number): Judgement | undefined {
    return finals(this.judgements).get(noteId);
  }
}

const E4 = 64;
const G4 = 67;

describe('timing windows at the exact edges (real seconds, any speed)', () => {
  // Δ in ms → expected outcome and early/late label. ±121 ms is outside every window: the onset is a
  // stray and the note becomes a Miss when its window closes.
  const table: [number, Outcome, 'early' | 'late' | null][] = [
    [0, 'Perfect', null],
    [35, 'Perfect', null],
    [-35, 'Perfect', null],
    [36, 'Great', null],
    [-36, 'Great', null],
    [70, 'Great', null],
    [-70, 'Great', null],
    [71, 'Good', 'late'],
    [-71, 'Good', 'early'],
    [120, 'Good', 'late'],
    [-120, 'Good', 'early'],
    [121, 'Miss', null],
    [-121, 'Miss', null],
  ];
  // Anchors with awkward floats so Δ carries rounding noise; speeds stretch song time but not windows.
  const clocks: [string, () => TestClock][] = [
    ['100%', () => new TestClock(1234.5678, 0, 1)],
    ['50%', () => new TestClock(987.6543, -1.3, 0.5)],
    ['40%', () => new TestClock(3.1, 0.7, 0.4)],
    ['110%', () => new TestClock(77.77, 0.2, 1.1)],
  ];
  for (const [label, makeClock] of clocks) {
    it.each(table)(`speed ${label}: Δ %d ms → %s (%s)`, (deltaMs, outcome, timing) => {
      const clock = makeClock();
      const song = makeSong([{ time: 3, midi: E4 }]);
      const rec = new Recorder(createJudge(song, { clock }));
      const target = clock.ctxTimeAt(3);
      rec.push(onset(target + deltaMs / 1000, E4));
      rec.advance(target + 1);
      const j = rec.final(0);
      expect(j?.outcome).toBe(outcome);
      expect(j?.timing).toBe(timing);
      if (outcome === 'Miss') {
        expect(rec.strays).toHaveLength(1);
        expect(j?.deltaMs).toBeNull();
      } else {
        expect(j?.deltaMs).toBeCloseTo(deltaMs, 6);
        expect(rec.strays).toHaveLength(0);
      }
    });
  }

  it('custom windows from the config are honoured', () => {
    const clock = new TestClock();
    const rec = new Recorder(
      createJudge(makeSong([{ time: 1, midi: E4 }]), { clock, windows: { perfect: 0.01, great: 0.02, good: 0.03 } }),
    );
    rec.push(onset(1.025, E4));
    expect(rec.final(0)?.outcome).toBe('Good');
  });

  it('the window closes (Miss) only once now > target + Good', () => {
    const clock = new TestClock(500.25, 0, 0.5);
    const rec = new Recorder(createJudge(makeSong([{ time: 2, midi: E4 }]), { clock }));
    const target = clock.ctxTimeAt(2);
    expect(rec.advance(target + WINDOWS.good).judgements).toHaveLength(0);
    const out = rec.advance(target + WINDOWS.good + 0.0001);
    expect(out.judgements).toHaveLength(1);
    expect(out.judgements[0]).toMatchObject({ outcome: 'Miss', final: true, deltaMs: null, noteIds: [0], expectedMidi: E4 });
    expect(out.judgements[0]?.ctxTime).toBeCloseTo(target + WINDOWS.good, 9);
  });
});

describe('pitch judgement', () => {
  it('wrong pitch in the window is a provisional WrongNote, final when the window closes', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }]), { clock }));
    const out = rec.push(onset(1.08, G4));
    expect(out.judgements[0]).toMatchObject({ outcome: 'WrongNote', final: false, playedMidi: G4, expectedMidi: E4, timing: 'late' });
    expect(rec.judge.state().judgedNotes).toBe(0);
    rec.advance(1.2);
    expect(rec.final(0)).toMatchObject({ outcome: 'WrongNote', final: true, playedMidi: G4 });
    expect(rec.judge.state().counts.WrongNote).toBe(1);
    expect(rec.judge.state().accuracy).toBe(0);
  });

  it('a provisional WrongNote upgrades to a hit when the right pitch arrives in the window', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }]), { clock }));
    rec.push(onset(0.95, G4));
    const out = rec.push(onset(1.01, E4));
    expect(out.judgements[0]).toMatchObject({ outcome: 'Perfect', final: true });
    rec.advance(2);
    const st = rec.judge.state();
    expect(st.counts).toMatchObject({ Perfect: 1, WrongNote: 0, Miss: 0 });
    expect(st.accuracy).toBe(100);
    expect(rec.judgements.filter((j) => j.final)).toHaveLength(1);
  });

  it('pitch within ±50 cents matches; the detected cents are taken into account', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }, { time: 2, midi: E4 }]), { clock }));
    rec.push(onset(1, 63, { cents: 50 }));
    rec.push(onset(2, 63, { cents: 40 }));
    rec.advance(3);
    expect(rec.final(0)?.outcome).toBe('Perfect');
    expect(rec.final(1)?.outcome).toBe('WrongNote');
  });

  it.each([
    [false, 52, 'Perfect'],
    [false, 76, 'Perfect'],
    [false, 40, 'WrongNote'],
    [true, 52, 'WrongNote'],
    [true, 76, 'WrongNote'],
    [true, 64, 'Perfect'],
  ] as const)('octave tolerance (strictOctave=%s): played %d for E4 → %s', (strictOctave, played, outcome) => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }]), { clock, strictOctave }));
    rec.push(onset(1, played));
    rec.advance(2);
    expect(rec.final(0)?.outcome).toBe(outcome);
    expect(rec.final(0)?.expectedMidi).toBe(E4);
  });

  it('an exact match beats a nearer octave match', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: 52 }, { time: 1.1, midi: E4, string: 2 }]), { clock }));
    rec.push(onset(1.04, E4));
    expect(rec.final(1)?.outcome).toBe('Great');
    expect(rec.final(0)).toBeUndefined();
  });

  it('dead notes match any pitched or unpitched onset', () => {
    const clock = new TestClock();
    const song = makeSong([
      { time: 1, midi: 50, tech: { dead: true } },
      { time: 2, midi: 50, tech: { dead: true } },
    ]);
    const rec = new Recorder(createJudge(song, { clock }));
    rec.push(onset(1.01, 77));
    rec.push(unpitched(2.02));
    rec.advance(3);
    expect(rec.final(0)?.outcome).toBe('Perfect');
    expect(rec.final(1)?.outcome).toBe('Perfect');
    expect(rec.final(1)?.playedMidi).toBeUndefined();
  });

  it('a bent note accepts any pitch up to its bend target', () => {
    const clock = new TestClock();
    const song = makeSong([
      { time: 1, midi: 62, tech: { bend: { semitones: 2 } } },
      { time: 2, midi: 62, tech: { bend: { semitones: 2 } } },
    ]);
    const rec = new Recorder(createJudge(song, { clock, strictOctave: true }));
    rec.push(onset(1, 64));
    rec.push(onset(2, 65));
    rec.advance(3);
    expect(rec.final(0)?.outcome).toBe('Perfect');
    expect(rec.final(1)?.outcome).toBe('WrongNote');
  });
});

describe('unpitched onsets and follow-up pitches', () => {
  it('an unpitched onset waits for its follow-up pitch and is judged at the onset time', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }]), { clock }));
    expect(rec.push(unpitched(1.05)).judgements).toHaveLength(0);
    rec.advance(1.07);
    expect(rec.judgements).toHaveLength(0);
    rec.push(onset(1.05, E4, { refines: 1.05 }));
    expect(rec.final(0)).toMatchObject({ outcome: 'Great', deltaMs: 50 });
  });

  it('without a follow-up within 40 ms it counts as WrongNote', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }]), { clock }));
    rec.push(unpitched(1));
    rec.advance(1.039);
    expect(rec.judgements).toHaveLength(0);
    rec.advance(1.04);
    expect(rec.judgements[0]).toMatchObject({ outcome: 'WrongNote', final: false });
    expect(rec.judgements[0]?.playedMidi).toBeUndefined();
    rec.advance(2);
    expect(rec.final(0)?.outcome).toBe('WrongNote');
  });

  it('a late follow-up only completes the judgement its own onset got (one onset, one note)', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }, { time: 1.1, midi: G4, string: 2 }]), { clock }));
    rec.push(unpitched(1));
    rec.advance(1.05); // times out → WrongNote on note 0
    rec.push(onset(1, G4, { refines: 1 })); // G4 would fit note 1, but this onset already belongs to note 0
    rec.push(onset(1.002, E4, { refines: 1.002 })); // no pending onset: treated as a fresh onset
    rec.advance(2);
    expect(rec.final(0)?.outcome).toBe('Perfect');
    expect(rec.final(0)?.deltaMs).toBeCloseTo(2, 6);
    expect(rec.final(1)?.outcome).toBe('Miss');
  });

  it('a window does not close while an unpitched onset inside it is still pending', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }]), { clock }));
    rec.push(unpitched(1.11));
    rec.advance(1.125);
    expect(rec.judgements).toHaveLength(0);
    rec.push(onset(1.11, E4, { refines: 1.11 }));
    expect(rec.final(0)?.outcome).toBe('Good');
  });

  it('an unpitched onset with no candidate is a stray immediately', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }]), { clock }));
    expect(rec.push(unpitched(0.5)).strays).toHaveLength(1);
  });
});

describe('chords, legato, retrigger guard and strays', () => {
  it('chord leniency: one onset matching any chord tone hits every note of the group', () => {
    const clock = new TestClock();
    const song = makeSong([
      { time: 1, midi: 45, string: 5, chordId: 1 },
      { time: 1, midi: 52, string: 4, chordId: 1 },
      { time: 1.004, midi: 57, string: 3, chordId: 1 },
    ]);
    const rec = new Recorder(createJudge(song, { clock }));
    const out = rec.push(onset(1.01, 52));
    expect(out.judgements).toHaveLength(1);
    expect(out.judgements[0]).toMatchObject({ outcome: 'Perfect', chord: true, expectedMidi: 52, final: true });
    expect([...(out.judgements[0]?.noteIds ?? [])].sort()).toEqual([0, 1, 2]);
    const st = rec.judge.state();
    expect(st.counts.Perfect).toBe(3);
    expect(st.judgedNotes).toBe(3);
    expect(st.combo).toBe(1);
    expect(st.score).toBe(100);
    expect(st.lenientChordNotes).toBe(3);
  });

  it('a missed chord is one Miss group with every note counted and the lowest tone expected', () => {
    const clock = new TestClock();
    const song = makeSong([
      { time: 1, midi: 52, string: 4, chordId: 1 },
      { time: 1, midi: 45, string: 5, chordId: 1 },
    ]);
    const rec = new Recorder(createJudge(song, { clock }));
    rec.advance(2);
    expect(rec.judgements).toHaveLength(1);
    expect(rec.judgements[0]).toMatchObject({ outcome: 'Miss', chord: true, expectedMidi: 45 });
    expect(rec.judge.state().counts.Miss).toBe(2);
  });

  it('legato destinations accept a pitch-change; other notes ignore it', () => {
    const clock = new TestClock();
    const song = makeSong([
      { time: 1, midi: 62, tech: { hammerOn: true } },
      { time: 1.25, midi: E4, tech: { legatoDest: true } },
      { time: 2, midi: 62 },
    ]);
    const rec = new Recorder(createJudge(song, { clock }));
    rec.push(onset(1, 62));
    const legato = rec.push(pitchChange(1.26, E4));
    expect(legato.judgements[0]).toMatchObject({ outcome: 'Perfect', noteIds: [1] });
    const plain = rec.push(pitchChange(2.0, 62));
    expect(plain.judgements).toHaveLength(0);
    expect(plain.strays).toHaveLength(0);
    const wrong = rec.push(pitchChange(2.3, 70));
    expect(wrong.judgements).toHaveLength(0);
    rec.advance(3);
    expect(rec.final(2)?.outcome).toBe('Miss');
  });

  it('a legato destination may also be picked', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4, tech: { legatoDest: true } }]), { clock }));
    rec.push(onset(1, E4));
    expect(rec.final(0)?.outcome).toBe('Perfect');
  });

  it('retrigger guard: a double trigger right after a hit is ignored, not a WrongNote or stray', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }, { time: 1.12, midi: E4 }]), { clock }));
    rec.push(onset(1, E4));
    const dbl = rec.push(onset(1.02, E4));
    expect(dbl.judgements).toHaveLength(0);
    expect(dbl.strays).toHaveLength(0);
    const dblOther = rec.push(onset(1.03, 70));
    expect(dblOther.judgements).toHaveLength(0);
    expect(dblOther.strays).toHaveLength(0);
    rec.push(onset(1.12, E4));
    rec.advance(2);
    expect(rec.final(0)?.outcome).toBe('Perfect');
    expect(rec.final(1)?.outcome).toBe('Perfect');
  });

  it('retrigger guard does not swallow a fast tremolo the song asks for (45 ms apart)', () => {
    const clock = new TestClock();
    const times = Array.from({ length: 12 }, (_, i) => 1 + i * 0.045);
    const rec = new Recorder(createJudge(makeSong(times.map((time) => ({ time, midi: E4 }))), { clock }));
    for (const t of times) rec.push(onset(t + 0.004, E4));
    rec.advance(3);
    for (let i = 0; i < times.length; i++) expect(rec.final(i)?.outcome).toBe('Perfect');
  });

  it('strays: no candidate → reported with song time, not penalised, combo kept', () => {
    const clock = new TestClock(10, 0, 0.5);
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }, { time: 3, midi: E4 }]), { clock }));
    rec.push(onset(clock.ctxTimeAt(1), E4));
    const out = rec.push(onset(clock.ctxTimeAt(2), G4));
    expect(out.strays).toEqual([{ ctxTime: clock.ctxTimeAt(2), songTime: 2, midi: G4, source: 'test' }]);
    expect(rec.judge.state()).toMatchObject({ combo: 1, judgedNotes: 1 });
    rec.push(onset(clock.ctxTimeAt(3), E4));
    expect(rec.judge.state().combo).toBe(2);
    expect(rec.judge.finish(clock.ctxTimeAt(5)).strays).toBe(1);
  });

  it('an extra onset when every candidate is already taken is a stray', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }]), { clock }));
    rec.push(onset(0.95, G4));
    expect(rec.push(onset(1.09, 70)).strays).toHaveLength(1);
  });
});

describe('assignment: one onset per note, dense passages', () => {
  it('one onset cannot satisfy two notes', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }, { time: 1.06, midi: E4 }]), { clock }));
    rec.push(onset(1.03, E4));
    rec.advance(2);
    expect(rec.final(0)?.outcome).toBe('Perfect');
    expect(rec.final(1)?.outcome).toBe('Miss');
  });

  it('greedy: the pitch-matching candidate wins over a nearer wrong-pitch one', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: G4 }, { time: 1.1, midi: E4 }]), { clock }));
    rec.push(onset(1.04, E4));
    expect(rec.final(1)?.outcome).toBe('Great');
    expect(rec.final(0)).toBeUndefined();
  });

  it('an exact tie in distance goes to the earlier note', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 2, midi: E4 }, { time: 2.1, midi: E4 }]), { clock }));
    rec.push(onset(2.05, E4));
    expect(rec.final(0)?.deltaMs).toBeCloseTo(50, 6);
    expect(rec.final(1)).toBeUndefined();
  });

  it('a skipped note is a Miss and the next note is judged on time', () => {
    const clock = new TestClock();
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }, { time: 1.11, midi: E4 }]), { clock }));
    rec.push(onset(1.11, E4));
    rec.advance(2);
    expect(rec.final(0)?.outcome).toBe('Miss');
    expect(rec.final(1)?.outcome).toBe('Perfect');
  });

  // A player's lateness is consistent across a phrase: the lead-in notes (0.5 s apart) set the
  // timing bias that keeps the dense part aligned. Plain nearest-onset matching would shift every
  // onset onto the following note.
  it('fast trill played consistently 65 ms late keeps every onset on its own note', () => {
    const clock = new TestClock();
    const times = [0, 0.5, ...Array.from({ length: 16 }, (_, i) => 1 + i * 0.06)];
    const song = makeSong(times.map((time, i) => ({ time, midi: i % 2 === 0 ? E4 : 65 })));
    const rec = new Recorder(createJudge(song, { clock }));
    times.forEach((t, i) => {
      rec.push(onset(t + 0.065, i % 2 === 0 ? E4 : 65));
      rec.advance(t + 0.065 - 0.12);
    });
    rec.advance(4);
    const outcomes = times.map((_, i) => rec.final(i)?.outcome);
    expect(outcomes.every((o) => o === 'Great')).toBe(true);
  });

  it('tremolo (94 ms apart) played consistently 55 ms late stays aligned', () => {
    const clock = new TestClock();
    const times = [0, 0.5, ...Array.from({ length: 16 }, (_, i) => 1 + i * 0.094)];
    const rec = new Recorder(createJudge(makeSong(times.map((time) => ({ time, midi: E4 }))), { clock }));
    for (const t of times) {
      rec.push(onset(t + 0.055, E4));
      rec.advance(t + 0.055 - 0.12);
    }
    rec.advance(4);
    expect(times.map((_, i) => rec.final(i)?.outcome).every((o) => o === 'Great')).toBe(true);
  });
});

describe('count-in, pre-roll, loops and passes', () => {
  it('notes before judgeFrom (count-in / start position) are not judged; onsets there are strays', () => {
    const clock = new TestClock(0, -2, 1);
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }, { time: 3, midi: E4 }]), { clock, judgeFrom: 2 }));
    const out = rec.push(onset(clock.ctxTimeAt(1), E4));
    expect(out.strays).toHaveLength(1);
    rec.advance(clock.ctxTimeAt(4));
    expect(rec.judgements.map((j) => j.noteIds[0])).toEqual([1]);
    expect(rec.judge.state().judgedNotes).toBe(1);
  });

  it('only notes inside the loop region are judged, pass after pass, with tallies kept', () => {
    // Loop bars 1–2 (2 s … 4 s) with a 1-bar pre-roll; notes at 1.0 (pre-roll), 2.0, 3.9, 4.5 (after B).
    const song = makeSong([{ time: 1, midi: E4 }, { time: 2, midi: E4 }, { time: 3.9, midi: G4 }, { time: 4.5, midi: E4 }], { bars: 4 });
    const region = { start: 2, end: 4 };
    // Pass 0 starts at ctx 100 at song time 0 (A − pre-roll).
    const clock = new TestClock(100, 0, 1);
    const rec = new Recorder(createJudge(song, { clock, judgeFrom: 2, region }));
    expect(rec.push(onset(101, E4)).strays).toHaveLength(1); // pre-roll note: not judged
    rec.push(onset(102.01, E4));
    rec.advance(103.85);
    // Wrap at ctx 104 (B): the transport re-anchors before B is reached, then the session starts pass 1.
    clock.anchorCtx = 104;
    clock.anchorSong = 0;
    rec.judge.startPass({ pass: 1 });
    rec.push(onset(103.95, G4)); // pass-0 note at 3.9 is still open with its frozen target (ctx 103.9)
    rec.advance(105.5);
    rec.push(onset(106.0, E4)); // pass 1, note at 2.0 → ctx 106
    rec.advance(108.2); // closes pass-1 note 3.9 (ctx 107.9) as a Miss
    const passes = rec.judgements.filter((j) => j.final).map((j) => [j.pass, j.noteIds[0], j.outcome]);
    expect(passes).toEqual([
      [0, 1, 'Perfect'],
      [0, 2, 'Great'],
      [1, 1, 'Perfect'],
      [1, 2, 'Miss'],
    ]);
    expect(rec.judgements.some((j) => j.noteIds.includes(3) || j.noteIds.includes(0))).toBe(false);
    const st = rec.judge.state();
    expect(st.judgedNotes).toBe(4);
    expect(st.counts).toMatchObject({ Perfect: 2, Great: 1, Miss: 1 });
  });

  it('startPass can change the region and judgeFrom', () => {
    const song = makeSong([{ time: 1, midi: E4 }, { time: 3, midi: E4 }], { bars: 2 });
    const clock = new TestClock();
    const rec = new Recorder(createJudge(song, { clock, region: { start: 0, end: 2 } }));
    rec.advance(2);
    clock.anchorCtx = 10;
    clock.anchorSong = 2;
    rec.judge.startPass({ pass: 1, region: { start: 2, end: 4 }, judgeFrom: 2 });
    rec.push(onset(11, E4));
    expect(rec.final(1)).toMatchObject({ outcome: 'Perfect', pass: 1 });
    expect(rec.final(0)).toMatchObject({ outcome: 'Miss', pass: 0 });
  });

  it('startPass with the current pass number only updates judgeFrom/region for the rest of the pass', () => {
    const song = makeSong([{ time: 1, midi: E4 }, { time: 2, midi: E4 }, { time: 3, midi: E4 }, { time: 5, midi: E4 }], { bars: 3 });
    const clock = new TestClock();
    const rec = new Recorder(createJudge(song, { clock, region: { start: 0, end: 2.5 } }));
    rec.push(onset(1, E4));
    rec.advance(1.95); // note 2 is open
    rec.judge.startPass({ pass: 0, region: { start: 0, end: 4 } });
    rec.push(onset(2, E4));
    rec.push(onset(3, E4));
    rec.advance(6);
    expect(rec.judgements.filter((j) => j.final).map((j) => [j.pass, j.songTime, j.outcome])).toEqual([
      [0, 1, 'Perfect'],
      [0, 2, 'Perfect'],
      [0, 3, 'Perfect'],
    ]);
  });

  it('follows speed changes live and freezes nothing while paused', () => {
    const song = makeSong([{ time: 1, midi: E4 }, { time: 2, midi: E4 }, { time: 3, midi: E4 }]);
    const clock = new TestClock(0, 0, 1);
    const rec = new Recorder(createJudge(song, { clock }));
    rec.push(onset(1, E4));
    // Pause at ctx 1.5 (song 1.5) for 10 s: the mapping is degenerate (speed 0).
    clock.reanchor(1.5, 0);
    rec.advance(5);
    rec.advance(11);
    expect(rec.judgements.filter((j) => j.outcome === 'Miss')).toHaveLength(0);
    // Resume at ctx 11.5 at 50 %: song 2.0 is reached at ctx 12.5, song 3.0 at 14.5.
    clock.anchorCtx = 11.5;
    clock.speed = 0.5;
    rec.push(onset(12.5 + 0.036, E4));
    rec.push(onset(14.5 - 0.071, E4));
    rec.advance(20);
    expect(rec.final(1)).toMatchObject({ outcome: 'Great' });
    expect(rec.final(2)).toMatchObject({ outcome: 'Good', timing: 'early' });
  });
});

describe('finish (R1-C-07)', () => {
  it('finalises reached notes and open WrongNotes; notes not yet reached stay unjudged', () => {
    const clock = new TestClock();
    const song = makeSong([{ time: 1, midi: E4 }, { time: 2, midi: E4 }, { time: 2.06, midi: G4 }, { time: 2.1, midi: E4 }]);
    const rec = new Recorder(createJudge(song, { clock }));
    rec.advance(2.03); // notes 1, 2.0 reached; 2.06 and 2.1 are open but ahead
    rec.push(onset(2.03, 50)); // wrong pitch: provisional WrongNote on the nearest open note (2.0)
    const summary = rec.judge.finish(2.03);
    expect(summary.counts).toMatchObject({ Miss: 1, WrongNote: 1, Perfect: 0 });
    expect(summary.judgedNotes).toBe(2);
    expect(rec.judge.state().judgedNotes).toBe(2);
  });
});

describe('guitar latency offset', () => {
  it('the guitar input lag covers pitch settle + the longest analysis window + a quantum at 44.1 kHz + delivery (R1-C-09)', () => {
    expect(INPUT_LAG_SEC.guitar).toBeGreaterThanOrEqual(0.025 + 2048 / 44100 + 128 / 44100 + 0.03);
  });

  it('a guitar onset arriving inputOffset late is judged on time after calibration', async () => {
    const { analysisToInputEvent } = await import('@core/judge');
    const sampleRate = 48000;
    const inputOffsetMs = 42;
    const clock = new TestClock(0, 0, 0.7);
    const rec = new Recorder(createJudge(makeSong([{ time: 1, midi: E4 }]), { clock }));
    const target = clock.ctxTimeAt(1);
    // The pluck reaches the worklet 42 ms after the player played on the (heard) beat.
    const frame = Math.round((target + inputOffsetMs / 1000) * sampleRate);
    const ev = analysisToInputEvent({ type: 'onset', frame, midi: E4, cents: 0, clarity: 0.9, rmsDb: -20 }, sampleRate, inputOffsetMs);
    expect(ev).not.toBeNull();
    rec.push(ev as InputEvent);
    expect(rec.final(0)?.outcome).toBe('Perfect');
    expect(Math.abs(rec.final(0)?.deltaMs ?? 99)).toBeLessThan(0.03);
  });
});
