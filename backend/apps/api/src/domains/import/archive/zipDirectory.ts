/*
 * A minimal, synchronous ZIP central-directory reader plus single-entry
 * extractor.
 *
 * This is NOT a general-purpose zip library and must not grow into one. It
 * exists so `./systemExtract` can repair the entry names the system `unzip`
 * gets wrong (see that module) without giving up `unzip` as the bulk extractor:
 * it reads the archive's own central directory to learn the true, stored
 * filename bytes, and can re-extract the handful of entries whose names came
 * out mangled.
 *
 * Everything here reads only the tail of the file and the central directory —
 * no payload is touched — until a caller asks for a specific entry, which is
 * then the only entry read. That keeps the cost proportional to the problem
 * (usually zero entries) rather than to the archive, which is the whole reason
 * `unzip` stays in charge of the 40-50GB exports.
 *
 * adm-zip is already a dependency and could parse this, but it reads the WHOLE
 * archive into memory via `readFileSync` and has no ZIP64 support — the two
 * exact reasons the large-archive path avoids it (see `./unpack`).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { assertParentInside } from './containment';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** General-purpose bit 11: "the filename and comment are UTF-8". */
const FLAG_UTF8_NAMES = 0x0800;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * Cap on the central directory we will buffer. A 100k-entry archive (the
 * intake cap in `./extract`) with long Takeout paths runs ~30MB; 128MB leaves
 * room without letting a crafted header size us out of memory.
 */
const MAX_CENTRAL_DIRECTORY_BYTES = 128 * 1024 * 1024;

/**
 * Cap on a single DEFLATED entry we will repair. `zlib.inflateRawSync` needs
 * the whole compressed entry and produces the whole result, so the transient
 * cost is compressed + uncompressed for one entry. Stored entries have no such
 * limit — they are copied in chunks (see {@link extractZipEntry}).
 */
const MAX_INFLATE_BYTES = 256 * 1024 * 1024;

/** One entry as described by the central directory. */
export interface ZipEntry {
  /**
   * The filename EXACTLY as stored, undecoded. The point of this module is
   * that the bytes and their interpretation are separate questions, so callers
   * decide the charset rather than having one imposed here.
   */
  nameBytes: Buffer;
  /** General-purpose bit 11 — set means the writer declared the name UTF-8. */
  utf8Flag: boolean;
  /** Compression method (0 = stored, 8 = deflate). */
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
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

function crc32Update(crc: number, chunk: Buffer): number {
  let c = crc;
  for (const byte of chunk) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }

  return c >>> 0;
}

function crc32(buf: Buffer): number {
  return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

/** `fs.readSync` is allowed to return a short read; loop until the buffer is full. */
function readFully(fd: number, buf: Buffer, position: number): void {
  let filled = 0;
  while (filled < buf.length) {
    const n = fs.readSync(fd, buf, filled, buf.length - filled, position + filled);
    if (n <= 0) {
      throw new Error('unexpected end of archive');
    }

    filled += n;
  }
}

interface CentralDirectoryLocation {
  offset: number;
  size: number;
}

/**
 * Locate the central directory from the end-of-central-directory record, which
 * sits in the last 22 bytes plus up to 64 KiB of archive comment. When any of
 * its fields is saturated the real values live in the ZIP64 record the locator
 * immediately before it points at.
 */
function locateCentralDirectory(fd: number, fileSize: number): CentralDirectoryLocation | null {
  const window = Math.min(fileSize, 22 + 0xffff);
  if (window < 22) {
    return null;
  }

  const tail = Buffer.alloc(window);
  readFully(fd, tail, fileSize - window);

  let at = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      at = i;
      break;
    }
  }

  if (at === -1) {
    return null;
  }

  let size = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);

  if (size === 0xffffffff || offset === 0xffffffff || tail.readUInt16LE(at + 10) === 0xffff) {
    const locatorAt = at - 20;
    if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== ZIP64_LOCATOR_SIGNATURE) {
      return null;
    }

    const zip64At = Number(tail.readBigUInt64LE(locatorAt + 8));
    if (!Number.isSafeInteger(zip64At) || zip64At < 0 || zip64At + 56 > fileSize) {
      return null;
    }

    const zip64 = Buffer.alloc(56);
    readFully(fd, zip64, zip64At);
    if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      return null;
    }

    size = Number(zip64.readBigUInt64LE(40));
    offset = Number(zip64.readBigUInt64LE(48));
  }

  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || offset < 0 || size < 0) {
    return null;
  }

  if (size > MAX_CENTRAL_DIRECTORY_BYTES || offset + size > fileSize) {
    return null;
  }

  return { offset, size };
}

/** Find one extra-field record by id within an entry's extra block. */
function findExtraField(extra: Buffer, id: number): Buffer | null {
  let p = 0;
  while (p + 4 <= extra.length) {
    const fieldId = extra.readUInt16LE(p);
    const fieldSize = extra.readUInt16LE(p + 2);
    if (p + 4 + fieldSize > extra.length) {
      return null;
    }

    if (fieldId === id) {
      return extra.subarray(p + 4, p + 4 + fieldSize);
    }

    p += 4 + fieldSize;
  }

  return null;
}

function parseCentralDirectory(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let p = 0;

  while (p + 46 <= buf.length && buf.readUInt32LE(p) === CENTRAL_SIGNATURE) {
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const entryCrc = buf.readUInt32LE(p + 16);
    let compressedSize = buf.readUInt32LE(p + 20);
    let uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    let localHeaderOffset = buf.readUInt32LE(p + 42);

    const nameAt = p + 46;
    const extraAt = nameAt + nameLength;
    const end = extraAt + extraLength + commentLength;
    if (end > buf.length) {
      break;
    }

    // ZIP64 replaces each saturated field, in this fixed order, from one extra
    // field. A 4GB+ Takeout split carries these on every large entry.
    if (
      uncompressedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const zip64 = findExtraField(buf.subarray(extraAt, extraAt + extraLength), 0x0001);
      if (zip64) {
        let q = 0;
        if (uncompressedSize === 0xffffffff && q + 8 <= zip64.length) {
          uncompressedSize = Number(zip64.readBigUInt64LE(q));
          q += 8;
        }

        if (compressedSize === 0xffffffff && q + 8 <= zip64.length) {
          compressedSize = Number(zip64.readBigUInt64LE(q));
          q += 8;
        }

        if (localHeaderOffset === 0xffffffff && q + 8 <= zip64.length) {
          localHeaderOffset = Number(zip64.readBigUInt64LE(q));
        }
      }
    }

    entries.push({
      nameBytes: Buffer.from(buf.subarray(nameAt, extraAt)),
      utf8Flag: (flags & FLAG_UTF8_NAMES) !== 0,
      method,
      crc32: entryCrc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    p = end;
  }

  return entries;
}

/**
 * Every entry in `archivePath`, read from its central directory.
 *
 * Returns null rather than throwing when the archive can't be read as a zip —
 * callers here are always working alongside a system extractor that has its
 * own, better diagnosis (see `diagnoseArchive` in `./unpack`), so a parse
 * failure means "this module has nothing to add", never "the archive is bad".
 */
export function readZipDirectory(archivePath: string): ZipEntry[] | null {
  let fd: number;
  try {
    fd = fs.openSync(archivePath, 'r');
  } catch {
    return null;
  }

  try {
    const fileSize = fs.fstatSync(fd).size;
    const located = locateCentralDirectory(fd, fileSize);
    if (!located) {
      return null;
    }

    const central = Buffer.alloc(located.size);
    readFully(fd, central, located.offset);

    return parseCentralDirectory(central);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether {@link extractZipEntry} can handle this entry at all. */
export function canExtractZipEntry(entry: ZipEntry): boolean {
  if (entry.method === METHOD_STORED) {
    return true;
  }

  return (
    entry.method === METHOD_DEFLATE &&
    entry.compressedSize <= MAX_INFLATE_BYTES &&
    entry.uncompressedSize <= MAX_INFLATE_BYTES
  );
}

/** Offset of an entry's payload, read from its LOCAL header (the central one lies about extra length). */
function payloadOffset(fd: number, entry: ZipEntry): number | null {
  const local = Buffer.alloc(30);
  readFully(fd, local, entry.localHeaderOffset);
  if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    return null;
  }

  return entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
}

/** Copy a STORED entry in chunks — constant memory, so entry size is unbounded. */
function copyStoredEntry(fd: number, from: number, entry: ZipEntry, tempPath: string): boolean {
  const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(entry.compressedSize, 1)));
  // `wx`: create, and fail if anything is already there. See extractZipEntry.
  const out = fs.openSync(tempPath, 'wx');
  let crc = 0xffffffff;

  try {
    let remaining = entry.compressedSize;
    let position = from;
    while (remaining > 0) {
      const want = Math.min(chunk.length, remaining);
      const n = fs.readSync(fd, chunk, 0, want, position);
      if (n <= 0) {
        return false;
      }

      const slice = chunk.subarray(0, n);
      crc = crc32Update(crc, slice);
      fs.writeSync(out, slice);
      position += n;
      remaining -= n;
    }
  } finally {
    fs.closeSync(out);
  }

  return (crc ^ 0xffffffff) >>> 0 === entry.crc32;
}

/**
 * Clear the way for the temp file, or say it cannot be done.
 *
 * A regular file there is what an interrupted earlier repair leaves behind and
 * is ours to remove. Anything else (a link above all, which opening the path
 * would follow) means the tree is not the one this pass expects, so the entry
 * is left unrepaired rather than written somewhere else.
 */
function clearTempPath(tempPath: string): boolean {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(tempPath);
  } catch {
    return true;
  }

  if (!info.isFile()) {
    return false;
  }

  fs.unlinkSync(tempPath);

  return true;
}

/**
 * Write one entry's contents to `targetPath`, creating parent directories.
 *
 * The payload is written to a sibling temp file and renamed only once its CRC
 * matches the archive's, so a truncated or corrupt entry never appears at the
 * real path — the mangled copy the system extractor already wrote stays as the
 * better of two bad answers. Returns false (having cleaned up) in that case,
 * and for any entry {@link canExtractZipEntry} rejects.
 *
 * Every write stays inside `destDir` by where it REALLY lands, not by how the
 * path reads. The tree it writes into came out of an archive, and a directory
 * on the way to `targetPath` can be a link to anywhere: `mkdirSync` with
 * `recursive` walks through one, and so do the open and the rename. So the
 * parent is resolved with `assertParentInside` before anything is created, a
 * link already sitting at the target is refused, and the temp file is created
 * exclusively (`wx`), which fails on a link instead of following it. A refusal
 * returns false like any other entry that could not be repaired.
 */
export function extractZipEntry(fd: number, entry: ZipEntry, targetPath: string, destDir: string): boolean {
  if (!canExtractZipEntry(entry)) {
    return false;
  }

  try {
    assertParentInside(destDir, targetPath);

    if (fs.lstatSync(targetPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return false;
    }
  } catch {
    return false;
  }

  let from: number | null;
  try {
    from = payloadOffset(fd, entry);
  } catch {
    return false;
  }

  if (from === null) {
    return false;
  }

  const tempPath = `${targetPath}.ci-name-repair`;

  try {
    // Inside the try: a directory the extractor restored read-only, or a full
    // disk, makes this throw, and that is one entry that cannot be repaired,
    // not a reason to abandon every entry after it.
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    if (!clearTempPath(tempPath)) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    let ok: boolean;
    if (entry.method === METHOD_STORED) {
      ok = copyStoredEntry(fd, from, entry, tempPath);
    } else {
      const compressed = Buffer.alloc(entry.compressedSize);
      readFully(fd, compressed, from);
      const data = zlib.inflateRawSync(compressed);
      ok = data.length === entry.uncompressedSize && crc32(data) === entry.crc32;
      if (ok) {
        fs.writeFileSync(tempPath, data, { flag: 'wx' });
      }
    }

    if (!ok) {
      fs.rmSync(tempPath, { force: true });

      return false;
    }

    fs.renameSync(tempPath, targetPath);

    return true;
  } catch {
    fs.rmSync(tempPath, { force: true });

    return false;
  }
}
