// Companion Intelligence © 2019-2026 LifeScope Inc.
// Licensed under the Companion Intelligence Commercial Standard License (CI-Commercial-1.0); see LICENSE.md.
// Data-source registry: the DataSource/importer types, the in-memory registry, and
// the recognition runner. Some advanced behaviors (FS archive handling, recognition
// algorithms, OAuth2) are simplified in this implementation.

import { readFileSync, promises as fsPromises } from 'node:fs';
import path from 'node:path';

/**
 * Opaque per-import context threaded through recognition and import.
 *
 * In the standalone importer this was Koa's `Context`, but the registry and
 * every importer only ever pass it along — none dereference it. Keeping it
 * `unknown` drops the HTTP-framework coupling without changing any call site,
 * and leaves a named seam for whatever the import job wants to thread through
 * later (run id, cancellation signal, progress sink).
 */
export type ImportContext = unknown;

// DataSourceRow corresponds to a row in the data_sources table plus RepoID (runtime-associated).
export interface DataSourceRow {
  id: number;
  name: string;
  title: string;
  description: string;
  standard: boolean;
  // media + mediaType not exposed here directly (large blobs) but may be returned when requested.
  repo_id: string;
}

// Recognition result from a FileImporter recognize attempt.
export interface Recognition {
  confidence: number; // > 0 indicates recognition
  dir_threshold?: number; // if directory match threshold reached, treat whole dir as recognized
  snapshot_date?: Date; // optional snapshot date
}

export interface DataSourceRecognition {
  data_source: DataSource;
  recognition: Recognition;
  /**
   * The path that actually matched. Equals the queried path for a top-level
   * match; for a match found by descending into a dropped folder it's the
   * sub-path the importer should run against (so a single `.gpx` dropped into a
   * staging folder still imports from the folder that really contains it).
   */
  matchedPath?: string;
  /**
   * Subtrees a specialised match has already claimed, set by
   * `ParseStage.dropGenericWhenSpecialised` on the SURVIVING `generic` match
   * only (see that function). Every other match's `excludePaths` stays unset —
   * a specialised parser only ever reads what it recognized at `matchedPath`,
   * so it has nothing else to be told to skip. `generic`'s walker (see
   * `datasources/generic.ts`) prunes any entry nested under, or equal to, one
   * of these before it stages anything — that is what lets a bare loose file
   * elsewhere in the same drop still reach `generic` without re-staging what a
   * specialised parser already consumed.
   */
  excludePaths?: readonly string[];
}

// Parameters for recognition (reserved for future use)
export type RecognizeParams = Record<string, never>;

// Minimal interface for a file importer.
export interface FileImporter {
  recognize(ctx: ImportContext, entry: DirEntry, opts: RecognizeParams): Promise<Recognition>;
  fileImport(ctx: ImportContext, entry: DirEntry, params: import('./timeline').ImportParams): Promise<void>;
  /**
   * Optional. From file paths alone (relative to the export's folder): is
   * there anything here this importer turns into records? `recognize` answers
   * "is this one of mine" from the export's SHAPE, which a half-delivered
   * export already has; this answers "is there anything in it to read yet".
   * An importer that cannot tell from names leaves it out, and is taken to
   * have something to read.
   */
  listingHasRecords?(relativePaths: readonly string[]): boolean;
}

// Settings accessor passed to API importers. Decouples the importer from the
// Service class so an importer can live entirely in its own module.
export interface SettingsAccess {
  getSetting(key: string): string | undefined;
}

// API importer — runs against a remote service using credentials read from
// settings. No filesystem path required. The `apiImport` method does its
// own pagination/rate-limit handling and pushes results into params.pipeline
// just like FileImporter.fileImport does.
export interface APIImporter {
  apiImport(settings: SettingsAccess, params: import('./timeline').ImportParams): Promise<void>;
}

// Placeholder retained for backwards compatibility with the original Go port
// shape; not used today.
export interface Account {
  id: string;
}

// An empty `ImportParams` placeholder also lived here, shadowing the real one in
// ./timeline. Nothing imported it — every importer takes the timeline type — so
// it is dropped rather than carried forward as a name collision.

// DataSource definition akin to Go struct.
export interface DataSource {
  name: string; // snake_case unique name
  title: string; // human-readable title
  icon: string; // icon filename (to be deprecated / unified later)
  description: string;
  stub?: boolean; // true when importer is recognized but not yet implemented
  newOptions?: () => unknown;
  newFileImporter?: () => FileImporter;
  newAPIImporter?: () => APIImporter;
}

// In-memory registry keyed by name.
const dataSources = new Map<string, DataSource>();

export function registerDataSource(ds: DataSource): void {
  if (!ds.name) {
    throw new Error('missing name');
  }

  if (!ds.title) {
    throw new Error('missing title');
  }

  if (dataSources.has(ds.name)) {
    throw new Error(`data source already registered: ${ds.name}`);
  }

  dataSources.set(ds.name, ds);
}

export function allDataSources(): DataSource[] {
  return Array.from(dataSources.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// DirEntry abstraction (simplified). In Go version this wraps fs.DirEntry + FS root path logic.
export interface DirEntry {
  // Relative filename within its containing FS or archive (POSIX-style)
  filename: string;
  // OS absolute root for the FS containing the entry (if known)
  fsRoot?: string;
  // Optional pre-read file buffer (when small)
  buffer?: Buffer;
  // Path to actual file if accessible directly
  fullPath?: string;
}

// DataSourceStore lived here: a raw-SQL reader over the standalone importer's
// SQLite `data_sources` table (listing importers and their icon blobs from the
// database rather than the in-memory registry above). It is dropped rather than
// ported — nothing referenced it, and the catalog it queried is superseded by
// the registry, which is the single source of truth for what can be imported.

/**
 * How many folders down recognition looks for an export's top folder.
 *
 * Was 4, which is enough for an export dropped on its own but not for one
 * NESTED inside another: a Google Takeout carries the whole of Drive, and an
 * export another service wrote there sits several folders in — Meta writes a
 * Facebook export under `Apps/Meta/meta-<date>/facebook-<user>-…`, which a
 * Takeout puts five levels down. One level short, and it was imported as loose
 * files by the catch-all importer instead of as Facebook data.
 *
 * The cost is a wider scan: every entry down to this depth is offered to every
 * recogniser.
 */
export const DEFAULT_RECOGNIZE_MAX_DEPTH = 8;

// Recognition runner over all registered data sources with file importer implementations.
/** Options controlling how `dataSourcesRecognize` searches. */
export interface RecognizeRunOptions {
  /**
   * When the queried path is a directory, also descend into it and recognize
   * the files/folders inside, attributing each match to the sub-path that
   * matched. This is what makes drag-and-drop work: a loose file (a single
   * `.gpx`, `.vcf`, `.ics`, …) is staged inside a folder, and without descent
   * the folder matches nothing. Off by default so the CLI/MCP keep the cheap
   * single-level behavior; the drag-and-drop recognize endpoint turns it on.
   */
  descend?: boolean;
  /** Max directory depth to descend (default {@link DEFAULT_RECOGNIZE_MAX_DEPTH}). */
  maxDepth?: number;
  /**
   * Max entries to scan per directory level. No limit by default.
   *
   * The default used to be 200, as a runaway guard, and it hid things: in a
   * folder of 5,000 files only the first 200 — in whatever order the
   * filesystem listed them — were ever offered to a recogniser, so an export
   * folder or a loose `.gpx` past that point was silently left to the
   * catch-all importer. A caller working to a time budget (the inbox scan's
   * preview) still sets its own.
   */
  maxEntriesPerDir?: number;
  /**
   * Restrict recognition to these importer names. The inbox scan sets this
   * for paths inside a service drop folder: `spotify/` can only hold what the
   * Spotify importer reads, so asking the other seventy-odd recognizers is
   * pure waste — the fan-out is the scan's dominant cost. Absent means every
   * registered importer, which is right whenever the location says nothing
   * (the inbox root, uploads, the CLI/MCP path tools).
   */
  only?: ReadonlySet<string>;
  /**
   * Called after each directory entry the descent finishes recognizing, with
   * the running count. Recognition is thousands of tiny reads and can crawl
   * when the disk is busy (a concurrent 350GB unpack) — a caller with a
   * progress surface uses this to show the crawl as movement instead of a
   * frozen label. Fire-and-forget: the walk never waits on it.
   */
  onEntry?: (scanned: number) => void;
}

/** Run every importer's `recognize` against a single entry; keep the hits. */
async function recognizeLevel(
  ctx: ImportContext,
  entry: DirEntry,
  opts: RecognizeParams,
  only?: ReadonlySet<string>,
): Promise<DataSourceRecognition[]> {
  const hits: DataSourceRecognition[] = [];
  for (const ds of dataSources.values()) {
    // all datasources considered (generic no longer skipped)
    if (!ds.newFileImporter) {
      continue;
    }

    if (only != null && !only.has(ds.name)) {
      continue;
    }

    const importer = ds.newFileImporter();
    try {
      const rec = await importer.recognize(ctx, entry, opts);
      if (rec.confidence > 0) {
        hits.push({ data_source: ds, recognition: rec, matchedPath: entry.fullPath });
      }
    } catch (err) {
      // Propagate error with data source context
      throw new Error(`${ds.name}: ${(err as Error).message}`);
    }
  }

  return hits;
}

export async function dataSourcesRecognize(
  ctx: ImportContext,
  entry: DirEntry,
  opts: RecognizeParams,
  runOpts: RecognizeRunOptions = {},
): Promise<DataSourceRecognition[]> {
  // Best match per data source AT A GIVEN LOCATION, keyed by name — so descent
  // can't list the same importer twice for the same unit, but CAN list it twice
  // for two different files it independently recognizes.
  //
  // "Twice for the same unit" happens when a match is found at two NESTING
  // levels: a Takeout root matches google_voice by directory shape, and a file
  // three levels down independently matches google_voice too — those are the
  // same underlying unit seen at different granularities, and importing both
  // would duplicate everything. "Twice for two different files" happens when a
  // browser profile directory has both `Bookmarks` and `History`, siblings, and
  // chromium.ts's recognizer legitimately and correctly claims each on its own
  // — those are NOT the same unit, and collapsing them onto whichever file
  // `readdir()` happened to enumerate first silently dropped the other file
  // from ever being imported (confirmed live: a real Chrome profile landed
  // 3,197 bookmarks and ZERO history rows, deterministically, across repeated
  // runs — chromium.ts's own History parser is correct and never got a chance
  // to run, because `Bookmarks`, sorting first, was the only match this
  // dedup kept for the name 'chromium').
  //
  // The two cases are told apart by path containment: nesting means one
  // match's path is an ancestor of (or equal to) the other's. Siblings are
  // neither ancestor of the other — those are kept side by side.
  const best = new Map<string, DataSourceRecognition[]>();
  const consider = (r: DataSourceRecognition) => {
    const existing = best.get(r.data_source.name);

    if (!existing) {
      best.set(r.data_source.name, [r]);

      return;
    }

    const nestedWith = existing.find((e) => isAncestorPath(e.matchedPath, r.matchedPath));

    if (!nestedWith) {
      existing.push(r);

      return;
    }

    if (r.recognition.confidence > nestedWith.recognition.confidence) {
      existing[existing.indexOf(nestedWith)] = r;
    }
    // Otherwise the existing, equally-or-more-confident match at the ancestor
    // (or same) level stands, and `r` is redundant with it — dropped.
  };

  for (const r of await recognizeLevel(ctx, entry, opts, runOpts.only)) {
    consider(r);
  }

  if (runOpts.descend && entry.fullPath && (await isDirectorySafe(entry.fullPath))) {
    const maxDepth = runOpts.maxDepth ?? DEFAULT_RECOGNIZE_MAX_DEPTH;
    const maxEntries = runOpts.maxEntriesPerDir ?? Number.POSITIVE_INFINITY;
    // The count is cumulative across the whole descent, not per directory —
    // it feeds a progress line, and a number that resets at every subfolder
    // reads as the scan starting over.
    let totalScanned = 0;
    const tick = runOpts.onEntry == null ? undefined : () => runOpts.onEntry?.((totalScanned += 1));

    await descendRecognize(ctx, entry.fullPath, opts, consider, maxDepth, maxEntries, 1, runOpts.only, tick);
  }

  const results = [...best.values()].flat();
  // Clamp confidence to [0, 1] — importers occasionally return values outside
  // this range (e.g. google_voice @ 1.3) which would mislead callers.
  for (const r of results) {
    r.recognition.confidence = Math.min(1, Math.max(0, r.recognition.confidence));
  }

  // Sort descending by confidence; 'generic' ranks last among ties so the
  // most specific real match is always pre-selected in the UI.
  results.sort((a, b) => {
    const aIsGeneric = a.data_source.name === 'generic';
    const bIsGeneric = b.data_source.name === 'generic';
    if (aIsGeneric !== bIsGeneric) {
      return aIsGeneric ? 1 : -1;
    }

    return b.recognition.confidence - a.recognition.confidence;
  });

  return results;
}

async function isDirectorySafe(p: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Is `child` equal to `parent`, or nested somewhere inside it? Pure
 * containment in ONE direction, with no "missing path means nested" fallback
 * — that conservative default belongs to callers that need it (see
 * {@link isAncestorPath} below), not to this primitive.
 *
 * Exported for `ParseStage.dropGenericWhenSpecialised` and `generic.ts`'s file
 * walker, which both need the same "is this path inside a claimed subtree"
 * check this module already proved out here.
 */
export function isPathWithinOrEqual(parent: string, child: string): boolean {
  if (parent === child) {
    return true;
  }

  const rel = path.relative(parent, child);

  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Is `a` an ancestor of `b`, `b` an ancestor of `a`, or the same path — i.e.
 * are the two "nested" relative to each other, in either direction? Two
 * SIBLINGS (`.../Bookmarks` and `.../History`, both direct children of the
 * same profile directory) are never nested, and that is exactly the
 * distinction {@link dataSourcesRecognize}'s dedup needs: collapse the same
 * unit seen at two levels of descent, but never collapse two different files
 * a single data source happens to recognize side by side.
 *
 * Either path missing means there is no information to prove them disjoint —
 * treated as nested (collapsed), the same conservative choice the dedup made
 * before this distinction existed.
 */
function isAncestorPath(a: string | undefined, b: string | undefined): boolean {
  if (a == null || b == null) {
    return true;
  }

  return isPathWithinOrEqual(a, b) || isPathWithinOrEqual(b, a);
}

/**
 * Recursively recognize the children of `dir`. Each child is recognized at its
 * own level (so a `.gpx` file matches the gpx importer, a `facebook/` folder
 * matches facebook), and matches are attributed to the child path via
 * `recognizeLevel`. Bounded by depth and per-directory fan-out so a giant
 * Takeout export can't turn one drop into a multi-minute crawl.
 */
async function descendRecognize(
  ctx: ImportContext,
  dir: string,
  opts: RecognizeParams,
  consider: (r: DataSourceRecognition) => void,
  maxDepth: number,
  maxEntries: number,
  depth: number,
  only?: ReadonlySet<string>,
  tick?: () => void,
): Promise<void> {
  if (depth > maxDepth) {
    return;
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  let scanned = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) {
      continue;
    } // skip dotfiles/.DS_Store noise

    if (scanned++ >= maxEntries) {
      break;
    }

    const childPath = path.join(dir, e.name);
    const childEntry: DirEntry = { filename: e.name, fsRoot: dir, fullPath: childPath };
    for (const r of await recognizeLevel(ctx, childEntry, opts, only)) {
      consider(r);
    }

    if (e.isDirectory()) {
      await descendRecognize(ctx, childPath, opts, consider, maxDepth, maxEntries, depth + 1, only, tick);
    }

    tick?.();
  }
}

/**
 * Resolve the path(s) a file import of `ds` should actually run against.
 *
 * The path handed to an import is often a folder that CONTAINS the export
 * rather than the export tree itself: upload-time extraction expands each
 * dropped .zip into a sibling directory named after the archive, and bundle
 * drops enqueue the drop root for every member importer — while importers
 * only look directly under the path they are given. When `rootPath` itself
 * recognizes, it is the sole root. Otherwise descend (same bounds as
 * `dataSourcesRecognize`) and collect EVERY sub-path the importer recognizes:
 * a multi-part export (Meta splits one download across several zips) stages
 * several sibling trees that all belong to this one import. Descent stops
 * below a match — a recognized dir is a complete export tree, and its
 * internals often re-recognize (facebook's `your_facebook_activity/` itself
 * contains `messages/`), which would import the same records twice under
 * different relative paths. Falls back to `[rootPath]` when nothing matches,
 * preserving the existing behavior for weak/stub recognizers.
 */
export async function findImportRoots(
  ctx: ImportContext,
  ds: DataSource,
  rootPath: string,
  opts: RecognizeParams = {},
  runOpts: RecognizeRunOptions = {},
): Promise<string[]> {
  if (!ds.newFileImporter) {
    return [rootPath];
  }

  const importer = ds.newFileImporter();
  const recognizes = async (p: string): Promise<boolean> => {
    const entry: DirEntry = { filename: path.basename(p), fsRoot: path.dirname(p), fullPath: p };
    try {
      return (await importer.recognize(ctx, entry, opts)).confidence > 0;
    } catch {
      return false;
    }
  };

  if (await recognizes(rootPath)) {
    return [rootPath];
  }

  if (!(await isDirectorySafe(rootPath))) {
    return [rootPath];
  }

  const maxDepth = runOpts.maxDepth ?? DEFAULT_RECOGNIZE_MAX_DEPTH;
  const maxEntries = runOpts.maxEntriesPerDir ?? Number.POSITIVE_INFINITY;
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      return;
    }

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    let scanned = 0;
    for (const e of entries) {
      if (e.name.startsWith('.')) {
        continue;
      }

      if (scanned++ >= maxEntries) {
        break;
      }

      const childPath = path.join(dir, e.name);
      if (await recognizes(childPath)) {
        found.push(childPath);
        continue;
      }

      if (e.isDirectory()) {
        await walk(childPath, depth + 1);
      }
    }
  };

  await walk(rootPath, 1);

  return found.length ? found : [rootPath];
}

// Utility: load JSON options for a data source and validate shape (placeholder).
export function unmarshalOptions(ds: DataSource, raw: string | undefined): unknown {
  if (!ds.newOptions) {
    return null;
  }

  const base = ds.newOptions();
  if (!raw) {
    return base;
  }

  try {
    const parsed = JSON.parse(raw);
    // Shallow merge onto base (if base is object)
    if (base && typeof base === 'object' && typeof parsed === 'object') {
      return { ...(base as object), ...(parsed as object) };
    }

    return parsed;
  } catch (e) {
    throw new Error(`decoding data source options: ${(e as Error).message}`);
  }
}

// Timeframe logic: IsEmpty, Contains, ContainsItem semantics.
export interface Timeframe {
  since?: Date;
  until?: Date;
  sinceItemId?: string;
  untilItemId?: string;
}

export function timeframeIsEmpty(tf: Timeframe): boolean {
  return !tf.since && !tf.until && !tf.sinceItemId && !tf.untilItemId;
}

export function timeframeContains(tf: Timeframe, ts: Date): boolean {
  if (!ts || ts.getTime() === 0) {
    return true;
  } // zero-value semantics

  const afterSince = !tf.since || ts > tf.since;
  const beforeUntil = !tf.until || ts < tf.until;

  return afterSince && beforeUntil;
}

// Item minimal shape for timeframeContainsItem
export interface ItemLike {
  timestamp: Date; // primary timestamp
  timespan?: Date; // end timespan
}

export function timeframeContainsItem(tf: Timeframe, item: ItemLike | null, strict: boolean): boolean {
  if (!item) {
    return false;
  }

  if (!item.timestamp || item.timestamp.getTime() === 0) {
    return true;
  }

  if (strict && tf.since && tf.until && item.timespan) {
    return item.timestamp > tf.since && item.timespan < tf.until;
  }

  const afterSince = !tf.since || item.timestamp > tf.since;
  const beforeUntil = !tf.until || item.timestamp < tf.until;

  return afterSince && beforeUntil;
}

// NOTE: concrete datasource modules self-register via side-effect imports.

// Developer helper: load embedded sample icons or assets (placeholder function)
export function loadIconAsset(assetsDir: string, iconName: string): Buffer | null {
  const p = path.join(assetsDir, iconName);
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
}
