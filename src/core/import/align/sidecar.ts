/**
 * Apply a saved rhythm-alignment sidecar (DEC-17) to an ASCII-derived song → `rhythm: 'aligned'`.
 * @module
 */
import type { Note, RhythmSidecar, Song } from '@shared/song';
import { enforceIncreasing } from '../midi';
import { barIndexAt, barSeconds, buildSections, constantBars } from './timing';

/** Onset groups of a song: runs of notes with an identical time (ASCII groups share one time). */
function timeGroups(notes: readonly Note[]): number[][] {
  const groups: number[][] = [];
  for (let i = 0; i < notes.length; i++) {
    const last = groups[groups.length - 1];
    if (last && notes[last[0]].time === notes[i].time) last.push(i);
    else groups.push([i]);
  }
  return groups;
}

/**
 * Apply a saved sidecar to an ASCII-derived song → `rhythm: 'aligned'`. `sidecar.onsets` holds one
 * time per onset group in tab order. Durations keep their share of the gap to the next onset; bars
 * follow the sidecar's BPM and time signature; named sections keep their first note. When the onset
 * count does not match the song's groups (the tab changed since alignment), the song is returned
 * unchanged with a `sidecar-mismatch` warning.
 */
export function applySidecar(song: Song, sidecar: RhythmSidecar): Song {
  const groups = timeGroups(song.notes);
  if (sidecar.onsets.length !== groups.length || groups.length === 0) {
    return {
      ...song,
      diagnostics: [
        ...(song.diagnostics ?? []),
        {
          severity: 'warning',
          code: 'sidecar-mismatch',
          message: `Saved rhythm has ${sidecar.onsets.length} onsets but the tab has ${groups.length}; re-align the song`,
        },
      ],
    };
  }

  const oldTimes = groups.map((g) => song.notes[g[0]].time);
  const newTimes = enforceIncreasing(sidecar.onsets.map((t) => (Number.isFinite(t) ? t : 0)));
  const oldEnd = Math.max(song.meta.durationSec, ...song.notes.map((n) => n.time + n.dur));
  const span = oldTimes[oldTimes.length - 1] - oldTimes[0];
  const globalRatio = span > 0 ? (newTimes[newTimes.length - 1] - newTimes[0]) / span : 1;

  const notes: Note[] = song.notes.map((n) => ({ ...n, tech: { ...n.tech } }));
  groups.forEach((g, k) => {
    const oldGap = (oldTimes[k + 1] ?? oldEnd) - oldTimes[k];
    const newGap = k + 1 < newTimes.length ? newTimes[k + 1] - newTimes[k] : oldGap * globalRatio;
    const ratio = oldGap > 0 ? newGap / oldGap : globalRatio;
    for (const i of g) {
      notes[i].time = newTimes[k];
      notes[i].dur = Math.max(0, song.notes[i].dur * ratio);
    }
  });
  // A note never rings past the next onset on its string.
  const nextOnString = new Map<number, number>();
  for (let i = notes.length - 1; i >= 0; i--) {
    const next = nextOnString.get(notes[i].string);
    if (next !== undefined) notes[i].dur = Math.min(notes[i].dur, next - notes[i].time);
    nextOnString.set(notes[i].string, notes[i].time);
  }

  const end = Math.max(...notes.map((n) => n.time + n.dur), newTimes[newTimes.length - 1]);
  const barDur = barSeconds(sidecar.bpm, sidecar.timeSig);
  const bars = constantBars(sidecar.bpm, sidecar.timeSig, Math.max(1, Math.ceil(end / barDur - 1e-9)));
  for (const n of notes) n.bar = barIndexAt(bars, n.time);

  const auto = song.sections.every((s) => /^Part \d+$/.test(s.name));
  const named = auto
    ? []
    : song.sections.map((s) => {
        const k = oldTimes.findIndex((t) => t >= s.start - 1e-9);
        return { bar: barIndexAt(bars, k >= 0 ? newTimes[k] : end), name: s.name };
      });

  const { tempoEstimated: _estimated, ...meta } = song.meta;
  const last = bars[bars.length - 1];
  return {
    ...song,
    meta: { ...meta, rhythm: 'aligned', durationSec: last.time + last.dur },
    timing: { tempos: [{ time: 0, bpm: sidecar.bpm }], bars },
    sections: buildSections(bars, named),
    notes,
    chords: song.chords.map((c) => ({ ...c, time: notes[c.noteIds[0]].time })),
  };
}
