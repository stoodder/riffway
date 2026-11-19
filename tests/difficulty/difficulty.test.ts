import { describe, expect, it } from 'vitest';
import type { DifficultyReport, Song, Tech, Tier } from '@shared/song';
import { analyzeDifficulty, tierName, tierOf } from '@core/difficulty';
import { onsetGroups } from '@core/model/onset-groups';
import { computePositions } from '@core/handpos';
import { chordLoad, peakWindowCount, stringSkipping, techniqueWeight } from '@core/difficulty/factors';
import { effectiveBpm, mergeSections } from '@core/difficulty/sections';
import { buildSong, line, odeToJoy, powerChordDrive, randomSpec, rng, type EventSpec, type SongSpec } from './song-builder';

const only = (report: DifficultyReport) => report.sections[0]!;

describe('worked example: Power Chord Drive (docs/difficulty.md)', () => {
  const report = analyzeDifficulty(powerChordDrive());
  const f = only(report).factors;

  it('measures every factor as the doc table says', () => {
    expect(f.density.measure).toBeCloseTo(4.0, 10); // 0.6·4.0 + 0.4·4.0
    expect(f.density.c).toBeCloseTo(3 / 4.5, 10);
    expect(f.tempo.measure).toBeCloseTo(120, 10);
    expect(f.tempo.c).toBeCloseTo(0.5, 10);
    expect(f.shifts.measure).toBeCloseTo(1.5, 10); // (3 + 5 + 4) / 8
    expect(f.shifts.c).toBeCloseTo(0.5, 10);
    expect(f.span.measure).toBe(2);
    expect(f.span.c).toBe(0);
    expect(f.skipping.measure).toBe(0);
    expect(f.techniques.measure).toBeCloseTo(0.4, 10);
    expect(f.techniques.c).toBeCloseTo(0.4, 10);
    expect(f.chords.measure).toBeCloseTo(2.0, 10);
    expect(f.chords.c).toBeCloseTo(2 / 3, 10);
    expect(f.density.weight * f.density.c).toBeCloseTo(0.233, 3);
    expect(f.chords.weight * f.chords.c).toBeCloseTo(0.033, 3);
  });

  it('rates 4.6, tier 5 (Intermediate)', () => {
    expect(only(report).raw).toBeCloseTo(0.402, 3);
    expect(only(report).rating).toBe(4.6);
    expect(report.rating).toBeCloseTo(4.6, 1);
    expect(Math.abs(report.rating - 4.6)).toBeLessThanOrEqual(0.05);
    expect(report.tier).toBe(5);
    expect(report.tierName).toBe('Intermediate');
    expect(report.provisional).toBe(false);
    expect(report.version).toBe(1);
  });

  it('derives skills and highlights', () => {
    expect(report.skills).toEqual(['chords', 'position-shifts']);
    expect(report.highlights).toEqual(['dense, fast notes', 'technique-heavy', 'fast position shifts']);
  });

  it('reuses passed positions instead of recomputing them', () => {
    const computed = computePositions(powerChordDrive());
    const flat = { cues: [], positions: computed.positions.map((p) => ({ ...p, lo: 5, hi: 8 })) };
    const noShifts = analyzeDifficulty(powerChordDrive(), { positions: flat });
    expect(only(noShifts).factors.shifts.measure).toBe(0);
    expect(noShifts.rating).toBe(4.2); // 1 + 9 × (0.4017 − 0.05)
  });
});

describe('Ode-to-Joy-like melody', () => {
  it('rates 1.5 ± 0.2, tier 2, with no skills', () => {
    const report = analyzeDifficulty(odeToJoy());
    expect(Math.abs(report.rating - 1.5)).toBeLessThanOrEqual(0.2);
    expect(report.tier).toBe(2);
    expect(report.tierName).toBe('Beginner');
    expect(only(report).raw).toBeCloseTo(0.05, 1);
    expect(only(report).factors.shifts.measure).toBe(0);
    expect(report.skills).toEqual([]);
    expect(report.highlights).toEqual([]);
  });
});

describe('tiers', () => {
  it('rounds and clamps ratings', () => {
    expect([1.0, 1.4, 1.5, 4.49, 9.6, 10, 0.2, 12].map(tierOf)).toEqual([1, 1, 2, 4, 10, 10, 1, 10]);
  });
  it('names the bands', () => {
    const names = ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as Tier[]).map(tierName);
    expect(names).toEqual([
      'Beginner', 'Beginner', 'Developing', 'Developing', 'Intermediate',
      'Intermediate', 'Advanced', 'Advanced', 'Expert', 'Expert',
    ]);
  });
});

describe('factor measures', () => {
  const groupsOf = (events: EventSpec[]) => onsetGroups(buildSong({ bpm: 60, events }));
  const factorsOf = (spec: SongSpec) => only(analyzeDifficulty(buildSong(spec))).factors;

  it('density: mean groups/s and a half-open 2 s peak window', () => {
    // 1 s apart at 60 BPM, then a burst of 4 eighths at 2 groups/s.
    expect(peakWindowCount(groupsOf(line([[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]], 0.5)))).toBe(4);
    expect(peakWindowCount(groupsOf(line([[1, 1], [1, 1], [1, 1]], 1)))).toBe(2);
    expect(peakWindowCount([])).toBe(0);
    // 8 quarter notes at 60 BPM over 8 s: D = 1, Dp = 2/2 → 0.6 + 0.4 = 1.0 → c = 0.
    const f = factorsOf({ bpm: 60, events: line(Array(8).fill([1, 1])), bars: 2 });
    expect(f.density.measure).toBeCloseTo(1.0, 10);
    expect(f.density.c).toBe(0);
  });

  it('tempo: duration-weighted mean of the tempo map', () => {
    const map = [{ time: 0, bpm: 60 }, { time: 4, bpm: 120 }];
    expect(effectiveBpm(map, 0, 8)).toBeCloseTo(90);
    expect(effectiveBpm(map, 2, 6)).toBeCloseTo(90);
    expect(effectiveBpm(map, 5, 7)).toBeCloseTo(120);
    expect(effectiveBpm([{ time: 2, bpm: 100 }], 0, 4)).toBeCloseTo(100);
    expect(effectiveBpm(map, 5, 5)).toBe(120);
    expect(effectiveBpm([], 0, 4)).toBe(120);
    expect(factorsOf({ bpm: 180, events: line([[1, 1]]) }).tempo.c).toBe(1);
  });

  it('shifts: fret distance of shifts per second', () => {
    // 4 bars at 60 BPM (16 s): positions 2 → 9 → 2 → 9 → Σ = 21.
    const events = [2, 9, 2, 9].flatMap((lo, bar) => line([[1, lo], [1, lo + 2], [2, lo], [2, lo + 2]], 1, bar * 4));
    const f = factorsOf({ bpm: 60, events });
    expect(f.shifts.measure).toBeCloseTo(21 / 16);
    expect(f.shifts.c).toBeCloseTo(21 / 16 / 3);
  });

  it('span: inside a chord or over 4 groups in one position, never across a shift', () => {
    expect(factorsOf({ bpm: 60, events: [{ at: 0, notes: [[6, 1], [5, 5]] }] }).span.measure).toBe(4);
    expect(factorsOf({ bpm: 60, events: line([[1, 7], [1, 9], [1, 11], [1, 8]]) }).span.measure).toBe(4);
    expect(factorsOf({ bpm: 60, events: line([[1, 7], [1, 9], [1, 11], [1, 8]]) }).span.c).toBeCloseTo(1 / 3);
    // Open strings and dead notes do not widen the span.
    expect(factorsOf({ bpm: 60, events: line([[1, 5], [1, 0], [1, 7], [1, 12, { dead: true }]]) }).span.measure).toBe(2);
    // 1,3 | 9,11: the only 4-group run crosses a shift.
    expect(factorsOf({ bpm: 60, events: line([[1, 1], [1, 3], [1, 9], [1, 11]]) }).span.measure).toBe(0);
    // Fewer than 4 groups: the whole section is one run.
    expect(factorsOf({ bpm: 60, events: line([[1, 2], [1, 5]]) }).span.measure).toBe(3);
  });

  it('string skipping: mean over consecutive single-note pairs', () => {
    expect(stringSkipping(groupsOf(line([[1, 1], [2, 1], [1, 1], [2, 1]])))).toBe(0);
    expect(stringSkipping(groupsOf(line([[1, 1], [3, 1], [1, 1]])))).toBe(0.5);
    expect(stringSkipping(groupsOf(line([[1, 1], [4, 1], [2, 1]])))).toBe(0.75); // (1 + 0.5) / 2
    expect(stringSkipping(groupsOf(line([[6, 1], [1, 1]])))).toBe(1);
    // Chords break pairs: no single-note pair → 0.
    expect(stringSkipping(groupsOf([{ at: 0, notes: [[1, 1]] }, { at: 1, notes: [[3, 1], [4, 1]] }, { at: 2, notes: [[6, 1]] }]))).toBe(0);
    expect(factorsOf({ bpm: 60, events: line([[1, 1], [3, 1], [1, 1]]) }).skipping.c).toBe(1);
  });

  it('techniques: distinct weights per group', () => {
    const w = (techs: Tech[]) => techniqueWeight(groupsOf([{ at: 0, notes: techs.map((t, i) => [(i + 1) as 1, 3, t] as const) }])[0]!);
    expect(w([{ bend: { semitones: 1 } }])).toBe(1.0);
    expect(w([{ bend: { semitones: 2 } }])).toBe(1.5);
    expect(w([{ palmMute: true }, { palmMute: true }])).toBeCloseTo(0.1);
    expect(w([{ hammerOn: true }])).toBe(0.5);
    expect(w([{ pullOff: true }])).toBe(0.5);
    expect(w([{ legatoDest: true }])).toBe(0);
    expect(w([{ slide: 'shift', vibrato: true }])).toBeCloseTo(0.9);
    expect(w([{ harmonic: 'natural' }, { dead: true }])).toBeCloseTo(1.0);
    expect(w([{ letRing: true }, { ghost: true }])).toBe(0);
    // 4 bends of 1 semitone in 4 s → Tq = 1 → c = 1.
    expect(factorsOf({ bpm: 60, events: line(Array(4).fill([2, 7, { bend: { semitones: 1 } }])) }).techniques.c).toBeCloseTo(1);
  });

  it('chords: load per chord group', () => {
    const load = (notes: EventSpec['notes']) => chordLoad(groupsOf([{ at: 0, notes }])[0]!);
    expect(load([[1, 3]])).toBe(0);
    expect(load([[6, 3], [5, 5]])).toBe(0.5);
    expect(load([[6, 3], [5, 5], [4, 5]])).toBe(1.0);
    expect(load([[6, 3], [4, 6]])).toBe(1.0); // span 3
    expect(load([[6, 1], [5, 3], [4, 3], [3, 2], [2, 1], [1, 5]])).toBe(1.5);
    expect(load([[6, 0], [5, 2], [4, 2]])).toBe(1.0); // open string not in the span
  });
});

describe('sections', () => {
  // 240 BPM: one 4/4 bar = 1 s.
  const sectioned = (sections: Array<[string, number]>) =>
    buildSong({ bpm: 240, events: line([[1, 1]]), bars: sections.reduce((a, [, n]) => a + n, 0), sections });

  it('merges sections shorter than 2 s into the next, the last into the previous', () => {
    const spans = mergeSections(sectioned([['Intro', 1], ['Verse', 4], ['Fill', 1], ['Chorus', 4], ['Outro', 1]]));
    expect(spans).toEqual([
      { sectionIndex: 0, name: 'Intro + Verse', start: 0, end: 5 },
      { sectionIndex: 2, name: 'Fill + Chorus + Outro', start: 5, end: 11 },
    ]);
    expect(mergeSections(sectioned([['A', 1], ['B', 1], ['C', 1]]))).toEqual([
      { sectionIndex: 0, name: 'A + B + C', start: 0, end: 3 },
    ]);
  });

  it('rates a song without sections as one span', () => {
    const song = { ...odeToJoy(), sections: [] };
    const report = analyzeDifficulty(song);
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]).toMatchObject({ sectionIndex: 0, name: 'Whole song', start: 0 });
    expect(report.sections[0]!.end).toBeCloseTo(9.6);
    expect(report.rating).toBe(analyzeDifficulty(odeToJoy()).rating);
  });

  it('song rating = 0.7 × hardest section ≥ 4 s + 0.3 × duration-weighted mean', () => {
    // 120 BPM: Easy = 4 bars (8 s) of quarter notes, Hard = 1 bar (2 s) of sixteenth-note chords.
    const easy = line(Array(16).fill([1, 0]));
    const hard: EventSpec[] = Array.from({ length: 16 }, (_, k) => ({ at: 16 + k * 0.25, notes: [[6, 1], [5, 3], [4, 3]], len: 0.25 }));
    const report = analyzeDifficulty(buildSong({ bpm: 120, events: [...easy, ...hard], bars: 5, sections: [['Easy', 4], ['Hard', 1]] }));
    const [e, h] = report.sections;
    expect(h!.rating).toBeGreaterThan(e!.rating);
    const expected = 0.7 * e!.rating + 0.3 * ((e!.rating * 8 + h!.rating * 2) / 10);
    expect(report.rating).toBeCloseTo(Math.round(expected * 10) / 10, 10);
    // With no section ≥ 4 s, the hardest of all counts.
    const short = analyzeDifficulty(buildSong({ bpm: 120, events: hard.map((ev) => ({ ...ev, at: ev.at - 16 })), bars: 1 }));
    expect(short.rating).toBe(short.sections[0]!.rating);
  });

  it('assigns groups and shifts to their section', () => {
    const events = [...line(Array(8).fill([1, 2])), ...line(Array(8).fill([1, 9]), 1, 8)];
    const report = analyzeDifficulty(buildSong({ bpm: 60, events, sections: [['A', 2], ['B', 2]] }));
    expect(report.sections.map((s) => s.factors.shifts.measure)).toEqual([0, 7 / 8]);
    expect(report.sections.map((s) => s.factors.density.measure)).toEqual([1, 1]);
  });

  it('marks needs-alignment songs provisional', () => {
    expect(analyzeDifficulty(buildSong({ bpm: 80, events: line([[1, 1]]), rhythm: 'needs-alignment' })).provisional).toBe(true);
  });

  it('handles an empty song', () => {
    const report = analyzeDifficulty(buildSong({ bpm: 60, events: [], bars: 2 }));
    expect(report.rating).toBe(1);
    expect(report.skills).toEqual([]);
  });
});

describe('skill tags', () => {
  const skills = (events: EventSpec[]) => analyzeDifficulty(buildSong({ bpm: 60, events })).skills;
  const withTech = (count: number, tech: Tech) =>
    line(Array.from({ length: 20 }, (_, i) => [2, 5, i < count ? tech : {}] as const));

  it('bends and legato need ≥ 3 groups and ≥ 5% of groups', () => {
    expect(skills(withTech(3, { bend: { semitones: 1 } }))).toContain('bends');
    expect(skills(withTech(2, { bend: { semitones: 1 } }))).not.toContain('bends');
    expect(skills(withTech(3, { hammerOn: true }))).toContain('legato');
    expect(skills(withTech(3, { legatoDest: true }))).not.toContain('legato');
  });

  it('chords need ≥ 4 chord groups and ≥ 25% of groups', () => {
    const chordsAt = (n: number) => Array.from({ length: 16 }, (_, i) => ({ at: i, notes: i < n ? ([[6, 3], [5, 5]] as const) : ([[6, 3]] as const) }));
    expect(skills(chordsAt(4))).toContain('chords');
    expect(skills(chordsAt(3))).not.toContain('chords');
  });

  it('string skipping and position shifts come from section factors', () => {
    expect(skills(line([[1, 1], [3, 1], [1, 1], [3, 1]]))).toContain('string-skipping');
    expect(skills(line([[1, 1], [2, 1], [1, 1], [2, 1]]))).not.toContain('string-skipping');
    // 1 s per note: positions 2 ↔ 9 every 2 notes → S = 7 / 2 s ≥ 1.
    expect(skills(line([[1, 2], [1, 3], [1, 9], [1, 10], [1, 2], [1, 3]]))).toContain('position-shifts');
    expect(skills(line([[1, 2], [1, 3], [1, 2], [1, 3]]))).not.toContain('position-shifts');
  });
});

describe('monotonicity', () => {
  const rating = (song: Song) => analyzeDifficulty(song).rating;

  it('a faster tempo never lowers the rating', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const bpm = 60 + Math.floor(rng(seed)() * 100);
      let prev = analyzeDifficulty(buildSong(randomSpec(seed, bpm)));
      for (const k of [1.1, 1.25, 1.5]) {
        const next = analyzeDifficulty(buildSong(randomSpec(seed, bpm * k)));
        expect(next.rating).toBeGreaterThanOrEqual(prev.rating);
        next.sections.forEach((s, i) => expect(s.raw).toBeGreaterThanOrEqual(prev.sections[i]!.raw - 1e-12));
        prev = next;
      }
    }
  });

  it('more techniques never lower the rating', () => {
    const extras: Tech[] = [{ bend: { semitones: 2 } }, { hammerOn: true }, { vibrato: true }, { palmMute: true }, { harmonic: 'natural' }];
    for (let seed = 1; seed <= 25; seed++) {
      const spec = randomSpec(seed, 100);
      const r = rng(seed * 7);
      let before = rating(buildSong(spec));
      let events = spec.events;
      for (let step = 0; step < 4; step++) {
        events = events.map((ev) =>
          r() < 0.2 ? { ...ev, notes: ev.notes.map(([s, f, t]) => [s, f, { ...t, ...extras[Math.floor(r() * extras.length)] }] as const) } : ev,
        );
        const after = rating(buildSong({ ...spec, events }));
        expect(after).toBeGreaterThanOrEqual(before);
        before = after;
      }
    }
  });

  it('more and wider position shifts never lower the rating', () => {
    // 8 bars at 100 BPM; a 4-note shape per bar; bars 1..m move up by d frets.
    const shifted = (m: number, d: number) =>
      buildSong({
        bpm: 100,
        bars: 8,
        events: Array.from({ length: 8 }, (_, bar) => {
          const lo = bar >= 1 && bar <= m && bar % 2 === 1 ? 2 + d : 2;
          return line([[3, lo], [3, lo + 2], [2, lo], [2, lo + 2]], 1, bar * 4);
        }).flat(),
      });
    let prev = 0;
    for (const m of [0, 1, 3, 5, 7]) {
      const r = rating(shifted(m, 5));
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    prev = 0;
    for (const d of [2, 4, 6, 8, 10]) {
      const r = rating(shifted(7, d));
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    expect(rating(shifted(7, 10))).toBeGreaterThan(rating(shifted(0, 10)));
  });
});

describe('performance', () => {
  it('analyses a 5,000-note song in < 20 ms', () => {
    const song = buildSong(randomSpec(42, 140, 80));
    expect(song.notes.length).toBeGreaterThanOrEqual(5000);
    for (let i = 0; i < 3; i++) analyzeDifficulty(song); // warm up the JIT
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      analyzeDifficulty(song, { positions: computePositions(song) });
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(20);
  });
});
