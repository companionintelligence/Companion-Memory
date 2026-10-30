/* Google Photos datasource (TypeScript port)
   Consolidated: supports Takeout album folder structure with sidecar JSON pairing and generic directory imports.
*/
import fs from 'fs';
import path from 'path';

import {
  type ExifBag,
  extractCameraFields,
  exifInstant,
  extractVideoMetadata,
  parseExifSafe,
} from '@ci/common/media/exif';

import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph, Item } from './timeline';
import { mediaItemFromFile, fileTimestamp, timeframeContains } from './timeline';

interface GooglePhotosOptions {
  includeArchivedMedia?: boolean;
}

// Common media file extensions
const RECOGNIZED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.jpe',
  '.png',
  '.gif',
  '.webp',
  '.heic',
  '.mp4',
  '.mov',
  '.mpeg',
  '.avi',
  '.wmv',
  '.m4v',
  '.3gp',
  '.raw',
  '.dng',
  '.nef',
  '.tiff',
  '.divx',
  '.mkv',
  '.asf',
]);

// Extensions for which an EXIF camera/lens read is worth doing on the binary
// itself (Takeout sidecars carry timestamp+GPS but NOT camera/lens/exposure).
// Videos rarely carry TIFF EXIF so we skip them here.
const EXIF_READABLE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.jpe',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.raw',
]);

/**
 * The binary's EXIF capture time, or null. DateTimeOriginal ONLY —
 * CreateDate/ModifyDate are write/edit times, and a filename-derived date is
 * deliberately not attempted (names may carry no capture signal, or a
 * user-invented one in the wrong format).
 *
 * When the camera also recorded OffsetTimeOriginal, the wall-clock's zone is
 * known and the TRUE instant is returned (wall-clock minus offset) — agreeing
 * with the sidecar's photoTakenTime for the same photo (verified against a
 * Takeout export: DateTimeOriginal 12:00 at +02:00 vs photoTakenTime 10:00Z).
 * Without the tag, the wall-clock is re-interpreted as UTC
 * (exifWallClockToUtc) so the value stays host-independent "floating local
 * time" — offset-less photos sort correctly among themselves, at the cost of
 * being up to a zone-width off from sidecar-dated neighbours.
 */
function exifCaptureTime(exif: unknown): Date | null {
  const bag = exif as { DateTimeOriginal?: unknown; OffsetTimeOriginal?: unknown } | null | undefined;
  const dt = bag?.DateTimeOriginal;
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) {
    return null;
  }

  return exifInstant(dt, bag?.OffsetTimeOriginal);
}

/**
 * Sanity floor for a container creation_time: some encoders write the zero
 * value (Unix 1970 / QuickTime 1904 epoch) when the camera clock was unset —
 * a "capture time" before this is garbage, not data.
 */
const MIN_PLAUSIBLE_CAPTURE_MS = Date.parse('1990-01-01T00:00:00Z');

/**
 * Timestamp fallback chain for media whose sidecar didn't supply one — the
 * media's own metadata first, file time last. This matters because Takeout
 * splits media and their JSON sidecars across the export's zip archives (an
 * import of a subset of the zips leaves most media sidecar-less), and motion-
 * photo clips NEVER have a sidecar of their own — the file-time fallback then
 * stamps them all with the ARCHIVE-creation mtime.
 *
 *  - Images: EXIF DateTimeOriginal (the caller already parsed the binary for
 *    camera fields — its bag is reused via `exif`).
 *  - Videos: the container's creation_time via extractVideoMetadata (ffprobe,
 *    exifr QuickTime fallback) — a TZ-aware instant, verified against a real
 *    Takeout export to match the sidecar-style capture time. Epoch-garbage
 *    stamps are rejected (MIN_PLAUSIBLE_CAPTURE_MS). Probed lazily, only for
 *    videos that actually miss a sidecar timestamp. Container GPS rides along
 *    when the sidecar gave none (already null-island-guarded upstream).
 */
async function applyTimestampFallback(item: Item, fpath: string, exif: unknown): Promise<void> {
  if (item.timestamp) {
    return;
  }

  const captured = exifCaptureTime(exif);
  if (captured) {
    item.timestamp = captured;
    item.metadata!['Timestamp Source'] = 'EXIF';

    return;
  }

  if (item.content?.mediaType?.startsWith('video/')) {
    try {
      const media = await extractVideoMetadata(fpath);
      const ts = media.timestamp;
      if (ts && ts.getTime() >= MIN_PLAUSIBLE_CAPTURE_MS) {
        item.timestamp = ts;
        item.metadata!['Timestamp Source'] = 'Container';
        if (!item.location && media.location) {
          item.location = media.location;
        }

        return;
      }
    } catch {
      /* probe failed — fall through to file time */
    }
  }

  item.timestamp = fileTimestamp(fpath);
  item.metadata!['Timestamp Source'] = 'File System';
}

/**
 * Resolve a media file's Google Takeout metadata sidecar, covering Takeout's
 * several sidecar-naming quirks:
 *
 *  - Modern exports name the sidecar `<file>.supplemental-metadata.json`; older
 *    ones use `<file>.json`.
 *  - The supplemental suffix is truncated for long filenames
 *    (`<file>.supplemental-met.json`), so we fall back to a `<file>.*.json`
 *    directory scan.
 *  - Duplicate filenames in a folder get a `(N)` counter on the MEDIA file
 *    (`IMG_0001(1).jpg`), but on the sidecar the counter lands at the very end,
 *    before `.json`, attached to the ORIGINAL name
 *    (`IMG_0001.jpg.supplemental-metadata(1).json`, or legacy
 *    `IMG_0001.jpg(1).json`). The naive `<file>.json` lookup misses these.
 *  - `-edited` derivatives carry no sidecar of their own; they share the base
 *    file's metadata.
 *
 * Returns the sidecar path or null.
 */
function resolveSidecarPath(fpath: string): string | null {
  const dir = path.dirname(fpath);
  const base = path.basename(fpath);

  // Lazily-read, cached directory listing for the scan-based fallbacks.
  let cachedDir: string[] | null = null;
  const dirFiles = (): string[] => {
    if (cachedDir === null) {
      try {
        cachedDir = fs.readdirSync(dir);
      } catch {
        cachedDir = [];
      }
    }

    return cachedDir;
  };

  const exists = (name: string): string | null => {
    const full = path.join(dir, name);

    return fs.existsSync(full) ? full : null;
  };

  // 1. Plain, non-duplicate sidecar (modern + legacy names).
  const exact = exists(`${base}.supplemental-metadata.json`) || exists(`${base}.json`);
  if (exact) {
    return exact;
  }

  // 2. Duplicate-counter media name `name(N).ext`: the sidecar keeps the counter
  //    before `.json`, attached to the original `name.ext`.
  const dup = base.match(/^(.+)\((\d+)\)(\.[^.]+)$/);
  if (dup) {
    const original = `${dup[1]}${dup[3]}`; // media name minus the (N) it carries
    const n = dup[2];
    const counted =
      exists(`${original}.supplemental-metadata(${n}).json`) || exists(`${original}(${n}).json`);
    if (counted) {
      return counted;
    }

    // Truncated supplemental suffix that still carries the trailing counter.
    const hit = dirFiles().find((f) => f.startsWith(`${original}.`) && f.endsWith(`(${n}).json`));
    if (hit) {
      return path.join(dir, hit);
    }
  }

  // 3. Truncated supplemental suffix on the plain name.
  const prefixHit = dirFiles().find((f) => f.startsWith(`${base}.`) && f.endsWith('.json'));
  if (prefixHit) {
    return path.join(dir, prefixHit);
  }

  // 4. `-edited` derivative: fall back to the base file's sidecar.
  const edited = base.match(/^(.+)-edited(\.[^.]+)$/i);
  if (edited) {
    const viaBase = resolveSidecarPath(path.join(dir, `${edited[1]}${edited[2]}`));
    if (viaBase) {
      return viaBase;
    }
  }

  return null;
}

/** The lat/lon/altitude block Takeout writes in a media sidecar. */
interface TakeoutGeo {
  latitude?: number;
  longitude?: number;
  altitude?: number;
}

/**
 * Google Takeout's per-media JSON sidecar. Every field is optional: the shape
 * has changed across Takeout generations and a given export may omit any of
 * them. Timestamps are seconds-since-epoch written as strings.
 */
interface TakeoutSidecar {
  title?: string;
  description?: string;
  url?: string;
  people?: Array<{ name?: string } | null>;
  photoTakenTime?: { timestamp?: string };
  creationTime?: { timestamp?: string };
  geoData?: TakeoutGeo;
  geoDataExif?: TakeoutGeo;
}

class GooglePhotosFileImporter implements FileImporter {
  private importRoot = '';

  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const baseDir = entry.fullPath || entry.fsRoot || entry.filename;
    if (!baseDir) {
      return { confidence: 0 };
    }

    const normalizedPath = baseDir.toLowerCase().replace(/\\/g, '/');
    const dirName = path.basename(baseDir).toLowerCase();

    // High confidence for the Google Photos export root, whether still nested
    // under `Takeout/` or already flattened up to `…/Google Photos` (unpack
    // strips the `Takeout/` wrapper — see unpack.ts:flattenTakeoutWrapper).
    if (dirName === 'google photos' || normalizedPath.includes('/takeout/google photos')) {
      return { confidence: 0.9 };
    }

    // Looser name match (e.g. a hand-renamed "Google Photos backup" folder).
    if (dirName.includes('google') && dirName.includes('photos')) {
      return { confidence: 0.6 };
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const startPath = entry.fullPath || entry.fsRoot || entry.filename;
    if (!startPath) {
      return;
    }

    this.importRoot = startPath;

    const stat = fs.statSync(startPath);
    if (!stat.isDirectory()) {
      params.log?.('warn', 'Google Photos import expects a directory', { path: startPath });

      return;
    }

    // When pointed at the Google Photos export root, process its album folders
    // specially (collection/motion/edited edges + Takeout sidecar pairing). The
    // root is `…/Google Photos` once unpack has flattened away the `Takeout/`
    // wrapper, or the legacy `…/Takeout/Google Photos` if extracted by hand.
    // Anything else (a single album folder, a generic dir) falls to the plain
    // recursive walk, which still pairs sidecars per file.
    const normalized = startPath.toLowerCase().replace(/\\/g, '/');
    if (normalized === 'google photos' || normalized.endsWith('/google photos')) {
      await this.importTakeoutAlbums(startPath, params);
    } else {
      for await (const fpath of this.walkDir(startPath)) {
        await this.processFile(fpath, params);
      }
    }
  }

  private async *walkDir(root: string): AsyncGenerator<string> {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(root, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) {
          continue;
        }

        yield* this.walkDir(full);
      } else if (e.isFile()) {
        yield full;
      }
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    if (base.startsWith('.')) {
      return;
    }

    const ext = path.extname(fpath).toLowerCase();
    if (ext === '.json') {
      return;
    } // sidecar metadata

    if (!RECOGNIZED_EXTENSIONS.has(ext)) {
      return;
    }

    const item = mediaItemFromFile(fpath);
    item.metadata = item.metadata || {};
    item.metadata.Source = 'Google Photos';

    // Camera context (Make/Model/Lens/F-Number/Exposure Time/ISO/Focal Length/
    // Orientation): Takeout sidecars carry timestamp+GPS but NOT camera/lens —
    // those tags live in the binary's EXIF. Read them directly for images
    // (videos skipped — they rarely carry TIFF EXIF). Best-effort and
    // timeout-guarded so one bad HEIC can't wedge the walk. We do the EXIF
    // read BEFORE the people-branch's early-return below so face-tagged
    // photos pick up camera context too. The parsed bag is kept in scope: its
    // DateTimeOriginal doubles as the timestamp fallback for sidecar-less
    // photos (applyTimestampFallback) without a second read.
    let exif: unknown = null;
    if (EXIF_READABLE_EXTS.has(ext)) {
      try {
        exif = await parseExifSafe(fpath, { tiff: true, exif: true });
        Object.assign(item.metadata, extractCameraFields(exif as ExifBag));
      } catch {
        /* skip — extractCameraFields(null) is already a no-op */
      }
    }

    // Try to load the Google Photos JSON metadata sidecar. Takeout renamed
    // sidecars from `<file>.json` to `<file>.supplemental-metadata.json` (and
    // sometimes truncates that suffix for long names), so try the new name, the
    // legacy name, then a best-effort `<file>.*.json` scan of the directory.
    const metadataPath = resolveSidecarPath(fpath);
    if (metadataPath) {
      try {
        const metadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf-8')) as TakeoutSidecar;

        // Extract timestamp from metadata (prefer photoTakenTime then creationTime)
        if (metadata.photoTakenTime?.timestamp) {
          item.timestamp = new Date(parseInt(metadata.photoTakenTime.timestamp) * 1000);
        } else if (metadata.creationTime?.timestamp) {
          item.timestamp = new Date(parseInt(metadata.creationTime.timestamp) * 1000);
        }

        // Location + Title/Description/URL are extracted BEFORE the people branch:
        // the people branch pushes `item` and returns early, so a face-tagged photo
        // would otherwise silently lose its GPS, title, description and URL.
        // Presence + null-island guard (mirrors google_location.ts) so a real (0,0)
        // sentinel isn't recorded as a coordinate.
        const gd = metadata.geoData,
          gx = metadata.geoDataExif;
        // Track which side won so we lift the matching altitude from the SAME
        // block (don't mix a geoData lat/lon with a geoDataExif altitude).
        let altitudeSource: TakeoutGeo | null = null;
        if (gd?.latitude != null && gd?.longitude != null && !(gd.latitude === 0 && gd.longitude === 0)) {
          item.location = { latitude: gd.latitude, longitude: gd.longitude };
          altitudeSource = gd;
        } else if (
          gx?.latitude != null &&
          gx?.longitude != null &&
          !(gx.latitude === 0 && gx.longitude === 0)
        ) {
          item.location = { latitude: gx.latitude, longitude: gx.longitude };
          altitudeSource = gx;
        }

        // Lift altitude into metadata.Altitude — the canonical mapper reads it
        // for the position pipeline's altitudeMeters. Takeout writes 0.0 when
        // the EXIF carried no altitude, so treat 0 as 'absent' (mirrors the
        // null-island guard above).
        if (
          altitudeSource &&
          typeof altitudeSource.altitude === 'number' &&
          Number.isFinite(altitudeSource.altitude) &&
          altitudeSource.altitude !== 0
        ) {
          item.metadata.Altitude = altitudeSource.altitude;
        }

        if (metadata.title) {
          item.metadata.Title = metadata.title;
        }

        if (metadata.description) {
          item.metadata.Description = metadata.description;
        }

        if (metadata.url) {
          item.metadata.URL = metadata.url;
        }

        // People -> entity edges
        if (Array.isArray(metadata.people) && metadata.people.length) {
          const graph: Graph = { item, edges: [] };
          for (const person of metadata.people) {
            if (!person?.name) {
              continue;
            }

            graph.edges!.push({
              relation: 'includes',
              to: {
                entity: {
                  type: 'person',
                  name: person.name,
                  attributes: [{ name: 'google_photos_name', value: person.name, identity: true }],
                },
              },
            });
          }

          await applyTimestampFallback(item, fpath, exif);
          if (!timeframeContains(params.timeframe, item.timestamp)) {
            return;
          }

          item.metadata.RetrievalKey = this.retrievalKeyFor(item.intermediateLocation || fpath);
          params.pipeline.push(graph);

          return;
        }
      } catch (error) {
        params.log?.('debug', 'Failed to parse metadata JSON', {
          file: base,
          error: (error as Error).message,
        });
      }
    }

    // No usable sidecar timestamp: the media's own metadata, then file time.
    await applyTimestampFallback(item, fpath, exif);

    if (!timeframeContains(params.timeframe, item.timestamp)) {
      return;
    }

    item.metadata.RetrievalKey = this.retrievalKeyFor(item.intermediateLocation || fpath);
    params.pipeline.push({ item });
  }

  /**
   * Import the Google Photos export root. Each immediate subdirectory is an
   * album ("Photos from 2020", custom album names, …); media inside is paired
   * with its Takeout JSON sidecar via `resolveSidecarPath` (the forward
   * direction — find each media file's sidecar — which is far more robust than
   * reverse-engineering the on-disk media name from the sidecar's `title`).
   */
  private async importTakeoutAlbums(root: string, params: ImportParams) {
    let albums: import('node:fs').Dirent[];
    try {
      albums = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const album of albums) {
      if (!album.isDirectory()) {
        continue;
      }

      const albumPath = path.join(root, album.name);
      let files: import('node:fs').Dirent[];
      try {
        files = await fs.promises.readdir(albumPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const f of files) {
        if (!f.isFile() || f.name.startsWith('.')) {
          continue;
        }

        const ext = path.extname(f.name).toLowerCase();
        if (ext === '.json' || !RECOGNIZED_EXTENSIONS.has(ext)) {
          continue;
        }

        // `-edited` derivatives are attached as an `edit` edge on their base
        // file (below), not imported as standalone items.
        if (/-edited\.[^.]+$/i.test(f.name)) {
          continue;
        }

        const mediaPath = path.join(albumPath, f.name);
        const item = mediaItemFromFile(mediaPath);
        item.metadata = item.metadata || {};
        item.metadata.Source = 'Google Photos';

        let meta: TakeoutSidecar | null = null;
        const sidecarPath = resolveSidecarPath(mediaPath);
        if (sidecarPath) {
          try {
            meta = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8')) as TakeoutSidecar;
          } catch (e) {
            params.log?.('debug', 'takeout sidecar parse failed', {
              file: path.basename(sidecarPath),
              error: (e as Error).message,
            });
          }
        }

        // Timestamp: prefer photoTakenTime, then creationTime, then the file's
        // own time (epoch-birthtime-guarded via fileTimestamp).
        const takenTs = Number(meta?.photoTakenTime?.timestamp);
        const createdTs = Number(meta?.creationTime?.timestamp);
        if (meta?.photoTakenTime?.timestamp && !Number.isNaN(takenTs)) {
          item.timestamp = new Date(takenTs * 1000);
        } else if (meta?.creationTime?.timestamp && !Number.isNaN(createdTs)) {
          item.timestamp = new Date(createdTs * 1000);
        }

        // Sidecar-less (or timestamp-less sidecar): read the binary's EXIF
        // before surrendering to file time. Lazy — the parse (this path's only
        // EXIF read) runs just for the photos that actually need it, so a
        // fully-sidecared export pays nothing.
        let exif: unknown = null;
        if (!item.timestamp && EXIF_READABLE_EXTS.has(ext)) {
          try {
            exif = await parseExifSafe(mediaPath, { tiff: true, exif: true });
          } catch {
            /* unreadable EXIF — fall through to file time */
          }
        }

        await applyTimestampFallback(item, mediaPath, exif);

        // Location (presence + null-island guard, mirrors processFile).
        const gd = meta?.geoData,
          gx = meta?.geoDataExif;
        if (gd?.latitude != null && gd?.longitude != null && !(gd.latitude === 0 && gd.longitude === 0)) {
          item.location = { latitude: gd.latitude, longitude: gd.longitude };
        } else if (
          gx?.latitude != null &&
          gx?.longitude != null &&
          !(gx.latitude === 0 && gx.longitude === 0)
        ) {
          item.location = { latitude: gx.latitude, longitude: gx.longitude };
        }

        if (meta?.title) {
          item.metadata.Title = meta.title;
        }

        if (meta?.description) {
          item.metadata.Description = meta.description;
        }

        if (meta?.url) {
          item.metadata.URL = meta.url;
        }

        // Altitude lift (#102): the GPS source `gd`/`gx` was already resolved for
        // `item.location` above; pull its altitude too. Takeout writes 0.0 for
        // "absent", so treat 0 as no-altitude. Reuses the existing extraction
        // rather than re-deriving location (the album loop's #107 path already
        // set it).
        const albumAlt =
          gd?.latitude != null && gd?.longitude != null && !(gd.latitude === 0 && gd.longitude === 0)
            ? gd
            : gx?.latitude != null && gx?.longitude != null && !(gx.latitude === 0 && gx.longitude === 0)
              ? gx
              : null;
        if (
          albumAlt &&
          typeof albumAlt.altitude === 'number' &&
          Number.isFinite(albumAlt.altitude) &&
          albumAlt.altitude !== 0
        ) {
          item.metadata.Altitude = albumAlt.altitude;
        }

        const graph: Graph = { item, edges: [] };
        // Album membership.
        graph.edges!.push({
          relation: 'in_collection',
          to: {
            item: {
              classification: 'collection',
              content: { filename: album.name, data: async () => Buffer.from(album.name) },
              metadata: {},
            },
          },
        });
        // People -> entity edges.
        if (Array.isArray(meta?.people)) {
          for (const person of meta.people) {
            if (!person?.name) {
              continue;
            }

            graph.edges!.push({
              relation: 'includes',
              to: {
                entity: {
                  type: 'person',
                  name: person.name,
                  attributes: [{ name: 'google_photos_name', value: person.name, identity: true }],
                },
              },
            });
          }
        }

        // Edited variant.
        const ext2 = path.extname(f.name);
        const editedCandidate = path.join(albumPath, `${path.basename(f.name, ext2)}-edited${ext2}`);
        if (fs.existsSync(editedCandidate)) {
          graph.edges!.push({ relation: 'edit', to: { item: mediaItemFromFile(editedCandidate) } });
        }

        // Motion photo: a still paired with a short video sharing the base name.
        if (/\.(jpe?g|heic|png)$/i.test(f.name)) {
          const baseName = path.basename(f.name, ext2);
          for (const mExt of ['.mp4', '.mov', '.MP4', '.MOV']) {
            const motionPath = path.join(albumPath, baseName + mExt);
            if (fs.existsSync(motionPath)) {
              const motionItem = mediaItemFromFile(motionPath);
              motionItem.timestamp = item.timestamp;
              graph.edges!.push({ relation: 'motion_photo', to: { item: motionItem } });
              break;
            }
          }
        }

        if (!timeframeContains(params.timeframe, item.timestamp)) {
          continue;
        }

        item.metadata.RetrievalKey = this.retrievalKeyFor(mediaPath);
        params.pipeline.push(graph);
      }
    }
  }

  private retrievalKeyFor(mediaPath: string): string {
    const exportID = this.exportIDFromArchivePath();
    const rel = mediaPath.startsWith(this.importRoot)
      ? mediaPath.substring(this.importRoot.length + 1)
      : mediaPath;

    return `google_photos::${exportID}::${rel}`;
  }

  private exportIDFromArchivePath(): string {
    const lower = this.importRoot.toLowerCase();
    const suffix = 'takeout/google photos';
    const idx = lower.indexOf(suffix);
    if (idx === -1) {
      return path.basename(this.importRoot);
    }

    const before =
      this.importRoot.substring(0, idx).split('/').filter(Boolean).pop() || path.basename(this.importRoot);

    return before.replace(/(-\d+)+(\.zip)?$/i, '').replace(/\.zip$/i, '');
  }
}

registerDataSource({
  name: 'google_photos',
  title: 'Google Photos',
  icon: 'google_photos.svg',
  description: 'Google Photos importer (Takeout + generic folder)',
  newOptions: () => ({ includeArchivedMedia: false }) as GooglePhotosOptions,
  newFileImporter: () => new GooglePhotosFileImporter(),
});
