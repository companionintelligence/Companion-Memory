import { relativePathOf } from './groupImportFiles';

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

/** One incremental CRC32 step — state in, state out, never the whole file. */
function crc32Update(state: number, chunk: Uint8Array): number {
  let c = state;

  for (const byte of chunk) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }

  return c;
}

/** Chunk size for the CRC pass fallback path — big enough to be I/O-bound. */
const CRC_SLICE_BYTES = 8 * 1024 * 1024;

/**
 * CRC32 of a Blob without ever holding it in memory.
 *
 * This is the load-bearing difference from the old packer: `arrayBuffer()` on
 * a whole file is capped around 2GB in Chromium and fails with a
 * NotReadableError whose boilerplate says "permission problems" — which is
 * exactly what a multi-GB Takeout part in a dropped folder produced. Reading
 * through `stream()` (or, where that is missing, an 8MB `slice()` loop) keeps
 * the high-water mark at one chunk regardless of file size.
 */
async function crc32OfBlob(file: Blob): Promise<number> {
  let state = 0xffffffff;

  if (typeof file.stream === 'function') {
    const reader = file.stream().getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      state = crc32Update(state, value);
    }
  } else {
    for (let at = 0; at < file.size; at += CRC_SLICE_BYTES) {
      const slice = file.slice(at, Math.min(at + CRC_SLICE_BYTES, file.size));

      state = crc32Update(state, await sliceBytes(slice));
    }
  }

  return (state ^ 0xffffffff) >>> 0;
}

/** One slice's bytes — arrayBuffer where available, FileReader where not (jsdom). */
function sliceBytes(slice: Blob): Promise<Uint8Array> {
  if (typeof slice.arrayBuffer === 'function') {
    return slice.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsArrayBuffer(slice);
  });
}

function dosTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Classic zip field ceiling: a size/offset at or past this needs Zip64. */
const ZIP64_FIELD_LIMIT = 0xffffffff;
/** Classic EOCD entry-count ceiling. */
const ZIP16_COUNT_LIMIT = 0xffff;

/** Version-needed-to-extract: 2.0 for plain stored entries, 4.5 once Zip64 is in play. */
const VERSION_CLASSIC = 20;
const VERSION_ZIP64 = 45;

interface PackOptions {
  /**
   * TEST-ONLY override of the 4GB boundary at which entries switch to Zip64
   * records. A test cannot allocate a 4GB fixture, but the Zip64 encoding
   * must still be proven against a spec-reading decoder; lowering the
   * threshold forces the same code path on bytes a test can afford.
   */
  zip64Threshold?: number;
}

/**
 * Pack a dropped folder into one uncompressed zip — streaming, constant
 * memory.
 *
 * STORE (no deflate) so a ChatGPT-sized tree does not spend a minute
 * compressing in the tab. The appliance unpacks this the same way it unpacks
 * the original export zip — one drop, one run, not one HTTP part per file.
 *
 * ## Why nothing is buffered
 *
 * The returned File is a LAZY composition: tiny header/central-directory
 * Uint8Arrays interleaved with the original `File` objects themselves as blob
 * parts. The browser materializes file bytes only while the upload streams
 * them off disk — the tab never holds file contents. The one full read is the
 * CRC pass ({@link crc32OfBlob}), chunked so its high-water mark is a single
 * chunk. The old packer read every file into memory at once, which both
 * capped a single file near 2GB (Chromium's arrayBuffer limit, surfaced as a
 * bogus "permission problems" NotReadableError) and let a big folder exhaust
 * the renderer.
 *
 * ## Zip64
 *
 * Real Takeout folders exceed the classic format's 4GB size/offset fields, so
 * entries at or past the boundary carry Zip64 extra fields and the archive
 * gains the Zip64 end-of-central-directory records — emitted ONLY when
 * something actually overflows, so a small folder still produces the plainest
 * possible zip (the server's adm-zip fast path reads those; oversized
 * archives take its system-unzip path, which speaks Zip64).
 */
export async function zipFilesStore(
  files: readonly File[],
  onProgress?: (done: number, total: number) => void,
  options?: PackOptions,
): Promise<File> {
  if (files.length === 0) {
    throw new Error('Nothing to pack');
  }

  const zip64At = options?.zip64Threshold ?? ZIP64_FIELD_LIMIT;
  const now = dosTime(new Date());
  const parts: BlobPart[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  let anyZip64 = false;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const name = relativePathOf(file);
    const nameBytes = new TextEncoder().encode(name);
    const crc = await crc32OfBlob(file);
    const size = file.size;

    const entryZip64 = size >= zip64At || offset >= zip64At;

    anyZip64 ||= entryZip64;

    // Local header. With Zip64: both 32-bit size fields hold 0xFFFFFFFF and
    // the 0x0001 extra carries the real (original, compressed) pair — equal
    // here, STORE writes the bytes verbatim.
    const localExtra = size >= zip64At ? 20 : 0;
    const local = new Uint8Array(30 + nameBytes.length + localExtra);
    const localView = new DataView(local.buffer);

    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, entryZip64 ? VERSION_ZIP64 : VERSION_CLASSIC, true);
    localView.setUint16(6, 1 << 11, true); // UTF-8 names
    localView.setUint16(8, 0, true); // stored
    localView.setUint16(10, now.time, true);
    localView.setUint16(12, now.day, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size >= zip64At ? 0xffffffff : size, true);
    localView.setUint32(22, size >= zip64At ? 0xffffffff : size, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, localExtra, true);
    local.set(nameBytes, 30);

    if (size >= zip64At) {
      const at = 30 + nameBytes.length;

      localView.setUint16(at, 0x0001, true);
      localView.setUint16(at + 2, 16, true);
      localView.setBigUint64(at + 4, BigInt(size), true);
      localView.setBigUint64(at + 12, BigInt(size), true);
    }

    // Central directory entry. The Zip64 extra lists ONLY the overflowed
    // fields, in the spec's fixed order: original size, compressed size,
    // local-header offset.
    const sizeOver = size >= zip64At;
    const offsetOver = offset >= zip64At;
    const centralExtra = sizeOver || offsetOver ? 4 + (sizeOver ? 16 : 0) + (offsetOver ? 8 : 0) : 0;
    const central = new Uint8Array(46 + nameBytes.length + centralExtra);
    const centralView = new DataView(central.buffer);

    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, entryZip64 ? VERSION_ZIP64 : VERSION_CLASSIC, true);
    centralView.setUint16(6, entryZip64 ? VERSION_ZIP64 : VERSION_CLASSIC, true);
    centralView.setUint16(8, 1 << 11, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, now.time, true);
    centralView.setUint16(14, now.day, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, sizeOver ? 0xffffffff : size, true);
    centralView.setUint32(24, sizeOver ? 0xffffffff : size, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, centralExtra, true);
    centralView.setUint32(42, offsetOver ? 0xffffffff : offset, true);
    central.set(nameBytes, 46);

    if (centralExtra > 0) {
      let at = 46 + nameBytes.length;

      centralView.setUint16(at, 0x0001, true);
      centralView.setUint16(at + 2, centralExtra - 4, true);
      at += 4;

      if (sizeOver) {
        centralView.setBigUint64(at, BigInt(size), true);
        centralView.setBigUint64(at + 8, BigInt(size), true);
        at += 16;
      }

      if (offsetOver) {
        centralView.setBigUint64(at, BigInt(offset), true);
      }
    }

    // The file itself rides as a LAZY blob part — never read here.
    parts.push(local, file);
    centrals.push(central);
    offset += local.length + size;
    onProgress?.(i + 1, files.length);
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);

  parts.push(...centrals);

  const needsZip64Eocd =
    anyZip64 ||
    files.length > ZIP16_COUNT_LIMIT ||
    centralOffset >= zip64At ||
    centralSize >= zip64At;

  if (needsZip64Eocd) {
    // Zip64 EOCD record + locator, immediately before the classic EOCD.
    const eocd64 = new Uint8Array(56);
    const eocd64View = new DataView(eocd64.buffer);

    eocd64View.setUint32(0, 0x06064b50, true);
    eocd64View.setBigUint64(4, BigInt(44), true); // size of remainder
    eocd64View.setUint16(12, VERSION_ZIP64, true);
    eocd64View.setUint16(14, VERSION_ZIP64, true);
    eocd64View.setBigUint64(24, BigInt(files.length), true);
    eocd64View.setBigUint64(32, BigInt(files.length), true);
    eocd64View.setBigUint64(40, BigInt(centralSize), true);
    eocd64View.setBigUint64(48, BigInt(centralOffset), true);

    const locator = new Uint8Array(20);
    const locatorView = new DataView(locator.buffer);

    locatorView.setUint32(0, 0x07064b50, true);
    locatorView.setBigUint64(8, BigInt(centralOffset + centralSize), true);
    locatorView.setUint32(16, 1, true);

    parts.push(eocd64, locator);
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  const countField = Math.min(files.length, ZIP16_COUNT_LIMIT);

  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, countField, true);
  eocdView.setUint16(10, countField, true);
  eocdView.setUint32(12, centralSize >= zip64At ? 0xffffffff : centralSize, true);
  eocdView.setUint32(16, centralOffset >= zip64At || needsZip64Eocd ? 0xffffffff : centralOffset, true);

  const root = relativePathOf(files[0]).split('/')[0] || 'export';
  const zipName = root.toLowerCase().endsWith('.zip') ? root : `${root}.zip`;

  return new File([...parts, eocd], zipName, { type: 'application/zip' });
}
