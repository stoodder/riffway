/**
 * Regenerates the binary import fixtures from the authored text fixtures in this folder:
 * - every `*.atex` → `gp/<name>.gp` via alphaTab's `Gp7Exporter` (techniques → `gp/techniques/`);
 * - `tab-dropd.musicxml` → `tab-dropd.mxl` (compressed MusicXML container, stored entries).
 *
 * Run: `npx tsx tests/fixtures/import/build-fixtures.ts`. Outputs are committed; tests never
 * regenerate them.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { exporter, importer, Settings } from '@coderline/alphatab';

const here = dirname(fileURLToPath(import.meta.url));

function atexFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory() && e.name !== 'gp') return atexFiles(path);
    return e.isFile() && e.name.endsWith('.atex') ? [path] : [];
  });
}

/** Minimal ZIP writer (stored entries, no compression): enough for an `.mxl` container. */
function storedZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(0, 10); // time + date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt32LE(0, 12);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data);
    central.push(dir, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

const settings = new Settings();
for (const file of atexFiles(here)) {
  const score = importer.ScoreLoader.loadAlphaTex(readFileSync(file, 'utf8'), settings);
  const out = join(here, 'gp', relative(here, file).replace(/\.atex$/, '.gp'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, new exporter.Gp7Exporter().export(score, settings));
  console.log('wrote', relative(here, out));
}

const container = `<?xml version="1.0" encoding="UTF-8"?>
<container><rootfiles><rootfile full-path="tab-dropd.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>
`;
writeFileSync(
  join(here, 'tab-dropd.mxl'),
  storedZip([
    { name: 'mimetype', data: new TextEncoder().encode('application/vnd.recordare.musicxml') },
    { name: 'META-INF/container.xml', data: new TextEncoder().encode(container) },
    { name: 'tab-dropd.musicxml', data: readFileSync(join(here, 'tab-dropd.musicxml')) },
  ]),
);
console.log('wrote tab-dropd.mxl');
