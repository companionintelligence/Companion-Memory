import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The one bounded directory walk the importers share.
 *
 * Thirteen datasources carried their own — depth limits of 2, 4, 5, 6, 8 and
 * none; sorted or filesystem order; collect-everything or stop-at-first;
 * async generators, promise-returning collectors and one synchronous
 * `readdirSync` on the recognition request path. The differences were never
 * deliberate, so they are options here, and every caller passes the values
 * its own copy had: what each importer finds, and in what order, is unchanged.
 *
 * Tolerant by design, as every copy was: a directory that cannot be read (a
 * broken symlink, a permission hole in a user-supplied tree) is skipped, not
 * fatal. Async throughout — recognition runs on the API request path, where a
 * synchronous walk of a large export blocks every other request.
 */
export interface WalkOptions {
  /**
   * How many directory levels below `root` to enter. `0` lists only the files
   * directly in `root`. Required: an unbounded walk over a dropped NAS folder
   * is the mistake every bounded copy was avoiding.
   */
  maxDepth: number;
  /** Keep a file when true. Absent, every file is yielded. */
  match?: (name: string, full: string, entry: Dirent) => boolean;
  /** Visit each directory's entries in locale name order rather than readdir order. */
  sorted?: boolean;
  /** Do not enter dot-prefixed directories. */
  skipHidden?: boolean;
}

/** Every matching file under `root`, depth first, directories entered in the order their entries are visited. */
export async function* walkFiles(root: string, options: WalkOptions): AsyncGenerator<string> {
  yield* walk(root, options, 0);
}

async function* walk(dir: string, options: WalkOptions, depth: number): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  if (options.sorted) {
    entries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (depth < options.maxDepth && !(options.skipHidden && entry.name.startsWith('.'))) {
        yield* walk(full, options, depth + 1);
      }
    } else if (entry.isFile() && (options.match == null || options.match(entry.name, full, entry))) {
      yield full;
    }
  }
}

/** {@link walkFiles}, collected. */
export async function listFiles(root: string, options: WalkOptions): Promise<string[]> {
  const found: string[] = [];

  for await (const file of walkFiles(root, options)) {
    found.push(file);
  }

  return found;
}

/**
 * The first matching file, searching each directory's own files before any of
 * its subdirectories — so a file at the root wins over the same name nested
 * below it. `undefined` when nothing matches within `maxDepth`.
 */
export async function firstFile(root: string, options: WalkOptions): Promise<string | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  if (options.sorted) {
    entries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  }

  for (const entry of entries) {
    const full = path.join(root, entry.name);

    if (entry.isFile() && (options.match == null || options.match(entry.name, full, entry))) {
      return full;
    }
  }

  if (options.maxDepth <= 0) {
    return undefined;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && !(options.skipHidden && entry.name.startsWith('.'))) {
      const found = await firstFile(path.join(root, entry.name), {
        ...options,
        maxDepth: options.maxDepth - 1,
      });

      if (found != null) {
        return found;
      }
    }
  }

  return undefined;
}

/** The files directly in `dir` that `match` keeps; `[]` when it cannot be read. */
export async function filesIn(dir: string, match: (name: string) => boolean): Promise<string[]> {
  return listFiles(dir, { maxDepth: 0, match: (name) => match(name) });
}

/**
 * The child directory of `dir` named `name`, compared case-insensitively —
 * export packages change the casing of their folders between eras
 * ("messages" vs "Messages"). `undefined` when there is none.
 */
export async function childDir(dir: string, name: string): Promise<string | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const wanted = name.toLowerCase();
  const found = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === wanted);

  return found ? path.join(dir, found.name) : undefined;
}
