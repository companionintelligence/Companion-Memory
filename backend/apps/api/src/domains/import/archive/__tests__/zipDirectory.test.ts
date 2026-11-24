import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canExtractZipEntry, extractZipEntry, readZipDirectory } from '../zipDirectory';

import { buildZip, buildZip64Eocd } from './zipFixtures';

/**
 * The ZIP64 branches, which nothing exercised before this file (grep for
 * `readZipDirectory` across `__tests__/` turned up nothing but this file and
 * `repairEntryNames.ts`, which reads it as a black box). `zipDirectory.ts`'s
 * own comment on the per-entry branch says why it matters: "A 4GB+ Takeout
 * split carries these on every large entry" — i.e. this path runs on real
 * production imports with zero prior verification.
 *
 * Neither fixture below needs an actual multi-gigabyte file: both parsers key
 * off a SATURATED 32-bit field (`0xffffffff` / `0xffff`), not off the
 * archive's real size, so a small archive can declare the sentinel honestly
 * and drive the exact branch a real split takes. See `zipFixtures.ts`'s
 * `zip64` entry flag and `buildZip64Eocd` for how.
 */

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ci-zip64-'));
}

describe('readZipDirectory', () => {
  let work: string;

  beforeEach(() => {
    work = scratch();
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function archiveOf(bytes: Buffer, name = 'a.zip'): string {
    const archive = path.join(work, name);
    fs.writeFileSync(archive, bytes);

    return archive;
  }

  it('reads a plain archive with ordinary 32-bit fields (baseline)', () => {
    const archive = archiveOf(buildZip([{ name: 'small.txt', contents: 'hello' }]));
    const entries = readZipDirectory(archive);

    expect(entries).toHaveLength(1);
    expect(entries?.[0].uncompressedSize).toBe(5);
    expect(entries?.[0].localHeaderOffset).toBe(0);
  });

  describe('per-entry ZIP64 override (parseCentralDirectory)', () => {
    it('reads the true size and local-header offset out of the ZIP64 extra field', () => {
      // Two entries so the ZIP64 one's local header offset is NONZERO — a
      // sentinel that happened to decode to 0 by accident would pass a
      // single-entry fixture and still be wrong.
      const archive = archiveOf(
        buildZip([
          { name: 'first.txt', contents: 'abcdefgh' },
          { name: 'second.txt', contents: 'the real payload', zip64: true },
        ]),
      );

      const entries = readZipDirectory(archive);
      expect(entries).toHaveLength(2);

      const [first, second] = entries!;

      // The non-ZIP64 sibling is untouched — this isn't a global mode switch.
      expect(first.uncompressedSize).toBe(8);
      expect(first.localHeaderOffset).toBe(0);

      expect(second.uncompressedSize).toBe('the real payload'.length);
      expect(second.compressedSize).toBe('the real payload'.length); // stored, not deflated
      // 30-byte local header + 9-byte name + 8-byte payload of the first entry.
      expect(second.localHeaderOffset).toBe(30 + 'first.txt'.length + 8);
    });

    it('overrides a DEFLATED entry’s sizes too, and the entry still extracts', () => {
      const archive = archiveOf(
        buildZip([{ name: 'big.json', contents: '{"a":1,"b":2,"c":3}', deflate: true, zip64: true }]),
      );

      const entries = readZipDirectory(archive);
      const [entry] = entries!;

      expect(entry.uncompressedSize).toBe('{"a":1,"b":2,"c":3}'.length);
      expect(canExtractZipEntry(entry)).toBe(true);

      const fd = fs.openSync(archive, 'r');
      const target = path.join(work, 'out', 'big.json');
      try {
        expect(extractZipEntry(fd, entry, target, work)).toBe(true);
      } finally {
        fs.closeSync(fd);
      }

      expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1,"b":2,"c":3}');
    });
  });

  describe('ZIP64 end-of-central-directory locator (locateCentralDirectory)', () => {
    it('follows the locator to the ZIP64 EOCD record when the plain one is saturated', () => {
      const archive = archiveOf(
        buildZip64Eocd([
          { name: 'one.txt', contents: 'first file' },
          { name: 'two.txt', contents: 'second file, a bit longer' },
        ]),
      );

      const entries = readZipDirectory(archive);

      expect(entries).toHaveLength(2);
      expect(entries?.map((e) => e.nameBytes.toString())).toEqual(['one.txt', 'two.txt']);
      expect(entries?.[1].uncompressedSize).toBe('second file, a bit longer'.length);
    });

    it('round-trips extraction through a ZIP64-EOCD archive', () => {
      const archive = archiveOf(
        buildZip64Eocd([{ name: 'only.txt', contents: 'payload under a zip64 eocd' }]),
      );
      const [entry] = readZipDirectory(archive)!;

      const fd = fs.openSync(archive, 'r');
      const target = path.join(work, 'out', 'only.txt');
      try {
        expect(extractZipEntry(fd, entry, target, work)).toBe(true);
      } finally {
        fs.closeSync(fd);
      }

      expect(fs.readFileSync(target, 'utf8')).toBe('payload under a zip64 eocd');
    });
  });

  it('handles both branches together — a large entry inside a large split', () => {
    // The shape the code comment describes: a 4GB+ Takeout split, where the
    // WHOLE archive needs the ZIP64 EOCD locator and its big member needs the
    // per-entry override too.
    const archive = archiveOf(
      buildZip64Eocd([
        { name: 'manifest.json', contents: '{"parts":1}' },
        { name: 'huge-video.mp4', contents: 'stand-in bytes for a 4GB+ file', zip64: true },
      ]),
    );

    const entries = readZipDirectory(archive);
    expect(entries).toHaveLength(2);

    const huge = entries!.find((e) => e.nameBytes.toString() === 'huge-video.mp4')!;
    expect(huge.uncompressedSize).toBe('stand-in bytes for a 4GB+ file'.length);

    const fd = fs.openSync(archive, 'r');
    const target = path.join(work, 'out', 'huge-video.mp4');
    try {
      expect(extractZipEntry(fd, huge, target, work)).toBe(true);
    } finally {
      fs.closeSync(fd);
    }

    expect(fs.readFileSync(target, 'utf8')).toBe('stand-in bytes for a 4GB+ file');
  });

  it('returns null for a file that is not a zip at all', () => {
    const archive = archiveOf(Buffer.from('this is not a zip file'));

    expect(readZipDirectory(archive)).toBeNull();
  });
});
