/**
 * `asciiToSong`: parse, choose a rhythm source (sidecar → paired MIDI → beat ruler → proportional)
 * and build the `Song` (docs/song-formats.md § ASCII tab parser, § ClassTab pairing).
 * @module
 */
import type { Bar, Chord, ImportDiagnostic, Note, RhythmStatus, Song, SongBundle, SourceRef, TempoChange } from '@shared/song';
import { ImportError } from '../errors';
import { applySidecar } from '../align/sidecar';
import { proportionalTimes } from '../align/grid';
import { rulerRhythm } from '../align/ruler';
import { barIndexAt, barSeconds, buildSections, constantBars, DEFAULT_BPM, DEFAULT_TIME_SIG, extendBars, midiBars } from '../align/timing';
import { alignTabToMidi, MIDI_MATCH_THRESHOLD, readMidiRhythm } from '../midi';
import { decodeText } from './decode';
import { parseTabDetailed, splitVersions, type DetailedTab } from './parse';
import { notePitch } from './pitch';

/** Options for {@link asciiToSong}. */
export interface AsciiToSongOptions {
  /** Song id to stamp (else `bundle.id`, else `''`). */
  id?: string;
  /** 1-based version of a multi-version tab (default 1). */
  version?: number;
}

/** Shortest duration given to a note, seconds. */
const MIN_DUR = 0.05;

/** `Artist - Title.txt` (how pasted tabs are saved) or a humanised ClassTab stem. */
function namesFromFile(fileName: string): { title: string; artist?: string } {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const dash = /^(.+?)\s+-\s+(.+)$/.exec(base);
  if (dash) return { artist: dash[1].trim(), title: dash[2].trim() };
  return { title: base.replace(/_+/g, ' ').trim() || 'Untitled' };
}

interface Rhythm {
  status: RhythmStatus;
  times: number[];
  bars: Bar[];
  tempos: TempoChange[];
  tempoEstimated: boolean;
  /** Tempo/time signature to extend bars with if notes run past them. */
  bpm: number;
  timeSig: [number, number];
}

/**
 * Bundle → `Song`. Rhythm precedence: a matching sidecar (`'aligned'`, the user's explicit
 * alignment), a paired MIDI with ≥ 80% of onset groups matched (`'midi'`), a beat ruler (`'ruler'`),
 * else column-proportional onsets (`'needs-alignment'`). Multi-version tabs import `opts.version`
 * (default 1). Throws `ImportError` (`empty`, `no-playable-track`) when no 6-line staff has notes.
 */
export function asciiToSong(bundle: SongBundle, opts: AsciiToSongOptions = {}): Song {
  const text = decodeText(bundle.data);
  const regions = splitVersions(text);
  const diagnostics: ImportDiagnostic[] = [];
  const vIdx = Math.min(Math.max((opts.version ?? 1) - 1, 0), regions.length - 1);
  const first = parseTabDetailed(regions[0].text);
  const d = vIdx === 0 ? first : parseTabDetailed(regions[vIdx].text, { lineOffset: regions[vIdx].startLine, headerFallback: first.tab.header });
  if (regions.length > 1) {
    diagnostics.push({ severity: 'info', code: 'multiple-versions', message: `The file holds ${regions.length} versions; importing version ${vIdx + 1}` });
  }
  diagnostics.push(...d.tab.diagnostics);
  const { tab } = d;
  if (tab.groups.length === 0) {
    const bass = tab.blocks.length === 0 && tab.diagnostics.some((x) => x.code === 'staff-line-count');
    throw new ImportError(
      bass ? 'no-playable-track' : 'empty',
      bass ? 'No 6-string guitar staff found (bass and 7-string tabs are not supported)' : 'No tab notes found',
      diagnostics,
    );
  }

  const header = tab.header;
  const capo = header.capo ?? 0;
  const bpm = header.tempo ?? DEFAULT_BPM;
  const timeSig: [number, number] = header.timeSig ?? [...DEFAULT_TIME_SIG];
  const est = proportionalTimes(tab.groups, bpm, timeSig);

  let rhythm: Rhythm | null = null;
  if (bundle.midi) rhythm = midiRhythm(bundle.midi.data, d, capo, est, diagnostics);
  if (!rhythm) {
    const ruler = rulerRhythm(d, bpm, header.timeSig);
    diagnostics.push(...ruler.diagnostics);
    if ('times' in ruler) {
      rhythm = {
        status: 'ruler',
        times: ruler.times,
        bars: ruler.bars,
        tempos: [{ time: 0, bpm }],
        tempoEstimated: header.tempo === undefined,
        bpm,
        timeSig: ruler.timeSig,
      };
    }
  }
  rhythm ??= {
    status: 'needs-alignment',
    times: est,
    bars: constantBars(bpm, timeSig, d.barCount),
    tempos: [{ time: 0, bpm }],
    tempoEstimated: header.tempo === undefined,
    bpm,
    timeSig,
  };

  const song = buildSong(bundle, opts, d, rhythm, capo, diagnostics);
  if (!bundle.sidecar) return song;
  const aligned = applySidecar(song, bundle.sidecar);
  return aligned.meta.rhythm === 'aligned' ? aligned : { ...song, diagnostics: aligned.diagnostics };
}

/** Paired-MIDI rhythm, or null (with a diagnostic) when unreadable or under the match threshold. */
function midiRhythm(data: Uint8Array, d: DetailedTab, capo: number, est: readonly number[], diagnostics: ImportDiagnostic[]): Rhythm | null {
  let midi;
  try {
    midi = readMidiRhythm(data);
  } catch (err) {
    diagnostics.push({ severity: 'warning', code: 'midi-unreadable', message: `Paired MIDI could not be read: ${(err as Error).message}` });
    return null;
  }
  const tabGroups = d.tab.groups.map((g, i) => ({
    pitches: g.notes.filter((n) => !n.tech.dead).map((n) => notePitch(d.tab.tuning, capo, n.string, n.fret, n.tech)),
    estTime: est[i],
  }));
  const alignment = alignTabToMidi(tabGroups, midi);
  const pct = Math.round(alignment.matched * 100);
  if (alignment.matched < MIDI_MATCH_THRESHOLD) {
    diagnostics.push({ severity: 'info', code: 'midi-low-match', message: `Only ${pct}% of the tab's onsets matched the paired MIDI (needs 80%); MIDI timing not used` });
    return null;
  }
  diagnostics.push({ severity: 'info', code: 'midi-aligned', message: `${pct}% of the tab's onsets matched the paired MIDI` });
  const last = alignment.times[alignment.times.length - 1];
  const ts = midi.timeSignatures[0];
  return {
    status: 'midi',
    times: alignment.times,
    bars: midiBars(midi.tempos, midi.timeSignatures, Math.max(midi.durationSec, last + 1e-3)),
    tempos: midi.tempos,
    tempoEstimated: false,
    bpm: midi.tempos[midi.tempos.length - 1].bpm,
    timeSig: [ts.num, ts.den],
  };
}

/** Assemble the `Song` from the parsed tab and chosen rhythm. */
function buildSong(bundle: SongBundle, opts: AsciiToSongOptions, d: DetailedTab, rhythm: Rhythm, capo: number, diagnostics: ImportDiagnostic[]): Song {
  const { tab } = d;
  const groups = tab.groups;
  const times = rhythm.times;
  const tuning = tab.tuning;

  // Group-end time for `=` sustains: the first later group of the same block at/after the column.
  const groupEndAt = (gi: number, column: number): number => {
    const block = groups[gi].block;
    for (let k = gi + 1; k < groups.length; k++) {
      if (groups[k].block !== block || groups[k].column < groups[gi].column) return times[k];
      if (groups[k].column >= column) return times[k];
    }
    return times[gi] + barSeconds(rhythm.bpm, rhythm.timeSig) / 4;
  };

  const lastBar = rhythm.bars[rhythm.bars.length - 1];
  const songEnd = lastBar.time + lastBar.dur;
  const draft: (Omit<Note, 'id' | 'bar'> & { group: number })[] = [];
  groups.forEach((g, gi) => {
    const t = times[gi];
    const next = gi + 1 < groups.length ? times[gi + 1] : Math.max(songEnd, t + MIN_DUR);
    for (const n of g.notes) {
      const end = n.sustainEnd !== undefined ? Math.max(next, groupEndAt(gi, n.sustainEnd)) : next;
      draft.push({
        time: t,
        dur: Math.max(MIN_DUR, end - t),
        string: n.string,
        fret: n.fret,
        midi: notePitch(tuning, capo, n.string, n.fret, n.tech),
        column: n.column,
        tech: { ...n.tech },
        group: gi,
      });
    }
  });
  draft.sort((a, b) => a.time - b.time || a.string - b.string);
  // A note never rings past the next onset on its string.
  const nextOnString = new Map<number, number>();
  for (let i = draft.length - 1; i >= 0; i--) {
    const nx = nextOnString.get(draft[i].string);
    if (nx !== undefined) draft[i].dur = Math.min(draft[i].dur, nx - draft[i].time);
    nextOnString.set(draft[i].string, draft[i].time);
  }

  const noteEnd = Math.max(...draft.map((n) => n.time + n.dur));
  const bars = extendBars(rhythm.bars, noteEnd, rhythm.bpm, rhythm.timeSig);
  const chords: Chord[] = [];
  const chordOfGroup = new Map<number, Chord>();
  const notes: Note[] = draft.map(({ group, ...n }, id) => {
    let chordId: number | undefined;
    if (groups[group].notes.length > 1) {
      let chord = chordOfGroup.get(group);
      if (!chord) {
        chord = { id: chords.length, time: n.time, noteIds: [], ...(groups[group].chordName ? { name: groups[group].chordName } : {}) };
        chords.push(chord);
        chordOfGroup.set(group, chord);
      }
      chord.noteIds.push(id);
      chordId = chord.id;
    }
    return { id, ...n, bar: barIndexAt(bars, n.time), ...(chordId !== undefined ? { chordId } : {}) };
  });

  // Named sections start at the first group of their tab bar.
  const named = d.sections.flatMap((s) => {
    const gi = groups.findIndex((g) => g.bar >= s.bar);
    return gi >= 0 ? [{ bar: barIndexAt(bars, times[gi]), name: s.name }] : [];
  });

  const source: SourceRef = { ...(bundle.source ?? { source: 'local', path: bundle.fileName }) };
  if (!source.url && tab.header.midiUrl && source.source === 'classtab') source.url = tab.header.midiUrl;
  const fromFile = namesFromFile(bundle.fileName);
  const useFileNames = source.source !== 'classtab' && fromFile.artist !== undefined;
  const header = tab.header;
  const title = useFileNames ? fromFile.title : header.title ?? fromFile.title;
  const artist = useFileNames ? fromFile.artist : header.artist ?? header.composer;
  const composer = useFileNames ? undefined : header.composer;
  const end = bars[bars.length - 1].time + bars[bars.length - 1].dur;

  return {
    schema: 1,
    id: opts.id ?? bundle.id ?? '',
    arrangement: 0,
    meta: {
      title,
      ...(artist ? { artist } : {}),
      ...(composer ? { composer } : {}),
      source,
      tags: { style: [...(bundle.tags?.style ?? [])], genre: [...(bundle.tags?.genre ?? [])], skills: [...(bundle.tags?.skills ?? [])] },
      tuning: [...tuning],
      capo,
      durationSec: end,
      rhythm: rhythm.status,
      ...(rhythm.tempoEstimated ? { tempoEstimated: true } : {}),
      tracks: [{ index: 0, name: 'Guitar', strings: 6, tuning: [...tuning], capo, playable: true, noteCount: notes.length }],
    },
    timing: { tempos: rhythm.tempos, bars },
    sections: buildSections(bars, named),
    notes,
    chords,
    diagnostics,
  };
}
