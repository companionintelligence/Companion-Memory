import { describe, expect, it } from 'vitest';

import { zipFilesStore } from './zipStore';

/**
 * A from-scratch, independent zip reader for these tests — deliberately NOT
 * sharing a line with `zipStore.ts`. A test that decodes with the same table
 * it encoded with would pass even if both were wrong the same way; this reads
 * the raw bytes back out against the plain zip spec (local file headers,
 * central directory, end-of-central-directory record) and is the only thing
 * in this file that proves the encoder's OUTPUT is a real zip, not just that
 * its functions returned without throwing.
 */

interface DecodedEntry {
  name: string;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  data: Uint8Array;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Walks LOCAL file headers from byte 0 until the central directory begins. */
function readLocalEntries(bytes: Uint8Array): DecodedEntry[] {
  const view = viewOf(bytes);
  const entries: DecodedEntry[] = [];
  let offset = 0;

  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const crc32 = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;

    entries.push({
      name,
      crc32,
      compressedSize,
      uncompressedSize,
      data: bytes.slice(dataStart, dataStart + compressedSize),
    });
    offset = dataStart + compressedSize;
  }

  return entries;
}

interface Eocd {
  signature: number;
  totalEntries: number;
  centralDirSize: number;
  centralDirOffset: number;
}

/** This encoder never writes a file comment, so the record is the final 22 bytes. */
function readEocd(bytes: Uint8Array): Eocd {
  const view = viewOf(bytes);
  const at = bytes.length - 22;

  return {
    signature: view.getUint32(at, true),
    totalEntries: view.getUint16(at + 10, true),
    centralDirSize: view.getUint32(at + 12, true),
    centralDirOffset: view.getUint32(at + 16, true),
  };
}

interface CentralEntry {
  name: string;
  crc32: number;
  localHeaderOffset: number;
}

function readCentralEntries(bytes: Uint8Array, eocd: Eocd): CentralEntry[] {
  const view = viewOf(bytes);
  const entries: CentralEntry[] = [];
  let offset = eocd.centralDirOffset;
  const end = eocd.centralDirOffset + eocd.centralDirSize;

  while (offset < end) {
    const nameLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 46;

    entries.push({
      name: new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength)),
      crc32: view.getUint32(offset + 16, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    offset = nameStart + nameLength;
  }

  return entries;
}

function bytesOf(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Standard CRC-32 (the zip/PNG polynomial, 0xEDB88320), coded independently
 * of `zipStore.ts`'s own table-driven version — checking a value the encoder
 * computed against a second implementation of the same standard, not against
 * itself.
 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function fileAt(path: string, content: string): File {
  const file = new File([content], path.split('/').pop()!);

  Object.defineProperty(file, 'webkitRelativePath', { value: path });

  return file;
}

describe('zipFilesStore', () => {
  it('builds a zip whose local header decodes back to the real name, bytes and CRC', async () => {
    const conversations = fileAt('chatgpt-export/conversations.json', '{"mapping":{}}');

    const zip = await zipFilesStore([conversations]);
    const bytes = await bytesOf(zip);

    expect(zip.name).toBe('chatgpt-export.zip');
    expect(zip.type).toBe('application/zip');

    const [entry] = readLocalEntries(bytes);

    expect(entry.name).toBe('chatgpt-export/conversations.json');
    expect(new TextDecoder().decode(entry.data)).toBe('{"mapping":{}}');
    // Not just "some CRC was written" — the exact standard CRC-32 of this
    // file's bytes, recomputed by an independent implementation above.
    expect(entry.crc32).toBe(crc32(new TextEncoder().encode('{"mapping":{}}')));
    expect(entry.compressedSize).toBe(entry.uncompressedSize); // STORE, never shrinks or grows
  });

  it('packs every file with its own path, content and CRC — and the central directory agrees', async () => {
    const files = [
      fileAt('export/conversations.json', '{"mapping":{"a":1}}'),
      fileAt('export/media/avatar.png', 'not-really-a-png-but-bytes-all-the-same'),
      fileAt('export/media/nested/clip.mp4', 'video-bytes'),
    ];

    const zip = await zipFilesStore(files);
    const bytes = await bytesOf(zip);

    const locals = readLocalEntries(bytes);
    const eocd = readEocd(bytes);
    const centrals = readCentralEntries(bytes, eocd);

    expect(eocd.signature).toBe(0x06054b50);
    expect(eocd.totalEntries).toBe(3);

    expect(locals.map((entry) => entry.name)).toEqual([
      'export/conversations.json',
      'export/media/avatar.png',
      'export/media/nested/clip.mp4',
    ]);
    expect(centrals.map((entry) => entry.name)).toEqual(locals.map((entry) => entry.name));

    // Every entry's own CRC-32 is independently correct, not just copied
    // from a neighbour or left at zero.
    for (const [i, local] of locals.entries()) {
      const expectedContent = [
        '{"mapping":{"a":1}}',
        'not-really-a-png-but-bytes-all-the-same',
        'video-bytes',
      ][i];

      expect(new TextDecoder().decode(local.data)).toBe(expectedContent);
      expect(local.crc32).toBe(crc32(new TextEncoder().encode(expectedContent)));
      // The central directory's copy of the CRC must match the local header's.
      expect(centrals[i].crc32).toBe(local.crc32);
    }

    // Each central-directory record points at a REAL local header — the
    // proof the archive is one coherent structure, not two halves that
    // happen to list the same names.
    let expectedOffset = 0;

    for (const [i, local] of locals.entries()) {
      expect(centrals[i].localHeaderOffset).toBe(expectedOffset);
      expectedOffset += 30 + local.name.length + local.compressedSize;
    }
  });

  it('rejects an empty file list instead of producing a hollow archive', async () => {
    await expect(zipFilesStore([])).rejects.toThrow('Nothing to pack');
  });

  it('reports progress once per file, in order, ending at the total', async () => {
    const files = [fileAt('bundle/a.txt', 'a'), fileAt('bundle/b.txt', 'b'), fileAt('bundle/c.txt', 'c')];
    const seen: Array<[number, number]> = [];

    await zipFilesStore(files, (done, total) => seen.push([done, total]));

    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('packs a folder with more entries than the engine argument limit without blowing the stack', async () => {
    // Regression: `parts.push(...centrals)` spread one argument per central
    // directory record into a single call, which throws "Maximum call stack
    // size exceeded" well before this count in V8 (~110k args). The fix pushes
    // one at a time instead.
    const FILE_COUNT = 130_000;
    const files: File[] = [];

    for (let i = 0; i < FILE_COUNT; i += 1) {
      files.push(fileAt(`huge-export/file-${i}.txt`, ''));
    }

    await expect(zipFilesStore(files)).resolves.toBeInstanceOf(File);
  }, 180_000);
});

/**
 * Zip64 decoding for the forced-threshold tests below — again independent of
 * the encoder, reading the structures straight off the APPNOTE layouts: the
 * 0x0001 extra field, the Zip64 end-of-central-directory record, and its
 * locator.
 */
interface Zip64CentralEntry {
  name: string;
  crc32: number;
  /** From the 32-bit fields, 0xFFFFFFFF where the zip64 extra takes over. */
  rawSize: number;
  rawOffset: number;
  /** Resolved through the zip64 extra when the raw field is masked. */
  size: number;
  offset: number;
  versionNeeded: number;
}

function readZip64CentralEntries(bytes: Uint8Array, dirOffset: number, dirSize: number): Zip64CentralEntry[] {
  const view = viewOf(bytes);
  const entries: Zip64CentralEntry[] = [];
  let at = dirOffset;
  const end = dirOffset + dirSize;

  while (at < end) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);

    const versionNeeded = view.getUint16(at + 6, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const rawSize = view.getUint32(at + 24, true);
    const rawOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));

    let size = rawSize;
    let offset = rawOffset;
    let extraAt = at + 46 + nameLength;
    const extraEnd = extraAt + extraLength;

    while (extraAt + 4 <= extraEnd) {
      const id = view.getUint16(extraAt, true);
      const dataSize = view.getUint16(extraAt + 2, true);

      if (id === 0x0001) {
        let fieldAt = extraAt + 4;

        // Fixed spec order: original size, compressed size, offset — each
        // present only when its 32-bit field is masked.
        if (rawSize === 0xffffffff) {
          size = Number(view.getBigUint64(fieldAt, true));
          fieldAt += 16; // original + compressed
        }

        if (rawOffset === 0xffffffff) {
          offset = Number(view.getBigUint64(fieldAt, true));
        }
      }

      extraAt += 4 + dataSize;
    }

    entries.push({ name, crc32: view.getUint32(at + 16, true), rawSize, rawOffset, size, offset, versionNeeded });
    at += 46 + nameLength + extraLength;
  }

  return entries;
}

describe('zipFilesStore — Zip64 (forced threshold: a test cannot allocate 4GB)', () => {
  const THRESHOLD = 8;

  it('emits masked 32-bit fields, zip64 extras, and the zip64 EOCD pair once an entry crosses the boundary', async () => {
    const big = fileAt('takeout/part-1.bin', 'x'.repeat(32)); // >= threshold
    const small = fileAt('takeout/note.txt', 'hi'); // < threshold, but offset past it

    const zip = await zipFilesStore([big, small], undefined, { zip64Threshold: THRESHOLD });
    const bytes = await bytesOf(zip);
    const view = viewOf(bytes);

    // Classic EOCD is last, with a masked central-directory offset pointing
    // readers at the locator.
    const eocdAt = bytes.length - 22;

    expect(view.getUint32(eocdAt, true)).toBe(0x06054b50);
    expect(view.getUint32(eocdAt + 16, true)).toBe(0xffffffff);

    // Locator sits immediately before, and points at the zip64 EOCD record.
    const locatorAt = eocdAt - 20;

    expect(view.getUint32(locatorAt, true)).toBe(0x07064b50);

    const eocd64At = Number(view.getBigUint64(locatorAt + 8, true));

    expect(view.getUint32(eocd64At, true)).toBe(0x06064b50);

    const totalEntries = Number(view.getBigUint64(eocd64At + 32, true));
    const dirSize = Number(view.getBigUint64(eocd64At + 40, true));
    const dirOffset = Number(view.getBigUint64(eocd64At + 48, true));

    expect(totalEntries).toBe(2);
    // The zip64 EOCD record begins where the central directory ends.
    expect(dirOffset + dirSize).toBe(eocd64At);

    const entries = readZip64CentralEntries(bytes, dirOffset, dirSize);

    expect(entries.map((entry) => entry.name)).toEqual(['takeout/part-1.bin', 'takeout/note.txt']);

    // Oversized file: size masked in the 32-bit field, real size in the extra.
    expect(entries[0].rawSize).toBe(0xffffffff);
    expect(entries[0].size).toBe(32);
    expect(entries[0].offset).toBe(0);
    expect(entries[0].versionNeeded).toBe(45);

    // Small file past the boundary: size stays classic, offset masked.
    expect(entries[1].rawSize).toBe(2);
    expect(entries[1].rawOffset).toBe(0xffffffff);
    expect(entries[1].versionNeeded).toBe(45);

    // Each local header is where the central directory says, and the stored
    // bytes + CRC survive the masking.
    for (const [entry, content] of [
      [entries[0], 'x'.repeat(32)],
      [entries[1], 'hi'],
    ] as const) {
      expect(view.getUint32(entry.offset, true)).toBe(0x04034b50);

      const nameLength = view.getUint16(entry.offset + 26, true);
      const extraLength = view.getUint16(entry.offset + 28, true);
      const dataAt = entry.offset + 30 + nameLength + extraLength;
      const data = bytes.slice(dataAt, dataAt + entry.size);

      expect(new TextDecoder().decode(data)).toBe(content);
      expect(entry.crc32).toBe(crc32(data));
    }
  });

  it('a small archive stays a plain classic zip — no zip64 records anywhere', async () => {
    const zip = await zipFilesStore([fileAt('folder/a.txt', 'aaa')]);
    const bytes = await bytesOf(zip);
    const view = viewOf(bytes);

    for (let at = 0; at + 4 <= bytes.length; at += 1) {
      const signature = view.getUint32(at, true);

      expect(signature === 0x06064b50 || signature === 0x07064b50).toBe(false);
    }
  });
});
