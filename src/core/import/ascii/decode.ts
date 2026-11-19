/**
 * Byte → text decoding for tab files: UTF-8 (BOM optional), UTF-16 with a BOM, and a windows-1252
 * fallback for legacy files (295 ClassTab tabs are Latin-1/CP1252). Line endings normalised to LF.
 * @module
 */

/** windows-1252 code points for bytes 0x80–0x9F (undefined bytes map to U+FFFD). */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
  0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

/** Decode windows-1252 (a superset of Latin-1 for printable characters). Pure, table-driven. */
export function decodeWindows1252(data: Uint8Array): string {
  let out = '';
  const CHUNK = 8192;
  for (let start = 0; start < data.length; start += CHUNK) {
    const end = Math.min(data.length, start + CHUNK);
    const codes = new Array<number>(end - start);
    for (let i = start; i < end; i++) {
      const b = data[i];
      codes[i - start] = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b;
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

/** Normalise CRLF and lone CR line endings to LF. */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Decode bytes: UTF-8, falling back to windows-1252; CRLF normalised to LF. */
export function decodeText(data: Uint8Array): string {
  let text: string;
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(data.subarray(2));
  } else if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(data.subarray(2));
  } else {
    const body = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? data.subarray(3) : data;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      text = decodeWindows1252(body);
    }
  }
  return normaliseNewlines(text);
}
