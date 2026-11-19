import { describe, expect, it } from 'vitest';
import type { ClockChange } from '@shared/clock';
import { type ClockSource, type OutputClock, SegmentTimeline, createSongClock, heardCtxTime } from '../../src/audio/engine/clock';

const play = (songStart: number, speed: number, pass = 0) => ({ songStart, speed, pass, bound: null, reason: 'play' as const });

describe('SegmentTimeline', () => {
  it('maps exactly through each segment and keeps history for past times', () => {
    const tl = new SegmentTimeline(0);
    tl.reanchor(1, play(0, 1));
    tl.reanchor(3, play(2, 0.5), 2);
    expect(tl.songTimeAt(0.5)).toBe(0);
    expect(tl.songTimeAt(2)).toBe(1);
    expect(tl.songTimeAt(5)).toBe(3);
    expect(tl.ctxTimeAt(1.5, 5, 1)).toBe(2.5);
    expect(tl.ctxTimeAt(3, 5, 1)).toBe(5);
    expect(tl.segments[1]).toMatchObject({ ctxEnd: 3, songEnd: 2 });
  });

  it('a re-anchor drops segments at or after its time and closes the one before', () => {
    const tl = new SegmentTimeline(0);
    tl.reanchor(1, play(0, 1));
    tl.reanchor(5, play(10, 1));
    const res = tl.reanchor(4, play(20, 1));
    expect(res.dropped.map((s) => s.songStart)).toEqual([10]);
    expect(res.closed).toMatchObject({ songStart: 0, ctxEnd: 4, songEnd: 3 });
    expect(tl.songTimeAt(6)).toBe(22);
  });

  it('replacing a not-yet-started first segment keeps a single base segment', () => {
    const tl = new SegmentTimeline(2);
    const res = tl.reanchor(2, { songStart: 7, speed: 0, pass: 0, bound: null, reason: 'seek' });
    expect(res.closed).toBeNull();
    expect(tl.segments).toHaveLength(1);
    expect(tl.songTimeAt(0)).toBe(7);
  });

  it('holds at a bound until the next segment is appended', () => {
    const tl = new SegmentTimeline(0);
    tl.reanchor(0, { ...play(0, 1), bound: { kind: 'end', song: 3 } });
    expect(tl.songTimeAt(10)).toBe(3);
  });

  it('prunes old history but always keeps the current segment', () => {
    const tl = new SegmentTimeline(0);
    tl.reanchor(1, play(0, 1));
    tl.reanchor(2, play(5, 1));
    tl.prune(10, 2);
    expect(tl.segments).toHaveLength(1);
    expect(tl.songTimeAt(10)).toBe(13);
  });
});

describe('heardCtxTime / SongClock', () => {
  const out = (o: Partial<OutputClock> = {}): OutputClock => ({
    now: () => 10,
    outputTimestamp: () => ({ contextTime: 9.95, performanceTime: 5000 }),
    perfNow: () => 5016,
    outputDelay: () => 0.03,
    ...o,
  });

  it('extrapolates getOutputTimestamp to the frame time', () => {
    expect(heardCtxTime(out(), 5016)).toBeCloseTo(9.966, 12);
  });

  it('falls back to currentTime − output delay when the timestamp is unusable', () => {
    expect(heardCtxTime(out({ outputTimestamp: () => null }), 5016)).toBeCloseTo(9.97, 12);
    expect(heardCtxTime(out({ outputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) }), 5006)).toBeCloseTo(9.96, 12);
    expect(heardCtxTime(out({ outputTimestamp: () => ({ contextTime: 1, performanceTime: 100 }) }), 5016)).toBeCloseTo(9.97, 12);
  });

  it('heardSongTime subtracts the visual offset scaled by speed', () => {
    const listeners: ((c: ClockChange) => void)[] = [];
    const src: ClockSource = {
      state: 'playing',
      speed: 0.5,
      anchor: { anchorCtxTime: 9, anchorSongTime: 20, speed: 0.5 },
      songTimeAt: (c) => 20 + (c - 9) * 0.5,
      ctxTimeAt: (s) => 9 + (s - 20) / 0.5,
      speedAt: () => 0.5,
      onChange: (cb) => {
        listeners.push(cb);
        return () => undefined;
      },
    };
    const clock = createSongClock(src, out(), () => 20);
    expect(clock.nowSong()).toBeCloseTo(20.5, 12);
    expect(clock.heardSongTime(5016)).toBeCloseTo(20 + 0.966 * 0.5 - 0.02 * 0.5, 12);
    expect(clock.heardSongTime()).toBeCloseTo(clock.heardSongTime(5016), 12);
    expect(clock.ctxTimeAt(21)).toBe(11);
    clock.onChange(() => undefined);
    expect(listeners).toHaveLength(1);
  });
});
