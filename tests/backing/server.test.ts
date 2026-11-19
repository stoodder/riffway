import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, type AudioUploadResponse } from '@shared/api';
import { sniffAudio } from '../../server/routes/audio';
import { makeTempDirs, multipart, startApp, type TempDirs, type TestApp } from '../server/helpers';
import { clickTrack, encodeWav } from './helpers';

const wav = encodeWav(clickTrack([0.1], 0.3, 8000, 1));
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, 1, 2, 3]);
const m4a = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0]);
const sha1 = (b: Uint8Array): string => createHash('sha1').update(b).digest('hex');

describe('sniffAudio', () => {
  it('recognises WAV, MP3 (ID3 and bare frame sync) and M4A; rejects the rest', () => {
    expect(sniffAudio(wav.subarray(0, 12))).toBe('wav');
    expect(sniffAudio(mp3)).toBe('mp3');
    expect(sniffAudio(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe('mp3');
    expect(sniffAudio(m4a)).toBe('m4a');
    expect(sniffAudio(new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBeNull(); // ADTS (layer bits 00)
    expect(sniffAudio(new TextEncoder().encode('MZ executable'))).toBeNull();
    expect(sniffAudio(new Uint8Array([]))).toBeNull();
  });
});

describe('/api/audio', () => {
  let dirs: TempDirs;
  let t: TestApp;
  const audioDir = (): string => join(dirs.dataDir, 'audio');

  beforeEach(async () => {
    dirs = makeTempDirs();
    t = await startApp(dirs);
  });
  afterEach(async () => {
    await t.app.close();
    dirs.cleanup();
  });

  const upload = async (name: string, data: string | Uint8Array, field = 'file') =>
    t.app.inject({ method: 'POST', url: '/api/audio', ...(await multipart([{ name, data }], field)) });

  it('stores an upload as <sha1>.<ext>, serves it back and deletes it', async () => {
    const res = await upload('My Song (live).WAV', wav);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<AudioUploadResponse>();
    expect(body).toEqual({ audioId: sha1(wav), fileName: 'My Song (live).WAV', ext: '.wav', bytes: wav.length });
    expect(readFileSync(join(audioDir(), `${body.audioId}.wav`))).toEqual(Buffer.from(wav));

    const got = await t.app.inject({ method: 'GET', url: `/api/audio/${body.audioId}` });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('audio/wav');
    expect(Number(got.headers['content-length'])).toBe(wav.length);
    expect(got.rawPayload).toEqual(Buffer.from(wav));

    const del = await t.app.inject({ method: 'DELETE', url: `/api/audio/${body.audioId}` });
    expect(del.statusCode).toBe(204);
    expect(existsSync(join(audioDir(), `${body.audioId}.wav`))).toBe(false);
    expect((await t.app.inject({ method: 'GET', url: `/api/audio/${body.audioId}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/audio/${body.audioId}` })).statusCode).toBe(404);
  });

  it('dedupes identical content and uses the sniffed format for the stored extension', async () => {
    const a = (await upload('a.mp3', mp3)).json<AudioUploadResponse>();
    const b = (await upload('b.mp3', mp3)).json<AudioUploadResponse>();
    expect(a.audioId).toBe(b.audioId);
    // An M4A named .mp3 is stored (and served) as what it is.
    const c = await upload('mislabelled.mp3', m4a);
    expect(c.statusCode).toBe(200);
    expect(c.json<AudioUploadResponse>().ext).toBe('.m4a');
    expect((await t.app.inject({ method: 'GET', url: `/api/audio/${sha1(m4a)}` })).headers['content-type']).toBe('audio/mp4');
    expect(readdirSync(audioDir()).sort()).toEqual([`${sha1(m4a)}.m4a`, `${sha1(mp3)}.mp3`].sort());
  });

  it('rejects disallowed types, non-audio content, empty files and bad requests without leftovers', async () => {
    const exe = await upload('evil.exe', 'MZ');
    expect([exe.statusCode, exe.json().code]).toEqual([415, 'unsupported-type']);
    const fake = await upload('fake.wav', 'not really audio at all');
    expect([fake.statusCode, fake.json().code]).toEqual([415, 'unsupported-type']);
    const empty = await upload('empty.m4a', '');
    expect([empty.statusCode, empty.json().code]).toEqual([400, 'empty']);
    const wrongField = await upload('a.wav', wav, 'files');
    expect(wrongField.statusCode).toBe(400);
    const notMultipart = await t.app.inject({ method: 'POST', url: '/api/audio', payload: { a: 1 } });
    expect(notMultipart.statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/audio/..%2F..%2Fconfig' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/audio/ABC' })).statusCode).toBe(400);
    expect(existsSync(audioDir()) ? readdirSync(audioDir()) : []).toEqual([]);
  });

  it(`caps uploads at ${LIMITS.audioBytes / 1024 / 1024} MB`, async () => {
    const big = new Uint8Array(LIMITS.audioBytes + 1);
    big.set(wav.subarray(0, 44));
    const res = await upload('huge.wav', big);
    expect([res.statusCode, res.json().code]).toEqual([413, 'too-large']);
    expect(readdirSync(audioDir())).toEqual([]);
  }, 30_000);
});
