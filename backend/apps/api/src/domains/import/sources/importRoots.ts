import { realpath } from 'node:fs/promises';
import path from 'node:path';

import config from '@ci/configuration';

import { sanitizeFilename } from './sanitizeFilename';

/**
 * Where a caller is allowed to point the path-based import tools.
 *
 * Upstream this question did not exist: the importer ran on the user's own
 * machine, under their own account, and "import this path" meant a path they
 * already had. Here it is an API on an appliance, reachable by any MCP client
 * holding a token — so an unconstrained absolute path is a filesystem read
 * primitive that would let a caller enumerate `/etc`, or ingest it.
 *
 * The roots are therefore explicit. Empty by default: nothing is importable by
 * path until an operator says which directory holds the exports, which is the
 * safe way round for a capability that only some deployments want. Uploading
 * through the API is unaffected and remains the ordinary path.
 */
export function configuredImportRoots(): string[] {
  return config.import.roots.filter((root) => root.trim().length > 0).map((root) => path.resolve(root));
}

/**
 * The import inbox: a directory the IMPORTER owns, unlike the roots, which
 * hold the user's own files. Everything under it is treated as a copy staged
 * for import — consumed (moved into a run's scratch, then deleted with it)
 * rather than read in place. That ownership difference is why deletion
 * eligibility is only ever computed against this root and never against
 * `configuredImportRoots()`.
 */
export function inboxRoot(): string {
  return path.resolve(config.import.inboxDir);
}

/**
 * One user's slice of the inbox: `<inboxRoot>/<folder derived from email>`.
 *
 * The inbox mount is shared by every account on the appliance, but WHO an
 * import is for is decided by whoever starts the run — so without scoping,
 * any account could import (and thereby consume) an archive someone else
 * dropped. Each account therefore gets its own subtree, and the scan and the
 * batch never leave the caller's.
 *
 * Derived from the EMAIL because it is the one identifier that is both unique
 * (DB constraint) and recognizable from the desktop side of the mount — the
 * display name is neither, and two "Kyle"s sharing a folder would recreate
 * the exact cross-account leak this exists to prevent. Lowercased before
 * sanitizing so the folder never depends on how the email was cased at
 * signup; `@` and friends become `_` (e.g. `kyle@lifescope.io` →
 * `kyle_lifescope.io`).
 */
export function userInboxDir(email: string): string {
  return path.join(inboxRoot(), inboxFolderName(email));
}

/** The folder name one account's inbox subtree gets — see {@link userInboxDir}. */
export function inboxFolderName(email: string): string {
  return sanitizeFilename(email.trim().toLowerCase());
}

/**
 * The inbox root as spelled on the HOST, or `null` when the operator has not
 * said (bare metal, or a container whose inbox is not bind-mounted).
 *
 * Deliberately NOT `path.resolve`d: this is a path on a different filesystem
 * namespace from the one the API runs in. Resolving it here would glue the
 * container's cwd onto a relative value and produce a path that exists
 * nowhere. A trailing separator is dropped so joining is predictable.
 */
export function inboxHostRoot(): string | null {
  const configured = config.import.inboxHostDir.trim().replace(/[\\/]+$/, '');

  return configured.length > 0 ? configured : null;
}

/**
 * {@link userInboxDir} as a PERSON reaches it.
 *
 * The scan tells the UI and the CLI where to drop files. When the API is a
 * container, `userInboxDir()` names a directory inside it —
 * `/var/lib/ci-import/inbox/<user>` — which is unreachable from the desktop
 * that owns the files, while the same bytes sit behind a bind mount at a
 * host path only the operator knows (`CI_IMPORT_INBOX_HOST_DIR`). This
 * returns that spelling when it is configured and the server's own otherwise.
 *
 * Display only. Everything that touches the filesystem keeps using
 * {@link userInboxDir} / {@link realUserInboxDir}; a host path must never be
 * handed to a resolver, because it does not exist where the resolver runs.
 * Joined with `/` rather than `path.join`: the host is not necessarily the
 * platform the API runs on, and a bind-mount source is always written with
 * forward slashes in compose.
 */
export function userInboxDisplayDir(email: string): string {
  const host = inboxHostRoot();

  return host == null ? userInboxDir(email) : `${host}/${inboxFolderName(email)}`;
}

/**
 * One user's inbox subtree as the RESOLVERS see it: {@link userInboxDir} put
 * through the same `realpath` that {@link resolveWithinRoots} applies before
 * its containment check.
 *
 * The two spellings are the same string only when no symlink sits above the
 * mount, and differ the moment one does — macOS puts `/tmp` and `/var` behind
 * `/private`, and a bind-mounted appliance data dir does the same. Anything
 * that compares a resolved path back against the inbox — `path.relative()` to
 * name a unit, or a lookup keyed on a path a run recorded — must start from
 * THIS root, or the two live in different namespaces and the comparison
 * quietly answers wrong: `path.relative()` yields a `../../…` escape rather
 * than the unit's path, and an equality test matches nothing.
 *
 * Falls back to the literal path when the directory cannot be resolved (an
 * account whose subtree is not provisioned yet), so a caller still gets a
 * usable root instead of an exception from what is only a comparison step.
 */
export async function realUserInboxDir(email: string): Promise<string> {
  const dir = userInboxDir(email);

  try {
    return await realpath(dir);
  } catch {
    return dir;
  }
}

/**
 * Where uploads are staged: `<uploadsDir>/<dropId>/<filename>`, registered in
 * `ci_import.staged_sources`. Importer-owned like the inbox, but root-only —
 * nothing lands here except through the API, and the TTL purge sweeps it.
 */
export function uploadsRoot(): string {
  return path.resolve(config.import.uploadsDir);
}

/** Raised when a caller points at somewhere they may not read. */
export class PathOutsideImportRootsError extends Error {
  constructor(requested: string, roots: string[]) {
    super(
      roots.length === 0
        ? `Path imports are not enabled on this appliance. Set CI_IMPORT_ROOTS to the directories ` +
            `that hold exports, or upload the archive instead.`
        : `${requested} is outside the configured import roots (${roots.join(', ')}).`,
    );
    this.name = 'PathOutsideImportRootsError';
  }
}

/**
 * Resolve a caller-supplied path against an explicit root set, or refuse it.
 *
 * Resolution goes through `realpath` BEFORE the containment check, so a symlink
 * inside a root that points outside one is rejected on where it actually leads
 * rather than where it appears to sit. Checking the literal path first and
 * following the link afterwards is the ordering that produces a bypass.
 *
 * Containment compares path SEGMENTS, not string prefixes: `/srv/exports-secret`
 * must not pass because `/srv/exports` is a prefix of it.
 *
 * A root whose own `realpath` fails (an unmounted volume) contributes nothing
 * rather than failing every resolution — the other roots still work.
 */
export async function resolveWithinRoots(requested: string, roots: string[]): Promise<string> {
  if (roots.length === 0) {
    throw new PathOutsideImportRootsError(requested, roots);
  }

  let resolved: string;

  try {
    resolved = await realpath(path.resolve(requested));
  } catch {
    // A path that cannot be resolved is reported as out of bounds rather than
    // as missing: "does this file exist?" is itself information about a
    // filesystem the caller has no business reading.
    throw new PathOutsideImportRootsError(requested, roots);
  }

  const contained = await Promise.all(
    roots.map(async (root) => {
      let realRoot: string;

      try {
        realRoot = await realpath(root);
      } catch {
        return false;
      }

      const relative = path.relative(realRoot, resolved);

      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }),
  );

  if (!contained.some(Boolean)) {
    throw new PathOutsideImportRootsError(requested, roots);
  }

  return resolved;
}

/**
 * The read-side resolver the path tools use: the operator's roots plus the
 * CALLER's OWN inbox subtree — the same composition upstream made when it
 * appended its data dir to CI_IMPORT_ROOTS so the wizard's dropped files were
 * importable, narrowed to the one slice of the shared mount that is the
 * caller's. Never the whole inbox root: reading is quieter than consuming,
 * but another account's dropped archive is not this caller's to read either.
 * `email: null` means an anonymous or unresolvable caller — configured roots
 * only, no inbox at all. Only the inbox batch surface may CONSUME an inbox
 * path, and it resolves through {@link resolveWithinUserInbox} instead.
 */
export async function resolveWithinImportRoots(requested: string, email: string | null): Promise<string> {
  const roots = configuredImportRoots();

  if (email != null) {
    roots.push(userInboxDir(email));
  }

  return resolveWithinRoots(requested, roots);
}

/**
 * The consume-side resolver for the INBOX surfaces: ONE USER's inbox subtree,
 * nothing else. Every path the scan walks or the batch starts goes through
 * this — so a path under a configured root can never reach the code that
 * claims inbox units, and neither can another account's subtree, by
 * construction rather than by a check someone could forget.
 */
export async function resolveWithinUserInbox(requested: string, email: string): Promise<string> {
  return resolveWithinRoots(requested, [userInboxDir(email)]);
}

/**
 * The mutation-site resolver: the two staging areas the importer OWNS — the
 * inbox and the uploads directory. `localAcquire` re-validates through this
 * immediately before moving or deleting, so nothing under the user's own
 * roots can ever be consumed, whichever registry row claims it.
 */
export async function resolveWithinStaging(requested: string): Promise<string> {
  return resolveWithinRoots(requested, [inboxRoot(), uploadsRoot()]);
}
