/**
 * Offline guide render (T-021) in Node with the bundled `sonivox.sf2`: rendered onsets land within
 * ±10 ms of the model's note times at 100% and 50%, pitch (MPM) equals each note's MIDI at 50%,
 * bar-range renders start at their bar's song time, and the length scales with 1 / speed — for
 * the alphaTab generator path and the DEC-21 path (MIDI built from `Song` notes, ClassTab-style
 * ASCII tab).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Song, SongBundle } from '@shared/song';
import { createOnsetDetector, createPitchDetector } from '@core/dsp';
import { loadAlphaTabScore } from '@core/import/alphatab';
import { loadSong } from '@core/import/load-song';
import { recipeFromAlphaTab, recipeFromSong, type MidiRecipe } from '../../src/audio/guide/midi';
import { renderRateFor } from '../../src/audio/guide/rate';
import { GuideSynth, RENDER_CHUNK_MS, deinterleave, type RenderRange } from '../../src/audio/guide/render';
import { ISOLATED_TEX, longTex, texBundle } from './fixtures';

const SR = 48000;
const ONSET_TOLERANCE_SEC = 0.01;
const require = createRequire(import.meta.url);
const SF2_PATH = require.resolve('@coderline/alphatab/soundfont/sonivox.sf2');
const CLASSTAB = new URL('../fixtures/classtab-synthetic/', import.meta.url);
const STARTER = new URL('../../starter/', import.meta.url);

let synth: GuideSynth;

beforeAll(() => {
  synth = new GuideSynth(new Uint8Array(readFileSync(SF2_PATH)));
});

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, CLASSTAB)));
}

/** Mono mix of a whole render. */
function renderMono(recipe: MidiRecipe, range: Omit<RenderRange, 'sampleRate'>): { pcm: Float32Array; chunks: number[] } {
  const parts = [...synth.render(recipe, { sampleRate: SR, ...range })];
  const pcm = new Float32Array(parts.reduce((n, c) => n + c.left.length, 0));
  let o = 0;
  for (const c of parts) {
    for (let i = 0; i < c.left.length; i++) pcm[o + i] = (c.left[i]! + c.right[i]!) / 2;
    o += c.left.length;
  }
  return { pcm, chunks: parts.map((c) => c.left.length) };
}

/** Silence fed to the onset detector first, so a note at sample 0 is an onset too. */
const PAD = 0.5 * SR;

/** Onsets (s) found by the T-015 onset detector, 128-sample hops. */
function detectOnsets(pcm: Float32Array): number[] {
  const padded = new Float32Array(PAD + pcm.length);
  padded.set(pcm, PAD);
  const det = createOnsetDetector({ sampleRate: SR });
  const out: number[] = [];
  for (let f = 0; f + 128 <= padded.length; f += 128) {
    const frame = det.process(padded.subarray(f, f + 128), f);
    if (frame >= 0) out.push((frame - PAD) / SR);
  }
  return out;
}

/** Distinct onset times of struck notes (chord notes and tie continuations collapse). */
function modelOnsets(song: Song): number[] {
  const times = song.notes.filter((n) => n.tiedFrom === undefined).map((n) => n.time);
  return times.filter((t, i) => i === 0 || t - times[i - 1]! > 1e-6);
}

/** Largest |rendered − expected| over all model onsets (expected at render time `t / speed`). */
function maxOnsetError(song: Song, recipe: MidiRecipe, speed: number): number {
  const detected = detectOnsets(renderMono(recipe, { speed, fromBar: 0, toBar: null }).pcm);
  let worst = 0;
  for (const t of modelOnsets(song)) {
    const nearest = detected.reduce((best, d) => (Math.abs(d - t / speed) < Math.abs(best - t / speed) ? d : best), Infinity);
    worst = Math.max(worst, Math.abs(nearest - t / speed));
  }
  return worst;
}

interface Case {
  name: string;
  song: Song;
  recipe: MidiRecipe;
}

function alphaTabCase(bundle: SongBundle): Case {
  const song = loadSong(bundle);
  const { score, settings } = loadAlphaTabScore(bundle);
  return { name: `alphaTab ${bundle.fileName}`, song, recipe: recipeFromAlphaTab(score, settings, song.arrangement) };
}

function classTabSong(): Song {
  return loadSong({
    fileName: 'riffway_study_no1_in_e.txt',
    data: fixture('riffway_study_no1_in_e.txt'),
    midi: { fileName: 'riffway_study_no1_in_e.mid', data: fixture('riffway_study_no1_in_e.mid') },
  });
}

/**
 * Offline synthesis is CPU-bound (seconds for the starter set): with parallel suites on a busy
 * machine the 5 s default timeout flakes, so these tests get a generous one.
 */
const RENDER_TIMEOUT_MS = 60_000;

describe('GuideSynth onsets', { timeout: RENDER_TIMEOUT_MS }, () => {
  const cases = (): Case[] => {
    const isolated = alphaTabCase(texBundle(ISOLATED_TEX));
    const ascii = classTabSong();
    return [
      isolated,
      { name: 'Song notes (DEC-21), isolated notes', song: isolated.song, recipe: recipeFromSong(isolated.song) },
      { name: 'Song notes (DEC-21), ClassTab-style ASCII tab', song: ascii, recipe: recipeFromSong(ascii) },
    ];
  };

  it('ClassTab-style fixture is an ASCII song timed from its MIDI', () => {
    expect(classTabSong().meta.rhythm).toBe('midi');
  });

  for (const speed of [1, 0.5]) {
    it(`every onset is within ±10 ms of the model at ${speed * 100}%`, () => {
      for (const c of cases()) {
        expect({ case: c.name, ok: maxOnsetError(c.song, c.recipe, speed) <= ONSET_TOLERANCE_SEC }).toEqual({ case: c.name, ok: true });
      }
    });
  }
});

describe('GuideSynth pitch', { timeout: RENDER_TIMEOUT_MS }, () => {
  it('rendered pitch equals each note at 50% speed (alphaTab and DEC-21 recipes)', () => {
    const { song, recipe } = alphaTabCase(texBundle(ISOLATED_TEX));
    const speed = 0.5;
    for (const r of [recipe, recipeFromSong(song)]) {
      const { pcm } = renderMono(r, { speed, fromBar: 0, toBar: null });
      const det = createPitchDetector({ sampleRate: SR, size: 2048 });
      // Skip the inharmonic attack: measure 60 ms (real time) after each onset.
      const heard = song.notes.map((n) => det.detect(pcm, Math.round((n.time / speed + 0.06) * SR))?.midi ?? null);
      expect(heard).toEqual(song.notes.map((n) => n.midi));
    }
  });
});

describe('GuideSynth ranges and chunks', { timeout: RENDER_TIMEOUT_MS }, () => {
  it('renders the song length scaled by 1/speed in 5 s chunks', () => {
    const { song, recipe } = alphaTabCase(texBundle(ISOLATED_TEX));
    for (const speed of [1, 0.5]) {
      const { pcm, chunks } = renderMono(recipe, { speed, fromBar: 0, toBar: null });
      expect(Math.abs(pcm.length / SR - song.meta.durationSec / speed)).toBeLessThan(0.005);
      const full = chunks.slice(0, -1);
      expect(full.every((n) => n === (RENDER_CHUNK_MS / 1000) * SR)).toBe(true);
    }
  });

  it('a bar-range render starts at its bar: onsets relative to the bar time', () => {
    const { song, recipe } = alphaTabCase(texBundle(ISOLATED_TEX));
    const speed = 0.5;
    const fromBar = 2;
    const bar = song.timing.bars[fromBar]!;
    const { pcm } = renderMono(recipe, { speed, fromBar, toBar: fromBar + 1 });
    expect(Math.abs(pcm.length / SR - bar.dur / speed)).toBeLessThan(0.005);
    const detected = detectOnsets(pcm);
    const expected = song.notes.filter((n) => n.bar === fromBar).map((n) => (n.time - bar.time) / speed);
    expect(detected).toHaveLength(expected.length);
    detected.forEach((d, i) => expect(Math.abs(d - expected[i]!)).toBeLessThan(ONSET_TOLERANCE_SEC));
  });

  it('never renders at a rate where alphaSynth breaks; refuses non-finite output', () => {
    expect(renderRateFor(48000)).toBe(48000);
    expect(renderRateFor(44100)).toBe(44100);
    expect(renderRateFor(96000)).toBe(96000);
    expect(renderRateFor(22050)).toBe(48000);
    expect(renderRateFor(32000)).toBe(48000);
    const { recipe } = alphaTabCase(texBundle(ISOLATED_TEX));
    // alphaSynth 1.9.0 yields NaN at 22050 Hz: the renderer throws instead of passing it on.
    expect(() => [...synth.render(recipe, { speed: 1, sampleRate: 22050, fromBar: 0, toBar: null })]).toThrow(/invalid samples/);
  });

  it('deinterleave splits alphaSynth stereo', () => {
    expect(deinterleave(new Float32Array([1, 2, 3, 4, 5, 6]))).toEqual({ left: new Float32Array([1, 3, 5]), right: new Float32Array([2, 4, 6]) });
  });

  it('rejects a corrupt soundfont', () => {
    expect(() => new GuideSynth(new Uint8Array([1, 2, 3, 4]))).toThrow(/soundfont/);
  });

  it('renders every starter item (multi-voice and harmonics included) for its full length', () => {
    const files = readdirSync(STARTER).filter((f) => f.endsWith('.atex'));
    expect(files.length).toBeGreaterThanOrEqual(14);
    for (const fileName of files) {
      const { song, recipe } = alphaTabCase({ fileName, data: new Uint8Array(readFileSync(new URL(fileName, STARTER))) });
      const sampleRate = 44100;
      let samples = 0;
      let peak = 0;
      for (const c of synth.render(recipe, { speed: 1, sampleRate, fromBar: 0, toBar: null })) {
        samples += c.left.length;
        for (const x of c.left) peak = Math.max(peak, Math.abs(x));
      }
      expect({ fileName, seconds: samples / sampleRate }).toEqual({ fileName, seconds: expect.closeTo(song.meta.durationSec, 2) });
      expect({ fileName, audible: peak > 0.05 }).toEqual({ fileName, audible: true });
    }
  });

  it('renders a 3-minute song quickly (logged; the < 2 s target is checked in the Chrome worker test)', () => {
    const { recipe } = alphaTabCase(texBundle(longTex(3)));
    const t0 = performance.now();
    const { pcm } = renderMono(recipe, { speed: 1, fromBar: 0, toBar: null });
    const ms = performance.now() - t0;
    console.log(`guide render: 180 s of audio in ${ms.toFixed(0)} ms in Node (${(180000 / ms).toFixed(0)}× real time)`);
    expect(pcm.length / SR).toBeCloseTo(180, 1);
  });
});
