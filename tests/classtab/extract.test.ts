import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLASSTAB_LIMITS } from '../../server/sources/classtab/layout';
import { ExtractError, extractClassTabZip, unsafeEntryReason, type ExtractLimits } from '../../server/sources/classtab/extract';
import { buildZip, syntheticEntries, tempDir, type ZipEntrySpec } from './helpers';

describe('extractClassTabZip', () => {
  let tmp: ReturnType<typeof tempDir>;
  let dest: string;

  beforeEach(() => {
    tmp = tempDir();
    dest = join(tmp.dir, 'root', 'files');
    mkdirSync(dest, { recursive: true });
  });
  afterEach(() => tmp.cleanup());

  const extract = (entries: ZipEntrySpec[], limits: ExtractLimits = CLASSTAB_LIMITS) => {
    const zip = join(tmp.dir, 'test.zip');
    writeFileSync(zip, buildZip(entries));
    return extractClassTabZip(zip, dest, limits);
  };

  it('keeps only .txt and .mid, flattened, with the zip mtime; nothing else is written', async () => {
    const mtime = new Date(2026, 9, 3, 12, 30, 0);
    const result = await extract([
      { name: 'classtab/', data: null },
      { name: 'classtab/0_readme.txt', data: 'readme' },
      { name: 'classtab/a_piece.txt', data: 'tab text', mtime },
      { name: 'classtab/a_piece.mid', data: new Uint8Array([0x4d, 0x54, 0x68, 0x64]), store: true },
      { name: 'classtab/index.htm', data: '<html>' },
      { name: 'classtab/tabreader.js', data: 'alert(1)' },
      { name: 'classtab/pic.jpg', data: 'jpg' },
      { name: 'classtab/sub/Deep_Piece.TXT', data: 'deep' },
    ]);
    expect(readdirSync(dest).sort()).toEqual(['0_readme.txt', 'Deep_Piece.TXT', 'a_piece.mid', 'a_piece.txt']);
    expect(result).toMatchObject({ tabs: 2, midis: 1, rejected: [], skipped: [] });
    expect(readFileSync(join(dest, 'a_piece.txt'), 'utf8')).toBe('tab text');
    expect(statSync(join(dest, 'a_piece.txt')).mtime.getTime()).toBe(mtime.getTime());
  });

  it('refuses zip-slip and absolute entries and writes nothing outside the destination', async () => {
    const result = await extract([
      { name: '../evil.txt', data: 'x' },
      { name: 'classtab/../../escape.txt', data: 'x' },
      { name: '/abs.txt', data: 'x' },
      { name: 'C:/windows.txt', data: 'x' },
      { name: '..\\backslash.txt', data: 'x' },
      { name: 'classtab/ctrl\u0001.txt', data: 'x' },
      { name: 'classtab/.hidden.txt', data: 'x' },
      { name: 'classtab/ok.txt', data: 'fine' },
    ]);
    expect(readdirSync(dest)).toEqual(['ok.txt']);
    expect(result.rejected).toHaveLength(7);
    expect(result.rejected.join('\n')).toMatch(/evil\.txt \(parent-directory segment\)/);
    expect(result.rejected.join('\n')).toMatch(/\/abs\.txt \(absolute path\)/);
    expect(existsSync(join(tmp.dir, 'root', 'evil.txt'))).toBe(false);
    expect(existsSync(join(tmp.dir, 'evil.txt'))).toBe(false);
    expect(existsSync(join(tmp.dir, 'escape.txt'))).toBe(false);
    expect(existsSync(join(tmp.dir, 'root', 'backslash.txt'))).toBe(false);
  });

  it('unsafeEntryReason flags traversal, absolute and control-character names only', () => {
    expect(unsafeEntryReason('classtab/anon_brian_boru\'s_march_(2).txt')).toBeNull();
    expect(unsafeEntryReason('a/../b.txt')).toMatch(/parent/);
    expect(unsafeEntryReason('/etc/passwd')).toMatch(/absolute/);
    expect(unsafeEntryReason('d:x.txt')).toMatch(/absolute/);
    expect(unsafeEntryReason('a\u0000.txt')).toMatch(/control/);
  });

  it('skips symlinks, oversize entries and case-insensitive duplicates', async () => {
    const result = await extract(
      [
        { name: 'classtab/link.txt', data: '/etc/passwd', unixMode: 0o120777 },
        { name: 'classtab/big.mid', data: new Uint8Array(2048) },
        { name: 'classtab/dup.txt', data: 'first' },
        { name: 'other/DUP.txt', data: 'second' },
      ],
      { ...CLASSTAB_LIMITS, entryBytes: 1024 },
    );
    expect(readdirSync(dest)).toEqual(['dup.txt']);
    expect(readFileSync(join(dest, 'dup.txt'), 'utf8')).toBe('first');
    expect(result.skipped.map((s) => s.replace(/ \(.*$/, ''))).toEqual(['classtab/link.txt', 'classtab/big.mid', 'other/DUP.txt']);
  });

  it('fails on an entry whose real size exceeds its header (bomb guard)', async () => {
    await expect(extract([{ name: 'classtab/liar.txt', data: 'x'.repeat(5000), declaredSize: 10 }])).rejects.toBeInstanceOf(ExtractError);
  });

  it('fails when the archive exceeds the entry-count or total-size limits', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `classtab/t${i}.txt`, data: 'x'.repeat(100) }));
    await expect(extract(many, { ...CLASSTAB_LIMITS, entries: 4 })).rejects.toThrow(/5 entries/);
    await expect(extract(many, { ...CLASSTAB_LIMITS, totalBytes: 250 })).rejects.toThrow(/more than 250 bytes/);
  });

  it('rejects a file that is not a zip', async () => {
    const zip = join(tmp.dir, 'not.zip');
    writeFileSync(zip, '<html>Service unavailable</html>');
    await expect(extractClassTabZip(zip, dest, CLASSTAB_LIMITS)).rejects.toThrow(/Not a readable zip/);
  });

  it('extracts the synthetic ClassTab-style corpus byte for byte (CRLF and windows-1252 kept)', async () => {
    const entries = syntheticEntries();
    const result = await extract(entries);
    expect(result.tabs).toBe(5);
    expect(result.midis).toBe(6);
    for (const e of entries) {
      const base = e.name.slice('classtab/'.length);
      expect(Buffer.compare(readFileSync(join(dest, base)), Buffer.from(e.data as Uint8Array))).toBe(0);
    }
  });
});
