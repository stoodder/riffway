import { describe, expect, it } from 'vitest';
import { beatLengthAt, computePositions, cueShowAt, positionHi } from '@core/handpos';
import { buildSong, line, powerChordDrive, type EventSpec } from '../difficulty/song-builder';

const los = (events: EventSpec[], bpm = 120) => computePositions(buildSong({ bpm, events })).positions.map((p) => p.lo);

describe('positionHi', () => {
  it('spans 4 frets below fret 7 and 5 frets from fret 7', () => {
    expect(positionHi(1)).toBe(4);
    expect(positionHi(6)).toBe(9);
    expect(positionHi(7)).toBe(11);
    expect(positionHi(12)).toBe(16);
  });
});

describe('computePositions', () => {
  it('keeps notes inside one window in one position, with no cues', () => {
    const { positions, cues } = computePositions(buildSong({ bpm: 120, events: line([[3, 2], [3, 4], [2, 5], [2, 3]]) }));
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ lo: 2, hi: 5, start: 0, firstNoteId: 0, lastNoteId: 3 });
    expect(positions[0]!.end).toBeCloseTo(2); // last note ends at 4 beats × 0.5 s
    expect(cues).toEqual([]);
  });

  it('never shifts for open strings (and an all-open song has no positions)', () => {
    expect(los(line([[1, 7], [1, 0], [6, 0], [2, 8], [3, 0], [1, 9]]))).toEqual([7]);
    expect(computePositions(buildSong({ bpm: 120, events: line([[1, 0], [6, 0]]) })).positions).toEqual([]);
  });

  it('ignores dead notes', () => {
    expect(los(line([[1, 3], [1, 12, { dead: true }], [1, 5]]))).toEqual([3]);
  });

  it('uses a 5-fret window from fret 7 and a 4-fret window below', () => {
    expect(los(line([[1, 7], [1, 9], [1, 11], [1, 8]]))).toEqual([7]);
    expect(los(line([[1, 5], [1, 7], [1, 9], [1, 10]]))).toEqual([5, 9]);
  });

  it('takes the new lo from the longest upcoming run that fits one window', () => {
    // From fret 3, fret 8 is out of [3,6]; the run 8, 10, 7 fits [7,11] → lo 7, not 8.
    expect(los(line([[1, 3], [1, 8], [1, 10], [1, 7]]))).toEqual([3, 7]);
    // The first position also looks ahead: 4, 2, 5 fits [2,5].
    expect(los(line([[1, 4], [1, 2], [1, 5]]))).toEqual([2]);
  });

  it('treats a chord stretching past the window as one position', () => {
    const stretch: EventSpec['notes'] = [[6, 1], [5, 5]];
    expect(los([0, 1, 2].map((at) => ({ at, notes: stretch })))).toEqual([1]);
  });

  it('records start, end and note ids per position', () => {
    const { positions } = computePositions(buildSong({ bpm: 60, events: line([[1, 2], [1, 0], [1, 9], [1, 10]]) }));
    expect(positions).toEqual([
      { lo: 2, hi: 5, start: 0, end: 2, firstNoteId: 0, lastNoteId: 1 },
      { lo: 9, hi: 13, start: 2, end: 4, firstNoteId: 2, lastNoteId: 3 },
    ]);
  });

  it('cues shifts of ≥ 2 frets only', () => {
    const big = computePositions(buildSong({ bpm: 120, events: line([[1, 5], [1, 9]]) }));
    expect(big.positions.map((p) => p.lo)).toEqual([5, 9]);
    const small = computePositions(buildSong({ bpm: 120, events: line([[1, 1], [1, 5], [1, 2], [1, 4]]) }));
    expect(small.positions.map((p) => p.lo)).toEqual([1, 2]);
    expect(small.cues).toEqual([]);
    expect(big.cues).toHaveLength(1);
  });

  it('shows cues at least 1.5 beats and at least 0.75 s ahead', () => {
    const at = (bpm: number) => computePositions(buildSong({ bpm, events: line([[1, 3], [1, 3], [1, 3], [1, 3], [1, 10]]) })).cues[0]!;
    const slow = at(60); // beat 1 s → lead 1.5 s
    expect(slow.time).toBeCloseTo(4);
    expect(slow.time - slow.showAt).toBeCloseTo(1.5);
    const fast = at(200); // beat 0.3 s → 1.5 beats = 0.45 s < 0.75 s
    expect(fast.time - fast.showAt).toBeCloseTo(0.75);
    expect(slow).toMatchObject({ fromLo: 3, lo: 10, hi: 14 });
  });

  it('matches the worked example: lo 5 → 8 → 3 → 7 with three cues', () => {
    const { positions, cues } = computePositions(powerChordDrive());
    expect(positions.map((p) => [p.lo, p.hi, p.start])).toEqual([
      [5, 8, 0],
      [8, 12, 2],
      [3, 6, 4],
      [7, 11, 6],
    ]);
    expect(positions[3]!.end).toBeCloseTo(8);
    expect(cues.map((c) => [c.fromLo, c.lo, c.time, c.showAt])).toEqual([
      [5, 8, 2, 1.25],
      [8, 3, 4, 3.25],
      [3, 7, 6, 5.25],
    ]);
  });
});

describe('beatLengthAt', () => {
  it('uses the bar grid, then the tempo map, then 120 BPM', () => {
    const song = buildSong({ bpm: 90, events: line([[1, 1]]), beatsPerBar: 3 });
    expect(beatLengthAt(song, 0.5)).toBeCloseTo(60 / 90);
    expect(beatLengthAt({ timing: { tempos: [{ time: 0, bpm: 60 }, { time: 4, bpm: 150 }], bars: [] } }, 5)).toBeCloseTo(0.4);
    expect(beatLengthAt({ timing: { tempos: [{ time: 0, bpm: 60 }, { time: 4, bpm: 150 }], bars: [] } }, 1)).toBeCloseTo(1);
    expect(beatLengthAt({ timing: { tempos: [], bars: [] } }, 1)).toBe(0.5);
  });
});

describe('cueShowAt (R1-C-10)', () => {
  it('keeps at least 0.75 real seconds of lead at any speed, never less than the song-time lead', () => {
    const cue = { showAt: 9.25, time: 10, fromLo: 2, lo: 7, hi: 11 }; // lead 0.75 s at 100%
    for (const speed of [0.4, 0.7, 1, 1.1]) {
      const showAt = cueShowAt(cue, speed);
      expect(showAt).toBeLessThanOrEqual(cue.showAt);
      expect((cue.time - showAt) / speed).toBeGreaterThanOrEqual(0.75 - 1e-12);
    }
    expect(cueShowAt(cue, 1.1)).toBeCloseTo(10 - 0.825, 12);
    expect(cueShowAt(cue, 0.5)).toBe(9.25);
    const beatLed = { ...cue, showAt: 8.5 }; // 1.5 beats at 60 BPM: already longer
    expect(cueShowAt(beatLed, 1.1)).toBe(8.5);
  });
});
