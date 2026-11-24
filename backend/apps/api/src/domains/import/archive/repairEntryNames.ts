/*
 * Repairing the entry names a system extractor got wrong.
 *
 * A zip stores filenames as raw bytes. Debian/Ubuntu's Info-ZIP `unzip` decides
 * how to read them from the entry's "version made by" HOST byte: host 0
 * (MS-DOS/FAT) means CP437, so it translates the bytes through a compiled-in
 * CP437→ISO-8859-1 table before calling open(2) and `Mariana Acuña …` (stored
 * as UTF-8 `C3 B1`) lands on disk as `Mariana Acu+¦a …` (`2B A6`).
 *
 * Measured, not assumed — and two things about it are worth stating plainly,
 * because both are the opposite of what the format suggests:
 *
 *   - It ignores general-purpose bit 11, the flag that exists to say "these
 *     bytes are UTF-8". Setting it changes nothing; host 0 is mangled either
 *     way and host 3 (UNIX) is passed through either way. A well-formed
 *     archive is not safe from this.
 *   - It is not a locale setting. `LC_ALL=C.UTF-8` and `-UU` change nothing,
 *     and the `-O CHARSET` flag that would fix it is a Fedora/RHEL patch that
 *     Debian does not carry, so `unzipSupportsUtf8Charset()` is false there and
 *     no environment tweak is available.
 *
 * Google Takeout writes host 0, as does anything built on Java's
 * ZipOutputStream. So this is not an edge case: it is every export belonging to
 * anyone with an accented name in their contacts, and since the appliance runs
 * Linux, "unzip handles it" was never true where it actually matters.
 *
 * Rather than replace `unzip` (it streams 50GB archives, reads ZIP64, and
 * tolerates the path-collision quirks in Drive exports that abort stricter
 * extractors), this runs AFTER it and fixes only what it got wrong: read the
 * archive's own central directory, and for every entry whose stored bytes are
 * valid UTF-8 but which did not land at its true name, extract that one entry
 * directly and remove the mangled twin.
 *
 * The test is always "is the file where the archive says it should be", never
 * "which extractor ran" or "how does that extractor mangle". So macOS (`ditto`)
 * and Fedora (`unzip -O UTF-8`) find everything in place and this costs one
 * central-directory read and nothing else — and the same code stays correct if
 * a future image translates names differently again.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { stripListedSymlinks } from './containment';
import type { ZipEntry } from './zipDirectory';
import { canExtractZipEntry, extractZipEntry, readZipDirectory } from './zipDirectory';

export interface NameRepairResult {
  /** Entries rewritten under their true UTF-8 name. */
  repaired: number;
  /**
   * Entries that needed repair but could not be (unsupported compression
   * method, an entry too large for the in-memory path, a CRC mismatch). Their
   * mangled copy is left alone — a badly-named file beats a missing one.
   */
  unrepaired: number;
  /**
   * Mangled twins removed once the real name was in place. Zero whenever the
   * sweep did not run (see {@link NameRepairOptions.sweep}), in which case
   * roughly `repaired` badly-named duplicates are still on disk.
   */
  removed: number;
}

export interface NameRepairOptions {
  /**
   * Delete the mangled copies left behind. Requires that `destDir` hold the
   * output of THIS archive and nothing else, because that is what makes
   * "absent from the central directory" mean "extractor debris".
   *
   * Off by default, and deliberately a caller's assertion rather than
   * something guessed here: `./unpack` expands archives into the folder that
   * CONTAINS them, which also holds sibling exports and their zips — sweeping
   * by set difference there would delete a user's un-extracted archive. Those
   * runs keep the correct name and live with the duplicate. `./extract`, the
   * upload path, extracts into a directory named after the archive and passes
   * this.
   */
  sweep?: boolean;
}

const NOTHING: NameRepairResult = { repaired: 0, unrepaired: 0, removed: 0 };

function hasNonAscii(bytes: Buffer): boolean {
  return bytes.some((b) => b >= 0x80);
}

/**
 * Whether these bytes really are UTF-8. A genuine CP437 name from a DOS-era
 * archive will not round-trip, and for those `unzip`'s translation is the
 * correct reading — this module must leave them alone.
 */
function isValidUtf8(bytes: Buffer): boolean {
  return Buffer.compare(Buffer.from(bytes.toString('utf8'), 'utf8'), bytes) === 0;
}

/**
 * The relative path an entry should occupy, or null if it is unusable: a
 * directory entry, an absolute path, or one that escapes the destination.
 *
 * The containment check is not inherited from the caller's: `./extract`
 * asserts containment over the names the SYSTEM extractor sees, and the true
 * UTF-8 name is by definition a different string. Anything this module writes
 * has to be re-checked against the same rule, or a crafted archive could use a
 * mangled name to pass the caller's check and a `../` name to land here.
 */
function safeRelativePath(entry: ZipEntry): string | null {
  const name = entry.nameBytes.toString('utf8');
  if (name.length === 0 || name.endsWith('/') || name.includes('\0')) {
    return null;
  }

  const normalized = path.normalize(name.replace(/\\/g, '/'));
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    return null;
  }

  return normalized;
}

/** Every path the archive accounts for, plus their ancestors, NFC-normalised. */
function expectedPaths(entries: ZipEntry[]): Set<string> {
  const expected = new Set<string>();

  for (const entry of entries) {
    const name = entry.nameBytes.toString('utf8').replace(/\\/g, '/').replace(/\/+$/, '');
    if (name.length === 0) {
      continue;
    }

    const segments = name.split('/').filter((s) => s.length > 0 && s !== '.');
    for (let i = 1; i <= segments.length; i += 1) {
      expected.add(segments.slice(0, i).join('/').normalize('NFC'));
    }
  }

  return expected;
}

/*
 * Finding and deleting the mangled copies needs BYTE-exact paths, and Node
 * cannot give us them here.
 *
 * A mangled name is by construction not valid UTF-8 (`A6` is a bare
 * continuation byte), and a JS string cannot hold those bytes — round-tripping
 * one through a string yields U+FFFD, which re-encodes to different bytes and
 * names a different file. Buffer paths are Node's answer to exactly this, but
 * Yarn PnP patches `fs` and rejects any Buffer path that is not valid UTF-8
 * (yarnpkg/berry#4942), and PnP is this repo's linker in dev, CI and the
 * production image alike.
 *
 * `find -print0` and `xargs -0` carry the bytes over a pipe rather than through
 * argv or a JS string, so they arrive intact. Both are POSIX and present
 * wherever `unzip` is, which this module already requires. If either is
 * missing, the sweep is skipped and the duplicates simply remain — the repair
 * itself does not depend on any of this.
 */

/** Split a NUL-delimited `-print0` stream. */
function splitNul(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) {
      if (i > start) {
        out.push(buf.subarray(start, i));
      }

      start = i + 1;
    }
  }

  return out;
}

/** Every path of `type` ('f' or 'd') under `destDir`, as raw bytes. Null if `find` is unusable. */
function findPaths(destDir: string, type: 'f' | 'd'): Buffer[] | null {
  const r = spawnSync('find', [destDir, '-mindepth', '1', '-type', type, '-print0'], {
    maxBuffer: 1 << 30,
  });

  if (r.error || r.status !== 0 || !Buffer.isBuffer(r.stdout)) {
    return null;
  }

  return splitNul(r.stdout);
}

/**
 * The `destDir`-relative key for a found path, NFC-normalised to match
 * {@link expectedPaths}. Normalising is what stops `ditto`'s NFD names on APFS
 * from looking like entries the archive never listed.
 */
function relativeKey(prefixLength: number, full: Buffer): string {
  return full.subarray(prefixLength).toString('utf8').split(path.sep).join('/').normalize('NFC');
}

/** Delete raw byte paths by piping them to `xargs -0`. Returns false if it could not run. */
function removeByBytes(paths: Buffer[], command: string[]): boolean {
  if (paths.length === 0) {
    return true;
  }

  const input = Buffer.concat(paths.flatMap((p) => [p, Buffer.from([0])]));
  const r = spawnSync('xargs', ['-0', ...command], { input, stdio: ['pipe', 'ignore', 'ignore'] });

  return !r.error;
}

/**
 * Fix any entry in `archivePath` whose true name did not survive extraction
 * into `destDir`.
 *
 * Cheap and a no-op for the common case: an all-ASCII archive costs one
 * central-directory read and returns before touching the tree.
 */
export function repairEntryNames(
  archivePath: string,
  destDir: string,
  options: NameRepairOptions = {},
): NameRepairResult {
  const entries = readZipDirectory(archivePath);
  if (!entries || entries.length === 0) {
    return NOTHING;
  }

  // Every entry with a non-ASCII name whose bytes really are UTF-8. Bit 11 is
  // deliberately NOT consulted: Debian's unzip ignores it, so a set flag is no
  // evidence the name survived, and an unset one is no evidence it did not.
  // Bytes that are NOT valid UTF-8 are left out — those are genuinely CP437,
  // `unzip`'s translation of them is the correct reading, and a JS string
  // could not express them anyway.
  const atRisk = entries.filter((e) => hasNonAscii(e.nameBytes) && isValidUtf8(e.nameBytes));
  if (atRisk.length === 0) {
    return NOTHING;
  }

  const pending: Array<{ entry: ZipEntry; target: string }> = [];
  let unrepaired = 0;

  for (const entry of atRisk) {
    const relative = safeRelativePath(entry);
    if (relative === null) {
      continue;
    }

    const target = path.resolve(destDir, relative);
    if (path.relative(destDir, target).startsWith('..')) {
      continue;
    }

    // Already correct — `ditto`, or an `unzip` with charset support, got here
    // first. Nothing to do and nothing to sweep. `lstat`, so a link at the true
    // name is seen as a link: that is the extractor restoring one of the
    // archive's link entries (removed below, before anything is written), and
    // this pass never turns a link into a file.
    try {
      const existing = fs.lstatSync(target);
      if (existing.isSymbolicLink() || existing.size === entry.uncompressedSize) {
        continue;
      }
    } catch {
      /* not present under its true name — that is what we are here to fix */
    }

    if (!canExtractZipEntry(entry)) {
      unrepaired += 1;
      continue;
    }

    pending.push({ entry, target });
  }

  if (pending.length === 0) {
    return { repaired: 0, unrepaired, removed: 0 };
  }

  // The extractor restores the archive's link entries as real links, and the
  // callers only remove them after this returns. Take them out first: one of
  // them can sit on the way to a true name (`dé` a link, `dé/x.json` an entry),
  // and the writes below would otherwise go wherever it points. A link this
  // archive did not list is not ours to delete; extractZipEntry refuses to
  // write through it instead.
  stripListedSymlinks(
    destDir,
    entries.map((e) => e.nameBytes.toString('utf8')),
  );

  let repaired = 0;
  let fd: number;
  try {
    fd = fs.openSync(archivePath, 'r');
  } catch {
    return { repaired: 0, unrepaired: unrepaired + pending.length, removed: 0 };
  }

  try {
    for (const { entry, target } of pending) {
      if (extractZipEntry(fd, entry, target, destDir)) {
        repaired += 1;
      } else {
        unrepaired += 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  // Remove the mangled copies now that the real names are in place. The
  // destination belongs to this archive alone (both callers extract into a
  // directory named after it), so anything the central directory does not
  // account for is extractor debris.
  //
  // The budget is what was actually REPAIRED, not what was at risk: each
  // repaired entry accounts for exactly one mangled twin, so a larger orphan
  // count means the tree holds something this pass cannot explain and the
  // whole sweep is abandoned. That is deliberately strict — it means one entry
  // failing to repair (a bad CRC, an unsupported method) protects its own
  // badly-named copy instead of deleting the only version of the file. A
  // duplicate is a much smaller problem than data we did not write being gone.
  if (repaired === 0 || !options.sweep) {
    return { repaired, unrepaired, removed: 0 };
  }

  const root = path.resolve(destDir);
  const prefixLength = Buffer.byteLength(root) + 1; // + the separator
  const expected = expectedPaths(entries);
  const files = findPaths(root, 'f');
  if (files === null) {
    return { repaired, unrepaired, removed: 0 };
  }

  const orphanFiles = files.filter((f) => !expected.has(relativeKey(prefixLength, f)));
  if (orphanFiles.length > repaired) {
    return { repaired, unrepaired, removed: 0 };
  }

  if (!removeByBytes(orphanFiles, ['rm', '-f'])) {
    return { repaired, unrepaired, removed: 0 };
  }

  // Then the directories they lived in, deepest-first. `rmdir` rather than
  // `rm -r`: it refuses a directory that still holds something, so a subtree
  // this pass did not fully account for is left standing instead of erased.
  const directories = findPaths(root, 'd') ?? [];
  const orphanDirectories = directories
    .filter((d) => !expected.has(relativeKey(prefixLength, d)))
    .sort((a, b) => b.length - a.length);
  removeByBytes(orphanDirectories, ['rmdir']);

  // Count what actually went, rather than what we asked to go.
  const after = findPaths(root, 'f');
  const remaining =
    after === null
      ? orphanFiles.length
      : after.filter((f) => !expected.has(relativeKey(prefixLength, f))).length;

  return { repaired, unrepaired, removed: orphanFiles.length - remaining };
}
