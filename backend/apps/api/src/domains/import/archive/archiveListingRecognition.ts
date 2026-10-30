/*
 * "Would an importer read this archive?" — answered from the archive's file
 * LISTING alone, before any of its contents exist on this machine.
 *
 * The listing is laid out as a tree of EMPTY files in a temp directory and the
 * ordinary recognisers run over it. Most exports are recognised by their shape
 * (Facebook's `your_facebook_activity/`, a Takeout's category folders), which
 * an empty tree reproduces exactly. A recogniser that has to read a file's
 * contents sees nothing and does not match, so this can MISS an export; it is
 * a gate for an unattended download, not a replacement for the real
 * recognition the import run does once the bytes are here.
 *
 * Only a match on a DIRECTORY counts. Several importers claim a single file by
 * its extension (.ics, .gpx, .vcf, .mbox), and one such file sitting in a
 * backup of a project folder does not make that zip an export — importing it
 * would also sweep every other file in the zip in through the catch-all
 * importer. An archive qualifies when its STRUCTURE is one an importer knows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { allDataSources, dataSourcesRecognize } from '../datasources/registry';

/** The catch-all importer: it claims any tree, so its match says nothing. */
const GENERIC_DATA_SOURCE = 'generic';

/**
 * Below this an importer's match is a guess from one weak signal (Facebook
 * answers 0.6 for any tree with a top-level `messages/` folder). Fine when a
 * person chose the file and is looking at the preview; not enough to pull an
 * archive out of someone's cloud drive and import it unasked.
 */
export const LISTING_CONFIDENCE_FLOOR = 0.75;

/** One directory of a listing that a specialised importer recognises as an export it reads. */
export interface ListingRoot {
  /** POSIX path of the directory, relative to the listing; `''` is the listing itself. */
  root: string;
  /** The importers that claimed it (or something nested inside it), most confident first. */
  importers: string[];
}

export interface RecognizeListingOptions {
  /**
   * How deep to look for an export's top folder. Defaults to the depth a
   * local import uses (DEFAULT_RECOGNIZE_MAX_DEPTH); a cloud-drive listing
   * asks for a little more, since the export sits wherever the service that
   * wrote it chose.
   */
  maxDepth?: number;
}

/**
 * The directories in a file listing that specialised importers recognise, as
 * OUTERMOST roots: a match nested inside another is folded into it, because
 * the unit that gets imported is the outer folder (a Takeout holding six
 * services is one export, not six).
 *
 * Empty when nothing is recognised, or when a recogniser fails on the empty
 * tree.
 */
export async function recognizeListingRoots(
  entryPaths: readonly string[],
  options: RecognizeListingOptions = {},
): Promise<ListingRoot[]> {
  // No upper bound on the listing's size. There was one (100,000 entries), and
  // all it did was make the largest exports — the ones with the most in them —
  // read as "not an export" and stay unimported. An empty file per entry is
  // cheap; missing a person's whole Takeout is not.
  if (entryPaths.length === 0) {
    return [];
  }

  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ci-archive-listing-'));

  try {
    const madeDirs = new Set<string>([base]);
    const ensureDir = async (dir: string): Promise<void> => {
      if (!madeDirs.has(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
        madeDirs.add(dir);
      }
    };

    for (const entryPath of entryPaths) {
      // Same containment rule as extraction: an entry that would land outside
      // the tree is skipped. Nothing is written but an empty file, but an
      // empty file in the wrong place is still a write this must not make.
      const target = path.resolve(base, entryPath.replace(/^\/+/, ''));
      if (target !== base && !target.startsWith(base + path.sep)) {
        continue;
      }

      if (entryPath.endsWith('/')) {
        await ensureDir(target);
        continue;
      }

      await ensureDir(path.dirname(target));
      await fs.promises.writeFile(target, '');
    }

    const matches = await dataSourcesRecognize(
      undefined,
      { filename: path.basename(base), fullPath: base, fsRoot: base },
      {},
      { descend: true, ...(options.maxDepth != null ? { maxDepth: options.maxDepth } : {}) },
    );

    const claimed = new Map<string, string[]>();
    for (const match of matches) {
      if (
        match.data_source.name === GENERIC_DATA_SOURCE ||
        match.recognition.confidence < LISTING_CONFIDENCE_FLOOR ||
        match.matchedPath == null
      ) {
        continue;
      }

      if ((await fs.promises.stat(match.matchedPath)).isDirectory()) {
        const root = path.relative(base, match.matchedPath).split(path.sep).join('/');
        const importers = claimed.get(root) ?? [];

        if (!importers.includes(match.data_source.name)) {
          importers.push(match.data_source.name);
        }

        claimed.set(root, importers);
      }
    }

    // Shortest first, so every root meets its ancestors before itself.
    const roots: ListingRoot[] = [];
    for (const [root, importers] of [...claimed].sort((a, b) => a[0].length - b[0].length)) {
      const outer = roots.find((kept) => kept.root === '' || root.startsWith(`${kept.root}/`));

      if (outer) {
        outer.importers.push(...importers.filter((name) => !outer.importers.includes(name)));
      } else {
        roots.push({ root, importers: [...importers] });
      }
    }

    return roots;
  } catch {
    return [];
  } finally {
    await fs.promises.rm(base, { recursive: true, force: true });
  }
}

/**
 * Whether a folder with these files holds anything its importers would turn
 * into records, judged from the paths alone. A service that delivers an export
 * over hours can leave it looking exactly like an export — same folders, so
 * the recognisers claim it — while the files that carry the records have not
 * arrived. Importing it then is a download for nothing.
 *
 * Only an importer that says outright "nothing here for me yet" counts
 * against the folder. One that cannot judge from names, or is not known,
 * counts as having something to read: waiting forever on a guess would be
 * worse than one early import.
 */
export function listingHasRecords(
  importerNames: readonly string[],
  relativePaths: readonly string[],
): boolean {
  const byName = new Map(allDataSources().map((source) => [source.name, source]));

  return (
    importerNames.length === 0 ||
    importerNames.some((name) => {
      const importer = byName.get(name)?.newFileImporter?.();

      return importer?.listingHasRecords ? importer.listingHasRecords(relativePaths) : true;
    })
  );
}

/**
 * The specialised importers that recognise an archive with these entry paths,
 * most confident first. Empty when none does.
 */
export async function recognizeArchiveListing(entryPaths: readonly string[]): Promise<string[]> {
  const importers: string[] = [];

  for (const root of await recognizeListingRoots(entryPaths)) {
    importers.push(...root.importers.filter((name) => !importers.includes(name)));
  }

  return importers;
}
