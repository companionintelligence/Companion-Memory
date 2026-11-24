/*
 * Hand-built zip fixtures.
 *
 * The archives that break extraction cannot be produced by the `zip` binary:
 * it sets general-purpose bit 11 ("names are UTF-8") whenever a name needs it,
 * which is exactly the flag Google Takeout leaves CLEAR and exactly why
 * Info-ZIP mis-reads those names. Writing the bytes by hand is the only way to
 * reproduce the shape, and it also means the archive tests need no `zip`
 * binary in CI's `node:22` image.
 *
 * Not a test file — `testMatch` is `*.test.ts`, so this is only ever imported.
 */
import zlib from 'node:zlib';

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

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }

  return (c ^ 0xffffffff) >>> 0;
}

export interface FixtureEntry {
  /**
   * The name as STORED. Pass a Buffer to write raw bytes that are not UTF-8 —
   * a genuine CP437 name, say — which a string cannot express.
   */
  name: string | Buffer;
  contents?: string | Buffer;
  /**
   * Set general-purpose bit 11. Defaults to FALSE, which is what Takeout
   * emits and what makes non-ASCII names go wrong.
   */
  utf8Flag?: boolean;
  /** Deflate the payload (method 8) instead of storing it (method 0). */
  deflate?: boolean;
  /**
   * Write this entry's CENTRAL directory record the way a 4GB+ split does:
   * `compressedSize`/`uncompressedSize`/local-header-offset saturated at
   * `0xffffffff`, with the true 64-bit values carried instead in a ZIP64 extra
   * field (id `0x0001`). The actual payload stays small — nothing here needs a
   * multi-gigabyte fixture, because the parser keys off the saturated 32-bit
   * field, not the archive's real size. The LOCAL header is left alone
   * (real sizes, no extra field): `zipDirectory.ts` never reads a local
   * header's size fields, only the central directory's, so a fixture chasing
   * exactly what the parser reads leaves it as an ordinary entry.
   */
  zip64?: boolean;
  /**
   * Make this entry a symbolic link to the given path, the way a UNIX `zip -y`
   * stores one: host 3 in "version made by", `S_IFLNK` in the external
   * attributes, and the link target as the payload. Info-ZIP `unzip` restores
   * such an entry as a real link. `contents` is ignored.
   */
  symlinkTo?: string;
}

interface ZipChunks {
  localChunk: Buffer;
  centralChunk: Buffer;
  entryCount: number;
}

/** Extra field record: 2-byte id, 2-byte size, then the data. */
function extraField(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);

  return Buffer.concat([header, data]);
}

/** Local + central directory bytes for `entries`, shared by every EOCD flavour below. */
function buildZipChunks(entries: FixtureEntry[]): ZipChunks {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, 'utf8');
    const raw =
      entry.symlinkTo != null
        ? Buffer.from(entry.symlinkTo, 'utf8')
        : Buffer.isBuffer(entry.contents)
          ? entry.contents
          : Buffer.from(entry.contents ?? '', 'utf8');
    const deflate = entry.deflate ?? false;
    const payload = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const flags = entry.utf8Flag ? 0x0800 : 0;
    const crc = crc32(raw);
    const localHeaderOffset = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([local, name, payload]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    // Version made by: the high byte is the host. 0 (MS-DOS) is what Takeout
    // writes; 3 (UNIX) is the only host whose mode bits `unzip` honours.
    central.writeUInt16LE(entry.symlinkTo != null ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);

    let extra = Buffer.alloc(0);
    if (entry.zip64) {
      // Real values ride in the extra field, in this fixed order — the exact
      // order `parseCentralDirectory` reads them back in.
      const zip64Data = Buffer.alloc(24);
      zip64Data.writeBigUInt64LE(BigInt(raw.length), 0); // uncompressed
      zip64Data.writeBigUInt64LE(BigInt(payload.length), 8); // compressed
      zip64Data.writeBigUInt64LE(BigInt(localHeaderOffset), 16);
      extra = extraField(0x0001, zip64Data);

      central.writeUInt32LE(0xffffffff, 20); // compressedSize sentinel
      central.writeUInt32LE(0xffffffff, 24); // uncompressedSize sentinel
      central.writeUInt16LE(name.length, 28);
      central.writeUInt16LE(extra.length, 30);
      central.writeUInt32LE(0xffffffff, 42); // localHeaderOffset sentinel
    } else {
      central.writeUInt32LE(payload.length, 20);
      central.writeUInt32LE(raw.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt16LE(extra.length, 30);
      central.writeUInt32LE(localHeaderOffset, 42);
    }

    if (entry.symlinkTo != null) {
      // External attributes: the UNIX mode in the high 16 bits, S_IFLNK | 0777.
      central.writeUInt32LE((0o120777 << 16) >>> 0, 38);
    }

    centrals.push(Buffer.concat([central, name, extra]));

    offset += 30 + name.length + payload.length;
  }

  return {
    localChunk: Buffer.concat(locals),
    centralChunk: Buffer.concat(centrals),
    entryCount: entries.length,
  };
}

/** The ordinary (non-ZIP64) end-of-central-directory record. */
function plainEocd(chunks: ZipChunks): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(chunks.entryCount, 8);
  eocd.writeUInt16LE(chunks.entryCount, 10);
  eocd.writeUInt32LE(chunks.centralChunk.length, 12);
  eocd.writeUInt32LE(chunks.localChunk.length, 16);

  return eocd;
}

/** A zip containing exactly these entries, in this order. */
export function buildZip(entries: FixtureEntry[]): Buffer {
  const chunks = buildZipChunks(entries);

  return Buffer.concat([chunks.localChunk, chunks.centralChunk, plainEocd(chunks)]);
}

/**
 * A zip whose regular EOCD is saturated (central directory size AND offset
 * both `0xffffffff`) and immediately preceded by a real ZIP64 End Of Central
 * Directory record and its locator — the fallback `locateCentralDirectory`
 * reads when the plain 32-bit fields cannot hold the true position. As with
 * per-entry ZIP64 above, nothing here needs to actually BE 4GB: the parser
 * reacts to the saturated field, so a small archive can declare it honestly
 * and exercise the exact branch a real 4GB+ split takes.
 *
 * `entries` may additionally set `zip64: true` to combine both branches in one
 * archive, matching the real shape described in `zipDirectory.ts`'s comment —
 * a large entry inside a large split.
 */
export function buildZip64Eocd(entries: FixtureEntry[]): Buffer {
  const chunks = buildZipChunks(entries);
  const centralOffset = chunks.localChunk.length;

  const zip64Record = Buffer.alloc(56);
  zip64Record.writeUInt32LE(0x06064b50, 0); // zip64 EOCD signature
  zip64Record.writeBigUInt64LE(44n, 4); // size of this record, excluding the first 12 bytes
  zip64Record.writeUInt16LE(45, 12); // version made by
  zip64Record.writeUInt16LE(45, 14); // version needed to extract
  zip64Record.writeBigUInt64LE(BigInt(chunks.entryCount), 24); // entries, this disk
  zip64Record.writeBigUInt64LE(BigInt(chunks.entryCount), 32); // entries, total
  zip64Record.writeBigUInt64LE(BigInt(chunks.centralChunk.length), 40); // size of central directory
  zip64Record.writeBigUInt64LE(BigInt(centralOffset), 48); // offset of central directory

  const zip64Locator = Buffer.alloc(20);
  zip64Locator.writeUInt32LE(0x07064b50, 0); // zip64 EOCD locator signature
  zip64Locator.writeUInt32LE(0, 4); // disk with the zip64 EOCD record
  zip64Locator.writeBigUInt64LE(BigInt(centralOffset + chunks.centralChunk.length), 8);
  zip64Locator.writeUInt32LE(1, 16); // total number of disks

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8); // entries, this disk — saturated
  eocd.writeUInt16LE(0xffff, 10); // entries, total — saturated
  eocd.writeUInt32LE(0xffffffff, 12); // size of central directory — saturated
  eocd.writeUInt32LE(0xffffffff, 16); // offset of central directory — saturated

  return Buffer.concat([chunks.localChunk, chunks.centralChunk, zip64Record, zip64Locator, eocd]);
}

/**
 * A one-entry, stored zip whose filename bytes are UTF-8 but whose
 * general-purpose bit 11 is left clear — i.e. what Google Takeout emits.
 */
export function zipWithoutUtf8Flag(filename: string, contents: string): Buffer {
  return buildZip([{ name: filename, contents }]);
}
