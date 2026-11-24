/*
 * Where an archive may write, checked two ways.
 *
 * Shared by every writer in this folder: the adm-zip paths in `./unpack` and
 * `./extract`, and the UTF-8 name repair in `./zipDirectory`. It lives in its
 * own module because the repair sits UNDER `./unpack` in the import graph
 * (`unpack` imports `systemExtract`, which imports the repair), so it cannot
 * import these from `./unpack` without a cycle.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * An archive tried to reach outside its extraction directory.
 *
 * Its own class so the extractor dispatch can tell it apart from a READ
 * failure. adm-zip failing to parse a ZIP64 archive is a reason to retry with
 * the system `unzip`; an entry named `../etc/cron.d/x` is not — retrying it
 * with a second tool hands the escape to whatever that tool's defaults happen
 * to be (Debian's `unzip` strips `../`; `ditto` was never checked). A
 * containment failure is final.
 */
export class ArchiveEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveEscapeError';
  }
}

/** Reject an entry NAME whose resolved path escapes the extraction dir. */
export function assertEntryInside(destDir: string, entryName: string): void {
  const target = path.resolve(destDir, entryName);
  const rel = path.relative(destDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ArchiveEscapeError(`archive entry escapes extraction dir: ${entryName}`);
  }
}

/** `lstat` truthiness: a dangling symlink counts as present, which `existsSync` denies. */
export function existsNoFollow(p: string): boolean {
  try {
    fs.lstatSync(p);

    return true;
  } catch {
    return false;
  }
}

/**
 * Reject a WRITE whose parent directory is not really inside the extraction
 * dir — the check a name can never make.
 *
 * `assertEntryInside` validates the string; this validates the filesystem. A
 * symlink that an earlier archive left in the tree (`link -> /data`) turns an
 * honest name (`link/x.txt`) into a write to `/data/x.txt`: `mkdirSync` with
 * `recursive` walks straight through the link and `writeFileSync` follows it,
 * and `existsSync` on the not-yet-existing file says false, so the
 * never-overwrite guard passes too. Reproduced with Node 22 before this check
 * existed.
 *
 * Walks up from the target's parent to the nearest path that exists, and
 * requires its REAL path to sit under the extraction dir's real path. Done
 * before `mkdirSync`, because creating the missing directories first would
 * already have created them on the far side of the link.
 */
export function assertParentInside(destDir: string, target: string): void {
  // Both sides resolve to their nearest EXISTING ancestor: the extraction dir
  // itself may not exist yet (the upload extractor creates it with the first
  // entry), and a path that does not exist cannot hold a link.
  const nearestExisting = (p: string): string => {
    let probe = p;
    while (!existsNoFollow(probe) && probe !== path.dirname(probe)) {
      probe = path.dirname(probe);
    }

    return probe;
  };

  let root: string;
  let real: string;
  try {
    root = fs.realpathSync(nearestExisting(destDir));
    real = fs.realpathSync(nearestExisting(path.dirname(target)));
  } catch (err) {
    throw new ArchiveEscapeError(
      `cannot resolve extraction path for ${path.relative(destDir, target)}: ${(err as Error).message}`,
    );
  }

  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new ArchiveEscapeError(
      `archive entry would write outside extraction dir through a link: ${path.relative(destDir, target)}`,
    );
  }
}

/**
 * Remove the symlinks among a just-extracted archive's own entries.
 *
 * The system extractors recreate a symlink entry as a real link, and the
 * end-of-stage `stripSymlinks` sweep is too late for the archives that
 * extract after it in the same pass — the next archive's writes would go
 * through it. Checking the archive's own names is O(entries) `lstat`s rather
 * than a walk of a 350GB tree per archive. A name that resolves outside
 * `destDir` is skipped, never unlinked: the extractor did not write there,
 * and neither may this.
 */
export function stripListedSymlinks(
  destDir: string,
  names: readonly string[],
  log?: (msg: string) => void,
): number {
  let removed = 0;

  for (const name of names) {
    const target = path.resolve(destDir, name);
    const rel = path.relative(destDir, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      continue;
    }

    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        fs.unlinkSync(target);
        removed += 1;
      }
    } catch {
      /* not extracted, or already gone */
    }
  }

  if (removed > 0) {
    log?.(`removed ${removed} symlink(s) an archive carried`);
  }

  return removed;
}
