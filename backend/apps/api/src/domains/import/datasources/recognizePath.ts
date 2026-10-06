import path from 'node:path';

import {
  type ImportRootsCaller,
  PathOutsideImportRootsError,
  resolveWithinImportRoots,
} from '../sources/importRoots';

import { dataSourcesRecognize, type DirEntry } from './registry';

/** One importer's verdict on a path. */
export interface PathRecognitionMatch {
  dataSource: string;
  title: string;
  confidence: number;
  /**
   * The sub-path that actually matched. For a top-level hit this is the queried
   * path; for one found by descending, the folder the importer would run
   * against — which is the answer someone asked "what is in here?" wants.
   */
  matchedPath: string;
}

/**
 * What every parser makes of a path, or why it could not be looked at.
 *
 * `allowed: false` is a RESULT, not an error, on both surfaces that return it:
 * an agent can act on "not permitted, upload instead" where a thrown error
 * reads as a malfunction, and a CLI can print the remedy instead of a stack.
 */
export interface PathRecognition {
  allowed: boolean;
  reason?: string;
  path?: string;
  recognized: PathRecognitionMatch[];
}

/**
 * Ask every registered importer what it makes of a path on the appliance's disk.
 *
 * The one import capability that answers BEFORE anything is written: elsewhere
 * an archive is opaque bytes until a run unpacks it, and recognition is what
 * the parse stage reports afterwards. Here the files are already on a disk the
 * appliance can see, so the question can be answered directly.
 *
 * Scoped to {@link resolveWithinImportRoots} — the caller's own inbox subtree,
 * plus the configured roots when the caller is the administrator, never anyone
 * else's. An unconstrained absolute path reachable over the API is a filesystem
 * read primitive, and "does this path exist?" is information on its own — which
 * is why an out-of-bounds path and an absent one produce the same answer.
 *
 * Lives here, beside the registry, rather than in either caller: the MCP tool
 * and the REST endpoint are two doors onto one question, and a second copy of
 * the descent options or the sort order is how the two would come to disagree
 * about what the same folder contains.
 */
export async function recognizePathWithinRoots(
  requested: string,
  caller: ImportRootsCaller,
): Promise<PathRecognition> {
  let resolved: string;

  try {
    resolved = await resolveWithinImportRoots(requested, caller);
  } catch (err) {
    if (err instanceof PathOutsideImportRootsError) {
      return { allowed: false, reason: err.message, recognized: [] };
    }

    throw err;
  }

  const entry: DirEntry = {
    filename: path.basename(resolved),
    fullPath: resolved,
    fsRoot: resolved,
  };

  // `descend` because the caller points at a folder they downloaded into, and
  // the export is usually a level or two inside it.
  const matches = await dataSourcesRecognize(undefined, entry, {}, { descend: true });

  return {
    allowed: true,
    path: resolved,
    recognized: matches
      .sort((a, b) => b.recognition.confidence - a.recognition.confidence)
      .map((match) => ({
        dataSource: match.data_source.name,
        title: match.data_source.title,
        confidence: match.recognition.confidence,
        matchedPath: match.matchedPath ?? resolved,
      })),
  };
}
