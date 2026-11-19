/**
 * Stretch scheduling plan (pure, DOM-free): turns the engine's {@link PlaybackSegment}s and the warp
 * anchors into signalsmith-stretch time-map changes, and decides **when** each change may be posted.
 *
 * Each change maps output (context) time to input (audio-file) time:
 * `input(t) = ev.input + (t − ev.output) × ev.rate` while active, with `rate = speed × warpSlope`.
 * A segment yields one change at its start, one at every interior anchor it crosses (slope change)
 * and an inactive change at its bound (loop B / song end) so a late wrap never plays past B.
 *
 * **Posting rule.** The stretch worklet (1.3.2) drops every change at or after *its* current time
 * whenever a new one arrives, so only one future change can be pending at a time. A change is
 * posted once all earlier changes are in the past and it is at most `lead` seconds ahead
 * (`lead ≥ stretch.latency()`, so the node can compensate its own latency). When a re-plan drops a
 * change that was already posted, the earliest remaining future change is re-posted, which clears
 * the stale one in the worklet.
 * @module
 */
import type { PlaybackSegment } from '@shared/clock';
import type { WarpAnchor } from '@shared/storage';
import { audioTimeAt, slopeAt, slopeChangesIn } from './warp';

/** One time-map change for the stretch node (`stretch.schedule()` fields). */
export interface StretchEvent {
  /** Context time the change takes effect (s). */
  output: number;
  /** Audio-file position at `output` (s; negative or past the end plays silence). */
  input: number;
  /** Input seconds per output second (`speed × slope`). */
  rate: number;
  active: boolean;
}

/** Times closer than this are treated as equal when replacing (float noise from ctx ↔ song maps). */
const EPS = 1e-9;

/** Plan the stretch changes for one playing segment (see module docs). */
export function planSegment(seg: PlaybackSegment, anchors: readonly WarpAnchor[]): StretchEvent[] {
  const { ctxStart, songStart, speed } = seg;
  if (!(speed > 0)) return [];
  const at = (song: number, output: number, active = true): StretchEvent => ({
    output,
    input: audioTimeAt(anchors, song),
    rate: speed * slopeAt(anchors, song),
    active,
  });
  const out = [at(songStart, ctxStart)];
  const songEnd = seg.songEnd ?? Infinity;
  for (const b of slopeChangesIn(anchors, songStart, songEnd)) {
    const output = ctxStart + (b - songStart) / speed;
    if (seg.ctxEnd !== undefined && output >= seg.ctxEnd - EPS) break;
    out.push(at(b, output));
  }
  if (seg.ctxEnd !== undefined && seg.songEnd !== undefined && seg.ctxEnd > ctxStart) {
    out.push(at(seg.songEnd, seg.ctxEnd, false));
  }
  return out;
}

/** Index of the last element (sorted by `key`) with `key ≤ t`, or −1. */
function lastIndexAtOrBefore<T>(list: readonly T[], t: number, key: (x: T) => number): number {
  let idx = -1;
  for (let i = 0; i < list.length && key(list[i]!) <= t; i++) idx = i;
  return idx;
}

/** Something the engine asked for: a playing segment or a stop. */
type PlaybackItem = { kind: 'play'; at: number; seg: PlaybackSegment } | { kind: 'stop'; at: number };

interface PlannedEvent extends StretchEvent {
  posted: boolean;
}

/**
 * The backing source's schedule: what the engine asked for (segments and stops, with the
 * `ScheduledSource` "replace from `ctxStart` on" semantics) and the stretch changes planned from it,
 * with posting state. Re-planning (new anchors) rebuilds the changes from a given time.
 */
export class StretchPlan {
  private items: PlaybackItem[] = [];
  private events: PlannedEvent[] = [];
  private anchors: readonly WarpAnchor[];

  constructor(anchors: readonly WarpAnchor[]) {
    this.anchors = anchors;
  }

  /** Planned changes (copies, ascending output time). */
  get planned(): StretchEvent[] {
    return this.events.map(({ output, input, rate, active }) => ({ output, input, rate, active }));
  }

  /** A segment from the engine: replaces everything from `seg.ctxStart` on. */
  schedule(seg: PlaybackSegment, now: number): void {
    this.dropItemsFrom(seg.ctxStart);
    this.items.push({ kind: 'play', at: seg.ctxStart, seg });
    this.rebuild(seg.ctxStart, now);
  }

  /** Stop at `when`: replaces everything from `when` on with silence. */
  stop(when: number, now: number): void {
    this.dropItemsFrom(when);
    this.items.push({ kind: 'stop', at: when });
    this.rebuild(when, now);
  }

  /** New warp anchors: re-plan everything from `from` (a time far enough ahead to post in time). */
  setAnchors(anchors: readonly WarpAnchor[], from: number, now: number): void {
    this.anchors = anchors;
    this.rebuild(from, now);
  }

  /** Audio-file position at context time `t` according to the plan (0 before any change). */
  positionAt(t: number): number {
    const e = this.eventAt(t);
    if (!e) return 0;
    return e.active ? e.input + (t - e.output) * e.rate : e.input;
  }

  /** True while some planned change has not been posted yet. */
  get hasUnposted(): boolean {
    return this.events.some((e) => !e.posted);
  }

  /**
   * Changes to post now (marked posted), in order: the first unposted change once every earlier
   * change lies before `now` and it is at most `lead` ahead; a change that is already due lets the
   * next one follow in the same call.
   */
  takeDue(now: number, lead: number): StretchEvent[] {
    const out: StretchEvent[] = [];
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]!;
      if (e.posted) {
        if (e.output >= now) break; // a pending change: the next one must wait until it is past
        continue;
      }
      if (e.output - now > lead) break;
      e.posted = true;
      out.push({ output: e.output, input: e.input, rate: e.rate, active: e.active });
      if (e.output >= now) break;
    }
    return out;
  }

  /** Forget items and changes that ended before `now − keepSec` (the one in effect is kept). */
  prune(now: number, keepSec = 2): void {
    const cut = now - keepSec;
    const lastItem = lastIndexAtOrBefore(this.items, cut, (it) => it.at);
    if (lastItem > 0) this.items.splice(0, lastItem);
    const lastEvent = lastIndexAtOrBefore(this.events, cut, (e) => e.output);
    if (lastEvent > 0) this.events.splice(0, lastEvent);
  }

  private dropItemsFrom(t: number): void {
    this.items = this.items.filter((it) => it.at < t - EPS);
  }

  private eventAt(t: number): PlannedEvent | undefined {
    let found: PlannedEvent | undefined;
    for (const e of this.events) {
      if (e.output <= t + EPS) found = e;
      else break;
    }
    return found;
  }

  /** Re-plan every change from `from` on out of the items in effect. */
  private rebuild(from: number, now: number): void {
    const kept = this.events.filter((e) => e.output < from - EPS);
    const dropped = this.events.length - kept.length;
    const stalePosted = this.events.some((e) => e.posted && e.output >= from - EPS);
    const fresh: StretchEvent[] = [];
    // The item in effect at `from` (it may have started earlier), then every later item.
    let first = this.items.length - 1;
    while (first > 0 && this.items[first]!.at > from + EPS) first--;
    for (let i = Math.max(0, first); i < this.items.length; i++) {
      const it = this.items[i]!;
      const next = this.items[i + 1];
      const start = Math.max(it.at, from);
      if (start > it.at + EPS && it.kind === 'stop') continue; // silence already planned before `from`
      if (it.kind === 'stop') {
        const last = fresh[fresh.length - 1] ?? kept[kept.length - 1];
        const pos = last ? (last.active ? last.input + (start - last.output) * last.rate : last.input) : 0;
        fresh.push({ output: start, input: pos, rate: last?.rate ?? 1, active: false });
        continue;
      }
      let seg = it.seg;
      if (start > seg.ctxStart + EPS) {
        if (seg.ctxEnd !== undefined && start >= seg.ctxEnd - EPS) continue;
        seg = { ...seg, ctxStart: start, songStart: seg.songStart + (start - seg.ctxStart) * seg.speed };
      }
      let planned = planSegment(seg, this.anchors);
      if (next) planned = planned.filter((e) => e.output < next.at - EPS);
      fresh.push(...planned);
    }
    if (dropped === 0 && fresh.length === 0) return;
    this.events = [...kept, ...fresh.map((e) => ({ ...e, posted: false }))];
    if (stalePosted) {
      // A posted change was replaced: re-post the earliest future change so the worklet drops it.
      for (const e of this.events) if (e.output >= now) e.posted = false;
      const current = this.eventAt(now);
      if (current && !this.events.some((e) => e.output >= now)) {
        // Nothing ahead: re-assert the change in effect, re-expressed at `now`.
        this.events.push({ ...current, output: now, input: this.positionAt(now), posted: false });
      }
    }
  }
}
