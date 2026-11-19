/**
 * T-029 end to end over the committed starter library: the real server indexer + real `loadSong` +
 * real `analyzeDifficulty`. Guards the difficulty calibration (docs/difficulty.md § Calibration):
 * every starter item rates within ±1 tier of its manifest `targetTier`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SongMeta } from '@shared/api';
import type { Song } from '@shared/song';
import type { StarterManifest } from '@shared/sources';
import { analyzeDifficulty, tierOf } from '@core/difficulty';
import { loadSong } from '@core/import/load-song';
import { flattenNotes, loadTex } from '../starter/alphatex';
import { STARTER_DIR, entryOf, fetchSongBundle, search, startRealApp, type RealApp } from './real-app';

const manifest = JSON.parse(readFileSync(join(STARTER_DIR, 'manifest.json'), 'utf8')) as StarterManifest;
const items = manifest.items;
const texOf = (slug: string): string => readFileSync(join(STARTER_DIR, `${slug}.atex`), 'utf8');
const loadFromDisk = (slug: string): Song => loadSong({ fileName: `${slug}.atex`, data: new Uint8Array(readFileSync(join(STARTER_DIR, `${slug}.atex`))) });

/** Tuning slug the file declares: standard `(E4 B3 G3 D3 A2 E2)` or Drop D `(… A2 D2)` (starter/README.md). */
function declaredTuning(tex: string): string {
  const m = /\\tuning\s*\(([^)]*)\)/.exec(tex);
  const notes = m?.[1]?.trim().split(/\s+/).join(' ');
  if (notes === 'E4 B3 G3 D3 A2 E2') return 'standard';
  if (notes === 'E4 B3 G3 D3 A2 D2') return 'drop-d';
  throw new Error(`unexpected starter tuning: ${m?.[0] ?? 'none'}`);
}

/** Spearman rank correlation (average ranks for ties). */
function spearman(a: readonly number[], b: readonly number[]): number {
  const rank = (x: readonly number[]): number[] => {
    const order = x.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(x.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
      for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const mean = (x: number[]): number => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

let real: RealApp;
beforeAll(async () => {
  real = await startRealApp();
});
afterAll(async () => {
  await real.close();
});

describe('starter library indexed with real difficulty', () => {
  it('indexes every manifest item and nothing else from starter/', () => {
    const ids = real.ctx.library.all().filter((e) => e.source === 'starter').map((e) => e.id).sort();
    expect(ids).toEqual(items.map((i) => `starter:${i.slug}`).sort());
    expect(items.length).toBe(14);
  });

  it.each(items.map((i) => [i.slug, i] as const))('%s: rated within ±1 of its target tier, with tuning and tags', (slug, item) => {
    const entry = entryOf(real.ctx, `starter:${slug}`);
    expect(entry.error).toBeUndefined();
    expect(entry.format).toBe('alphatex');
    expect(entry.title).toBe(item.title);
    expect(entry.bpm).toBe(item.bpm);
    expect(entry.rhythm).toBe('exact');
    expect(entry.defaultArrangement).toBe(0);
    const difficulty = entry.difficulty!;
    expect(difficulty).not.toBeNull();
    expect(difficulty.provisional).toBe(false);
    expect(difficulty.tier).toBe(tierOf(difficulty.rating));
    expect(Math.abs(difficulty.tier - item.targetTier), `${slug}: rating ${difficulty.rating}, target ${item.targetTier}`).toBeLessThanOrEqual(1);
    expect(entry.tuningId).toBe(declaredTuning(texOf(slug)));
    expect(entry.tuningLabel).toBe(entry.tuningId === 'drop-d' ? 'Drop D' : 'Standard');
    expect(entry.capo).toBe(0);
    for (const s of item.tags.style ?? []) expect(entry.tags.style).toContain(s);
    for (const g of item.tags.genre ?? []) expect(entry.tags.genre).toContain(g);
    expect(entry.tags.skills).toEqual(difficulty.skills);
  });

  it('ratings track the intended tiers across the library (rank correlation ≥ 0.7, mean error ≤ 0.75)', () => {
    const ratings = items.map((i) => entryOf(real.ctx, `starter:${i.slug}`).difficulty!.rating);
    const targets = items.map((i) => i.targetTier);
    expect(spearman(ratings, targets)).toBeGreaterThanOrEqual(0.7);
    const meanError = ratings.reduce((s, r, k) => s + Math.abs(r - targets[k]!), 0) / ratings.length;
    expect(meanError).toBeLessThanOrEqual(0.75);
  });

  it('skill tags reflect what the arrangements teach (starter/README.md)', () => {
    const skills = (slug: string) => entryOf(real.ctx, `starter:${slug}`).tags.skills;
    expect(skills('pentatonic-box-lick')).toEqual(expect.arrayContaining(['bends', 'legato']));
    expect(skills('power-chord-drive')).toContain('chords');
    expect(skills('house-of-the-rising-sun')).toContain('string-skipping');
    expect(skills('hall-of-the-mountain-king')).toContain('position-shifts');
    expect(skills('open-strings-first-frets')).toEqual([]);
  });
});

describe('search over the real index', () => {
  it('"mountain king" finds the starter item with its tier', async () => {
    const { results } = await search(real.app, { q: 'mountain king' });
    const hit = results[0]!;
    const entry = entryOf(real.ctx, 'starter:hall-of-the-mountain-king');
    expect(hit.id).toBe('starter:hall-of-the-mountain-king');
    expect(hit.tier).toBe(entry.difficulty!.tier);
    expect(hit.rating).toBe(entry.difficulty!.rating);
    expect(Math.abs(hit.tier! - 5)).toBeLessThanOrEqual(1);
    expect(hit.ratingProvisional).toBe(false);
    expect(hit.availability).toBe('playable');
    expect(hit.tuningId).toBe('standard');
    expect(hit.composer).toBe(items.find((i) => i.slug === 'hall-of-the-mountain-king')!.composer);
    expect(hit.tags.genre).toContain('metal');
    expect(hit.tags.skills).toEqual(entry.difficulty!.skills);
  });

  it('filters by tuning, tier range and tags (style, genre and difficulty skills)', async () => {
    const ids = async (params: Record<string, string>) => (await search(real.app, { source: 'starter', ...params })).results.map((r) => r.id).sort();
    expect(await ids({ tuning: 'drop-d' })).toEqual(['starter:drop-d-palm-mute-chug']);
    expect(await ids({ tags: 'fingerstyle,classical' })).toEqual(
      expect.arrayContaining(['starter:bourree-in-e-minor', 'starter:spanish-romance']),
    );
    expect(await ids({ tags: 'bends' })).toContain('starter:pentatonic-box-lick');

    const inRange = real.ctx.library
      .all()
      .filter((e) => e.source === 'starter' && e.difficulty && e.difficulty.tier >= 2 && e.difficulty.tier <= 4)
      .map((e) => e.id)
      .sort();
    expect(inRange.length).toBeGreaterThan(0);
    expect(await ids({ tierMin: '2', tierMax: '4' })).toEqual(inRange);
  });
});

describe('GET /api/songs/:id(/file) → loadSong in Node', () => {
  it.each(items.map((i) => i.slug))('%s: served bytes give the indexed note count and difficulty', async (slug) => {
    const entry = entryOf(real.ctx, `starter:${slug}`);
    const song = loadSong(await fetchSongBundle(real.app, entry));
    const track = entry.tracks[entry.defaultArrangement]!;
    expect(track.playable).toBe(true);
    // `noteCount` counts written notes without tie destinations; starter files have no repeats.
    expect(song.notes.filter((n) => n.tiedFrom === undefined).length).toBe(track.noteCount);
    expect(song.notes.length).toBe(loadFromDisk(slug).notes.length);
    expect(song.meta.durationSec).toBeCloseTo(entry.durationSec, 6);
    expect(analyzeDifficulty(song)).toEqual(entry.difficulty);

    const res = await real.app.inject({ method: 'GET', url: `/api/songs/${encodeURIComponent(entry.id)}`, headers: { host: '127.0.0.1' } });
    const meta = res.json<SongMeta>();
    expect(res.statusCode).toBe(200);
    expect(meta.difficulty[entry.defaultArrangement]).toEqual(entry.difficulty);
  });
});

describe('multi-voice starter items', () => {
  // Fingerstyle pieces put the melody in voice 1 and the accompaniment in voice 2 (starter/README.md).
  it.each(['spanish-romance', 'bourree-in-e-minor'])('%s: both voices import as playable notes at their times', (slug) => {
    const tex = texOf(slug);
    expect(tex.match(/^\\voice\b/gm)?.length).toBe(2);
    const tempos = [...tex.matchAll(/\\tempo\s+(\d+)/g)].map((m) => Number(m[1]));
    expect(tempos).toHaveLength(1); // one tempo: ticks convert to seconds directly
    const secPerTick = 60 / tempos[0]! / 960;

    const { score } = loadTex(tex);
    const flat = flattenNotes(score!);
    const voice2 = flat.filter((n) => n.voiceIndex === 1);
    expect(flat.filter((n) => n.voiceIndex === 0).length).toBeGreaterThan(0);
    expect(voice2.length).toBeGreaterThan(20);

    const song = loadFromDisk(slug);
    expect(song.notes.length).toBe(flat.length);
    for (const n of voice2) {
      const time = n.tick * secPerTick;
      const match = song.notes.find((s) => s.string === n.string && s.midi === n.pitch && Math.abs(s.time - time) < 1e-3);
      expect(match, `voice 2 note string ${n.string} pitch ${n.pitch} at ${time.toFixed(3)} s`).toBeDefined();
      expect(match!.tiedFrom !== undefined).toBe(n.note.isTieDestination);
    }
  });
});
