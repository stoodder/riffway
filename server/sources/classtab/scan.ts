/**
 * Lists the extracted ClassTab files and pairs tabs with MIDI files through T-012's
 * `pairClassTab` (basename, suffix, header URL, multi-version rules). The pairing reads every tab's
 * text (decoded UTF-8 → windows-1252 by `decodeText`), so its result is cached in `pairs.json`,
 * keyed by a fingerprint of the folder listing (names, sizes, mtimes).
 * @module
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pairClassTab, type ClassTabFile, type ClassTabPair } from '@core/import/align';
import { decodeText } from '@core/import/ascii';
import type { IndexCandidate } from '@shared/sources';
import { lowerExt } from '../../fs-safety';
import { isRecord, readJsonFile, writeJsonFile } from '../../json-file';
import { CLASSTAB_TAGS, KEPT_EXTENSIONS, README_NAME, classTabPageUrl } from './layout';

/** One file in the extracted folder. */
interface FileInfo {
  name: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/** `pairs.json`. */
interface PairsCache {
  schema: 1;
  fingerprint: string;
  pairs: ClassTabPair[];
}

/** Result of {@link scanClassTab}. */
export interface ClassTabScan {
  /** One candidate per tab (version 1's MIDI for multi-version tabs). */
  candidates: IndexCandidate[];
  /** `.txt` tabs (without the readme) and `.mid` files found. */
  tabs: number;
  midis: number;
  /** Tabs whose (first) version has a MIDI. */
  paired: number;
  /** Tabs holding more than one version. */
  multiVersion: number;
}

/** List kept files (regular, not hidden) in `dir`; [] when it does not exist. */
async function listFiles(dir: string): Promise<FileInfo[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: FileInfo[] = [];
  for (const d of dirents) {
    if (!d.isFile() || d.name.startsWith('.') || !KEPT_EXTENSIONS.includes(lowerExt(d.name))) continue;
    const abs = join(dir, d.name);
    try {
      const st = await stat(abs);
      out.push({ name: d.name, abs, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // vanished while listing
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function fingerprintOf(files: readonly FileInfo[]): string {
  const h = createHash('sha1');
  for (const f of files) h.update(`${f.name}\u0000${f.size}\u0000${f.mtimeMs}\n`);
  return h.digest('hex');
}

function isPair(value: unknown): value is ClassTabPair {
  return isRecord(value) && typeof value.tab === 'string' && (value.midi === null || typeof value.midi === 'string');
}

async function readPairsCache(file: string, fingerprint: string): Promise<ClassTabPair[] | null> {
  const raw = await readJsonFile(file);
  if (!isRecord(raw) || raw.schema !== 1 || raw.fingerprint !== fingerprint || !Array.isArray(raw.pairs)) return null;
  return raw.pairs.every(isPair) ? (raw.pairs as ClassTabPair[]) : null;
}

/** Pair the files with T-012's rules, reading tab text for header URLs and versions. */
async function computePairs(files: readonly FileInfo[]): Promise<ClassTabPair[]> {
  const input: ClassTabFile[] = [];
  for (const f of files) {
    if (lowerExt(f.name) !== '.txt' || f.name.toLowerCase() === README_NAME) {
      input.push({ name: f.name });
      continue;
    }
    try {
      input.push({ name: f.name, text: decodeText(new Uint8Array(await readFile(f.abs))) });
    } catch {
      input.push({ name: f.name });
    }
  }
  return pairClassTab(input);
}

/**
 * Scan the extracted folder `filesDir`: list the files, pair them (cached in `pairsFile`) and build
 * one index candidate per tab with its paired MIDI, the `fingerstyle` / `classical` tags and the
 * tab's classtab.org page URL. Paths are relative to `filesDir`.
 */
export async function scanClassTab(filesDir: string, pairsFile: string): Promise<ClassTabScan> {
  const files = await listFiles(filesDir);
  const fingerprint = fingerprintOf(files);
  let pairs = await readPairsCache(pairsFile, fingerprint);
  if (!pairs) {
    pairs = await computePairs(files);
    if (files.length) await writeJsonFile(pairsFile, { schema: 1, fingerprint, pairs } satisfies PairsCache);
  }
  const byName = new Map(files.map((f) => [f.name, f]));
  const firstPair = new Map<string, ClassTabPair>();
  const versions = new Map<string, number>();
  for (const p of pairs) {
    if (!firstPair.has(p.tab) || p.version === 1) firstPair.set(p.tab, p);
    versions.set(p.tab, (versions.get(p.tab) ?? 0) + 1);
  }

  const candidates: IndexCandidate[] = [];
  let paired = 0;
  for (const [tab, pair] of firstPair) {
    const file = byName.get(tab);
    if (!file) continue;
    const candidate: IndexCandidate = {
      absPath: file.abs,
      relPath: file.name,
      mtimeMs: file.mtimeMs,
      size: file.size,
      tags: { style: [...CLASSTAB_TAGS.style], genre: [...CLASSTAB_TAGS.genre] },
      url: classTabPageUrl(file.name),
    };
    const midi = pair.midi ? byName.get(pair.midi) : undefined;
    if (midi) {
      candidate.midiPath = midi.abs;
      paired++;
    }
    candidates.push(candidate);
  }
  const tabs = files.filter((f) => lowerExt(f.name) === '.txt' && f.name.toLowerCase() !== README_NAME).length;
  return {
    candidates,
    tabs,
    midis: files.filter((f) => lowerExt(f.name) === '.mid').length,
    paired,
    multiVersion: [...versions.values()].filter((n) => n > 1).length,
  };
}
