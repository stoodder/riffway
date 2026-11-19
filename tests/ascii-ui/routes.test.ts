import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, type PasteResponse, type SidecarsBundle } from '@shared/api';
import type { RhythmSidecar } from '@shared/song';
import { parseSidecar, pasteFileName } from '../../server/routes/sidecars';
import { fakeSong, makeTempDirs, startApp, type TempDirs, type TestApp } from '../server/helpers';
import { ARPEGGIO } from './tabs';

const sidecar = (n: number, over: Partial<RhythmSidecar> = {}): RhythmSidecar => ({
  schema: 1,
  bpm: 100,
  timeSig: [4, 4],
  grid: 8,
  onsets: Array.from({ length: n }, (_, i) => i * 0.3),
  method: 'snap',
  savedAt: 1700000000000,
  ...over,
});

const localId = (text: string): string => `local:${createHash('sha1').update(text).digest('hex').slice(0, 16)}`;

describe('sidecar + paste routes', () => {
  let dirs: TempDirs;
  let t: TestApp;

  beforeEach(() => {
    dirs = makeTempDirs();
  });
  afterEach(async () => {
    await t.app.close();
    dirs.cleanup();
  });

  const paste = (body: unknown) => t.app.inject({ method: 'POST', url: '/api/library/paste', payload: body as object });
  const sidecarFile = (id: string): string => join(dirs.dataDir, 'sidecars', `${encodeURIComponent(id)}.json`);

  describe('POST /api/library/paste', () => {
    it('writes "Artist - Title.txt" and the sidecar, indexes it at once and returns its id', async () => {
      t = await startApp(dirs);
      const sc = sidecar(16);
      const res = await paste({ title: 'Arpeggio', artist: 'Riffway', text: ARPEGGIO, sidecar: sc });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<PasteResponse>();
      expect(body).toEqual({ id: localId(ARPEGGIO), path: 'Riffway - Arpeggio.txt' });
      expect(readFileSync(join(dirs.libraryDir, body.path), 'utf8')).toBe(ARPEGGIO);
      expect(JSON.parse(readFileSync(sidecarFile(body.id), 'utf8'))).toEqual(sc);
      const entry = t.ctx.library.get(body.id);
      expect(entry).toMatchObject({ path: 'Riffway - Arpeggio.txt', hasSidecar: true, rhythm: 'aligned', format: 'ascii' });
      const got = await t.app.inject({ method: 'GET', url: `/api/songs/${encodeURIComponent(body.id)}/sidecar` });
      expect(got.json()).toEqual(sc);
      const meta = await t.app.inject({ method: 'GET', url: `/api/songs/${encodeURIComponent(body.id)}` });
      expect(meta.json().files.sidecar).toBe(`/api/songs/${encodeURIComponent(body.id)}/sidecar`);
    });

    it('saves without a sidecar (title only), adds a final newline and honours the import subfolder', async () => {
      t = await startApp(dirs);
      await t.ctx.config.update({ importSubfolder: 'Pasted' });
      const text = ARPEGGIO.trimEnd();
      const res = await paste({ title: 'AC/DC riff', text });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<PasteResponse>();
      expect(body.path).toBe('Pasted/AC-DC riff.txt');
      expect(readFileSync(join(dirs.libraryDir, 'Pasted', 'AC-DC riff.txt'), 'utf8')).toBe(`${text}\n`);
      expect(existsSync(join(dirs.dataDir, 'sidecars'))).toBe(false);
      expect(t.ctx.library.get(body.id)?.hasSidecar).toBe(false);
    });

    it('suffixes name collisions and reports identical content as the existing song', async () => {
      t = await startApp(dirs);
      const first = (await paste({ title: 'Riff', text: ARPEGGIO })).json<PasteResponse>();
      const other = ARPEGGIO.replace('-3--', '-5--');
      const second = (await paste({ title: 'Riff', text: other })).json<PasteResponse>();
      expect(second.path).toBe('Riff (2).txt');
      expect(second.id).not.toBe(first.id);
      const sc = sidecar(16, { method: 'tap' });
      const dup = await paste({ title: 'Something else', text: ARPEGGIO, sidecar: sc });
      expect(dup.json()).toEqual(first);
      expect(JSON.parse(readFileSync(sidecarFile(first.id), 'utf8'))).toEqual(sc);
      expect(readdirSync(dirs.libraryDir).sort()).toEqual(['Riff (2).txt', 'Riff.txt']);
    });

    it('rejects bad requests without writing anything', async () => {
      t = await startApp(dirs);
      const cases: [unknown, number, string][] = [
        [{ text: ARPEGGIO }, 400, 'bad-request'],
        [{ title: '   ', text: ARPEGGIO }, 400, 'bad-request'],
        [{ title: 'x'.repeat(201), text: ARPEGGIO }, 400, 'bad-request'],
        [{ title: 'Song', text: '' }, 400, 'bad-request'],
        [{ title: 'Song', text: 'no tab in here\njust words' }, 400, 'empty'],
        [{ title: 'Song', text: ARPEGGIO, sidecar: sidecar(15) }, 400, 'sidecar-mismatch'],
        [{ title: 'Song', text: ARPEGGIO, sidecar: { ...sidecar(16), grid: 7 } }, 400, 'bad-request'],
        [{ title: 'Song', text: ARPEGGIO, sidecar: { ...sidecar(16), onsets: [0, 2, 1] } }, 400, 'bad-request'],
        [{ title: 'Song', text: 'e|-0-|\n'.repeat(LIMITS.importBytes / 6 + 10) }, 413, 'too-large'],
      ];
      for (const [body, status, code] of cases) {
        const res = await paste(body);
        expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(status);
        expect(res.json().code).toBe(code);
      }
      expect(readdirSync(dirs.libraryDir)).toEqual([]);
    });
  });

  describe('GET/PUT /api/songs/:id/sidecar', () => {
    it('saves a matching sidecar for a library ASCII tab and re-indexes it', async () => {
      writeFileSync(join(dirs.libraryDir, 'Riff.txt'), ARPEGGIO);
      t = await startApp(dirs);
      const id = localId(ARPEGGIO);
      expect(t.ctx.library.get(id)?.hasSidecar).toBe(false);
      const url = `/api/songs/${encodeURIComponent(id)}/sidecar`;
      expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(404);

      const sc = sidecar(16, { method: 'tap', grid: 16 });
      const put = await t.app.inject({ method: 'PUT', url, payload: sc });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json()).toEqual(sc);
      expect(JSON.parse(readFileSync(sidecarFile(id), 'utf8'))).toEqual(sc);
      expect(t.ctx.library.get(id)).toMatchObject({ hasSidecar: true, rhythm: 'aligned' });
      expect((await t.app.inject({ method: 'GET', url })).json()).toEqual(sc);
    });

    it('rejects unknown songs, non-ASCII songs, malformed and mismatching sidecars', async () => {
      writeFileSync(join(dirs.libraryDir, 'Riff.txt'), ARPEGGIO);
      const atex = fakeSong({ title: 'Exact', tier: 2 });
      writeFileSync(join(dirs.libraryDir, 'Exact.atex'), atex);
      t = await startApp(dirs);
      const put = (id: string, payload: unknown) =>
        t.app.inject({ method: 'PUT', url: `/api/songs/${encodeURIComponent(id)}/sidecar`, payload: payload as object });
      expect((await put('local:nope', sidecar(16))).statusCode).toBe(404);
      const nonAscii = await put(localId(atex), sidecar(16));
      expect([nonAscii.statusCode, nonAscii.json().code]).toEqual([400, 'unsupported']);
      const mismatch = await put(localId(ARPEGGIO), sidecar(3));
      expect([mismatch.statusCode, mismatch.json().code]).toEqual([400, 'sidecar-mismatch']);
      expect((await put(localId(ARPEGGIO), { ...sidecar(16), schema: 2 })).statusCode).toBe(400);
      expect((await put(localId(ARPEGGIO), { ...sidecar(16), bpm: 5 })).statusCode).toBe(400);
      expect(existsSync(sidecarFile(localId(ARPEGGIO)))).toBe(false);
      expect((await t.app.inject({ method: 'GET', url: '/api/songs/local%3Anope/sidecar' })).statusCode).toBe(404);
    });
  });

  describe('GET/POST /api/sidecars', () => {
    it('round-trips every sidecar for export/import, skipping invalid ones and re-indexing known songs', async () => {
      writeFileSync(join(dirs.libraryDir, 'Riff.txt'), ARPEGGIO);
      t = await startApp(dirs);
      expect((await t.app.inject({ method: 'GET', url: '/api/sidecars' })).json()).toEqual({ sidecars: {} });
      const id = localId(ARPEGGIO);
      const bundle: SidecarsBundle = {
        sidecars: {
          [id]: sidecar(16),
          'classtab:abc/def': sidecar(4, { grid: 12 }),
          'local:bad': { ...sidecar(4), method: 'guess' } as unknown as RhythmSidecar,
        },
      };
      const post = await t.app.inject({ method: 'POST', url: '/api/sidecars', payload: bundle });
      expect(post.statusCode, post.body).toBe(200);
      expect(post.json()).toEqual({ written: 2 });
      expect(t.ctx.library.get(id)?.hasSidecar).toBe(true);
      // A stray, unparsable file in the folder is ignored.
      mkdirSync(join(dirs.dataDir, 'sidecars'), { recursive: true });
      writeFileSync(join(dirs.dataDir, 'sidecars', 'junk.json'), '{nope');
      const all = (await t.app.inject({ method: 'GET', url: '/api/sidecars' })).json<SidecarsBundle>();
      expect(all.sidecars).toEqual({ [id]: bundle.sidecars[id], 'classtab:abc/def': bundle.sidecars['classtab:abc/def'] });
      expect((await t.app.inject({ method: 'POST', url: '/api/sidecars', payload: { nope: 1 } })).statusCode).toBe(400);
    });
  });

  describe('helpers', () => {
    it('parseSidecar normalises and defaults savedAt', () => {
      const r = parseSidecar({ ...sidecar(2), savedAt: undefined, extra: 'x' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(Object.keys(r.sidecar).sort()).toEqual(['bpm', 'grid', 'method', 'onsets', 'savedAt', 'schema', 'timeSig']);
        expect(r.sidecar.savedAt).toBeGreaterThan(0);
      }
      expect(parseSidecar({ ...sidecar(2), timeSig: [4, 3] }).ok).toBe(false);
      expect(parseSidecar({ ...sidecar(2), onsets: [] }).ok).toBe(false);
      expect(parseSidecar({ ...sidecar(2), onsets: [-1, 0] }).ok).toBe(false);
      expect(parseSidecar(null).ok).toBe(false);
    });

    it('pasteFileName cleans titles like the upload sanitiser', () => {
      expect(pasteFileName('One', 'Metallica')).toBe('Metallica - One.txt');
      expect(pasteFileName('a/b\\c')).toBe('a-b-c.txt');
      expect(pasteFileName('..hidden: "x"?')).toBe('hidden_ _x__.txt');
    });
  });
});
