/**
 * MIDI tick → seconds conversion over alphaTab's played-order tempo changes
 * (`MidiFileGenerator.tickLookup.masterBars[].tempoChanges`). Matches the verified recipe in
 * docs/research/libraries.md and alphaTab's own sync points.
 * @module
 */

/** One tempo change in played-order ticks. */
export interface TickTempo {
  tick: number;
  /** Quarter-note BPM. */
  tempo: number;
}

interface TempoPoint {
  tick: number;
  bpm: number;
  /** Seconds at `tick`, relative to the clock origin. */
  sec: number;
}

/** Piecewise-linear tick → seconds map. Immutable after construction. */
export class TickClock {
  private readonly points: TempoPoint[];
  private readonly ppq: number;

  /**
   * @param changes Tempo changes in played order (ticks need not be unique; later wins).
   * @param ppq Ticks per quarter note (`MidiFile.division`).
   * @param fallbackBpm Tempo before the first change (the score tempo).
   * @param origin Tick that maps to 0 s.
   */
  constructor(changes: readonly TickTempo[], ppq: number, fallbackBpm: number, origin = 0) {
    this.ppq = ppq;
    const sorted = [...changes].filter((c) => c.tempo > 0).sort((a, b) => a.tick - b.tick);
    const points: TempoPoint[] = [{ tick: origin, bpm: sorted[0]?.tempo ?? fallbackBpm, sec: 0 }];
    for (const c of sorted) {
      const last = points[points.length - 1] as TempoPoint;
      if (c.tick <= last.tick) {
        // A change at (or before) the origin / the previous point replaces its tempo.
        last.bpm = c.tempo;
        continue;
      }
      if (c.tempo === last.bpm) continue;
      points.push({ tick: c.tick, bpm: c.tempo, sec: last.sec + this.span(c.tick - last.tick, last.bpm) });
    }
    this.points = points;
  }

  private span(ticks: number, bpm: number): number {
    return (ticks * 60) / (bpm * this.ppq);
  }

  /** Seconds at `tick` (ticks before the origin extrapolate at the first tempo). */
  seconds(tick: number): number {
    const { points } = this;
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((points[mid] as TempoPoint).tick <= tick) lo = mid + 1;
      else hi = mid;
    }
    const p = points[Math.max(0, lo - 1)] as TempoPoint;
    return p.sec + this.span(tick - p.tick, p.bpm);
  }

  /** Tempo changes as `{time, bpm}` (the first at 0 s; consecutive duplicates removed). */
  tempoChanges(): { time: number; bpm: number }[] {
    return this.points.map((p) => ({ time: p.sec, bpm: p.bpm }));
  }
}
