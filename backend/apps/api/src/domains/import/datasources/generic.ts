/* Generic datasource — walks a directory and emits one media item per file.

   Each file's metadata read is MIME-routed via the shared extractMediaMetadata
   helper: image/* through EXIF, video/* through ffprobe (with an exifr-QuickTime
   fallback). The legacy ad-hoc fallback (try image EXIF, catch, retry as video)
   wedged here because exifr.parse on an .mov returns undefined without throwing
   — so the catch never ran, video metadata never landed, and all video items
   ended up with NULL dimensions and zero duration.
*/
import fs from 'node:fs';
import path from 'node:path';

import { extractMediaMetadata } from './_exif';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { isPathWithinOrEqual, registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { mediaItemFromFile } from './timeline';

type GenericOptions = Record<string, never>;

class GenericFileImporter implements FileImporter {
  async recognize(): Promise<Recognition> {
    return { confidence: 1 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const startPath = entry.fullPath || entry.fsRoot || entry.filename;
    if (!startPath) {
      return;
    }

    // Subtrees `ParseStage.dropGenericWhenSpecialised` already attributed to a
    // specialised parser (see `registry.ts`'s `DataSourceRecognition.excludePaths`
    // and `ImportParams.excludePaths`). Empty for every run with no specialised
    // claims to skip, and for every OTHER importer's own `fileImport` call —
    // this field only ever means something to `generic`.
    const excludePaths = params.excludePaths ?? [];

    if (isClaimed(startPath, excludePaths)) {
      return;
    }

    const stat = fs.statSync(startPath);
    if (!stat.isDirectory()) {
      await this.processFile(startPath, params);

      return;
    }

    for await (const fpath of walkDir(startPath, excludePaths)) {
      await this.processFile(fpath, params);
    }
  }

  private async processFile(fpath: string, params: ImportParams) {
    const base = path.basename(fpath);
    if (base.startsWith('.')) {
      return;
    }

    const item = mediaItemFromFile(fpath);
    item.metadata = item.metadata || {};

    const media = await extractMediaMetadata(fpath, item.content.mediaType);
    if (media.timestamp) {
      item.timestamp = media.timestamp;
    }

    if (media.location) {
      item.location = media.location;
    }

    if (media.accuracyMeters != null) {
      item.metadata.AccuracyMeters = media.accuracyMeters;
    }

    Object.assign(item.metadata, media.metadata);

    if (!item.timestamp) {
      // No embedded date: leave the timestamp NULL rather than invent one.
      //
      // The filesystem time used to be the fallback, and for archive-delivered
      // files it is pure noise: a OneDrive "download as zip" stamps EVERY entry
      // with the moment the server built the archive (verified — a 2021
      // wallpaper and a 4K video shared one second), and `unzip` faithfully
      // restores that as mtime. Worse, it isn't even stable: fileTimestamp()
      // prefers birthtime when the filesystem reports one, so the SAME import
      // yields the archive's build time on ecryptfs and the EXTRACTION time on
      // ext4. Every such file then landed on the timeline at a date that means
      // nothing, indistinguishable at a glance from the EXIF-dated ones.
      //
      // The mtime is still recorded as metadata — a weak signal is worth
      // keeping when it is LABELLED as one — it just no longer poses as the
      // item's date. mtime specifically, NOT fileTimestamp(): mtime is what an
      // archive carries through (the zip entry's time), where birthtime is
      // merely when extraction touched the disk. Downstream: items.timestamp is
      // nullable, the push cursor is COALESCE(timestamp, created_at), and a
      // CanonicalRecord falls back to created_at for startTime, so a null-dated
      // item still pushes cleanly.
      item.metadata['Timestamp Source'] = 'None';
      item.metadata['File Modified'] = fs.statSync(fpath).mtime.toISOString();
    } else {
      item.metadata['Timestamp Source'] = item.content.mediaType?.startsWith('video/') ? 'Container' : 'EXIF';
    }

    params.pipeline.push({ item });
  }
}

/**
 * Is `p` one of `excludePaths`, or nested inside one of them? Checked once per
 * directory entry BEFORE recursing — pruning a claimed directory here means
 * `walkDir` never opens it at all, rather than opening every file inside it
 * and rejecting each one individually. A Google Voice export claims 73,124
 * files across `/Voice/`; the difference between the two is one `readdir`
 * call skipped here versus 73,124 `stat`-and-reject calls, and it's what keeps
 * an exclusion-aware `generic` from becoming its own O(files) rescan of
 * exactly the tree this whole exclusion exists to avoid re-reading.
 */
function isClaimed(p: string, excludePaths: readonly string[]): boolean {
  return excludePaths.some((claimed) => isPathWithinOrEqual(claimed, p));
}

async function* walkDir(root: string, excludePaths: readonly string[] = []): AsyncGenerator<string> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (isClaimed(full, excludePaths)) {
      continue;
    }

    if (e.isDirectory()) {
      if (e.name.startsWith('.')) {
        continue;
      }

      yield* walkDir(full, excludePaths);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

registerDataSource({
  name: 'generic',
  title: 'Generic',
  icon: 'folder.svg',
  description: 'Generic file importer (fallback)',
  newOptions: () => ({}) as GenericOptions,
  newFileImporter: () => new GenericFileImporter(),
});
