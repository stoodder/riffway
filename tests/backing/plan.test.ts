import { describe, expect, it } from 'vitest';
import type { PlaybackSegment } from '@shared/clock';
import type { WarpAnchor } from '@shared/storage';
import { StretchPlan, type StretchEvent, planSegment } from '../../src/audio/backing/plan';

const DRIFT: WarpAnchor[] = [
  { songTime: 0, audioTime: 0.4 },
  { songTime: 8, audioTime: 8.56 }, // slope 1.02
  { songTime: 16, audioTime: 16.48 }, // slope 0.99
];
const seg = (s: Partial<PlaybackSegment>): PlaybackSegment => ({ ctxStart: 1, songStart: 0, speed: 1, pass: 0, ...s });

/** Simulates the stretch worklet's time map: every schedule pops changes at or after its own time. */
class FakeWorklet {
  map: StretchEvent[] = [];
  post(ev: StretchEvent, workletNow: number): void {
    while (this.map.length && this.map[this.map.length - 1]!.output >= workletNow) this.map.pop();
    this.map.push(ev);
  }
  /** Input position the worklet would play at output time `t` (its own semantics). */
  inputAt(t: number): number | null {
    let cur: StretchEvent | undefined;
    for (const e of this.map) if (e.output <= t) cur = e;
    if (!cur || !cur.active) return null;
    return cur.input + (t - cur.output) * cur.rate;
  }
}

describe('planSegment', () => {
  it('starts at the segment, changes rate at interior anchors, goes silent at the bound', () => {
    const ev = planSegment(seg({ ctxStart: 2, songStart: 4, speed: 0.5, songEnd: 12, ctxEnd: 18 }), DRIFT);
    expect(ev).toHaveLength(3);
    expect(ev[0]).toMatchObject({ output: 2, active: true });
    expect(ev[0]!.input).toBeCloseTo(0.4 + 4 * 1.02, 12);
    expect(ev[0]!.rate).toBeCloseTo(0.5 * 1.02, 12);
    expect(ev[1]!.output).toBeCloseTo(2 + 4 / 0.5, 12); // song 8 at half speed
    expect(ev[1]!.input).toBeCloseTo(8.56, 12);
    expect(ev[1]!.rate).toBeCloseTo(0.5 * 0.99, 12);
    expect(ev[2]).toMatchObject({ output: 18, active: false });
    expect(ev[2]!.input).toBeCloseTo(8.56 + 4 * 0.99, 12);
  });

  it('an unbounded segment has no end change; a boundary at the bound is not duplicated', () => {
    expect(planSegment(seg({ songStart: 0 }), [{ songTime: 0, audioTime: 0.3 }])).toEqual([{ output: 1, input: 0.3, rate: 1, active: true }]);
    const ev = planSegment(seg({ ctxStart: 0, songStart: 0, songEnd: 8, ctxEnd: 8 }), DRIFT);
    expect(ev.map((e) => e.active)).toEqual([true, false]);
    expect(planSegment(seg({ speed: 0 }), DRIFT)).toEqual([]);
  });
});

describe('StretchPlan', () => {
  it('replaces from a new segment start and stops with silence', () => {
    const p = new StretchPlan([{ songTime: 0, audioTime: 0 }]);
    p.schedule(seg({ ctxStart: 1, songStart: 0, songEnd: 10, ctxEnd: 11 }), 0.95);
    p.schedule(seg({ ctxStart: 3, songStart: 6, speed: 0.8 }), 2.9); // seek
    expect(p.planned.map((e) => [e.output, e.input, e.active])).toEqual([
      [1, 0, true],
      [3, 6, true],
    ]);
    p.stop(5, 4.9);
    expect(p.planned.at(-1)).toMatchObject({ output: 5, active: false });
    expect(p.planned.at(-1)!.input).toBeCloseTo(6 + 2 * 0.8, 12);
    expect(p.positionAt(4)).toBeCloseTo(6.8, 12);
    expect(p.positionAt(6)).toBeCloseTo(7.6, 12);
  });

  it('re-plans the rest of a playing segment when anchors change', () => {
    const p = new StretchPlan([{ songTime: 0, audioTime: 0 }]);
    p.schedule(seg({ ctxStart: 1, songStart: 0 }), 0.95);
    p.setAnchors([{ songTime: 0, audioTime: 0.25 }], 4, 3.95);
    expect(p.planned).toEqual([
      { output: 1, input: 0, rate: 1, active: true },
      { output: 4, input: 3.25, rate: 1, active: true },
    ]);
  });

  it('posts one pending change at a time, at most `lead` ahead', () => {
    const p = new StretchPlan(DRIFT);
    p.schedule(seg({ ctxStart: 1, songStart: 6 }), 0.95); // boundary at song 8 → ctx 3
    expect(p.takeDue(0.95, 0.2).map((e) => e.output)).toEqual([1]);
    expect(p.takeDue(0.99, 0.2)).toEqual([]); // the start is still pending
    expect(p.takeDue(1.5, 0.2)).toEqual([]); // boundary too far ahead
    expect(p.takeDue(2.85, 0.2).map((e) => e.output)).toEqual([3]);
    expect(p.hasUnposted).toBe(false);
  });

  it('a late timer catches up: past changes are posted in order with the next due one', () => {
    const p = new StretchPlan(DRIFT);
    p.schedule(seg({ ctxStart: 1, songStart: 6, songEnd: 9, ctxEnd: 4 }), 0.95);
    expect(p.takeDue(3.95, 0.2).map((e) => e.output)).toEqual([1, 3, 4]);
  });

  it('a replaced, already-posted change is cleared by re-posting the earliest future change', () => {
    const p = new StretchPlan([{ songTime: 0, audioTime: 0 }]);
    const w = new FakeWorklet();
    const pump = (now: number): void => p.takeDue(now, 0.2).forEach((e) => w.post(e, now));
    p.schedule(seg({ ctxStart: 1, songStart: 0, songEnd: 4, ctxEnd: 5 }), 0.95);
    pump(0.95);
    pump(4.85); // the bound (silence at 5) is now pending in the worklet
    p.schedule(seg({ ctxStart: 5, songStart: 2, songEnd: 4, ctxEnd: 7, pass: 1 }), 4.9); // late wrap
    pump(4.9);
    expect(w.inputAt(5.5)).toBeCloseTo(2.5, 12);
    expect(w.map.filter((e) => e.output === 5).map((e) => e.active)).toEqual([true]);
  });

  it('drives a fake worklet so every output time plays the planned input across wraps and anchors', () => {
    const p = new StretchPlan(DRIFT);
    const w = new FakeWorklet();
    const lead = 0.17;
    // Loop song 6–10 (crosses the anchor at 8) at 70 %, wraps appended ~0.24 s ahead like the engine.
    const speed = 0.7;
    const pass = 4 / speed;
    let now = 0.9;
    p.schedule(seg({ ctxStart: 1, songStart: 6, speed, songEnd: 10, ctxEnd: 1 + pass }), now);
    let k = 1;
    for (; now < 1 + 3 * pass; now += 0.025) {
      if (1 + k * pass - now < 0.24) {
        p.schedule(seg({ ctxStart: 1 + k * pass, songStart: 6, speed, songEnd: 10, ctxEnd: 1 + (k + 1) * pass, pass: k }), now);
        k++;
      }
      p.takeDue(now, lead).forEach((e) => w.post(e, now));
      p.prune(now);
      // The worklet needs each change `latency` (0.12 s) ahead: check the time it renders then.
      const t = now + 0.12;
      if (t > 1) {
        const song = 6 + ((t - 1) % pass) * speed;
        const expected = song < 8 ? 0.4 + song * 1.02 : 8.56 + (song - 8) * 0.99;
        expect(w.inputAt(t)).toBeCloseTo(expected, 9);
      }
    }
  });
});
