/** Shared helpers for the import tests: fixture bundles and a compact, diff-friendly song summary. */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Song, SongBundle } from '@shared/song';

export const FIXTURES = fileURLToPath(new URL('../fixtures/import/', import.meta.url));

/** Read `tests/fixtures/import/<rel>` into a bundle (file name = base name). */
export function fixture(rel: string, extra: Partial<SongBundle> = {}): SongBundle {
  return { fileName: basename(rel), data: new Uint8Array(readFileSync(join(FIXTURES, rel))), ...extra };
}

/** Milliseconds rounded to 0.1 ms (golden files compare these, not raw floats). */
export const ms = (sec: number): number => Math.round(sec * 10000) / 10;

/**
 * Golden summary: one line per note (`t=… d=… s… f… m… bar… [chord] [tie] {tech}`), bars as
 * `sourceIndex@ms num/den ×beats`, everything else as plain JSON.
 */
export function summarize(song: Song): unknown {
  return {
    meta: { ...song.meta, durationSec: ms(song.meta.durationSec) / 1000 },
    tempos: song.timing.tempos.map((t) => `${ms(t.time)}ms ${t.bpm}bpm`),
    bars: song.timing.bars.map((b) => `${b.sourceIndex}@${ms(b.time)}ms ${b.num}/${b.den} x${b.beats.length} dur=${ms(b.dur)}`),
    sections: song.sections.map((s) => `${s.name} [${s.startBar},${s.endBar}) ${ms(s.start)}-${ms(s.end)}ms`),
    notes: song.notes.map(
      (n) =>
        `${n.id} t=${ms(n.time)} d=${ms(n.dur)} s${n.string} f${n.fret} m${n.midi} bar${n.bar}` +
        (n.chordId !== undefined ? ` chord${n.chordId}` : '') +
        (n.tiedFrom !== undefined ? ` tiedFrom${n.tiedFrom}` : '') +
        (Object.keys(n.tech).length > 0 ? ` ${JSON.stringify(n.tech)}` : ''),
    ),
    chords: song.chords.map((c) => `${c.id} @${ms(c.time)}ms [${c.noteIds.join(',')}]${c.name ? ` ${c.name}` : ''}`),
    diagnostics: song.diagnostics ?? [],
  };
}

/**
 * Everything that must survive a GP7 export round trip. The source ref differs, and GP stores a
 * default tuning on non-guitar tracks, so tracks compare by playability only.
 */
export function musicalContent(song: Song): unknown {
  const { source: _source, tracks, ...meta } = song.meta;
  return {
    meta: { ...meta, tracks: tracks.map((t) => [t.index, t.name, t.playable, t.unsupportedReason, t.noteCount]) },
    timing: song.timing,
    sections: song.sections,
    notes: song.notes,
    chords: song.chords,
  };
}
