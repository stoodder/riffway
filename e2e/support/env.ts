/**
 * Test environment for the e2e suite, used by `playwright.config.ts` (runner and workers) and specs:
 * a free port, the throwaway data dir layout, the seeded library folder and the fake-microphone WAV.
 * Node-only; nothing here touches the network.
 * @module
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Authored fixtures the e2e specs use (all committed, none fetched). */
export const FIXTURES = {
  /** Guitar Pro 7 export of `tests/fixtures/import/riff.atex` ("Riff Test"): seeded into the library. */
  riffGp: join(ROOT, 'tests/fixtures/import/gp/riff.gp'),
  /** "Capo Two" (Guitar Pro 7): dropped onto the library in the drag-drop spec. */
  capoGp: join(ROOT, 'tests/fixtures/import/gp/capo.gp'),
  /** UG-style ASCII tab without rhythm ("Synthetic Riff Study"): seeded, shows "Needs rhythm". */
  asciiRiff: join(ROOT, 'tests/fixtures/ascii/ug-style-riff.txt'),
  /** Plain ASCII tab pasted on the Import screen. */
  pasteTab: join(ROOT, 'e2e/fixtures/paste-arpeggio.txt'),
} as const;

/** The committed screenshots for the owner; written only on request (see {@link screenshotDir}). */
export const COMMITTED_SCREENSHOT_DIR = join(ROOT, 'e2e/screenshots');

/** Where an ordinary e2e run writes its screenshots (git-ignored). */
export const SCRATCH_SCREENSHOT_DIR = join(ROOT, 'test-results/e2e-screenshots');

/**
 * The screenshot directory for this run. A plain `npm run test:e2e` writes to
 * {@link SCRATCH_SCREENSHOT_DIR}, so the gate leaves the working tree clean (PNG bytes differ from run
 * to run). `RIFFWAY_UPDATE_SCREENSHOTS=1` (or `true`) refreshes the committed
 * {@link COMMITTED_SCREENSHOT_DIR} instead.
 */
export function screenshotDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return /^(1|true)$/i.test(env.RIFFWAY_UPDATE_SCREENSHOTS ?? '') ? COMMITTED_SCREENSHOT_DIR : SCRATCH_SCREENSHOT_DIR;
}

/** The library folder inside a data dir (`RIFFWAY_LIBRARY_DIR` for the server). */
export function libraryDir(dataDir: string): string {
  return join(dataDir, 'library');
}

/** The WAV Chrome plays as its fake microphone. */
export function fakeMicWav(dataDir: string): string {
  return join(dataDir, 'e2e-input', 'plucked-a2.wav');
}

/** A free TCP port on 127.0.0.1, found synchronously (the config can't await). */
export function freePortSync(): number {
  const script =
    "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});";
  const port = Number(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`freePortSync: bad port "${port}"`);
  return port;
}

/**
 * Seed a data dir: the library folder with the Guitar Pro and ASCII fixtures, and the fake-mic WAV.
 * Idempotent (existing files are left alone), so workers re-evaluating the config change nothing.
 */
export function prepareDataDir(dataDir: string): void {
  const lib = libraryDir(dataDir);
  mkdirSync(lib, { recursive: true });
  for (const [src, name] of [
    [FIXTURES.riffGp, 'Riff Test.gp'],
    [FIXTURES.asciiRiff, 'The Riffway Testers - Synthetic Riff Study.txt'],
  ] as const) {
    const dest = join(lib, name);
    if (!existsSync(dest)) copyFileSync(src, dest);
  }
  const wav = fakeMicWav(dataDir);
  if (!existsSync(wav)) {
    mkdirSync(join(dataDir, 'e2e-input'), { recursive: true });
    writeFileSync(wav, pluckedToneWav(110, 1.2, 4));
  }
}

/**
 * A 16-bit mono 48 kHz WAV of `count` plucks of a guitar-like tone at `freq`, one every `periodSec`.
 * Each pluck decays by ~12 dB, so a level meter visibly moves while a tuner still reads the pitch.
 * `freq × periodSec` should be a whole number: the file then loops seamlessly in Chrome's fake device.
 */
export function pluckedToneWav(freq: number, periodSec: number, count: number, sampleRate = 48_000): Buffer {
  const perPluck = Math.round(periodSec * sampleRate);
  const n = perPluck * count;
  const partials = [0.6, 1, 0.5, 0.35, 0.2];
  const pcm = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < partials.length; k++) v += (partials[k] as number) * Math.sin((2 * Math.PI * freq * (k + 1) * i) / sampleRate + k * 0.7);
    const t = (i % perPluck) / sampleRate;
    const attack = Math.min(1, t / 0.005);
    const env = attack * Math.exp((-t / periodSec) * Math.log(4));
    pcm[i] = v * env;
    peak = Math.max(peak, Math.abs(pcm[i] as number));
  }
  const amp = 0.5;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(((pcm[i] as number) / peak) * amp * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
