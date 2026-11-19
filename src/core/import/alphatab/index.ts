/**
 * alphaTab importer (T-011): GP3–7/GPX, MusicXML and alphaTex → `Song`, via `importer.ScoreLoader`
 * / `AlphaTexImporter` and `midi.MidiFileGenerator` (verified recipe in docs/research/libraries.md).
 * The alphaTab player is never used (D3).
 *
 * Played order comes from `MidiFileGenerator.tickLookup.masterBars` (repeats, voltas and jumps
 * expanded); note onsets are `masterBar.start + beat.playbackStart` in ticks, converted to seconds
 * through the played-order tempo changes ({@link TickClock}). alphaTab numbers strings from the
 * lowest (1 = low E); the model numbers from the highest, so `string = strings − n.string + 1`.
 * @module
 */
import { importer, midi, model, Settings } from '@coderline/alphatab';
import type {
  Bar,
  Chord,
  ImportDiagnostic,
  Note,
  Section,
  Song,
  SongBundle,
  SongTags,
  StringNumber,
  Tech,
  TrackInfo,
  UnsupportedReason,
} from '@shared/song';
import { autoSections, STANDARD_TUNING } from '../../model';
import { ImportError } from '../errors';
import { assignFrets } from '../fret-assign';
import { noteTech } from './techniques';
import { TickClock } from './tick-clock';

/** A parsed alphaTab score plus the settings it was loaded with (guide synth reuses both, T-021). */
export interface AlphaTabScore {
  score: model.Score;
  settings: Settings;
  /** Non-fatal alphaTex warnings (hints are dropped); copied into `Song.diagnostics`. */
  diagnostics?: ImportDiagnostic[];
}

/** General MIDI programs 24–31 (0-based) are guitars; 32–39 are basses. */
const GUITAR_PROGRAMS = { min: 24, max: 31 } as const;
const BASS_PROGRAMS = { min: 32, max: 39 } as const;
/** General MIDI percussion channel (0-based). */
const DRUM_CHANNEL = 9;
/** Name of the section covering bars before the first section marker. */
const LEADING_SECTION_NAME = 'Start';

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

/** True for alphaTex bundles (`.atex`). */
function isAlphaTex(fileName: string): boolean {
  return /\.atex$/i.test(fileName);
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder('utf-8').decode(data);
}

/** alphaTex diagnostic → model diagnostic (`AT202`, 1-based line/column). Hints are dropped. */
function texDiagnostics(tex: importer.AlphaTexImporter): ImportDiagnostic[] {
  const out: ImportDiagnostic[] = [];
  for (const bag of [tex.lexerDiagnostics, tex.parserDiagnostics, tex.semanticDiagnostics]) {
    for (const d of bag.items) {
      if (d.severity !== importer.alphaTex.AlphaTexDiagnosticsSeverity.Error && d.severity !== importer.alphaTex.AlphaTexDiagnosticsSeverity.Warning) continue;
      const diag: ImportDiagnostic = {
        severity: d.severity === importer.alphaTex.AlphaTexDiagnosticsSeverity.Error ? 'error' : 'warning',
        code: `AT${String(d.code).padStart(3, '0')}`,
        message: d.message,
      };
      if (d.start) {
        diag.line = d.start.line;
        diag.column = d.start.col;
      }
      out.push(diag);
    }
  }
  return out;
}

/** Collapse whitespace (alphaTab's MusicXML importer turns spaces into U+00A0) and trim. */
function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load the alphaTab `Score` (bytes via `loadScoreFromBytes`, `.atex` text via `AlphaTexImporter`).
 * Throws `ImportError`: `syntax` (alphaTex errors with line/column diagnostics), `unsupported`
 * (bytes alphaTab cannot read), `empty` (no tracks).
 */
export function loadAlphaTabScore(bundle: SongBundle): AlphaTabScore {
  const settings = new Settings();
  let score: model.Score;
  let diagnostics: ImportDiagnostic[] = [];
  if (isAlphaTex(bundle.fileName)) {
    const tex = new importer.AlphaTexImporter();
    tex.logErrors = false;
    tex.initFromString(decodeUtf8(bundle.data), settings);
    try {
      score = tex.readScore();
    } catch (err) {
      const diags = texDiagnostics(tex);
      const first = diags.find((d) => d.severity === 'error');
      if (!first) throw new ImportError('internal', `alphaTex import failed: ${errorMessage(err)}`, diags, { cause: err });
      throw new ImportError('syntax', `${bundle.fileName}:${first.line ?? '?'}:${first.column ?? '?'} ${first.code} ${first.message}`, diags, { cause: err });
    }
    diagnostics = texDiagnostics(tex);
  } else {
    try {
      score = importer.ScoreLoader.loadScoreFromBytes(bundle.data, settings);
    } catch (err) {
      throw new ImportError('unsupported', `${bundle.fileName} could not be read: ${errorMessage(err)}`, [], { cause: err });
    }
  }
  if (score.tracks.length === 0 || score.masterBars.length === 0) {
    throw new ImportError('empty', `${bundle.fileName} contains no tracks`);
  }
  return diagnostics.length > 0 ? { score, settings, diagnostics } : { score, settings };
}

// ---------------------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------------------

/** The staff carrying tab data (first stringed staff), else the first staff. */
function mainStaff(track: model.Track): model.Staff | undefined {
  return track.staves.find((s) => s.isStringed && s.tuning.length > 0) ?? track.staves[0];
}

/** Notes as written (repeats not expanded), excluding tied destinations. */
function writtenNoteCount(staff: model.Staff): number {
  let count = 0;
  for (const bar of staff.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest) continue;
        for (const n of beat.notes) if (!n.isTieDestination) count++;
      }
    }
  }
  return count;
}

function inRange(value: number, range: { min: number; max: number }): boolean {
  return value >= range.min && value <= range.max;
}

/** Track listing; the effective tuning is `STANDARD_TUNING` for guitar staves without tab data. */
function trackInfo(track: model.Track): TrackInfo {
  const staff = mainStaff(track);
  const program = track.playbackInfo.program;
  const percussion = track.isPercussion || (staff?.isPercussion ?? false) || track.playbackInfo.primaryChannel === DRUM_CHANNEL;
  const hasTab = !percussion && staff !== undefined && staff.tuning.length > 0;
  const noTabGuitar = !percussion && !hasTab && inRange(program, GUITAR_PROGRAMS);
  const tuning = hasTab ? [...(staff?.tuning ?? [])] : noTabGuitar ? [...STANDARD_TUNING] : [];
  const strings = tuning.length;
  const noteCount = staff && !percussion ? writtenNoteCount(staff) : 0;

  let reason: UnsupportedReason | undefined;
  if (percussion) reason = 'drums';
  else if (inRange(program, BASS_PROGRAMS) || strings === 4 || strings === 5) reason = 'bass';
  else if (strings === 0 || (!inRange(program, GUITAR_PROGRAMS) && !(staff?.showTablature ?? false))) reason = 'not-guitar';
  else if (strings !== 6) reason = 'string-count';
  else if (noteCount === 0) reason = 'no-notes';

  const info: TrackInfo = {
    index: track.index,
    name: clean(track.name) || `Track ${track.index + 1}`,
    strings,
    tuning,
    capo: staff?.capo ?? 0,
    playable: reason === undefined,
  };
  if (reason) info.unsupportedReason = reason;
  else info.noteCount = noteCount;
  return info;
}

/**
 * Track listing for a loaded score. Playable = a 6-string stringed staff shown as tablature or
 * with a guitar program (or a guitar-program staff without tab data, fret-assigned in standard
 * tuning) with notes. Bass (program 32–39 or
 * 4–5 strings), drums, 7-string and other instruments are listed with `unsupportedReason`.
 * `noteCount` counts notes as written (repeats not expanded).
 */
export function alphaTabTracks(score: AlphaTabScore): TrackInfo[] {
  return score.score.tracks.map(trackInfo);
}

// ---------------------------------------------------------------------------------------------
// Song conversion
// ---------------------------------------------------------------------------------------------

/** One note before sorting / id assignment. */
interface RawNote {
  time: number;
  dur: number;
  string: StringNumber;
  fret: number;
  midi: number;
  tech: Tech;
  /** alphaTab note (identity is shared across repeat passes). */
  src: model.Note;
  /** Index of the raw note this one is tied from. */
  tiedFrom?: number;
  /** Identifies the beat instance (played bar × beat) for chord grouping. */
  beatKey: number;
  chordName?: string;
  /** Sounding pitch alphaTab reports, used when the position is fret-assigned. */
  realValue: number;
  needsFret: boolean;
}

/** The bar alphaTab actually plays for a simile mark (`%` repeats the previous bar(s)). */
function playbackBar(bar: model.Bar): model.Bar {
  switch (bar.simileMark) {
    case model.SimileMark.Simple:
      return bar.previousBar ? playbackBar(bar.previousBar) : bar;
    case model.SimileMark.FirstOfDouble:
    case model.SimileMark.SecondOfDouble:
      return bar.previousBar?.previousBar ? playbackBar(bar.previousBar.previousBar) : bar;
    default:
      return bar;
  }
}

/** `// riffway: tags=pick,rock` comment in an alphaTex file (`pick`/`fingerstyle` = style, else genre). */
function texTags(bundle: SongBundle): string[] {
  if (!isAlphaTex(bundle.fileName)) return [];
  const m = /^\s*\/\/\s*riffway:\s*tags\s*=\s*(.+?)\s*$/im.exec(decodeUtf8(bundle.data));
  return m?.[1] ? m[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
}

function mergeTags(bundle: SongBundle): SongTags {
  const style = new Set<SongTags['style'][number]>(bundle.tags?.style ?? []);
  const genre = new Set<string>(bundle.tags?.genre ?? []);
  const skills = new Set<string>(bundle.tags?.skills ?? []);
  for (const tag of texTags(bundle)) {
    if (tag === 'pick' || tag === 'fingerstyle') style.add(tag);
    else genre.add(tag);
  }
  return { style: [...style], genre: [...genre], skills: [...skills] };
}

function baseName(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() ?? fileName;
  return name.replace(/\.[^.]+$/, '');
}

/** Index of the last bar starting at or before `time` (bars are contiguous from 0 s). */
function barIndexAt(bars: readonly Bar[], time: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((bars[mid] as Bar).time <= time) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/**
 * Convert one track of a loaded score to a `Song` (string flip, repeats expanded, techniques).
 * Throws `ImportError('bad-arrangement')` when the track is missing or not playable.
 */
export function alphaTabToSong(score: AlphaTabScore, arrangement: number, bundle: SongBundle): Song {
  const tracks = alphaTabTracks(score);
  const info = tracks[arrangement];
  const track = score.score.tracks[arrangement];
  const staff = track ? mainStaff(track) : undefined;
  if (!info || !track || !staff || !info.playable) {
    throw new ImportError('bad-arrangement', `Track ${arrangement} of ${bundle.fileName} is not a playable 6-string guitar track`);
  }
  const diagnostics: ImportDiagnostic[] = [...(score.diagnostics ?? [])];
  const tuning = info.tuning;
  const capo = info.capo;

  // Played order and tempo map from the MIDI generator.
  const midiFile = new midi.MidiFile();
  const gen = new midi.MidiFileGenerator(score.score, score.settings, new midi.AlphaSynthMidiFileHandler(midiFile));
  gen.generate();
  const played = gen.tickLookup.masterBars;
  const ppq = midiFile.division;
  const origin = played[0]?.start ?? 0;
  const clock = new TickClock(
    played.flatMap((m) => m.tempoChanges),
    ppq,
    score.score.tempo,
    origin,
  );
  const sec = (tick: number): number => clock.seconds(tick);

  // Bars (played order). Durations come from consecutive starts so bars are exactly contiguous.
  const bars: Bar[] = played.map((m, i) => {
    const mb = m.masterBar;
    const time = sec(m.start);
    const next = played[i + 1];
    const end = next ? sec(next.start) : sec(m.end);
    const beatTicks = (ppq * 4) / mb.timeSignatureDenominator;
    const beats: number[] = [];
    for (let k = 0; k === 0 || m.start + k * beatTicks < m.end - 1e-9; k++) beats.push(sec(m.start + k * beatTicks));
    return { index: i, sourceIndex: mb.index, time, dur: end - time, num: mb.timeSignatureNumerator, den: mb.timeSignatureDenominator, beats };
  });

  // Notes in played order.
  const raw: RawNote[] = [];
  const lastEmitted = new Map<model.Note, number>();
  let beatKey = 0;
  played.forEach((m) => {
    const written = staff.bars[m.masterBar.index];
    if (!written) return;
    const bar = playbackBar(written);
    const barTicks = m.end - m.start;
    let overfull = false;
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        beatKey++;
        if (beat.isRest || beat.notes.length === 0) continue;
        if (beat.playbackStart >= barTicks) {
          overfull = true;
          continue;
        }
        const tick = m.start + beat.playbackStart;
        if (tick < origin) continue; // grace note before the very first beat
        const endTick = Math.min(tick + beat.playbackDuration, m.end);
        const time = sec(tick);
        const dur = Math.max(0, sec(endTick) - time);
        const chordName = clean(beat.chord?.name) || undefined;
        for (const n of beat.notes) {
          const stringed = n.isStringed && n.string >= 1 && n.string <= tuning.length;
          const string = (stringed ? tuning.length - n.string + 1 : 1) as StringNumber;
          const fret = stringed ? n.fret : 0;
          const open = tuning[string - 1] ?? 0;
          const r: RawNote = {
            time,
            dur,
            string,
            fret,
            midi: open + capo + fret + (n.isHarmonic ? n.realValue - n.realValueWithoutHarmonic : 0),
            tech: noteTech(n),
            src: n,
            beatKey,
            realValue: n.realValue,
            needsFret: !stringed,
          };
          if (chordName) r.chordName = chordName;
          if (n.isTieDestination && n.tieOrigin) {
            const from = lastEmitted.get(n.tieOrigin);
            if (from !== undefined) r.tiedFrom = from;
          }
          lastEmitted.set(n, raw.length);
          raw.push(r);
        }
      }
    }
    if (overfull) {
      diagnostics.push({
        severity: 'warning',
        code: 'overfull-bar',
        message: `Bar ${m.masterBar.index + 1} is longer than its time signature; notes past the bar end were dropped`,
      });
    }
  });

  assignMissingFrets(raw, tuning, capo, diagnostics);
  const { notes, chords } = finishNotes(raw, bars, diagnostics);

  const sections = buildSections(played, bars);
  const last = bars[bars.length - 1];
  const song: Song = {
    schema: 1,
    id: bundle.id ?? '',
    arrangement,
    meta: {
      title: clean(score.score.title) || baseName(bundle.fileName),
      source: bundle.source ?? { source: 'local' },
      tags: mergeTags(bundle),
      tuning: [...tuning],
      capo,
      durationSec: last ? last.time + last.dur : 0,
      rhythm: 'exact',
      tracks,
    },
    timing: { tempos: clock.tempoChanges(), bars },
    sections,
    notes,
    chords,
  };
  const artist = clean(score.score.artist);
  const composer = clean(score.score.music);
  if (artist) song.meta.artist = artist;
  if (composer) song.meta.composer = composer;
  if (diagnostics.length > 0) song.diagnostics = diagnostics;
  return song;
}

/** Fret-assign notes without tab data (MusicXML pitch-only parts); recompute their `midi`. */
function assignMissingFrets(raw: RawNote[], tuning: readonly number[], capo: number, diagnostics: ImportDiagnostic[]): void {
  const pending = raw.filter((r) => r.needsFret);
  if (pending.length === 0) return;
  const positions = assignFrets(
    pending.map((r) => ({ time: r.time, midi: r.realValue, chordId: r.beatKey })),
    tuning,
    capo,
  );
  let shifted = 0;
  pending.forEach((r, i) => {
    const p = positions[i];
    if (!p) return;
    r.string = p.string;
    r.fret = p.fret;
    r.midi = (tuning[p.string - 1] ?? 0) + capo + p.fret;
    if (r.midi !== r.realValue) shifted++;
  });
  diagnostics.push({ severity: 'info', code: 'fret-assigned', message: `${pending.length} notes had no tab data; strings and frets were assigned` });
  if (shifted > 0) {
    diagnostics.push({ severity: 'warning', code: 'out-of-range', message: `${shifted} notes were outside the guitar's range and moved by octaves` });
  }
}

/** Sort, drop string collisions, assign ids, resolve ties and build chord groups. */
function finishNotes(raw: RawNote[], bars: readonly Bar[], diagnostics: ImportDiagnostic[]): { notes: Note[]; chords: Chord[] } {
  const order = raw.map((_, i) => i).sort((a, b) => {
    const ra = raw[a] as RawNote;
    const rb = raw[b] as RawNote;
    return ra.time - rb.time || ra.string - rb.string || a - b;
  });

  const idOf = new Map<number, number>();
  const notes: Note[] = [];
  let dropped = 0;
  for (const i of order) {
    const r = raw[i] as RawNote;
    const prev = notes[notes.length - 1];
    if (prev && prev.time === r.time && prev.string === r.string && r.tiedFrom === undefined && prev.tiedFrom === undefined) {
      dropped++;
      idOf.set(i, prev.id);
      continue;
    }
    const note: Note = { id: notes.length, time: r.time, dur: r.dur, string: r.string, fret: r.fret, midi: r.midi, bar: barIndexAt(bars, r.time), tech: r.tech };
    if (r.tiedFrom !== undefined) {
      const from = idOf.get(r.tiedFrom);
      if (from !== undefined) note.tiedFrom = from;
    }
    idOf.set(i, note.id);
    notes.push(note);
  }
  if (dropped > 0) {
    diagnostics.push({ severity: 'warning', code: 'string-collision', message: `${dropped} notes shared a string and onset with another note and were dropped` });
  }

  // Chords: ≥ 2 non-tied notes from one beat instance.
  const byBeat = new Map<number, { ids: number[]; name?: string }>();
  for (const i of order) {
    const r = raw[i] as RawNote;
    const id = idOf.get(i);
    if (id === undefined || notes[id]?.tiedFrom !== undefined) continue;
    let entry = byBeat.get(r.beatKey);
    if (!entry) {
      entry = r.chordName ? { ids: [], name: r.chordName } : { ids: [] };
      byBeat.set(r.beatKey, entry);
    }
    if (!entry.ids.includes(id)) entry.ids.push(id);
  }
  const chords: Chord[] = [];
  const groups = [...byBeat.values()].filter((g) => g.ids.length >= 2);
  groups.sort((a, b) => (a.ids[0] ?? 0) - (b.ids[0] ?? 0));
  for (const g of groups) {
    const id = chords.length;
    const noteIds = [...g.ids].sort((a, b) => a - b);
    for (const nid of noteIds) (notes[nid] as Note).chordId = id;
    const chord: Chord = { id, time: (notes[noteIds[0] as number] as Note).time, noteIds };
    if (g.name) chord.name = g.name;
    chords.push(chord);
  }
  return { notes, chords };
}

/** Sections from played-order section markers; bars before the first marker form "Start". */
function buildSections(played: readonly midi.MasterBarTickLookup[], bars: readonly Bar[]): Section[] {
  const starts: { bar: number; name: string }[] = [];
  played.forEach((m, i) => {
    const s = m.masterBar.section;
    if (!s) return;
    const name = clean(s.text) || clean(s.marker) || `Section ${starts.length + 1}`;
    starts.push({ bar: i, name });
  });
  if (starts.length === 0) return autoSections({ tempos: [], bars: [...bars] });
  if ((starts[0] as { bar: number }).bar > 0) starts.unshift({ bar: 0, name: LEADING_SECTION_NAME });
  return starts.map((s, k) => {
    const endBar = starts[k + 1]?.bar ?? bars.length;
    const first = bars[s.bar] as Bar;
    const last = bars[endBar - 1] as Bar;
    return { name: s.name, startBar: s.bar, endBar, start: first.time, end: last.time + last.dur };
  });
}
