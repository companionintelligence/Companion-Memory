/* Apple Photos datasource — filesystem walk of a .photoslibrary package.

   A real Photos export is a "*.photoslibrary" PACKAGE whose media live under
   originals/<hex>/<UUID>.<ext> (HEIC/JPG/PNG/MOV/MP4/DNG/…). The proprietary
   database/Photos.sqlite carries dates, GPS, faces, etc. but its schema drifts
   between macOS releases and the live DB is often WAL-locked, so reading it
   produced 0 items from real exports. This importer ignores Photos.sqlite and
   best-effort walks originals/, emitting one 'photo' item per media file.

   We best-effort read EXIF from each image original (the media files carry it
   even though Photos.sqlite is unreadable) and ffprobe each video for duration
   / dimensions / codec / framerate / bitrate / capture time + GPS. Without the
   video branch every .mov landed with NULL dims and zero duration, breaking
   scrubber sizing, autoplay heuristics, and "long videos" sorts downstream.

   Albums + face/person edges still need the sqlite path; they can be layered
   back later. Live Photo pairs (basename-matched .heic + .mov) ARE detected
   here and stamped on both items so they don't show up as two separate events.
*/
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { extractMediaMetadata } from './_exif';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Metadata } from './timeline';
import { mimeForFile, timeframeContains } from './timeline';

// Media extensions we treat as photo-library assets. mimeForFile covers most,
// but RAW/.dng has no MIME entry there, so supply the missing types here too.
const EXT_MEDIA_TYPE: Record<string, string> = {
  '.dng': 'image/x-adobe-dng',
  '.cr2': 'image/x-canon-cr2',
  '.cr3': 'image/x-canon-cr3',
  '.nef': 'image/x-nikon-nef',
  '.arw': 'image/x-sony-arw',
  '.aae': 'application/xml', // edit sidecar — kept so re-import is exhaustive
};

function mediaTypeFor(filename: string): string | undefined {
  return mimeForFile(filename) || EXT_MEDIA_TYPE[path.extname(filename).toLowerCase()];
}

const MEDIA_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
  '.bmp',
  '.avif',
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.mov',
  '.mp4',
  '.m4v',
  '.webm',
  '.avi',
  '.mkv',
  '.3gp',
]);

// Extensions that, when paired by basename with an image of the same stem,
// indicate an Apple Live Photo. The .mov is the motion half; the .heic/.jpg
// is the still. Either side stamps metadata.LivePhoto = true so the timeline
// can collapse them or render the still+motion together.
const LIVE_PHOTO_VIDEO_EXTS = new Set(['.mov']);
const LIVE_PHOTO_IMAGE_EXTS = new Set(['.heic', '.heif', '.jpg', '.jpeg']);
const EARLIEST_PLAUSIBLE_CAPTURE_TIME = Date.UTC(1900, 0, 1);

/** Treat EXIF's 1899-11-30 unset-date sentinel as missing metadata. */
function hasPlausibleCaptureTime(value: Date | undefined): value is Date {
  return !!value && Number.isFinite(value.getTime()) && value.getTime() >= EARLIEST_PLAUSIBLE_CAPTURE_TIME;
}

function isMediaFile(name: string): boolean {
  return MEDIA_EXTS.has(path.extname(name).toLowerCase());
}

// True for a *.photoslibrary package or any dir that directly contains an
// originals/ subdirectory (the shape we can actually walk).
async function originalsDir(baseDir: string): Promise<string | undefined> {
  const candidate = path.join(baseDir, 'originals');
  try {
    if ((await stat(candidate)).isDirectory()) {
      return candidate;
    }
  } catch {
    /* no originals/ */
  }

  return undefined;
}

/**
 * Resolve either a .photoslibrary package itself or the wizard's conventional
 * parent folder containing exactly one package. The wizard stages exports at
 * `inbox/apple/photos/<name>.photoslibrary`; requiring callers to point at the
 * nested package made that standard inbox route recognize successfully but
 * import zero items.
 */
async function libraryDir(baseDir: string): Promise<string | undefined> {
  if (await originalsDir(baseDir)) {
    return baseDir;
  }

  let entries: fs.Dirent[];
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const packages: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith('.photoslibrary')) {
      continue;
    }

    const candidate = path.join(baseDir, entry.name);
    if (await originalsDir(candidate)) {
      packages.push(candidate);
    }
  }

  return packages.length === 1 ? packages[0] : undefined;
}

/**
 * Within one originals bucket, build the set of basenames that have BOTH a
 * Live-Photo-compatible image and a Live-Photo-compatible video (e.g. UUID.heic
 * + UUID.mov, or IMG_1234.jpg + IMG_1234.mov). Both halves get LivePhoto=true.
 */
function livePhotoStems(filenames: string[]): Set<string> {
  const stillStems = new Set<string>();
  const motionStems = new Set<string>();
  for (const name of filenames) {
    const ext = path.extname(name).toLowerCase();
    const stem = name.slice(0, name.length - ext.length);
    if (LIVE_PHOTO_IMAGE_EXTS.has(ext)) {
      stillStems.add(stem);
    } else if (LIVE_PHOTO_VIDEO_EXTS.has(ext)) {
      motionStems.add(stem);
    }
  }

  const pairs = new Set<string>();
  for (const s of stillStems) {
    if (motionStems.has(s)) {
      pairs.add(s);
    }
  }

  return pairs;
}

class ApplePhotosFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const baseDir = entry.fullPath || entry.fsRoot || entry.filename;
    if (!baseDir) {
      return { confidence: 0 };
    }

    let isDir = false;
    try {
      isDir = (await stat(baseDir)).isDirectory();
    } catch {
      return { confidence: 0 };
    }

    if (!isDir) {
      return { confidence: 0 };
    }

    const resolved = await libraryDir(baseDir);
    const isPackage = baseDir.toLowerCase().endsWith('.photoslibrary');
    const hasOriginals = !!resolved;
    if (!isPackage && !hasOriginals) {
      return { confidence: 0 };
    }

    let confidence = isPackage ? 0.7 : 0.5;
    if (hasOriginals) {
      confidence += 0.2;
    }

    return { confidence };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const baseDir = entry.fullPath || entry.fsRoot || entry.filename;
    if (!baseDir) {
      return;
    }

    const resolved = await libraryDir(baseDir);
    const originals = resolved ? await originalsDir(resolved) : undefined;
    if (!originals) {
      params.log?.('warn', 'no readable originals/ — nothing to import', { baseDir });

      return;
    }

    // originals/ is a flat set of hex-named subdirs each holding the media files.
    let buckets: fs.Dirent[];
    try {
      buckets = fs.readdirSync(originals, { withFileTypes: true });
    } catch (e) {
      params.log?.('error', 'read originals/ failed', { error: (e as Error).message });

      return;
    }

    for (const bucket of buckets) {
      if (!bucket.isDirectory()) {
        continue;
      }

      const bucketDir = path.join(originals, bucket.name);
      let files: string[];
      try {
        files = fs.readdirSync(bucketDir);
      } catch {
        continue;
      }

      // Pre-scan this bucket for Live Photo pairs so the still and the motion
      // half can both carry the flag (and downstream can collapse them).
      const livePairs = livePhotoStems(files);

      for (const name of files) {
        if (!isMediaFile(name)) {
          continue;
        }

        const fpath = path.join(bucketDir, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fpath);
        } catch {
          continue;
        }

        if (!stat.isFile()) {
          continue;
        }

        const mediaType = mediaTypeFor(name);
        // MIME-routed metadata read: images go through EXIF; videos go through
        // ffprobe (with an exifr-QuickTime fallback). Returns {} on any failure,
        // so a single bad file never halts the bucket.
        const media = await extractMediaMetadata(fpath, mediaType);
        const hasCaptureTime = hasPlausibleCaptureTime(media.timestamp);
        const ts = hasCaptureTime ? media.timestamp : stat.mtime;
        if (!timeframeContains(params.timeframe, ts)) {
          continue;
        }

        // Stable id keyed on the path within the package: media files share no
        // common filename pattern but the originals-relative path is unique and
        // deterministic, so re-import is idempotent (see hashItem fallback).
        const relativePath = path.join('originals', bucket.name, name);

        const ext = path.extname(name).toLowerCase();
        const stem = name.slice(0, name.length - ext.length);
        const isLivePhoto = livePairs.has(stem);

        const metadata: Metadata = {
          Title: name,
          'Media Type': mediaType || undefined,
          Bucket: bucket.name,
          Source: 'Apple Photos',
          'Timestamp Source': hasCaptureTime
            ? mediaType?.startsWith('video/')
              ? 'Container'
              : 'EXIF'
            : 'File mtime',
          // GPS uncertainty when the camera recorded one — the canonical mapper
          // reads this key (and so does the position pipeline once the
          // createPositions route lands) instead of guessing 30m.
          ...(media.accuracyMeters != null ? { AccuracyMeters: media.accuracyMeters } : {}),
          // Spread the EXIF camera + container bag (Make/Model/Lens/Exposure/
          // ISO/Orientation/Duration/Frame Rate/Width/Height/Codec) last so a
          // malformed tag can't overwrite the keys above. Empty when absent.
          ...(media.metadata as Metadata),
        };
        if (isLivePhoto) {
          metadata.LivePhoto = true;
        }

        params.pipeline.push({
          item: {
            id: 'apple_photos:' + relativePath,
            // 'photo' short-circuits kindFor's MIME-decides branch straight to
            // capture.photo, misrouting videos; 'media' (google_photos.ts's
            // classification) lets kindFor branch on the real image/video MIME.
            classification: 'media',
            timestamp: ts,
            ...(media.location ? { location: media.location } : {}),
            intermediateLocation: fpath,
            content: {
              filename: name,
              mediaType,
              data: async () => fs.promises.readFile(fpath),
            },
            metadata,
          },
        });
      }
    }
  }
}

registerDataSource({
  name: 'apple_photos',
  title: 'Apple Photos',
  icon: 'apple_photos.svg',
  description: 'Apple Photos library importer (media files from a .photoslibrary package)',
  newFileImporter: () => new ApplePhotosFileImporter(),
});
