/*
 * Guarded expansion of a single uploaded archive.
 *
 * A drop lands in object storage as opaque bytes; the unpack stage pulls it to
 * a run-owned scratch directory and expands it HERE, into a SIBLING directory
 * named after the archive, so recognition and the parsers see a real export
 * tree rather than a zip.
 *
 * Unlike `./unpack` (the recursive tree pass that expands into the CONTAINING
 * folder and knows Takeout quirks), this path handles untrusted, user-supplied
 * bytes, so it enforces:
 *   - zip-slip: every entry must resolve inside the target dir, or the whole
 *     archive is rejected before any byte is written;
 *   - caps: max entry count and max total UNCOMPRESSED size. Declared (header)
 *     sizes are validated up front; on the in-memory path the actually-
 *     decompressed bytes are re-checked during the write, so a lying header
 *     can't smuggle a zip bomb through.
 *
 * Small archives go through adm-zip (fast, no subprocess). adm-zip reads the
 * WHOLE archive into memory (`readFileSync`) and decompresses each entry into a
 * Buffer synchronously, so a multi-GB drop would block the event loop (freezing
 * everything sharing the worker for the whole extraction) and spike RSS by
 * gigabytes or OOM. Above a size threshold we therefore never touch adm-zip: we
 * validate the archive from its central directory (via `unzip -Z1` / `unzip -l`,
 * which don't decompress or buffer payloads) and then STREAM the extraction
 * through the system `unzip` binary — the same fallback `./unpack` uses for the
 * 40-50GB Google Takeout / Apple Photos exports. This keeps the zip-slip and
 * declared-size guards on both paths.
 *
 * .tar.gz is intentionally not handled: Node's zlib alone can't walk a tarball
 * and no tar dependency is carried here.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import AdmZip from 'adm-zip';

import { systemExtract } from './systemExtract';
import {
  assertEntryInside,
  assertParentInside,
  CorruptArchiveError,
  diagnoseArchive,
  freeBytesAt,
  InsufficientDiskError,
  stripListedSymlinks,
} from './unpack';

export interface ExtractLimits {
  /** Max number of entries in the archive (default 100k). */
  maxEntries?: number;
  /** Max total uncompressed bytes (default 10 GB). */
  maxTotalBytes?: number;
  /**
   * On-disk archive size (bytes) at/above which adm-zip is skipped and the
   * archive is streamed through the system `unzip` instead. Defaults to 1 GB,
   * matching unpack.ts's LARGE_ZIP_BYTES. Exposed mainly so tests can force the
   * streaming path on a tiny fixture.
   */
  largeArchiveThreshold?: number;
  /**
   * Delete the staged archive once its extraction fully succeeds. The unpack
   * stage passes this for the copy it pulled from object storage: the extracted
   * tree is what the parsers read, so keeping the zip only doubles the run's
   * disk footprint until end-of-run cleanup (a 350GB Takeout ENOSPC'd a
   * 500GB-free disk exactly this way). A FAILED extraction always keeps the
   * archive so a retry still has the bytes.
   */
  deleteArchiveAfterExtract?: boolean;
}

export interface ExtractResult {
  /** Absolute directory the archive was extracted into (a sibling of the zip). */
  destDir: string;
  /** Number of files written. */
  files: number;
  /** Which extractor ran: in-memory adm-zip, or streaming system `unzip`. */
  method: 'adm-zip' | 'system-unzip';
  /** The staged archive was deleted after a fully-successful extraction. */
  archiveDeleted?: boolean;
  /**
   * An extractor errored but still produced a tree, so SOME entries are
   * missing. The run imports what arrived and reports the shortfall rather
   * than reporting a clean success over bytes that never landed.
   */
  partial?: boolean;
  /** Why it was partial — the extractor errors, verbatim. */
  partialReason?: string;
}

/**
 * Disk preflight shared by both extraction paths: the declared uncompressed
 * bytes (already read from the central directory for the cap check) must fit
 * in the free space on the destination filesystem, with headroom. Throws
 * InsufficientDiskError with an actionable message instead of letting `unzip`
 * ENOSPC midway and leave a half-written tree on a full disk.
 */
const DISK_MARGIN_BYTES = 1 * 1024 ** 3; // 1 GiB headroom
function assertDiskFits(declaredBytes: number | null, destDir: string): void {
  if (declaredBytes === null) {
    return;
  }

  const free = freeBytesAt(path.dirname(destDir));
  if (free === null) {
    return;
  } // no statfs — the guard must not break extraction

  if (declaredBytes + DISK_MARGIN_BYTES > free) {
    throw new InsufficientDiskError(declaredBytes + DISK_MARGIN_BYTES, free, path.dirname(destDir));
  }
}

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 ** 3; // 10 GB uncompressed
// Above this on-disk size, skip adm-zip (whole-archive-in-memory + synchronous
// per-entry decompress) and stream via `unzip`. Matches unpack.ts.
const DEFAULT_LARGE_ARCHIVE_BYTES = 1_000_000_000; // 1 GB

let systemUnzipProbe: boolean | undefined;
function systemUnzipAvailable(): boolean {
  if (systemUnzipProbe === undefined) {
    try {
      systemUnzipProbe = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;
    } catch {
      systemUnzipProbe = false;
    }
  }

  return systemUnzipProbe;
}

/** True when this path looks like an archive the intake path should expand. */
export function isExtractableArchive(p: string): boolean {
  return /\.zip$/i.test(p);
}

/** Resolve the sibling directory an archive extracts into. */
function extractionDestDir(archivePath: string): string {
  const base = archivePath.replace(/\.zip$/i, '');

  return path.resolve(fs.existsSync(base) && !fs.statSync(base).isDirectory() ? `${base}.extracted` : base);
}

/**
 * Reject an entry name whose resolved path escapes the extraction dir. The
 * shared check in unpack.ts, so both extractors refuse the same names with the
 * same error class.
 */
const assertInside = assertEntryInside;

/**
 * A symlink sitting where a file is about to be written would be written
 * THROUGH, not replaced: `writeFileSync` follows it. The destination is
 * normally fresh, but a resumed extraction lands in the directory an earlier
 * attempt left behind, and nothing in an export needs a link (see
 * stripSymlinks) — so it goes, and the file takes its place.
 */
function unlinkIfSymlink(target: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      fs.unlinkSync(target);
    }
  } catch {
    /* nothing there */
  }
}

/**
 * In-memory extraction via adm-zip. Reads the whole archive into RAM and
 * decompresses each entry into a Buffer, so this is only used for archives
 * below the streaming threshold. Validates the whole archive (entry count,
 * zip-slip, declared size) before writing any byte, and re-checks the real
 * decompressed size mid-write.
 */
async function extractViaAdmZip(
  archivePath: string,
  destDir: string,
  maxEntries: number,
  maxTotalBytes: number,
): Promise<ExtractResult> {
  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries();
  if (entries.length > maxEntries) {
    throw new Error(`archive has ${entries.length} entries (cap ${maxEntries})`);
  }

  // Validate BEFORE writing anything: a slip or oversize rejects the whole
  // archive with the target directory untouched.
  let declaredBytes = 0;
  for (const entry of entries) {
    assertInside(destDir, entry.entryName);
    if (!entry.isDirectory) {
      declaredBytes += entry.header.size;
    }
  }

  if (declaredBytes > maxTotalBytes) {
    throw new Error(
      `archive would extract ${(declaredBytes / 1e9).toFixed(1)}GB ` +
        `(cap ${(maxTotalBytes / 1e9).toFixed(1)}GB)`,
    );
  }

  assertDiskFits(declaredBytes, destDir);

  let writtenBytes = 0;
  let files = 0;
  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }

    const target = path.resolve(destDir, entry.entryName);
    const data = entry.getData();
    // Re-check against the real decompressed size — headers can lie.
    writtenBytes += data.length;
    if (writtenBytes > maxTotalBytes) {
      throw new Error(`archive exceeded the ${(maxTotalBytes / 1e9).toFixed(1)}GB extraction cap mid-write`);
    }

    // The name was checked above; this checks the filesystem the name lands
    // on — a link already in the destination would carry the write elsewhere.
    assertParentInside(destDir, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    unlinkIfSymlink(target);
    fs.writeFileSync(target, data);
    files += 1;

    // Bound the event-loop block to one entry, not the whole archive: this
    // path decompresses synchronously, and the worker runs every stage of
    // every run in one process.
    await yieldToEventLoop();
  }

  return { destDir, files, method: 'adm-zip' };
}

/** Names of every entry in the archive, read from the central directory. */
function listEntryNames(archivePath: string): string[] {
  const list = spawnSync('unzip', ['-Z1', archivePath], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  });
  if (list.status !== 0) {
    throw new Error(`could not list archive: ${(list.stderr || '').trim() || `unzip exit ${list.status}`}`);
  }

  return list.stdout.split('\n').filter((l) => l.length > 0);
}

/**
 * Total UNCOMPRESSED bytes across all entries, parsed from the `unzip -l`
 * footer (`<bytes>  <n> files`). Reads only the central directory, so it never
 * decompresses or buffers payloads. Returns null if the footer can't be parsed,
 * in which case the caller skips the declared-size check (the entry-count and
 * zip-slip guards still apply).
 */
function declaredUncompressedBytes(archivePath: string): number | null {
  const l = spawnSync('unzip', ['-l', archivePath], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  });
  if (l.status !== 0) {
    return null;
  }

  let total: number | null = null;
  for (const line of l.stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+\d+\s+files?\s*$/);
    if (m) {
      total = Number(m[1]);
    }
  }

  return total;
}

/**
 * Streaming extraction via the system `unzip`. Handles ZIP64 and multi-GB
 * archives without buffering the payload in memory. The archive is validated
 * from its central directory first (zip-slip on every entry, declared total
 * size against the cap) so a malicious or oversize archive is rejected before
 * `unzip` writes anything. `-o` overwrites (a resumed extraction completes);
 * `-qq` is silent. unzip exits 0 (ok) or 1 (ok, with warnings such as a skipped
 * bad entry) — both count as success.
 */
async function extractViaSystemUnzip(
  archivePath: string,
  destDir: string,
  maxEntries: number,
  maxTotalBytes: number,
): Promise<ExtractResult> {
  const names = listEntryNames(archivePath);
  if (names.length > maxEntries) {
    throw new Error(`archive has ${names.length} entries (cap ${maxEntries})`);
  }

  for (const name of names) {
    assertInside(destDir, name);
  }

  const declared = declaredUncompressedBytes(archivePath);
  if (declared !== null && declared > maxTotalBytes) {
    throw new Error(
      `archive would extract ${(declared / 1e9).toFixed(1)}GB ` +
        `(cap ${(maxTotalBytes / 1e9).toFixed(1)}GB)`,
    );
  }

  assertDiskFits(declared, destDir);

  // Containment was asserted above against the archive's own entry names, so it
  // holds whichever extractor systemExtract picks. `exclusiveDest` says this
  // directory is named after (and holds only) this archive — see
  // `extractionDestDir` — which lets the UTF-8 name repair delete the mangled
  // copies it supersedes instead of leaving them to import as duplicates.
  const r = await systemExtract(archivePath, destDir, { exclusiveDest: true });
  if (!r.ok) {
    throw new Error(`archive extraction failed (${r.detail})`);
  }

  // The extractor recreates symlink entries as real links, and the nested pass
  // that runs next writes into this same tree. Take them out here rather than
  // leaving them for the end-of-stage sweep.
  stripListedSymlinks(destDir, names);

  const files = names.filter((n) => !n.endsWith('/')).length;

  return {
    destDir,
    files,
    method: 'system-unzip',
    ...(r.partial ? { partial: true, partialReason: r.detail } : {}),
  };
}

/**
 * Extract `archivePath` into a sibling directory named after the archive
 * (`export.zip` → `export/`; falls back to `export.extracted/` if a FILE with
 * that name already exists). Small archives extract in-memory via adm-zip;
 * archives at/above `largeArchiveThreshold` (default 1 GB) stream through the
 * system `unzip` so the worker's event loop isn't blocked and RSS doesn't
 * balloon. Throws on zip-slip attempts, cap violations, and unreadable
 * archives — the caller decides whether that fails the stage or is reported and
 * retried.
 */
export async function extractUploadedArchive(
  archivePath: string,
  limits: ExtractLimits = {},
): Promise<ExtractResult> {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const largeThreshold = limits.largeArchiveThreshold ?? DEFAULT_LARGE_ARCHIVE_BYTES;

  const destDir = extractionDestDir(archivePath);

  let archiveSize = 0;
  try {
    archiveSize = fs.statSync(archivePath).size;
  } catch {
    /* keep 0 — a missing/unstattable archive falls to adm-zip, which reports it */
  }

  // Diagnose before either extractor runs, so an unreadable upload reports WHY
  // ("truncated — the download did not finish") instead of adm-zip's
  // "Invalid or unsupported zip format" / `unzip exit 9`. Same check, same
  // wording as the recursive pass in unpack.ts.
  const badArchive = diagnoseArchive(archivePath, archiveSize || undefined);
  if (badArchive) {
    throw new CorruptArchiveError([{ archive: archivePath, reason: badArchive }]);
  }

  // Big archives never touch adm-zip: it would read the whole file into memory
  // and decompress each entry synchronously. Stream via `unzip` instead — the
  // same path unpack.ts takes above 1 GB. If the system `unzip` isn't available
  // we can't stream, so surface that.
  let result: ExtractResult;
  if (archiveSize >= largeThreshold) {
    if (!systemUnzipAvailable()) {
      throw new Error(
        `archive is ${(archiveSize / 1e9).toFixed(1)}GB (exceeds in-memory unzip) ` +
          `and system 'unzip' is unavailable`,
      );
    }

    result = await extractViaSystemUnzip(archivePath, destDir, maxEntries, maxTotalBytes);
  } else {
    result = await extractViaAdmZip(archivePath, destDir, maxEntries, maxTotalBytes);
  }

  // Reclaim the staged copy the moment the extraction fully succeeded — any
  // throw above leaves the archive untouched for a retry.
  if (limits.deleteArchiveAfterExtract) {
    try {
      fs.rmSync(archivePath, { force: true });
      result.archiveDeleted = true;
    } catch {
      /* best-effort — a kept zip is only a disk cost, never a correctness one */
    }
  }

  return result;
}
