/**
 * Test helpers for the starter library (T-019): load alphaTex with full diagnostics, read the
 * `// riffway:` header comments, flatten a score into absolutely-timed notes and pick a melody line.
 * Works directly on alphaTab's model so the content checks do not depend on the importer (T-011).
 * @module
 */
import { importer, Settings, type model } from '@coderline/alphatab';

/** Result of parsing one alphaTex file. */
export interface TexLoadResult {
  /** The parsed score, or `null` when alphaTab threw. */
  score: model.Score | null;
  /** Every lexer, parser and semantic diagnostic (any severity) as `line:col code message`. */
  diagnostics: string[];
}

/**
 * Parses alphaTex and collects every diagnostic, including warnings and hints that
 * `ScoreLoader.loadAlphaTex` would swallow on success.
 */
export function loadTex(tex: string): TexLoadResult {
  const texImporter = new importer.AlphaTexImporter();
  texImporter.logErrors = false;
  texImporter.initFromString(tex, new Settings());
  let score: model.Score | null = null;
  const diagnostics: string[] = [];
  try {
    score = texImporter.readScore();
  } catch (error) {
    diagnostics.push(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bags = [texImporter.lexerDiagnostics, texImporter.parserDiagnostics, texImporter.semanticDiagnostics];
  for (const bag of bags) {
    for (const d of bag.items) {
      diagnostics.push(`${d.start?.line ?? '?'}:${d.start?.col ?? '?'} AT${d.code} ${d.message}`);
    }
  }
  return { score, diagnostics };
}

/** How a melody is picked out of a section (see `starter/README.md`). */
export type MelodySelect = 'top' | 'low' | 'voice1' | 'downbeat';

const SELECTS: readonly MelodySelect[] = ['top', 'low', 'voice1', 'downbeat'];

/** The `// riffway: melody …` declaration of a file. */
export interface MelodySpec {
  section: string;
  select: MelodySelect;
  /** Scientific pitch names with sharps, e.g. `F#4`. */
  notes: string[];
}

/** Parsed `// riffway:` header comments. */
export interface RiffwayHeader {
  /** `tags=` values: style (`pick`, `fingerstyle`) and genre tags, in file order. */
  tags: string[];
  melody: MelodySpec | null;
}

/** Reads the `// riffway: tags=…` and `// riffway: melody …` comments of an alphaTex file. */
export function parseRiffwayComments(tex: string): RiffwayHeader {
  let tags: string[] = [];
  let melody: MelodySpec | null = null;
  for (const line of tex.split('\n')) {
    const tagMatch = /^\/\/ riffway: tags=(\S+)\s*$/.exec(line);
    if (tagMatch?.[1]) tags = tagMatch[1].split(',');
    const melodyMatch = /^\/\/ riffway: melody section="([^"]+)" select=(\w+) notes="([^"]+)"\s*$/.exec(line);
    if (melodyMatch?.[1] && melodyMatch[2] && melodyMatch[3]) {
      const select = melodyMatch[2] as MelodySelect;
      if (!SELECTS.includes(select)) throw new Error(`unknown melody select "${melodyMatch[2]}"`);
      melody = { section: melodyMatch[1], select, notes: melodyMatch[3].trim().split(/\s+/) };
    }
  }
  return { tags, melody };
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** MIDI number → scientific pitch name with sharps (60 → `C4`). */
export function midiToName(midi: number): string {
  return `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** One note of the first track/staff with absolute timing in MIDI ticks (960 per quarter). */
export interface FlatNote {
  note: model.Note;
  barIndex: number;
  voiceIndex: number;
  /** Absolute start tick (master bar start + beat playback start). */
  tick: number;
  /** Beat playback duration in ticks. */
  dur: number;
  /** Sounding MIDI pitch (alphaTab's `realValue`, which already resolves harmonics). */
  pitch: number;
  /** Tab string, 1 = high e (alphaTab numbers strings from the lowest). */
  string: number;
}

/** All notes of track 0 / staff 0 in time order (then low string first). */
export function flattenNotes(score: model.Score): FlatNote[] {
  const staff = score.tracks[0]?.staves[0];
  if (!staff) return [];
  const stringCount = staff.tuning.length;
  const out: FlatNote[] = [];
  for (const bar of staff.bars) {
    const masterBar = score.masterBars[bar.index];
    if (!masterBar) continue;
    bar.voices.forEach((voice, voiceIndex) => {
      for (const beat of voice.beats) {
        for (const note of beat.notes) {
          out.push({
            note,
            barIndex: bar.index,
            voiceIndex,
            tick: masterBar.start + beat.playbackStart,
            dur: beat.playbackDuration,
            pitch: note.realValue,
            string: stringCount - note.string + 1,
          });
        }
      }
    });
  }
  return out.sort((a, b) => a.tick - b.tick || b.string - a.string);
}

/** Bar range `[start, end)` of the section with this name, or `null` when absent. */
export function sectionBars(score: model.Score, name: string): [number, number] | null {
  const starts = score.masterBars.filter((mb) => mb.section !== null);
  const index = starts.findIndex((mb) => mb.section?.text === name);
  const start = starts[index];
  if (!start) return null;
  return [start.index, starts[index + 1]?.index ?? score.masterBars.length];
}

/**
 * Picks the melody of a section as pitch names. Onsets are groups of notes starting on the same
 * tick; tie destinations are skipped. `top`/`low`: highest/lowest note of every onset; `voice1`:
 * highest note of every onset in the first voice; `downbeat`: lowest note of each bar's first onset.
 */
export function selectMelody(score: model.Score, section: string, select: MelodySelect): string[] {
  const range = sectionBars(score, section);
  if (!range) throw new Error(`section "${section}" not found`);
  const [from, to] = range;
  const notes = flattenNotes(score).filter(
    (n) =>
      n.barIndex >= from &&
      n.barIndex < to &&
      !n.note.isTieDestination &&
      (select !== 'voice1' || n.voiceIndex === 0),
  );
  const onsets = new Map<number, FlatNote[]>();
  for (const n of notes) {
    const group = onsets.get(n.tick) ?? [];
    group.push(n);
    onsets.set(n.tick, group);
  }
  const groups = [...onsets.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
  const pitches = (group: FlatNote[]): number[] => group.map((n) => n.pitch);
  if (select === 'downbeat') {
    const seenBars = new Set<number>();
    const out: string[] = [];
    for (const group of groups) {
      const bar = group[0]?.barIndex ?? -1;
      if (seenBars.has(bar)) continue;
      seenBars.add(bar);
      out.push(midiToName(Math.min(...pitches(group))));
    }
    return out;
  }
  return groups.map((g) => midiToName(select === 'low' ? Math.min(...pitches(g)) : Math.max(...pitches(g))));
}
