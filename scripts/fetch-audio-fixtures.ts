/**
 * Reproduces the recorded-guitar test fixtures in `tests/fixtures/audio/` (T-036, DEC-22):
 *
 * - **University of Iowa MIS — Guitar** (2011, "may be downloaded and used for any projects, without
 *   restrictions"): 15 single notes (13 mf + 2 pp, E2–A5, all six strings) cut from the chromatic
 *   24-bit/96 kHz mono AIFF files into `iowa-single-notes.wav`. Each note gets a 0.6 s slot with its
 *   onset 0.12 s in. There are no published onset annotations: each note is located by hand
 *   (`nearSec`, from the files' chromatic order and their silence-separated attacks), its reference
 *   onset is the first sample of the attack that reaches 10 % of its peak ({@link refineOnset}),
 *   and its pitch is checked with an independent YIN estimate ({@link yinMidi}).
 * - **GuitarSet** (Xi et al., ISMIR 2018, CC BY 4.0): two solo excerpts with their note-level JAMS
 *   annotations (onset, offset, pitch, string). The 657 MB audio zips are not downloaded: the zip
 *   central directory and the two members are read with HTTP range requests.
 *
 * Output: 48 kHz mono 16-bit WAVs (windowed-sinc resampling, 5 ms fade-in, 30 ms fade-out) plus
 * `annotations.json` (notes in clip seconds and provenance with SHA-256 of every source file).
 * Attribution: `tests/fixtures/audio/ATTRIBUTION.md` (hand-written; keep it in sync with the
 * selections below). Downloads are cached (default `<tmpdir>/riffway-audio-fixtures`, ~220 MB of
 * Iowa AIFFs + ~3 MB of GuitarSet members), so re-runs are offline.
 *
 * Usage: `npx tsx scripts/fetch-audio-fixtures.ts [--cache-dir <dir>] [--out <dir>]`.
 * Behind an HTTPS proxy, run it with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) so `fetch` uses it.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { crc32, inflateRawSync } from 'node:zlib';
import { readWav, writeWavMono16 } from '../tests/audio-pipeline/wav';
import type { ClipAnnotation, FixtureManifest } from '../tests/audio-pipeline/manifest';

/** Generic client name (Zenodo rejects some default user agents). */
const USER_AGENT = 'riffway-fixtures/1.0';
const OUT_RATE = 48000;
const FADE_IN_SEC = 0.005;
const FADE_OUT_SEC = 0.03;

const IOWA_BASE = 'https://theremin.music.uiowa.edu/sound%20files/MIS/Piano_Other/guitar/';
const IOWA_PAGE = 'https://theremin.music.uiowa.edu/MISguitar.html';
/** Slot per Iowa note and the onset position inside it (s). */
const IOWA_SLOT_SEC = 0.6;
const IOWA_PRE_SEC = 0.12;

/**
 * Iowa notes, in clip order: chromatic file, expected MIDI, string (1 = high e), dynamic, and the
 * approximate attack time in the file (s). Most files hold one note per silence-separated region;
 * `mf.sul_E.E4B4` and `mf.sul_E.C5B5` put two notes in their first region.
 */
const IOWA_NOTES: readonly { file: string; midi: number; string: number; dynamic: 'pp' | 'mf'; nearSec: number }[] = [
  { file: 'Guitar.mf.sulE.E2B2.mono.aif', midi: 40, string: 6, dynamic: 'mf', nearSec: 0.09 },
  { file: 'Guitar.mf.sulE.E2B2.mono.aif', midi: 43, string: 6, dynamic: 'mf', nearSec: 34.04 },
  { file: 'Guitar.mf.sulA.C3B3.mono.aif', midi: 48, string: 5, dynamic: 'mf', nearSec: 0.04 },
  { file: 'Guitar.mf.sulA.C3B3.mono.aif', midi: 54, string: 5, dynamic: 'mf', nearSec: 62.85 },
  { file: 'Guitar.mf.sulD.D3B3.mono.aif', midi: 50, string: 4, dynamic: 'mf', nearSec: 0.03 },
  { file: 'Guitar.mf.sulD.D3B3.mono.aif', midi: 57, string: 4, dynamic: 'mf', nearSec: 83.47 },
  { file: 'Guitar.mf.sulG.C4B4.mono.aif', midi: 60, string: 3, dynamic: 'mf', nearSec: 0.02 },
  { file: 'Guitar.mf.sulG.C4B4.mono.aif', midi: 67, string: 3, dynamic: 'mf', nearSec: 51.72 },
  { file: 'Guitar.mf.sul_E.E4B4.mono.aif', midi: 64, string: 1, dynamic: 'mf', nearSec: 0.04 },
  { file: 'Guitar.mf.sul_E.E4B4.mono.aif', midi: 71, string: 1, dynamic: 'mf', nearSec: 52.44 },
  { file: 'Guitar.mf.sulB.C5Gb5.mono.aif', midi: 72, string: 2, dynamic: 'mf', nearSec: 0.02 },
  { file: 'Guitar.mf.sulB.C5Gb5.mono.aif', midi: 77, string: 2, dynamic: 'mf', nearSec: 32.1 },
  { file: 'Guitar.mf.sul_E.C5B5.mono.aif', midi: 81, string: 1, dynamic: 'mf', nearSec: 53.77 },
  { file: 'Guitar.pp.sulE.E2B2.mono.aif', midi: 41, string: 6, dynamic: 'pp', nearSec: 11.99 },
  { file: 'Guitar.pp.sul_E.E4B4.mono.aif', midi: 68, string: 1, dynamic: 'pp', nearSec: 23.26 },
];

const GUITARSET_RECORD = 'https://zenodo.org/records/3371780';
const GUITARSET_FILES = 'https://zenodo.org/api/records/3371780/files/';

/** GuitarSet excerpts: track, which audio zip, excerpt start and length in the track (s). */
const GUITARSET_EXCERPTS: readonly { id: string; track: string; audio: 'mic' | 'pickup_mix'; startSec: number; durSec: number }[] = [
  { id: 'guitarset-rock1-mic', track: '01_Rock1-90-C#_solo', audio: 'mic', startSec: 9.0, durSec: 4.5 },
  { id: 'guitarset-rock2-pickup', track: '03_Rock2-142-D_solo', audio: 'pickup_mix', startSec: 6.8, durSec: 4.6 },
];
/** An excerpt may not cut an annotated note: no onset this close to either edge (s). */
const EDGE_GUARD_SEC = 0.15;

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

async function httpGet(url: string, range?: { start: number; end: number }): Promise<Uint8Array> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (range) headers.Range = `bytes=${range.start}-${range.end - 1}`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (range ? res.status !== 206 : !res.ok) throw new Error(`GET ${url}${range ? ` [${range.start}, ${range.end})` : ''}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function httpSize(url: string): Promise<number> {
  const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  const len = Number(res.headers.get('content-length'));
  if (!res.ok || !(len > 0)) throw new Error(`HEAD ${url}: HTTP ${res.status}, length ${len}`);
  return len;
}

/** Read `path` from the cache, or download it with `fetchBytes` and cache it. */
async function cached(path: string, fetchBytes: () => Promise<Uint8Array>): Promise<Uint8Array> {
  if (existsSync(path)) return new Uint8Array(await readFile(path));
  const bytes = await fetchBytes();
  await writeFile(path, bytes);
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Zip members over HTTP range requests (no zip64: the GuitarSet mono zips are < 4 GiB)
// ---------------------------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeader: number;
}

/** Central directory of a remote zip (EOCD and directory fetched with range requests). */
async function remoteZipDirectory(url: string): Promise<Map<string, ZipEntry>> {
  const total = await httpSize(url);
  const tailStart = Math.max(0, total - 65536 - 22);
  const tail = await httpGet(url, { start: tailStart, end: total });
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${url}: end of central directory not found`);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOffset = tv.getUint32(eocd + 16, true);
  const cd = cdOffset >= tailStart ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize) : await httpGet(url, { start: cdOffset, end: cdOffset + cdSize });
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = new Map<string, ZipEntry>();
  for (let at = 0; at + 46 <= cd.length; ) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error(`${url}: bad central directory entry at ${at}`);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const name = new TextDecoder().decode(cd.subarray(at + 46, at + 46 + nameLen));
    entries.set(name.split('/').pop() ?? name, {
      name,
      method: v.getUint16(at + 10, true),
      crc: v.getUint32(at + 16, true),
      compressedSize: v.getUint32(at + 20, true),
      size: v.getUint32(at + 24, true),
      localHeader: v.getUint32(at + 42, true),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Download and inflate one zip member (stored or deflated), CRC-checked. */
async function remoteZipMember(url: string, entry: ZipEntry): Promise<Uint8Array> {
  const header = await httpGet(url, { start: entry.localHeader, end: entry.localHeader + 30 });
  const hv = new DataView(header.buffer, header.byteOffset, 30);
  if (hv.getUint32(0, true) !== 0x04034b50) throw new Error(`${entry.name}: bad local header`);
  const dataStart = entry.localHeader + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  const raw = await httpGet(url, { start: dataStart, end: dataStart + entry.compressedSize });
  let data: Uint8Array;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = new Uint8Array(inflateRawSync(raw));
  else throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
  if (data.length !== entry.size || crc32(data) >>> 0 !== entry.crc) throw new Error(`${entry.name}: size/CRC mismatch`);
  return data;
}

// ---------------------------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------------------------

/** Decode a mono/multi-channel AIFF (big-endian integer PCM); returns channel 0 and the rate. */
function readAiff(bytes: Uint8Array): { sampleRate: number; samples: Float32Array } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (id(0) !== 'FORM' || id(8) !== 'AIFF') throw new Error('not an AIFF file');
  let channels = 0;
  let frames = 0;
  let bits = 0;
  let sampleRate = 0;
  let data = -1;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = v.getUint32(at + 4);
    if (id(at) === 'COMM') {
      channels = v.getInt16(at + 8);
      frames = v.getUint32(at + 10);
      bits = v.getInt16(at + 14);
      // 80-bit IEEE extended: sign+exponent (15 bits, bias 16383) and a 64-bit mantissa with explicit integer bit.
      const exp = (v.getUint16(at + 16) & 0x7fff) - 16383;
      const mant = v.getUint32(at + 18) * 2 ** 32 + v.getUint32(at + 22);
      sampleRate = mant * 2 ** (exp - 63);
    } else if (id(at) === 'SSND') {
      data = at + 16 + v.getUint32(at + 8);
    }
    at += 8 + size + (size & 1);
  }
  if (data < 0 || channels < 1 || ![16, 24, 32].includes(bits)) throw new Error(`unsupported AIFF (${channels} ch, ${bits}-bit)`);
  const step = (bits / 8) * channels;
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const at = data + i * step;
    if (bits === 16) samples[i] = v.getInt16(at) / 0x8000;
    else if (bits === 24) samples[i] = ((v.getInt8(at) << 16) | (v.getUint8(at + 1) << 8) | v.getUint8(at + 2)) / 0x800000;
    else samples[i] = v.getInt32(at) / 0x80000000;
  }
  return { sampleRate, samples };
}

/** Zeroth-order modified Bessel function (Kaiser window). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * Kaiser-windowed sinc resampler: `count` output samples at `outRate`, output sample `j` taken at
 * input position `start + j × inRate / outRate`. Cut-off at 0.95 × the lower Nyquist, 32 zero
 * crossings each side, β = 8.6 (≈ −90 dB stop band).
 */
function resample(input: Float32Array, inRate: number, outRate: number, start: number, count: number): Float32Array {
  const ratio = inRate / outRate;
  const fc = 0.95 * Math.min(1, outRate / inRate);
  const half = Math.ceil(32 / fc);
  const beta = 8.6;
  const norm = besselI0(beta);
  const out = new Float32Array(count);
  for (let j = 0; j < count; j++) {
    const pos = start + j * ratio;
    const centre = Math.floor(pos);
    let acc = 0;
    for (let k = centre - half + 1; k <= centre + half; k++) {
      if (k < 0 || k >= input.length) continue;
      const t = pos - k;
      const r = t / half;
      if (r <= -1 || r >= 1) continue;
      const x = Math.PI * fc * t;
      const sinc = t === 0 ? 1 : Math.sin(x) / x;
      acc += input[k] * fc * sinc * (besselI0(beta * Math.sqrt(1 - r * r)) / norm);
    }
    out[j] = acc;
  }
  return out;
}

/** Linear fades in place. */
function fade(signal: Float32Array, sampleRate: number): Float32Array {
  const fin = Math.round(FADE_IN_SEC * sampleRate);
  const fout = Math.round(FADE_OUT_SEC * sampleRate);
  for (let i = 0; i < fin; i++) signal[i] *= i / fin;
  for (let i = 0; i < fout; i++) signal[signal.length - 1 - i] *= i / fout;
  return signal;
}

/** High-pass corner applied to every source before slicing (Hz); see {@link highPass}. */
const HIGH_PASS_HZ = 30;

/**
 * Zero-phase high-pass in place: a 2nd-order Butterworth biquad (RBJ) run forward and backward
 * (4th-order magnitude, no phase shift, so attacks are not smeared). The Iowa recordings carry
 * strong sub-30 Hz rumble (often louder than the note below 30 Hz); a guitar's pickup into an
 * AC-coupled interface has none, so the fixtures leave it out.
 */
function highPass(x: Float32Array, sampleRate: number, cutoffHz = HIGH_PASS_HZ): Float32Array {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const y = Float64Array.from(x);
  const pass = (from: number, to: number, step: number): void => {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = from; i !== to; i += step) {
      const v = y[i];
      const out = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = out;
      y[i] = out;
    }
  };
  pass(0, y.length, 1);
  pass(y.length - 1, -1, -1);
  x.set(y);
  return x;
}

/**
 * Reference onset of the note attacked near `nearSec`: within [near − 0.1 s, near + 0.15 s], the
 * first sample whose magnitude reaches 10 % (−20 dB) of the window's peak. A level threshold on an
 * isolated note, independent of the detector under test; on slow fingertip attacks it marks the
 * steep part of the rise, a few ms after the first audible sound.
 * @throws Error when anything in the `preSec` before that sample reaches 10 % of the peak (not an
 *   isolated attack: the slot's pre-roll would hold another event).
 */
function refineOnset(x: Float32Array, sampleRate: number, nearSec: number, preSec: number): number {
  const from = Math.max(0, Math.round((nearSec - 0.1) * sampleRate));
  const to = Math.min(x.length, Math.round((nearSec + 0.15) * sampleRate));
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = from; i < to; i++) {
    if (Math.abs(x[i]) < 0.1 * peak) continue;
    let before = 0;
    for (let k = Math.max(0, i - Math.round(preSec * sampleRate)); k < i - Math.round(0.002 * sampleRate); k++) before = Math.max(before, Math.abs(x[k]));
    if (before >= 0.1 * peak) throw new Error(`no isolated attack near ${nearSec} s (pre-roll peak ${(20 * Math.log10(before / peak)).toFixed(1)} dB re note)`);
    return i;
  }
  throw new Error(`no attack near ${nearSec} s`);
}

/**
 * YIN pitch (de Cheveigné & Kawahara 2002: cumulative-mean-normalised difference, threshold 0.1,
 * parabolic refinement) of the 4096-sample window starting at `start`, as fractional MIDI. Used only
 * to confirm the hand-located Iowa notes; deliberately a different algorithm from the MPM tracker
 * under test.
 */
function yinMidi(x: Float32Array, sampleRate: number, start: number): number {
  const w = 4096;
  const maxTau = Math.min(w / 2, Math.ceil(sampleRate / 70));
  const minTau = Math.floor(sampleRate / 1200);
  const d = new Float64Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < w - maxTau; i++) {
      const diff = x[start + i] - x[start + i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  let running = 0;
  const cmnd = new Float64Array(maxTau + 1).fill(1);
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let best = -1;
  for (let tau = minTau; tau < maxTau; tau++) {
    if (cmnd[tau] < 0.1) {
      while (tau + 1 < maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    best = minTau;
    for (let tau = minTau; tau < maxTau; tau++) if (cmnd[tau] < cmnd[best]) best = tau;
  }
  const a = cmnd[best - 1];
  const b = cmnd[best];
  const c = cmnd[best + 1];
  const den = a - 2 * b + c;
  const period = best + (den !== 0 ? (0.5 * (a - c)) / den : 0);
  return 69 + 12 * Math.log2(sampleRate / period / 440);
}

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

async function buildIowa(cacheDir: string): Promise<{ clip: ClipAnnotation; samples: Float32Array }> {
  const decoded = new Map<string, { sampleRate: number; samples: Float32Array }>();
  const out = new Float32Array(Math.round(IOWA_NOTES.length * IOWA_SLOT_SEC * OUT_RATE));
  const notes: ClipAnnotation['notes'] = [];
  const sources: ClipAnnotation['sources'] = [];
  for (const [i, n] of IOWA_NOTES.entries()) {
    let file = decoded.get(n.file);
    if (!file) {
      const url = IOWA_BASE + encodeURIComponent(n.file);
      const bytes = await cached(join(cacheDir, n.file), () => httpGet(url));
      const aiff = readAiff(bytes);
      file = { sampleRate: aiff.sampleRate, samples: highPass(aiff.samples, aiff.sampleRate) };
      decoded.set(n.file, file);
      sources.push({ file: n.file, url, sha256: sha256(bytes) });
    }
    const onset = refineOnset(file.samples, file.sampleRate, n.nearSec, IOWA_PRE_SEC);
    const pitch = yinMidi(file.samples, file.sampleRate, onset + Math.round(0.1 * file.sampleRate));
    if (Math.abs(pitch - n.midi) > 0.5) throw new Error(`${n.file} @ ${n.nearSec} s: expected MIDI ${n.midi}, YIN says ${pitch.toFixed(2)}`);
    const slotStart = onset - IOWA_PRE_SEC * file.sampleRate;
    const slot = fade(resample(file.samples, file.sampleRate, OUT_RATE, slotStart, Math.round(IOWA_SLOT_SEC * OUT_RATE)), OUT_RATE);
    out.set(slot, Math.round(i * IOWA_SLOT_SEC * OUT_RATE));
    notes.push({
      onsetSec: round6(i * IOWA_SLOT_SEC + IOWA_PRE_SEC),
      offsetSec: round6((i + 1) * IOWA_SLOT_SEC),
      midi: n.midi,
      string: n.string,
      dynamic: n.dynamic,
      origin: `${n.file} @ ${(onset / file.sampleRate).toFixed(4)} s (YIN ${pitch.toFixed(2)})`,
    });
  }
  const clip: ClipAnnotation = {
    id: 'iowa-single-notes',
    file: 'iowa-single-notes.wav',
    sampleRate: OUT_RATE,
    durationSec: round6(out.length / OUT_RATE),
    dataset: 'University of Iowa MIS — Guitar (2011), mono 24-bit/96 kHz, Earthworks QTC40 at 5 ft, anechoic',
    license: 'Unrestricted ("may be downloaded and used for any projects, without restrictions")',
    homepage: IOWA_PAGE,
    onsetReference: 'derived',
    notes,
    sources,
  };
  return { clip, samples: out };
}

async function buildGuitarSet(cacheDir: string): Promise<{ clip: ClipAnnotation; samples: Float32Array }[]> {
  const gsDir = join(cacheDir, 'guitarset');
  await mkdir(gsDir, { recursive: true });
  const dirs = new Map<string, Map<string, ZipEntry>>();
  const member = async (zip: string, name: string): Promise<Uint8Array> =>
    cached(join(gsDir, name), async () => {
      const url = `${GUITARSET_FILES}${zip}/content`;
      let dir = dirs.get(zip);
      if (!dir) {
        dir = await remoteZipDirectory(url);
        dirs.set(zip, dir);
      }
      const entry = dir.get(name);
      if (!entry) {
        const similar = [...dir.keys()].filter((k) => k.startsWith(name.slice(0, 12))).join(', ');
        throw new Error(`${zip}: no member ${name} (similar: ${similar || 'none'})`);
      }
      return remoteZipMember(url, entry);
    });

  const result: { clip: ClipAnnotation; samples: Float32Array }[] = [];
  for (const ex of GUITARSET_EXCERPTS) {
    const jamsName = `${ex.track}.jams`;
    const wavName = `${ex.track}_${ex.audio === 'mic' ? 'mic' : 'mix'}.wav`;
    const zip = ex.audio === 'mic' ? 'audio_mono-mic.zip' : 'audio_mono-pickup_mix.zip';
    const jamsBytes = await member('annotation.zip', jamsName);
    const wavBytes = await member(zip, wavName);
    const wav = readWav(wavBytes);
    const end = ex.startSec + ex.durSec;
    const notes = guitarSetNotes(jamsBytes).filter((n) => n.onset > ex.startSec - EDGE_GUARD_SEC && n.onset < end);
    for (const n of notes) {
      if (n.onset < ex.startSec + EDGE_GUARD_SEC || n.onset > end - EDGE_GUARD_SEC) {
        throw new Error(`${ex.id}: annotated onset ${n.onset.toFixed(3)} s is within ${EDGE_GUARD_SEC} s of the excerpt edge`);
      }
    }
    const count = Math.round(ex.durSec * OUT_RATE);
    const samples = fade(resample(highPass(wav.channels[0], wav.sampleRate), wav.sampleRate, OUT_RATE, ex.startSec * wav.sampleRate, count), OUT_RATE);
    result.push({
      clip: {
        id: ex.id,
        file: `${ex.id}.wav`,
        sampleRate: OUT_RATE,
        durationSec: ex.durSec,
        dataset: `GuitarSet v1.1.0, ${ex.track} (${ex.audio === 'mic' ? 'acoustic guitar, mono microphone' : 'hexaphonic pickup summed to mono'}), ${ex.startSec}–${end} s`,
        license: 'CC BY 4.0',
        homepage: GUITARSET_RECORD,
        onsetReference: 'annotated',
        notes: notes.map((n) => ({
          onsetSec: round6(n.onset - ex.startSec),
          offsetSec: round6(Math.min(ex.durSec, n.onset + n.dur - ex.startSec)),
          midi: Math.round(n.midi),
          midiExact: round6(n.midi),
          string: n.string,
        })),
        sources: [
          { file: `annotation.zip/${jamsName}`, url: `${GUITARSET_FILES}annotation.zip/content`, sha256: sha256(jamsBytes) },
          { file: `${zip}/${wavName}`, url: `${GUITARSET_FILES}${zip}/content`, sha256: sha256(wavBytes) },
        ],
      },
      samples,
    });
  }
  return result;
}

/** Notes of a GuitarSet JAMS file (`note_midi` annotations, one per string, low E first). */
function guitarSetNotes(jams: Uint8Array): { onset: number; dur: number; midi: number; string: number }[] {
  const doc = JSON.parse(new TextDecoder().decode(jams)) as {
    annotations: { namespace: string; data: { time: number; duration: number; value: number }[] }[];
  };
  const perString = doc.annotations.filter((a) => a.namespace === 'note_midi');
  if (perString.length !== 6) throw new Error(`expected 6 note_midi annotations, got ${perString.length}`);
  return perString
    .flatMap((a, i) => a.data.map((d) => ({ onset: d.time, dur: d.duration, midi: d.value, string: 6 - i })))
    .sort((a, b) => a.onset - b.onset);
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    'cache-dir': { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log('Usage: npx tsx scripts/fetch-audio-fixtures.ts [--cache-dir <dir>] [--out <dir>]');
  process.exit(0);
}
const cacheDir = resolve(values['cache-dir'] ?? join(tmpdir(), 'riffway-audio-fixtures'));
const outDir = resolve(values.out ?? 'tests/fixtures/audio');
await mkdir(cacheDir, { recursive: true });
await mkdir(outDir, { recursive: true });

const built = [await buildIowa(cacheDir), ...(await buildGuitarSet(cacheDir))];
let total = 0;
for (const { clip, samples } of built) {
  const bytes = writeWavMono16(samples, OUT_RATE);
  total += bytes.length;
  await writeFile(join(outDir, clip.file), bytes);
  console.log(`${clip.file}: ${clip.notes.length} notes, ${clip.durationSec} s, ${(bytes.length / 1024).toFixed(0)} KiB`);
}
const manifest: FixtureManifest = {
  schema: 1,
  generatedBy: 'scripts/fetch-audio-fixtures.ts',
  attribution: 'ATTRIBUTION.md',
  clips: built.map((b) => b.clip),
};
await writeFile(join(outDir, 'annotations.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MiB of audio in ${outDir}`);
