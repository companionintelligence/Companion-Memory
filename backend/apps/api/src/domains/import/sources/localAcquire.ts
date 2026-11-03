import { createHash } from 'node:crypto';
import { constants as fsConstants, lstatSync, type Stats } from 'node:fs';
import { chmod, chown, copyFile, cp, link, lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { freeBytesAt } from '../archive/unpack';

import { resolveWithinRoots, resolveWithinStaging } from './importRoots';

/**
 * How the unit ended up in scratch. `rename` is the designed case (inbox and
 * scratch share a filesystem); `copy` is the EXDEV fallback; `recovered` means
 * a previous attempt already got it there and this call only had to notice.
 */
export type AcquireMethod = 'rename' | 'copy' | 'recovered';

export interface AcquireLocalUnitInput {
  /** Realpath of the source, recorded inside a staging area at claim time. */
  sourcePath: string;
  /** The run's scratch directory. */
  scratchDir: string;
  /** Advisory size of the unit, for the copy-fallback disk preflight. */
  sizeBytes: number | null;
  log: (message: string) => void;
  /**
   * Whether the run still holds its claim, asked after a cross-filesystem copy
   * and before the source is deleted. A cancel releases the claim while the
   * copy runs, and a released unit is the user's again: it stays where it is
   * and the copy is dropped. Absent means the claim is not re-checked.
   */
  stillClaimed?: () => Promise<boolean>;
  /** Test seam: overrides the filesystem rename to simulate EXDEV. */
  renameImpl?: typeof rename;
}

/** The claim was released (the run was cancelled) while the unit was being copied. */
export class ClaimReleasedDuringCopyError extends Error {
  constructor(name: string) {
    super(`The import was cancelled while ${name} was being copied, so it was left where it was.`);
    this.name = 'ClaimReleasedDuringCopyError';
  }
}

export class InsufficientScratchSpaceError extends Error {
  constructor(needed: number, free: number) {
    super(
      `Not enough disk space to copy this unit into the import's working area: ` +
        `about ${Math.ceil(needed / 1e9)}GB needed, ${Math.floor(free / 1e9)}GB free. ` +
        `Free space and retry the stage.`,
    );
    this.name = 'InsufficientScratchSpaceError';
  }
}

/**
 * Move a staged source (an upload's staged copy, or an inbox unit) into the
 * run's scratch — the acquisition half of every import, and the ONLY code
 * that mutates the staging areas.
 *
 * The move is transactional per unit, built from two renames through a
 * deterministic temp name:
 *
 *   1. `rename(source, tmp)` — atomic on one filesystem; on EXDEV, a copy
 *      into `tmp` followed by deleting `source` ONLY after the copy completed.
 *   2. `rename(tmp, dest)` — same-filesystem, atomic finalize.
 *
 * Both names derive from durable state (the claim's `source_path` and the
 * run's scratch dir), so a retry after any crash can look at the filesystem
 * and finish the story:
 *
 *   - `dest` exists      → a previous attempt finalized; nothing to do.
 *   - `tmp`, no `source` → the first rename landed and the finalize did not;
 *                          finish the second rename.
 *   - `tmp` AND `source` → a copy fallback died mid-write; the source is
 *                          intact, so scrap `tmp` and start over.
 *
 * A NEW same-named unit dropped into the inbox between a crash and the retry
 * is deliberately left alone when `dest` already exists: this run's bytes are
 * the ones that reached scratch, and the newcomer is a different unit for a
 * later batch. Do not "fix" the dest-exists branch into a re-move — that
 * would import someone's fresh copy under a finished claim.
 *
 * Defense in depth: the source is re-resolved against the inbox immediately
 * before the mutation, even though the claim already validated it — a
 * `staged_sources` row edited to point elsewhere must be refused HERE, at the
 * site that moves and deletes, not only at enqueue.
 */
export async function acquireLocalUnit(
  input: AcquireLocalUnitInput,
): Promise<{ destPath: string; method: AcquireMethod }> {
  const doRename = input.renameImpl ?? rename;
  const name = path.basename(input.sourcePath);
  const destPath = path.join(input.scratchDir, name);
  const tmpPath = path.join(input.scratchDir, `.acquiring-${name}`);

  await mkdir(input.scratchDir, { recursive: true });

  if (await exists(destPath)) {
    input.log(`acquire: ${name} already in scratch from a previous attempt`);

    return { destPath, method: 'recovered' };
  }

  if (await exists(tmpPath)) {
    if (await exists(input.sourcePath)) {
      // A copy fallback died mid-write. The source is whole, so the partial
      // copy is garbage.
      input.log(`acquire: scrapping partial copy of ${name} and starting over`);
      await rm(tmpPath, { recursive: true, force: true });
    } else {
      // The first rename landed and the finalize did not.
      input.log(`acquire: finishing interrupted move of ${name}`);
      await doRename(tmpPath, destPath);

      return { destPath, method: 'recovered' };
    }
  }

  // Refuses anything outside the staging areas the importer owns (inbox and
  // uploads) — including a row whose path was tampered with after the claim.
  // Throws PathOutsideImportRootsError, which fails the stage without
  // touching the filesystem.
  const resolved = await resolveWithinStaging(input.sourcePath);

  try {
    await doRename(resolved, tmpPath);
    await doRename(tmpPath, destPath);

    return { destPath, method: 'rename' };
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== 'EXDEV') {
      throw err;
    }
  }

  // The inbox and scratch are on different filesystems (an operator split the
  // mounts). Copy, then delete the source ONLY after the copy completed — the
  // ordering is the entire guarantee here.
  const needed = Math.ceil((input.sizeBytes ?? (await stat(resolved)).size) * 1.1);
  const free = freeBytesAt(input.scratchDir);

  if (free != null && free < needed) {
    throw new InsufficientScratchSpaceError(needed, free);
  }

  input.log(`acquire: inbox and scratch are on different filesystems; copying ${name}`);

  const original = await lstat(resolved);

  // Symlinks are skipped rather than followed: the scan never offers them,
  // and a link inside a unit must not smuggle outside bytes into scratch.
  await cp(resolved, tmpPath, {
    recursive: true,
    dereference: false,
    filter: (src) => !isSymlink(src),
  });

  // `cp` makes the copy as the API's user (root in the container). A file
  // unit keeps its owner here as a rename would have kept it, because a
  // discard copies this file back into the inbox with this owner. Left as
  // root, the host user could not rename or delete it in the sticky inbox.
  if (original.isFile()) {
    await chown(tmpPath, original.uid, original.gid).catch(() => undefined);
  }

  // A copy can take minutes, and a cancel in that time releases the claim. The
  // source is then the user's again, so it must not be deleted.
  if (input.stillClaimed != null && !(await input.stillClaimed())) {
    await rm(tmpPath, { recursive: true, force: true });
    throw new ClaimReleasedDuringCopyError(name);
  }

  await rm(resolved, { recursive: true, force: true });
  await doRename(tmpPath, destPath);

  return { destPath, method: 'copy' };
}

/**
 * Where an inbox unit is in its run's scratch, if it is still whole there.
 *
 * `acquireLocalUnit` leaves it at `<scratchDir>/<name>`, or at the temp name
 * when a crash split its two renames. The temp name counts only when the
 * original is gone: with the original still in the inbox, a temp is a copy
 * fallback that died mid-write and the original is the whole unit.
 */
export async function inboxUnitInScratch(sourcePath: string, scratchDir: string): Promise<string | null> {
  const name = path.basename(sourcePath);
  const destPath = path.join(scratchDir, name);

  if (await exists(destPath)) {
    return destPath;
  }

  const tmpPath = path.join(scratchDir, `.acquiring-${name}`);

  return (await exists(tmpPath)) && !(await exists(sourcePath)) ? tmpPath : null;
}

export interface ReturnInboxUnitInput {
  /** The unit in the run's scratch, from {@link inboxUnitInScratch}. A file. */
  unitPath: string;
  /** The claim's `source_path`: where the unit was when the run took it. */
  sourcePath: string;
  /** The owner's inbox. The unit goes back under it and nowhere else. */
  inboxDir: string;
  log: (message: string) => void;
  /** Test seam: overrides the filesystem link to simulate EXDEV. */
  linkImpl?: typeof link;
}

/**
 * Put an inbox FILE back where its run took it from: the reverse of
 * {@link acquireLocalUnit}, for a run that is being discarded.
 *
 * The unit was the user's only copy, acquired by rename, so a discard must not
 * delete it with the scratch tree. It goes back to its own path in the inbox,
 * or beside it as `name (2).ext` when something has taken that name since.
 * Nothing in the inbox is ever overwritten: the file is placed with `link`,
 * which fails rather than replaces. Only then is it unlinked from scratch. A
 * plain `rename` would silently replace a file written into the inbox between
 * the name check and the move.
 *
 * Files only. A directory unit is changed in place by the unpack (nested
 * archives expanded and deleted, rejects quarantined), so it is not the folder
 * the user dropped any more. The caller refuses it.
 *
 * The target is re-resolved against the owner's inbox before anything moves,
 * as the acquire re-resolves its source: a `source_path` that no longer lies
 * under this inbox (an edited row, a folder moved since) comes back at the
 * inbox's top level under its own name instead. Folders it has to recreate get
 * the inbox's own `1777`, so the host user can still manage them.
 *
 * Returns the path the unit now has.
 */
export async function returnInboxUnit(input: ReturnInboxUnitInput): Promise<string> {
  const doLink = input.linkImpl ?? link;
  const unit = await lstat(input.unitPath);

  if (!unit.isFile()) {
    throw new Error(`${input.unitPath} is not a file. Only a file unit goes back to the inbox`);
  }

  const relative = path.relative(input.inboxDir, input.sourcePath);
  const underInbox = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  const topLevel = path.join(input.inboxDir, path.basename(input.sourcePath));
  let wanted = underInbox ? path.join(input.inboxDir, relative) : topLevel;

  await ensureInboxFolder(input.inboxDir);

  // The deepest folder that exists is checked BEFORE anything is created, so a
  // symlink out of the inbox cannot have folders made through it. The
  // parent is checked again after, on where it leads.
  let missing: string[] = [];
  let existing = path.dirname(wanted);

  // `lstat`, so a dangling symlink where a folder was stops the walk here
  // rather than reading as missing and failing every `mkdir` after it.
  while ((await lstatOrNull(existing)) == null && existing !== input.inboxDir) {
    missing.unshift(existing);
    existing = path.dirname(existing);
  }

  // A folder on the way that is a file now (`google/` replaced by a file of
  // that name, or by a dangling symlink) cannot hold the unit. The link
  // would fail with ENOTDIR on every retry, so the unit goes to the inbox's
  // top level instead.
  if (!(await isDirectory(existing))) {
    wanted = topLevel;
    missing = [];
    existing = input.inboxDir;
  }

  await resolveWithinRoots(existing, [input.inboxDir]);

  for (const dir of missing) {
    await ensureInboxFolder(dir);
  }

  const parent = await resolveWithinRoots(path.dirname(wanted), [input.inboxDir]);
  const name = path.basename(wanted);

  try {
    const target = await linkUnderFreeName(doLink, input.unitPath, parent, name);

    await rm(input.unitPath, { force: true });
    input.log(`return: ${path.basename(input.unitPath)} moved back to the inbox as ${target}`);

    return target;
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== 'EXDEV') {
      throw err;
    }
  }

  // The split-mount case the acquire copies across. The copy goes to a temp
  // name beside the target and is linked into place only once it is whole, so
  // a disk filling up mid-copy leaves a temp file, never a truncated file under
  // the user's own name.
  //
  // The temp name is tagged with this unit's path, so a retry sees only what an
  // earlier attempt for this same unit left. A temp still linked under a second
  // name was whole when that attempt linked it into place and stopped. Linking
  // it again finds that name as done (see linkUnderFreeName). A fresh copy is a
  // different file and would land beside it as `name (2)`.
  input.log(`return: inbox and scratch are on different filesystems; copying ${name}`);

  const tag = createHash('sha256').update(input.unitPath).digest('hex').slice(0, 12);
  const tmpPath = path.join(parent, `.returning-${tag}-${name}`);
  const leftover = await lstatOrNull(tmpPath);

  if (leftover == null || !leftover.isFile() || leftover.nlink < 2) {
    await rm(tmpPath, { force: true });
    await copyFile(input.unitPath, tmpPath, fsConstants.COPYFILE_EXCL);
    // The copy is made by the API's user (root in the container). In the
    // inbox's sticky 1777 folders only a file's owner can rename or delete it,
    // so the copy takes the scratch file's owner, which the acquire kept from
    // the inbox file whether it renamed or copied it.
    await chown(tmpPath, unit.uid, unit.gid).catch(() => undefined);
  }

  const target = await linkUnderFreeName(link, tmpPath, parent, name);

  // Scratch before the temp. If the scratch unlink fails, the temp is still
  // linked here for the retry to recognise.
  await rm(input.unitPath, { force: true });
  await rm(tmpPath, { force: true });

  return target;
}

/** `mkdir` plus the inbox's `1777`, as `ImportInboxService` makes its folders. */
async function ensureInboxFolder(dir: string): Promise<void> {
  if (await exists(dir)) {
    return;
  }

  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o1777).catch(() => undefined);
}

/** Archive suffixes that are one extension, so a renamed copy reads `x (2).tar.gz`. */
const COMPOUND_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst'];

/**
 * Link `from` into `dir` as `name`, or as the first `name (n)` nothing uses
 * yet. `link` refuses an existing name with EEXIST instead of replacing it,
 * so a file that appears in the inbox while this runs moves the unit to the
 * next name rather than being lost.
 *
 * A name already linked to `from` itself counts as done: an earlier return
 * that linked the unit and then crashed or failed before unlinking scratch,
 * or a second discard racing this one. Taking the next name there would put
 * the same file in the inbox twice.
 */
async function linkUnderFreeName(
  doLink: typeof link,
  from: string,
  dir: string,
  name: string,
): Promise<string> {
  const lower = name.toLowerCase();
  const compound = COMPOUND_EXTENSIONS.find((ext) => lower.endsWith(ext));
  const ext = compound != null ? name.slice(-compound.length) : path.extname(name);
  const stem = ext === '' ? name : name.slice(0, -ext.length);
  const source = await lstat(from);

  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    let taken = await lstatOrNull(candidate);

    if (taken == null) {
      try {
        await doLink(from, candidate);

        return candidate;
      } catch (err: unknown) {
        if ((err as { code?: string }).code !== 'EEXIST') {
          throw err;
        }
      }

      taken = await lstatOrNull(candidate);
    }

    if (taken != null && taken.dev === source.dev && taken.ino === source.ino) {
      return candidate;
    }
  }

  throw new Error(`No free name for ${name} in ${dir}: ${stem} (2)${ext} to (999) are all taken`);
}

/** What is at `target`, a dangling symlink included (which `stat` would miss), or null. */
async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch {
    return null;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);

    return true;
  } catch {
    return false;
  }
}

function isSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}
