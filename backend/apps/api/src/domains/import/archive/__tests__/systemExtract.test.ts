import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dittoAvailable, systemExtract, systemUnzipAvailable } from '../systemExtract';

/**
 * The regression these guard is a real one: a 2.7GB Google Takeout failed at 0%
 * with `system unzip failed (exit 50)` because macOS ships Info-ZIP 6.00 (2009),
 * which cannot write an entry whose name is not ASCII and reports that as
 * "disk full". `ditto` reads the same archive correctly.
 *
 * Both extractors are system binaries, so the meaningful assertions are made
 * against a real zip rather than a mock — but only where the binary exists.
 */

const describeIfZip = systemUnzipAvailable() || dittoAvailable() ? describe : describe.skip;

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ci-systemextract-'));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[n] = c >>> 0;
  }

  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }

  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A one-entry, stored (uncompressed) zip whose filename bytes are UTF-8 but
 * whose general-purpose bit 11 is left clear — i.e. what Google Takeout emits.
 */
function zipWithoutUtf8Flag(filename: string, contents: string): Buffer {
  const name = Buffer.from(filename, 'utf8');
  const data = Buffer.from(contents, 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags — bit 11 deliberately CLEAR
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localChunk = Buffer.concat([local, name, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory signature
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8); // flags — clear here too
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // relative offset of local header
  const centralChunk = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralChunk.length, 12);
  eocd.writeUInt32LE(localChunk.length, 16);

  return Buffer.concat([localChunk, centralChunk, eocd]);
}

describeIfZip('systemExtract', () => {
  it('extracts an archive whose entry names are plain ASCII', () => {
    const work = scratch();
    const src = path.join(work, 'src');
    const dest = path.join(work, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(src, 'hello.txt'), 'hello');

    const archive = path.join(work, 'plain.zip');
    spawnSync('zip', ['-rq', archive, '.'], { cwd: src });

    const result = systemExtract(archive, dest);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'hello.txt'), 'utf8')).toBe('hello');

    fs.rmSync(work, { recursive: true, force: true });
  });

  it('extracts a non-ASCII entry name written without the UTF-8 flag', () => {
    // The exact shape that killed a 2.7GB Google Takeout at 0%.
    //
    // Note it is NOT enough to zip an accented filename with the `zip` binary:
    // that sets general-purpose bit 11 (the "names are UTF-8" flag) and Info-ZIP
    // then reads it correctly. Google's writer leaves the bit CLEAR, so unzip
    // decodes the name as CP437, produces an illegal byte sequence for the
    // filesystem, and aborts the WHOLE archive with exit 50 — whose documented
    // meaning is "disk full". Hence the hand-built fixture: it is the only way
    // to reproduce the failure the appliance actually hits.
    const work = scratch();
    const dest = path.join(work, 'dest');
    fs.mkdirSync(dest, { recursive: true });

    const name = 'Mariana Acuña - Text - 2025-11-19T18_28_09Z.html';
    const archive = path.join(work, 'no-utf8-flag.zip');
    fs.writeFileSync(archive, zipWithoutUtf8Flag(name, '<html></html>'));

    const result = systemExtract(archive, dest);

    expect(result.ok).toBe(true);
    // Compare on the decoded set rather than the literal name: the extractors
    // differ in the Unicode normalisation they write, and the point of the test
    // is that the entry survived at all.
    const written = fs.readdirSync(dest).map((entry) => entry.normalize('NFC'));
    expect(written).toContain(name.normalize('NFC'));

    fs.rmSync(work, { recursive: true, force: true });
  });

  it('reports a cause rather than succeeding on a file that is not an archive', () => {
    const work = scratch();
    const dest = path.join(work, 'dest');
    fs.mkdirSync(dest, { recursive: true });

    const notAZip = path.join(work, 'notazip.zip');
    fs.writeFileSync(notAZip, 'this is not a zip file');

    const result = systemExtract(notAZip, dest);

    expect(result.ok).toBe(false);
    expect(result.detail).not.toHaveLength(0);

    fs.rmSync(work, { recursive: true, force: true });
  });
});
