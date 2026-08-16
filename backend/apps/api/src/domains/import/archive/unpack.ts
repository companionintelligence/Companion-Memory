/*
 * Unzip-on-ingest. Real exports arrive as .zip (amazon "Your Orders.zip",
 * twitter, facebook, Google Takeout splits, …). Importers operate on the
 * unpacked tree, so we expand every archive found in a staging directory before
 * recognition. By default the original zip is kept (idempotent via a sibling
 * `.unpacked` marker); the unpack stage passes `deleteArchives` so each staged
 * copy is reclaimed the moment its extraction succeeds — a 350GB Takeout used
 * to hold zips + extracted tree simultaneously (~650GB transient) and ENOSPC'd
 * a 500GB-free disk mid-import.
 *
 * adm-zip buffers the whole archive in memory and has no ZIP64 support, so it
 * silently FAILS on the multi-GB archives real exports ship as (Google Takeout
 * splits run 40-50GB; an Apple "Photos Library" zip is ~35GB) — which is how
 * ~200GB of a real export once imported as 0 items. Large archives therefore
 * stream through the system `unzip` instead. Google Takeout also wraps every
 * category in a top-level `Takeout/` folder; we flatten it up so the
 * per-category importers see `Mail/`, `Google Photos/`, … at the level they
 * recognize.
 *
 * This is the RECURSIVE pass over a whole tree. The guarded single-archive
 * expansion of freshly-uploaded, untrusted bytes lives in `./extract`, which
 * adds zip-slip and size caps this pass does not need — by the time this runs,
 * the drop has already been through those guards.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import AdmZip from 'adm-zip';

import { systemExtract, systemExtractAvailable } from './systemExtract';

export interface UnpackResult {
  archive: string;
  files: number;
  method: 'adm-zip' | 'system-unzip';
}

export interface UnpackOptions {
  /**
   * Delete each archive after ITS extraction succeeds (and write no `.unpacked`
   * marker — a gone zip can't be re-extracted). Pass ONLY for paths the
   * importer owns (a run's scratch directory), never for a user-supplied path:
   * scratch is consume-and-delete territory anyway (the whole path is reclaimed
   * after the run), this just reclaims each zip's bytes ~an import earlier,
   * halving the peak disk a big export needs. A FAILED extraction keeps its zip
   * (and writes no marker), so a retry — e.g. after freeing disk — picks up
   * where it left off.
   */
  deleteArchives?: boolean;
  /**
   * Called once per archive moved to `.rejected/` (see {@link RejectedArchive}),
   * so the caller can surface it: the unpack stage folds them into the run's
   * ledger. Purely a reporting hook — the unpack continues either way.
   */
  onRejected?: (rejected: RejectedArchive) => void;
}

/** An archive the readability preflight set aside, and why. */
export interface RejectedArchive {
  /** Where the archive was when it failed (its original staged path). */
  archive: string;
  /** Where it was moved to — `<dir>/.rejected/<name>`, kept for inspection. */
  movedTo: string;
  /** Human-readable defect, from {@link diagnoseArchive}. */
  reason: string;
}

/**
 * Quarantine directory for unreadable archives, inside the folder they were
 * staged in. Dot-prefixed so the recursive collect below skips it (no
 * re-diagnosing what we already set aside) and so importer recognition never
 * sees the bytes.
 */
export const REJECTED_DIR = '.rejected';

/**
 * Preflight failure: the pending archives declare more uncompressed bytes than
 * the target filesystem has free. Raised BEFORE anything extracts, so the run
 * fails with an actionable message instead of ENOSPC-ing midway with the disk
 * full of half-extracted trees.
 */
export class InsufficientDiskError extends Error {
  constructor(
    public readonly neededBytes: number,
    public readonly freeBytes: number,
    dir: string,
  ) {
    super(
      `not enough disk space to unpack: archives under ${dir} declare ` +
        `${(neededBytes / 1e9).toFixed(1)}GB uncompressed but only ` +
        `${(freeBytes / 1e9).toFixed(1)}GB is free — free up space and retry`,
    );
    this.name = 'InsufficientDiskError';
  }
}

/**
 * An archive the caller handed us that is not a readable zip.
 *
 * Thrown by the single-archive path only ({@link diagnoseArchive} via
 * `./extract`), where it fails one just-received upload and is reported in that
 * upload's response — the earliest and most useful moment to tell someone their
 * download is broken.
 *
 * The tree pass below does NOT throw this: it quarantines (see
 * {@link RejectedArchive}) so one bad archive cannot block its siblings.
 */
export class CorruptArchiveError extends Error {
  constructor(public readonly archives: Array<{ archive: string; reason: string }>) {
    const detail = archives.map((a) => `${path.basename(a.archive)}: ${a.reason}`).join('; ');
    super(
      (archives.length === 1
        ? `cannot unpack ${detail}`
        : `cannot unpack ${archives.length} archives: ${detail}`) +
        `. Nothing was extracted — re-download the export and upload it again.`,
    );
    this.name = 'CorruptArchiveError';
  }
}

/**
 * Why this file can't be read as a zip, or null when it looks readable.
 *
 * Cheap by design (a 4-byte head read, a ≤64 KiB tail read, and — only when the
 * structure looks sane — the `unzip -l` the disk preflight already runs), so it
 * can gate every pending archive before the first byte extracts.
 *
 * The tail scan is the load-bearing check: every zip reader locates entries
 * through the end-of-central-directory record at the END of the file, so a
 * download that stopped early is unreadable in its entirety no matter how many
 * complete entries precede the cut. ZIP64 archives carry an EOCD record too
 * (behind a locator), so the same signature scan covers them.
 */
export function diagnoseArchive(archivePath: string, size?: number): string | null {
  let bytes: number;
  try {
    bytes = size ?? fs.statSync(archivePath).size;
  } catch (err) {
    return `unreadable: ${(err as Error).message}`;
  }

  if (bytes === 0) {
    return 'the file is empty (0 bytes)';
  }

  let fd: number;
  try {
    fd = fs.openSync(archivePath, 'r');
  } catch (err) {
    return `unreadable: ${(err as Error).message}`;
  }

  try {
    // A zip starts with a local file header, or the bare EOCD of an empty zip.
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    const localHeader = head.equals(Buffer.from('504b0304', 'hex'));
    const emptyZip = head.equals(Buffer.from('504b0506', 'hex'));
    if (!localHeader && !emptyZip) {
      return 'the file is not a zip archive (no zip signature at its start)';
    }

    // The EOCD sits in the last 22 bytes + up to 64 KiB of archive comment.
    const window = Math.min(bytes, 22 + 0xffff);
    const tail = Buffer.alloc(window);
    fs.readSync(fd, tail, 0, window, bytes - window);
    if (tail.indexOf(Buffer.from('504b0506', 'hex')) === -1) {
      return (
        'the file is truncated — its end-of-central-directory record is missing, ' +
        `so the download did not finish (${(bytes / 1e6).toFixed(1)} MB arrived)`
      );
    }
  } finally {
    fs.closeSync(fd);
  }

  // Structure looks sane; let `unzip` have the final say on the directory
  // itself (bad offsets, a damaged record). Skipped when it isn't installed —
  // adm-zip then reports any residual damage at extraction time, as before.
  if (systemUnzipAvailable()) {
    const l = spawnSync('unzip', ['-l', archivePath], { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (l.status !== 0) {
      const why =
        (l.stderr || l.stdout || '')
          .split('\n')
          .map((s) => s.trim())
          .find((s) => s.length > 0) || `unzip exit ${l.status}`;

      return `its central directory is unreadable: ${why}`;
    }
  }

  return null;
}

/**
 * Move an unreadable archive into `<dir>/.rejected/`, beside a `.txt` naming
 * the defect — the only place a user without shell access can see WHY their
 * upload produced nothing. Same filesystem, so the rename is atomic; a name
 * already taken there gets a `-2`, `-3`, … suffix rather than clobbering the
 * previous rejection.
 *
 * Best-effort by design: if the move fails (permissions, a read-only mount) the
 * archive is left where it is and reported anyway. It will be re-diagnosed and
 * re-reported next pass — noisy, but never fatal and never silent.
 */
function quarantine(archivePath: string, dir: string, reason: string): RejectedArchive {
  const rejectedDir = path.join(dir, REJECTED_DIR);
  const base = path.basename(archivePath);
  let target = path.join(rejectedDir, base);
  try {
    fs.mkdirSync(rejectedDir, { recursive: true });
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    for (let n = 2; fs.existsSync(target); n += 1) {
      target = path.join(rejectedDir, `${stem}-${n}${ext}`);
    }

    fs.renameSync(archivePath, target);
    fs.writeFileSync(
      `${target}.txt`,
      `${base} was not imported.\n\nReason: ${reason}\nSet aside: ${new Date().toISOString()}\n\n` +
        `Nothing under ${REJECTED_DIR}/ is imported, scanned for readiness, or counted as\n` +
        `pending input — re-upload a good copy of the export instead. These bytes are kept\n` +
        `so you can inspect or recover them, until the next import of this source reclaims\n` +
        `the folder along with everything else it consumes.\n`,
    );
  } catch {
    // Could not move it — report against its original location.
    return { archive: archivePath, movedTo: archivePath, reason };
  }

  return { archive: archivePath, movedTo: target, reason };
}

/** Headroom the preflight reserves beyond the declared bytes (DB growth, markers, FS overhead). */
const PREFLIGHT_MARGIN_BYTES = 1 * 1024 ** 3; // 1 GiB

/**
 * Free bytes for unprivileged writes on the filesystem holding `dir`, or null
 * when statfs isn't available — the caller then skips the preflight (the guard
 * must never be the thing that breaks extraction).
 */
export function freeBytesAt(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);

    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Total UNCOMPRESSED bytes an archive declares, read from the central directory
 * via `unzip -l` (no payload is decompressed or buffered). Falls back to the
 * archive's own on-disk size when the footer can't be read — an underestimate
 * for compressible content, but exports are dominated by already-compressed
 * media, so it keeps the preflight meaningful without adm-zip's
 * whole-file-in-memory read.
 */
function declaredBytesFor(archivePath: string, size: number): number {
  if (systemUnzipAvailable()) {
    const l = spawnSync('unzip', ['-l', archivePath], { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (l.status === 0) {
      let total: number | null = null;
      for (const line of l.stdout.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+\d+\s+files?\s*$/);
        if (m) {
          total = Number(m[1]);
        }
      }

      if (total !== null) {
        return total;
      }
    }
  }

  return size;
}

// Above this size, skip adm-zip (in-memory + no ZIP64) and stream via `unzip`.
const LARGE_ZIP_BYTES = 1_000_000_000; // 1 GB

// Extractor availability now means "unzip OR ditto" — see ./systemExtract.
function systemUnzipAvailable(): boolean {
  return systemExtractAvailable();
}

// Stream-extract via the system `unzip`: handles ZIP64 + 50GB archives, and is
// more tolerant of the path-collision quirks (e.g. Drive exports) that abort
// stricter extractors. `-o` overwrites so a resumed/partial extraction
// completes; `-qq` is silent. unzip exits 0 (ok) or 1 (ok, with warnings such as
// a skipped bad entry) — both count as success.
function runSystemUnzip(archive: string, destDir: string): { ok: boolean; files: number; detail: string } {
  const r = systemExtract(archive, destDir);
  let files = 0;
  if (r.ok) {
    const list = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (list.status === 0) {
      files = list.stdout.split('\n').filter((l) => l && !l.endsWith('/')).length;
    }
  }

  return { ok: r.ok, files, detail: r.detail };
}

// Extract one archive into destDir. Small archives go through adm-zip (fast, no
// subprocess); anything large — or an adm-zip failure (ZIP64 / corruption it
// can't read) — falls through to the streaming system `unzip`.
function extractArchive(full: string, destDir: string, size: number): UnpackResult {
  const large = size >= LARGE_ZIP_BYTES;
  if (!large) {
    try {
      const zip = new AdmZip(full);
      zip.extractAllTo(destDir, /* overwrite */ false);
      const files = zip.getEntries().filter((en) => !en.isDirectory).length;

      return { archive: full, files, method: 'adm-zip' };
    } catch (err) {
      if (!systemUnzipAvailable()) {
        throw err;
      } // small + no fallback → genuine failure
    }
  }

  if (!systemUnzipAvailable()) {
    throw new Error(
      `archive is ${(size / 1e9).toFixed(1)}GB (exceeds in-memory unzip) and no system extractor ` +
        `('unzip' or 'ditto') is available`,
    );
  }

  const r = runSystemUnzip(full, destDir);
  if (!r.ok) {
    throw new Error(`archive extraction failed (${r.detail})`);
  }

  return { archive: full, files: r.files, method: 'system-unzip' };
}

// Google Takeout wraps everything in a single `Takeout/` dir. Move its children
// up into `parent` so per-category importers see them at the level they
// recognize. Skips names already present (idempotent; never overwrites), and
// removes the wrapper once empty.
function flattenTakeoutWrapper(parent: string, log?: (msg: string) => void): void {
  const wrap = path.join(parent, 'Takeout');
  let st: fs.Stats;
  try {
    st = fs.statSync(wrap);
  } catch {
    return;
  }

  if (!st.isDirectory()) {
    return;
  }

  let children: string[];
  try {
    children = fs.readdirSync(wrap);
  } catch {
    return;
  }

  let moved = 0;
  for (const name of children) {
    const to = path.join(parent, name);
    if (fs.existsSync(to)) {
      continue;
    } // already flattened / collision — leave in place

    try {
      fs.renameSync(path.join(wrap, name), to);
      moved += 1;
    } catch {
      /* cross-device or perms — skip */
    }
  }

  try {
    if (fs.readdirSync(wrap).length === 0) {
      fs.rmdirSync(wrap);
    }
  } catch {
    /* wrapper still holds collision dirs — leave it */
  }

  if (moved) {
    log?.(`flattened Takeout/ → ${moved} categories raised into ${path.basename(parent)}`);
  }
}

/**
 * Recursively unpack every `*.zip` under `dir`. Each archive expands into the
 * folder that contains it, without overwriting existing files; large/ZIP64
 * archives stream via the system `unzip`. After a directory's archives are
 * expanded, a Google `Takeout/` wrapper (if any) is flattened up. An archive
 * already unpacked (its `<name>.zip.unpacked` marker exists) is skipped.
 *
 * Two preflights run before anything extracts:
 *   - readability — every pending archive is checked for a zip signature and an
 *     end-of-central-directory record (plus `unzip -l` when available). A
 *     failure moves that archive to `.rejected/` and reports it through
 *     `opts.onRejected` and the log; its readable siblings still extract. A
 *     truncated download used to be logged-and-skipped in place, which produced
 *     imports that "succeeded" having ingested nothing.
 *   - disk — the pending archives' declared uncompressed totals are checked
 *     against the free space on `dir`'s filesystem (central-directory reads
 *     only — cheap even for a 136-zip Takeout). With `deleteArchives`, the
 *     archives' own bytes count as reclaimable. Short → InsufficientDiskError
 *     BEFORE the disk fills with half an export. This one still throws: unlike
 *     a bad archive, there is nothing to set aside and retrying without freeing
 *     space cannot help.
 *
 * A per-archive failure that survives both preflights (a damaged entry found
 * mid-extraction) is still logged and skipped: that archive keeps its bytes and
 * gets no `.unpacked` marker, so a retry picks it up.
 *
 * With `opts.deleteArchives` (run-owned scratch only — see UnpackOptions) each
 * archive is deleted the moment its own extraction succeeds, so peak disk is
 * ~one archive + the growing tree instead of all archives + the whole tree.
 */
export function unpackArchives(
  dir: string,
  log?: (msg: string) => void,
  opts: UnpackOptions = {},
): UnpackResult[] {
  // Pass 1: collect pending archives per directory (markers respected), so the
  // preflight sees the WHOLE job before the first byte extracts.
  const byDir = new Map<string, Array<{ full: string; size: number }>>();
  const collect = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) {
          collect(full);
        }

        continue;
      }

      if (!e.isFile() || !e.name.toLowerCase().endsWith('.zip')) {
        continue;
      }

      if (fs.existsSync(`${full}.unpacked`)) {
        continue;
      }

      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* keep 0 */
      }

      let list = byDir.get(d);
      if (!list) {
        byDir.set(d, (list = []));
      }

      list.push({ full, size });
    }
  };

  collect(dir);
  if (byDir.size === 0) {
    return [];
  }

  // Readability gate, before the disk check (a truncated archive's declared
  // bytes are meaningless) and before any extraction. An archive we cannot read
  // is QUARANTINED, not skipped and not fatal: it moves to `.rejected/` and the
  // pass continues with its readable siblings.
  //
  // Failing the whole pass was the first shape of this guard, and it was wrong
  // in the one way that matters: there is no route (and no UI) that removes an
  // uploaded file from a staging folder, so a single truncated download would
  // have blocked EVERY future upload for that source, permanently. Moving the
  // bad bytes aside is what makes "we could not read this" recoverable without
  // shell access — and the rejection is still reported, per archive, to the
  // caller and the log.
  for (const [d, list] of byDir) {
    const keep: typeof list = [];
    for (const a of list) {
      const reason = diagnoseArchive(a.full, a.size);
      if (!reason) {
        keep.push(a);
        continue;
      }

      const rejected = quarantine(a.full, d, reason);
      log?.(
        `REJECTED ${path.basename(a.full)}: ${reason} — moved to ` +
          `${path.join(REJECTED_DIR, path.basename(rejected.movedTo))}, nothing imported from it`,
      );
      opts.onRejected?.(rejected);
    }

    if (keep.length) {
      byDir.set(d, keep);
    } else {
      byDir.delete(d);
    }
  }

  if (byDir.size === 0) {
    return [];
  }

  const free = freeBytesAt(dir);
  if (free !== null) {
    let declared = 0;
    let archiveBytes = 0;
    for (const list of byDir.values()) {
      for (const a of list) {
        declared += declaredBytesFor(a.full, a.size);
        archiveBytes += a.size;
      }
    }

    // Deleting each zip after its extraction returns those bytes along the way,
    // so they don't count against the budget (conservatively assumes the
    // biggest transient is the finished tree, which holds for multi-archive
    // exports where no single zip dominates).
    const needed = (opts.deleteArchives ? declared - archiveBytes : declared) + PREFLIGHT_MARGIN_BYTES;
    if (needed > free) {
      throw new InsufficientDiskError(needed, free, dir);
    }
  }

  // Pass 2: extract.
  const out: UnpackResult[] = [];
  for (const [d, archives] of byDir) {
    let extractedHere = false;
    for (const { full, size } of archives) {
      try {
        const res = extractArchive(full, d, size);
        if (opts.deleteArchives) {
          // The staged copy is spent — reclaim it now (not at end-of-run
          // cleanup) so the next archive extracts into the space this one
          // freed. No marker: a deleted zip can't be re-extracted.
          fs.rmSync(full, { force: true });
        } else {
          fs.writeFileSync(`${full}.unpacked`, '');
        }

        out.push(res);
        extractedHere = true;
        log?.(
          `unpacked ${path.basename(full)} → ${res.files} files` +
            (res.method === 'system-unzip' ? ' (system unzip)' : '') +
            (opts.deleteArchives ? ' (archive reclaimed)' : ''),
        );
      } catch (err) {
        log?.(`skipped ${path.basename(full)}: ${(err as Error).message}`);
      }
    }

    // Flatten a Takeout/ wrapper produced by this directory's archives.
    if (extractedHere) {
      flattenTakeoutWrapper(d, log);
    }
  }

  return out;
}
