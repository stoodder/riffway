import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { model } from '@coderline/alphatab';
import type { StarterItem, StarterManifest } from '@shared/sources';
import { flattenNotes, loadTex, midiToName, parseRiffwayComments, selectMelody, type FlatNote } from './alphatex';

// Content checks for the committed starter library (T-019, D10). Files are authored by us;
// see starter/README.md for provenance.

const STARTER_DIR = fileURLToPath(new URL('../../starter/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(STARTER_DIR, 'manifest.json'), 'utf8')) as StarterManifest;
const readme = readFileSync(join(STARTER_DIR, 'README.md'), 'utf8');

const STANDARD = [64, 59, 55, 50, 45, 40];
const DROP_D = [64, 59, 55, 50, 45, 38];
/** Lowest note we allow: open low D in Drop D. Highest: E6 (fret 24 / 5th-fret harmonic on high e). */
const MIN_PITCH = 38;
const MAX_PITCH = 88;
const MAX_FRET = 22;
const STYLES = new Set(['pick', 'fingerstyle']);

interface LoadedItem {
  item: StarterItem;
  tex: string;
  score: model.Score;
  notes: FlatNote[];
}

function load(item: StarterItem): LoadedItem {
  const tex = readFileSync(join(STARTER_DIR, `${item.slug}.atex`), 'utf8');
  const { score, diagnostics } = loadTex(tex);
  if (!score || diagnostics.length > 0) throw new Error(`${item.slug}: ${diagnostics.join('; ')}`);
  return { item, tex, score, notes: flattenNotes(score) };
}

const loaded = manifest.items.map(load);

describe('starter manifest', () => {
  it('has schema 1 and the 14 planned items with unique slugs', () => {
    expect(manifest.schema).toBe(1);
    expect(manifest.items).toHaveLength(14);
    expect(new Set(manifest.items.map((i) => i.slug)).size).toBe(14);
  });

  it('lists exactly the .atex files in starter/', () => {
    const files = readdirSync(STARTER_DIR).filter((f) => f.endsWith('.atex')).sort();
    expect(files).toEqual(manifest.items.map((i) => `${i.slug}.atex`).sort());
  });

  it.each(manifest.items)('$slug has complete metadata', (item) => {
    expect(item.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(existsSync(join(STARTER_DIR, `${item.slug}.atex`))).toBe(true);
    expect(item.title.length).toBeGreaterThan(0);
    expect(item.credit).toContain('Arrangement original to Riffway');
    expect(item.publicDomainNote.length).toBeGreaterThan(10);
    expect(item.tags.style.length).toBeGreaterThan(0);
    for (const s of item.tags.style) expect(STYLES.has(s)).toBe(true);
    expect(item.tags.genre.length).toBeGreaterThan(0);
    for (const g of item.tags.genre) expect(g).toMatch(/^[a-z-]+$/);
    expect(Number.isInteger(item.targetTier)).toBe(true);
    expect(item.targetTier).toBeGreaterThanOrEqual(1);
    expect(item.targetTier).toBeLessThanOrEqual(6);
    expect(item.bpm).toBeGreaterThanOrEqual(40);
    expect(item.bpm).toBeLessThanOrEqual(240);
  });

  it('spans every tier from 1 to 6, with pick and fingerstyle items', () => {
    expect(new Set(manifest.items.map((i) => i.targetTier))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(manifest.items.some((i) => i.tags.style.includes('fingerstyle'))).toBe(true);
    expect(manifest.items.some((i) => i.tags.style.includes('pick'))).toBe(true);
  });

  it('README carries a provenance entry for every item', () => {
    expect(readme).toContain('original to Riffway');
    for (const item of manifest.items) expect(readme).toContain(`\`${item.slug}\``);
  });
});

describe.each(loaded)('starter item $item.slug', ({ item, tex, score, notes }) => {
  const staff = score.tracks[0]?.staves[0];
  const header = parseRiffwayComments(tex);

  it('has one 6-string guitar track in standard or Drop D tuning', () => {
    expect(score.tracks).toHaveLength(1);
    expect(score.tracks[0]?.staves).toHaveLength(1);
    const program = score.tracks[0]?.playbackInfo.program ?? -1;
    expect(program).toBeGreaterThanOrEqual(24);
    expect(program).toBeLessThanOrEqual(31);
    expect([STANDARD, DROP_D]).toContainEqual(staff?.tuning);
    expect(staff?.capo).toBe(0);
  });

  it('matches the manifest title and starting tempo', () => {
    expect(score.title).toBe(item.title);
    expect(score.masterBars[0]?.tempoAutomations[0]?.value).toBe(item.bpm);
  });

  it('has at least two sections, starting at bar 1', () => {
    const sections = score.masterBars.filter((mb) => mb.section !== null);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(score.masterBars[0]?.section).not.toBeNull();
    expect(new Set(sections.map((mb) => mb.section?.text)).size).toBe(sections.length);
  });

  it('tags comment agrees with the manifest tags', () => {
    expect(new Set(header.tags)).toEqual(new Set([...item.tags.style, ...item.tags.genre]));
  });

  it('fills every bar exactly (no over- or underfull voices)', () => {
    for (const bar of staff?.bars ?? []) {
      const expected = score.masterBars[bar.index]?.calculateDuration() ?? 0;
      for (const voice of bar.voices) {
        if (voice.isEmpty) continue;
        const total = voice.beats.reduce((sum, b) => sum + b.playbackDuration, 0);
        expect({ bar: bar.index + 1, total }).toEqual({ bar: bar.index + 1, total: expected });
      }
    }
  });

  it('uses no slap/pop/tap beats (alphaTex `{p}` is pop, not pull-off: legato is `{h}` both ways)', () => {
    for (const bar of staff?.bars ?? []) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) expect({ bar: bar.index + 1, pop: beat.pop, slap: beat.slap, tap: beat.tap }).toEqual({ bar: bar.index + 1, pop: false, slap: false, tap: false });
      }
    }
  });

  it('stays within a 6-string guitar range', () => {
    expect(notes.length).toBeGreaterThan(30);
    for (const n of notes) {
      const where = `bar ${n.barIndex + 1} string ${n.string} fret ${n.note.fret}`;
      expect(n.note.fret, where).toBeGreaterThanOrEqual(0);
      expect(n.note.fret, where).toBeLessThanOrEqual(MAX_FRET);
      expect(n.pitch, where).toBeGreaterThanOrEqual(MIN_PITCH);
      expect(n.pitch, where).toBeLessThanOrEqual(MAX_PITCH);
    }
  });

  it('never sounds two notes on one string at once', () => {
    const byString = new Map<number, FlatNote[]>();
    for (const n of notes) byString.set(n.string, [...(byString.get(n.string) ?? []), n]);
    for (const list of byString.values()) {
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1] as FlatNote;
        const cur = list[i] as FlatNote;
        expect(prev.tick + prev.dur, `bar ${cur.barIndex + 1} string ${cur.string}`).toBeLessThanOrEqual(cur.tick);
      }
    }
  });

  it('plays the melody written in its header comment', () => {
    expect(header.melody).not.toBeNull();
    const spec = header.melody;
    if (!spec) return;
    expect(spec.notes.length).toBeGreaterThanOrEqual(8);
    expect(selectMelody(score, spec.section, spec.select)).toEqual(spec.notes);
  });
});

describe('starter library as a whole', () => {
  const all = loaded.flatMap((l) => l.notes.map((n) => n.note));

  it('includes a Drop D piece', () => {
    expect(loaded.some((l) => l.score.tracks[0]?.staves[0]?.tuning[5] === 38)).toBe(true);
  });

  it('uses every technique glyph at least once', () => {
    const has = (pred: (n: model.Note) => boolean): boolean => all.some(pred);
    const legatoUp = (n: model.Note): boolean =>
      n.isHammerPullOrigin && n.hammerPullDestination !== null && n.hammerPullDestination.fret > n.fret;
    const legatoDown = (n: model.Note): boolean =>
      n.isHammerPullOrigin && n.hammerPullDestination !== null && n.hammerPullDestination.fret < n.fret;
    expect(has(legatoUp), 'hammer-on').toBe(true);
    expect(has(legatoDown), 'pull-off').toBe(true);
    expect(has((n) => n.slideOutType === model.SlideOutType.Legato), 'legato slide').toBe(true);
    expect(has((n) => n.slideOutType === model.SlideOutType.Shift), 'shift slide').toBe(true);
    expect(has((n) => n.slideInType !== model.SlideInType.None), 'slide in').toBe(true);
    expect(
      has((n) => n.slideOutType === model.SlideOutType.OutDown || n.slideOutType === model.SlideOutType.OutUp),
      'slide out',
    ).toBe(true);
    expect(has((n) => n.hasBend), 'bend').toBe(true);
    expect(has((n) => n.hasBend && (n.bendPoints?.at(-1)?.value ?? 1) === 0), 'bend and release').toBe(true);
    expect(has((n) => n.isPalmMute), 'palm mute').toBe(true);
    expect(has((n) => n.isLetRing), 'let ring').toBe(true);
    expect(has((n) => n.vibrato !== model.VibratoType.None), 'vibrato').toBe(true);
    expect(has((n) => n.harmonicType === model.HarmonicType.Natural), 'harmonic').toBe(true);
    expect(has((n) => n.isDead), 'dead note').toBe(true);
    expect(has((n) => n.isTieDestination), 'tie').toBe(true);
  });

  it('names pitches with sharps in scientific notation', () => {
    expect(midiToName(60)).toBe('C4');
    expect(midiToName(66)).toBe('F#4');
    expect(midiToName(38)).toBe('D2');
  });
});
