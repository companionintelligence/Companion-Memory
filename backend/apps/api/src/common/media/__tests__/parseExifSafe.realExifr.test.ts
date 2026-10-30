import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseExifSafe } from '../exif';

/**
 * parseExifSafe against the REAL exifr and a REAL file on disk — deliberately
 * no jest.mock('exifr'), unlike every other exif spec here.
 *
 * The mocked specs proved the importers handle whatever exifr returns; none of
 * them could see that under Yarn PnP exifr never returned anything at all:
 * its file reader hands a DataView to FileHandle.read, PnP's patched fs
 * rejects it (`TypeError: … Received an instance of ArrayBuffer`), and every
 * path-based parse threw before reading a byte. The importers' best-effort
 * catches ate the throw, so 517 camera JPGs in a real Takeout import fell
 * back to file-system time — the archive's own date — with DateTimeOriginal
 * sitting intact in each of them. parseExifSafe now reads the bytes itself
 * and hands exifr a Buffer; this spec pins that the path-in, capture-time-out
 * contract holds on the runtime the tests run on.
 */

/**
 * A minimal but genuine JPEG: SOI + one EXIF APP1 segment (little-endian TIFF,
 * IFD0 → Exif sub-IFD → DateTimeOriginal "2023:10:22 09:49:47") + EOI. Built
 * by hand so no binary fixture is checked in.
 */
function jpegWithDateTimeOriginal(): Buffer {
  const ascii = '2023:10:22 09:49:47\0'; // 20 bytes, ASCII count includes NUL

  // TIFF block, offsets relative to its own start.
  const tiff = Buffer.alloc(64);
  tiff.write('II', 0, 'ascii'); // little-endian
  tiff.writeUInt16LE(0x002a, 2); // TIFF magic
  tiff.writeUInt32LE(8, 4); // IFD0 offset

  // IFD0 @8: one entry (tag@10, type@12, count@14, value@18) — ExifIFD
  // pointer (0x8769) → offset 26; next-IFD @22.
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8769, 10);
  tiff.writeUInt16LE(4, 12); // LONG
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22); // no next IFD

  // Exif sub-IFD @26: one entry (tag@28, type@30, count@32, value@36) —
  // DateTimeOriginal (0x9003), ASCII ×20 @44; next-IFD @40.
  tiff.writeUInt16LE(1, 26);
  tiff.writeUInt16LE(0x9003, 28);
  tiff.writeUInt16LE(2, 30); // ASCII
  tiff.writeUInt32LE(ascii.length, 32);
  tiff.writeUInt32LE(44, 36);
  tiff.writeUInt32LE(0, 40); // no next IFD
  tiff.write(ascii, 44, 'ascii');

  const exifHeader = Buffer.from('Exif\0\0', 'ascii');
  const app1Length = Buffer.alloc(2);
  app1Length.writeUInt16BE(2 + exifHeader.length + tiff.length, 0);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe1]), // APP1 marker
    app1Length,
    exifHeader,
    tiff,
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

describe('parseExifSafe on a real file path', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-exif-real-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads DateTimeOriginal through the importer options', async () => {
    const fpath = path.join(dir, 'photo.jpg');
    fs.writeFileSync(fpath, jpegWithDateTimeOriginal());

    const exif = (await parseExifSafe(fpath, { tiff: true, exif: true })) as {
      DateTimeOriginal?: unknown;
    } | null;

    const dt = exif?.DateTimeOriginal;
    expect(dt).toBeInstanceOf(Date);
    // exifr parses the wall clock in the HOST zone here; the importers correct
    // that (exifWallClockToUtc / exifInstant), so this only pins the DATE parts.
    expect((dt as Date).getFullYear()).toBe(2023);
    expect((dt as Date).getMonth()).toBe(9);
    expect((dt as Date).getDate()).toBe(22);
  });
});
