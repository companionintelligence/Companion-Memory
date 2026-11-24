import { stat } from 'node:fs/promises';
import path from 'node:path';

import { listFiles } from './fsWalk';
import type { DirEntry, FileImporter, Recognition } from './registry';
import type { ImportParams } from './timeline';

/**
 * The recognize / fileImport scaffold every one-CSV export importer shares.
 *
 * Fifteen importers (Letterboxd, Goodreads, Last.fm, Garmin, Apple Music,
 * Audible, Prime Video, Kindle, Netflix, MyFitnessPal, Withings, Oura,
 * PayPal, Venmo, Robinhood) each carried the same sixty to eighty lines:
 * resolve the entry's root, stat it, and then — for a file — decide between
 * "this is the export's known filename" and "this is some CSV whose header
 * reads as ours"; for a directory — list it (or walk it a few levels) and ask
 * the same two questions of what is inside; and in fileImport, pick the same
 * files again and hand each to `processFile`.
 *
 * What differed between the copies is deliberate and is the {@link CsvExportSpec}:
 * the known names, the header test, whether a known name must ALSO pass the
 * header test, the confidence each tier claims (these are tuned against each
 * other across importers, so every subclass states its own numbers verbatim),
 * how deep a directory is scanned, and which files a directory import takes.
 * Nothing here chooses a value for an importer; the base only runs the shape.
 *
 * `{ confidence: 0, dir_threshold: 0.7 }` for a directory that holds nothing
 * of ours is the registry's "look inside, and claim this directory if 70% of
 * what you find is mine" answer, which every copy returned.
 */
export interface CsvExportSpec {
  /** Is this (lower-cased) basename one the export is known to ship under? Absent: no name tier. */
  isNamed?: (lowerName: string) => boolean;
  /** Does this CSV's header read as this export's? Used for every unnamed `.csv`. */
  headerMatches: (fpath: string) => Promise<boolean>;
  /**
   * The header test a named file must pass when `namedNeedsHeader`. Defaults
   * to `headerMatches`; Netflix's known files accept either of its two shapes
   * while an unnamed CSV must be the full export.
   */
  namedHeaderMatches?: (fpath: string) => Promise<boolean>;
  /** A known filename is only recognized when its header ALSO matches. */
  namedNeedsHeader?: boolean;
  /** What a file claims: by its known name, or by its header alone. `sniffed: 0` means names only. */
  confidence: { named: number; sniffed: number };
  /** What a directory claims. Defaults to `confidence`; some importers claim the same for either tier. */
  dirConfidence?: { named: number; sniffed: number };
  /** Directory levels to enter when scanning. `0` (the default) reads the directory itself. */
  scanDepth?: number;
  /** Scan entries in name order rather than readdir order. */
  sortedScan?: boolean;
  /**
   * Directory recognition order. `named-first` (default): any known name
   * wins, then the first CSV whose header matches. `walk-order`: the first
   * CSV met decides, by name if known, else by header.
   */
  scanOrder?: 'named-first' | 'walk-order';
  /**
   * Which files a directory import reads.
   * - `named-first` (default): the first known file when there is one (subject
   *   to `namedNeedsHeader`), else every CSV whose header matches;
   * - `all-matches`: every known file (subject to `namedNeedsHeader`) and every CSV whose header matches;
   * - `all-named`: every known file, headers unchecked;
   * - `all-csv`: every CSV, unchecked.
   */
  importInDir?: 'named-first' | 'all-matches' | 'all-named' | 'all-csv';
}

const NOT_OURS_DIR: Recognition = { confidence: 0, dir_threshold: 0.7 };

export abstract class CsvExportImporter implements FileImporter {
  protected abstract readonly spec: CsvExportSpec;

  /** Read one CSV of the export into the pipeline. */
  protected abstract processFile(fpath: string, params: ImportParams): Promise<void>;

  /**
   * Read the files a directory (or single-file) import selected. The default
   * is one `processFile` per file, in order; an importer that needs context
   * from the rest of the export first (Kindle's title map) overrides this.
   */
  protected async importFiles(files: string[], _root: string, params: ImportParams): Promise<void> {
    for (const fpath of files) {
      await this.processFile(fpath, params);
    }
  }

  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entryRoot(entry);

    if (!root) {
      return { confidence: 0 };
    }

    let st;
    try {
      st = await stat(root);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile()) {
      return this.recognizeFile(root);
    }

    if (st.isDirectory()) {
      return this.recognizeDirectory(root);
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entryRoot(entry);

    if (!root) {
      return;
    }

    let st;
    try {
      st = await stat(root);
    } catch {
      return;
    }

    if (st.isFile()) {
      await this.importFiles([root], root, params);
    } else if (st.isDirectory()) {
      await this.importFiles(await this.selectInDirectory(root), root, params);
    }
  }

  private isNamed(fpath: string): boolean {
    return this.spec.isNamed?.(path.basename(fpath).toLowerCase()) ?? false;
  }

  private isCsv(fpath: string): boolean {
    return path.extname(fpath).toLowerCase() === '.csv';
  }

  /** A known file, accepted: by name alone, or by name and header when the spec asks. */
  private async namedAccepted(fpath: string): Promise<boolean> {
    if (!this.isNamed(fpath)) {
      return false;
    }

    return this.spec.namedNeedsHeader
      ? (this.spec.namedHeaderMatches ?? this.spec.headerMatches)(fpath)
      : true;
  }

  private async recognizeFile(fpath: string): Promise<Recognition> {
    const { confidence } = this.spec;

    if (await this.namedAccepted(fpath)) {
      return { confidence: confidence.named };
    }

    if (confidence.sniffed > 0 && this.isCsv(fpath) && (await this.spec.headerMatches(fpath))) {
      return { confidence: confidence.sniffed };
    }

    return { confidence: 0 };
  }

  private scan(root: string): Promise<string[]> {
    return listFiles(root, { maxDepth: this.spec.scanDepth ?? 0, sorted: this.spec.sortedScan });
  }

  private async recognizeDirectory(root: string): Promise<Recognition> {
    const confidence = this.spec.dirConfidence ?? this.spec.confidence;
    const files = await this.scan(root);

    if (this.spec.scanOrder === 'walk-order') {
      for (const fpath of files) {
        if (!this.isCsv(fpath)) {
          continue;
        }

        if (await this.namedAccepted(fpath)) {
          return { confidence: confidence.named };
        }

        if (confidence.sniffed > 0 && (await this.spec.headerMatches(fpath))) {
          return { confidence: confidence.sniffed };
        }
      }

      return NOT_OURS_DIR;
    }

    for (const fpath of files) {
      if (await this.namedAccepted(fpath)) {
        return { confidence: confidence.named };
      }
    }

    if (confidence.sniffed > 0) {
      for (const fpath of files) {
        if (this.isCsv(fpath) && !this.isNamed(fpath) && (await this.spec.headerMatches(fpath))) {
          return { confidence: confidence.sniffed };
        }
      }
    }

    return NOT_OURS_DIR;
  }

  private async selectInDirectory(root: string): Promise<string[]> {
    const files = await this.scan(root);
    const csvs = files.filter((fpath) => this.isCsv(fpath));

    switch (this.spec.importInDir ?? 'named-first') {
      case 'all-csv':
        return csvs;
      case 'all-named':
        return files.filter((fpath) => this.isNamed(fpath));
      case 'all-matches': {
        const selected: string[] = [];

        for (const fpath of files) {
          if (
            (await this.namedAccepted(fpath)) ||
            (this.isCsv(fpath) && (await this.spec.headerMatches(fpath)))
          ) {
            selected.push(fpath);
          }
        }

        return selected;
      }

      default: {
        for (const fpath of files) {
          if (await this.namedAccepted(fpath)) {
            return [fpath];
          }
        }

        const selected: string[] = [];

        for (const fpath of csvs) {
          if (await this.spec.headerMatches(fpath)) {
            selected.push(fpath);
          }
        }

        return selected;
      }
    }
  }
}

/** The filesystem path a DirEntry names, as every importer resolved it. */
export function entryRoot(entry: DirEntry): string | undefined {
  return entry.fullPath || entry.fsRoot || entry.filename || undefined;
}
