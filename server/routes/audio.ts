/**
 * Backing audio store (T-027, DEC-13): `POST /api/audio` (multipart, field `file`),
 * `GET /api/audio/:id`, `DELETE /api/audio/:id`.
 *
 * Uploads stream to a hidden temp file in `<dataDir>/audio/` while being hashed; the file must have an
 * allowed extension (`AUDIO_EXTENSIONS`), be non-empty, at most `LIMITS.audioBytes`, and its content
 * must sniff as WAV (`RIFF…WAVE`), MP3 (ID3 tag or MPEG frame sync) or M4A (ISO-BMFF `ftyp`). It is
 * stored content-addressed as `<sha1>.<ext>` (ext from the sniffed format), so the same recording is
 * stored once; the id is the sha1. The original name is only echoed back (never used as a path).
 * @module
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { AUDIO_EXTENSIONS, LIMITS, type AudioUploadResponse } from '@shared/api';
import { lowerExt } from '../fs-safety';
import { sendError } from '../http';
import type { RouteModule } from '../types';

/** Audio formats we accept, by stored extension. */
export type AudioFormat = 'mp3' | 'wav' | 'm4a';

/** `Content-Type` served per stored extension. */
export const AUDIO_CONTENT_TYPES: Readonly<Record<AudioFormat, string>> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
};

/** Bytes needed to sniff a format. */
const SNIFF_BYTES = 12;
const ID_PATTERN = /^[0-9a-f]{40}$/;
const MAX_NAME_LENGTH = 255;

/**
 * Identify an audio file from its first bytes: WAV (`RIFF` + `WAVE`), M4A/MP4 audio (`ftyp` box at
 * offset 4), MP3 (`ID3` tag or an MPEG audio frame sync `0xFFE`). Returns null otherwise.
 */
export function sniffAudio(head: Uint8Array): AudioFormat | null {
  const ascii = (from: number, len: number): string => String.fromCharCode(...head.subarray(from, from + len));
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (head.length >= 8 && ascii(4, 4) === 'ftyp') return 'm4a';
  if (head.length >= 3 && ascii(0, 3) === 'ID3') return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 && (head[1]! & 0x06) !== 0) return 'mp3';
  return null;
}

/** Discard the rest of a part we are not keeping (the multipart parser needs it consumed). */
function drain(part: MultipartFile): Promise<void> {
  return pipeline(part.file, new Writable({ write: (_chunk, _enc, cb) => cb() }));
}

async function readHead(path: string): Promise<Uint8Array> {
  const fh = await open(path, 'r');
  try {
    const buf = new Uint8Array(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Stored file for an id, or null. */
async function findAudio(dir: string, id: string): Promise<{ path: string; format: AudioFormat } | null> {
  for (const format of Object.keys(AUDIO_CONTENT_TYPES) as AudioFormat[]) {
    const path = join(dir, `${id}.${format}`);
    if (await isFile(path)) return { path, format };
  }
  return null;
}

/** Outcome of {@link storeUpload}. */
type StoreResult =
  | { audioId: string; format: AudioFormat; bytes: number }
  | { status: number; code: string; error: string };

/**
 * Stream a part to a temp file in `dir` while hashing it, validate size and content, and move it to
 * `<sha1>.<format>` (kept as is when that content is already stored). The temp file is always gone
 * when this resolves.
 */
async function storeUpload(part: MultipartFile, dir: string): Promise<StoreResult> {
  const tmp = join(dir, `.upload-${randomBytes(6).toString('hex')}.part`);
  try {
    const hash = createHash('sha1');
    let bytes = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(part.file, tap, createWriteStream(tmp, { flags: 'wx' }));
    if (part.file.truncated) {
      return { status: 413, code: 'too-large', error: `Audio files are limited to ${LIMITS.audioBytes / 1024 / 1024} MB` };
    }
    if (bytes === 0) return { status: 400, code: 'empty', error: 'The audio file is empty' };
    const format = sniffAudio(await readHead(tmp));
    if (!format) return { status: 415, code: 'unsupported-type', error: 'The file is not MP3, WAV or M4A audio' };
    const audioId = hash.digest('hex');
    const dest = join(dir, `${audioId}.${format}`);
    if (!(await isFile(dest))) await rename(tmp, dest);
    return { audioId, format, bytes };
  } finally {
    await rm(tmp, { force: true });
  }
}

export const register: RouteModule = async (app, ctx) => {
  const dir = ctx.paths.audioDir;

  app.post('/api/audio', async (req, reply) => {
    if (!req.isMultipart()) return sendError(reply, 400, 'bad-request', 'Expected multipart/form-data with field "file"');
    let part: MultipartFile | undefined;
    try {
      part = await req.file({ limits: { fileSize: LIMITS.audioBytes, files: 1 }, throwFileSizeLimit: false });
    } catch (err) {
      if (err instanceof app.multipartErrors.FilesLimitError) return sendError(reply, 400, 'bad-request', 'Attach one audio file at a time');
      throw err;
    }
    if (!part) return sendError(reply, 400, 'bad-request', 'No file in the request');
    if (part.fieldname !== 'file') {
      await drain(part);
      return sendError(reply, 400, 'bad-request', 'Expected the field "file"');
    }
    const fileName = (part.filename ?? '').trim();
    const ext = lowerExt(fileName);
    if (!fileName || fileName.length > MAX_NAME_LENGTH || /[/\\\0]/.test(fileName)) {
      await drain(part);
      return sendError(reply, 400, 'bad-name', 'Invalid file name');
    }
    if (!AUDIO_EXTENSIONS.includes(ext)) {
      await drain(part);
      return sendError(reply, 415, 'unsupported-type', `Unsupported audio type${ext ? ` ${ext}` : ''}; allowed: ${AUDIO_EXTENSIONS.join(' ')}`);
    }

    await mkdir(dir, { recursive: true });
    const stored = await storeUpload(part, dir);
    if ('error' in stored) return sendError(reply, stored.status, stored.code, stored.error);
    const res: AudioUploadResponse = { audioId: stored.audioId, fileName, ext: `.${stored.format}`, bytes: stored.bytes };
    return res;
  });

  app.get<{ Params: { id: string } }>('/api/audio/:id', async (req, reply) => {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) return sendError(reply, 400, 'bad-id', 'Invalid audio id');
    const found = await findAudio(dir, id);
    if (!found) return sendError(reply, 404, 'not-found', 'No audio with this id');
    const { size } = await stat(found.path);
    return reply
      .header('content-type', AUDIO_CONTENT_TYPES[found.format])
      .header('content-length', size)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(createReadStream(found.path));
  });

  app.delete<{ Params: { id: string } }>('/api/audio/:id', async (req, reply) => {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) return sendError(reply, 400, 'bad-id', 'Invalid audio id');
    const found = await findAudio(dir, id);
    if (!found) return sendError(reply, 404, 'not-found', 'No audio with this id');
    await rm(found.path, { force: true });
    return reply.code(204).send();
  });
};
