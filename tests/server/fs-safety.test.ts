import { describe, expect, it } from 'vitest';
import { isInside, normalizeSubfolder, sanitizeUploadName } from '../../server/fs-safety';
import { isAllowedOrigin, isLoopbackHost, isLoopbackOrigin } from '../../server/app';

describe('sanitizeUploadName', () => {
  it('rejects names carrying a path or traversal', () => {
    for (const raw of ['../x.gp', 'a/b.gp', '..\\x.gp', 'C:\\x\\y.gp', '/etc/passwd.txt', 'x\0.gp', '..', '.']) {
      expect(sanitizeUploadName(raw).ok, raw).toBe(false);
    }
  });

  it('allows only song and paired-MIDI extensions', () => {
    for (const ok of ['a.gp', 'a.GPX', 'a.gp5', 'a.gp4', 'a.gp3', 'a.musicxml', 'a.xml', 'a.mxl', 'a.atex', 'a.txt', 'a.tab', 'a.mid']) {
      expect(sanitizeUploadName(ok).ok, ok).toBe(true);
    }
    for (const bad of ['a.exe', 'a.js', 'a.html', 'a', 'a.gp.exe', 'a.midi']) expect(sanitizeUploadName(bad).ok, bad).toBe(false);
  });

  it('cleans the name: reserved characters, hidden prefix, whitespace, length', () => {
    expect(sanitizeUploadName('  My  Song: Live?.GP5 ')).toEqual({ ok: true, name: 'My Song_ Live_.gp5' });
    expect(sanitizeUploadName('...hidden.atex')).toEqual({ ok: true, name: 'hidden.atex' });
    expect(sanitizeUploadName('.atex')).toEqual({ ok: false, reason: expect.stringContaining('Unsupported') });
    expect(sanitizeUploadName('tab\u0007.txt')).toEqual({ ok: true, name: 'tab_.txt' });
    const long = sanitizeUploadName(`${'é'.repeat(300)}.gp`);
    expect(long.ok && Buffer.byteLength(long.name)).toBeLessThanOrEqual(200);
    expect(long.ok && long.name.endsWith('.gp')).toBe(true);
  });
});

describe('path helpers', () => {
  it('isInside', () => {
    expect(isInside('/lib', '/lib')).toBe(true);
    expect(isInside('/lib', '/lib/a/b.gp')).toBe(true);
    expect(isInside('/lib', '/lib/../etc')).toBe(false);
    expect(isInside('/lib', '/library')).toBe(false);
    expect(isInside('/lib', '/')).toBe(false);
  });

  it('normalizeSubfolder', () => {
    expect(normalizeSubfolder('')).toBe('');
    expect(normalizeSubfolder('Imported/')).toBe('Imported');
    expect(normalizeSubfolder('a\\b/./c')).toBe('a/b/c');
    for (const bad of ['../x', 'a/../../b', '/abs', 'C:/x', '.hidden', 'a/.git', 'a:b']) expect(normalizeSubfolder(bad), bad).toBeNull();
  });

  it('loopback host and origin checks', () => {
    for (const h of ['localhost', 'localhost:5173', '127.0.0.1:5174', '[::1]:5174', 'LOCALHOST']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of [undefined, '', 'evil.com', '127.0.0.1.evil.com', 'localhost.evil.com:80', '0.0.0.0']) expect(isLoopbackHost(h), String(h)).toBe(false);
    expect(isLoopbackOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isLoopbackOrigin('http://localhost')).toBe(true);
    for (const o of ['null', 'https://evil.com', 'file:///x', 'chrome-extension://abc']) expect(isLoopbackOrigin(o), o).toBe(false);
  });

  it('accepts only a loopback origin on the port the request was sent to (R1-P-07)', () => {
    expect(isAllowedOrigin('http://127.0.0.1:5174', '127.0.0.1:5174')).toBe(true);
    // Vite's proxy keeps the browser's Host (changeOrigin: false), so dev requests are same-port too.
    expect(isAllowedOrigin('http://localhost:5173', '127.0.0.1:5173')).toBe(true);
    expect(isAllowedOrigin('http://localhost', 'localhost')).toBe(true);
    expect(isAllowedOrigin('http://localhost', 'localhost:80')).toBe(true);
    expect(isAllowedOrigin('https://localhost', 'localhost:443')).toBe(true);
    // Another local server (a dev server, a local tool's page) is a different origin.
    for (const o of ['http://localhost:9999', 'http://127.0.0.1:5173', 'http://localhost']) expect(isAllowedOrigin(o, '127.0.0.1:5174'), o).toBe(false);
    for (const o of ['null', 'https://evil.com:5174', 'file:///x']) expect(isAllowedOrigin(o, 'localhost:5174'), o).toBe(false);
    expect(isAllowedOrigin('http://localhost:5174', undefined)).toBe(false);
  });
});
