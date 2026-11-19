/**
 * A scripted "player" for the highway dev screen: as notes reach the hit line it emits judgements with
 * a realistic mix (mostly Perfect/Great, some early/late Goods, the odd WrongNote and Miss) and keeps a
 * combo/multiplier like the judge does, so every feedback effect can be seen without a guitar.
 * @module
 */
import type { Judgement, Outcome, StrayEvent, TimingLabel } from '@shared/judge';
import type { Highway } from '@shared/services';
import type { Song } from '@shared/song';
import { onsetGroups, type OnsetGroup } from '@core/model';
import { seededRandom } from './songs';

/** Delay after a note before its Miss is shown (Good window + input lag), song seconds at 100%. */
const MISS_DELAY = 0.21;

/** Emits demo judgements to a highway. */
export class DemoPlayer {
  private readonly groups: OnsetGroup[];
  private next = 0;
  private combo = 0;
  private readonly rand = seededRandom(42);

  constructor(
    song: Song,
    private readonly highway: Highway,
  ) {
    this.groups = onsetGroups(song);
  }

  /** Restart from song time `t` (after a seek or loop wrap); the streak carries over like the judge's. */
  rewind(t: number): void {
    let lo = 0;
    let hi = this.groups.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.groups[mid]!.time < t) lo = mid + 1;
      else hi = mid;
    }
    this.next = lo;
  }

  /** Judge every group the heard time `now` has passed. `pass` is the clock's loop pass. */
  update(now: number, pass: number): void {
    while (this.next < this.groups.length) {
      const g = this.groups[this.next]!;
      const r = this.rand();
      const outcome: Outcome = r < 0.62 ? 'Perfect' : r < 0.8 ? 'Great' : r < 0.9 ? 'Good' : r < 0.95 ? 'WrongNote' : 'Miss';
      const due = outcome === 'Miss' ? g.time + MISS_DELAY : g.time;
      if (now < due) return;
      this.next++;
      this.emit(g, outcome, pass);
      if (this.rand() < 0.03) this.highway.stray(this.strayAt(g.time));
    }
  }

  /** Emit one judgement and update the combo display. */
  emit(g: OnsetGroup, outcome: Outcome, pass: number, timing?: TimingLabel): void {
    const hit = outcome === 'Perfect' || outcome === 'Great' || outcome === 'Good';
    const delta = outcome === 'Perfect' ? 12 : outcome === 'Great' ? -48 : outcome === 'Good' ? (this.rand() < 0.5 ? -95 : 102) : 30;
    const expected = g.notes[0]!.midi;
    const j: Judgement = {
      noteIds: g.notes.map((n) => n.id),
      outcome,
      deltaMs: outcome === 'Miss' ? null : delta,
      timing: timing !== undefined ? timing : outcome === 'Good' ? (delta < 0 ? 'early' : 'late') : null,
      expectedMidi: expected,
      chord: g.chord,
      songTime: g.time,
      ctxTime: g.time,
      final: true,
      pass,
      source: 'test',
      ...(outcome === 'WrongNote' ? { playedMidi: expected + (this.rand() < 0.5 ? 1 : -2) } : {}),
    };
    this.highway.feedback(j);
    this.combo = hit ? this.combo + 1 : 0;
    // The multiplier shown *before* a hit counts it (docs/game-mechanics.md); display the new state.
    this.highway.setCombo(this.combo, Math.min(4, 1 + Math.floor(this.combo / 10)) as 1 | 2 | 3 | 4);
  }

  /** Set the combo directly (screenshots). */
  setCombo(combo: number): void {
    this.combo = combo;
    this.highway.setCombo(combo, Math.min(4, 1 + Math.floor(combo / 10)));
  }

  /** Up to `count` onset groups at or before song time `t` whose top strings differ, latest first. */
  groupsBefore(t: number, count: number): OnsetGroup[] {
    const out: OnsetGroup[] = [];
    const used = new Set<number>();
    for (let i = this.groups.length - 1; i >= 0 && out.length < count; i--) {
      const g = this.groups[i]!;
      if (g.time > t) continue;
      const top = g.notes[0]!.string;
      if (used.has(top)) continue;
      used.add(top);
      out.push(g);
    }
    return out;
  }

  private strayAt(t: number): StrayEvent {
    return { ctxTime: t, songTime: t, source: 'test' };
  }
}
