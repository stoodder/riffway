import { describe, expect, it } from 'vitest';
import { decodeText } from '@core/import/ascii';
import { classtab } from './song-checks';

describe('decodeText', () => {
  it('decodes UTF-8 and strips a BOM', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Händel\n')]))).toBe('Händel\n');
  });

  it('normalises CRLF and lone CR to LF', () => {
    expect(decodeText(new TextEncoder().encode('a\r\nb\rc\n'))).toBe('a\nb\nc\n');
  });

  it('falls back to windows-1252 for invalid UTF-8', () => {
    // é (0xE9), en dash (0x96 in CP1252), smart quote (0x92).
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x92, 0x0d, 0x0a]))).toBe('café – ’\n');
  });

  it('decodes UTF-16 with a byte-order mark', () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x65, 0x00, 0x7c, 0x00]))).toBe('e|');
  });

  it('decodes the windows-1252 synthetic fixture', () => {
    const text = decodeText(classtab('riffway_march_in_c.txt'));
    expect(text.split('\n')[0]).toBe('Marche élégante in C - Bérénice Exemple (1790-1850)');
    expect(text).not.toContain('\r');
  });
});
