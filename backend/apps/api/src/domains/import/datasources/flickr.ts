/* Flickr — "Request my Flickr data" self-serve export (Settings → Your Flickr
 * Data → Request My Flickr Data). Confirmed live and current on the vendor's
 * own help page (see below): the request emails ~5 zip links; every zip this
 * codebase's own unpack stage extracts for one run lands in the SAME
 * destination directory (unpackArchives extracts each sibling zip into the
 * directory it was found in), so the metadata and image archives end up flat
 * together in one folder — exactly the layout every source below describes.
 *
 * Directory shape, once unpacked:
 *   photo_<id>.json          one per photo/video — the distinctive, load-bearing
 *                             filename this importer recognizes on.
 *   albums.json               { "albums": [ { id, title, ... } ] } — not required
 *                             to import a photo (each photo's own JSON already
 *                             carries its album memberships), used here only as
 *                             a weaker recognition signal for a metadata-only
 *                             partial drop.
 *   <slug>_<id>_o.<ext>       the photo/video bytes themselves, id-keyed. `_o`
 *                             marks the "original" size; slug is a-slugified
 *                             title and may be empty for an untitled upload.
 *
 * Format sources:
 *  - Flickr Help Center, "Downloading content from Flickr" — the "Download all
 *    your Flickr Data" section: Settings → Your Flickr Data → "Request My
 *    Flickr Data"; "Any details added to your photos after upload will be
 *    compiled in a separate JSON file."
 *    https://www.flickrhelp.com/hc/en-us/articles/4404079675156
 *  - Flickr Help Center, "Opening Your Flickr Data Zip Files" — confirms the
 *    multi-zip delivery (>500 photos gets several numbered download links).
 *    https://www.flickrhelp.com/hc/en-us/articles/4404071661844
 *  - philipmallis.com, "How to export Flickr photos with metadata attached"
 *    (2023, updated with reader corrections into 2025) — the id-extraction
 *    rule (last 11 chars before `_o`, not 8, since Flickr lengthened photo
 *    ids in 2020) and that geo lat/lon ship as integers in millionths of a
 *    degree, not decimal degrees.
 *    https://philipmallis.com/2023/09/11/how-to-export-flickr-photos-with-metadata-attached/
 *  - github.com/nickivanov/flickr-meta-export — a metadata2csv converter whose
 *    default field map is read directly off a real export and names the raw
 *    JSON keys used below: `name`, `description`, `albums[0].title`,
 *    `tags[*].tag`, `date_imported`, `license`.
 *  - github.com/yaniv-golan/offlickr — an actively maintained "Flickr export →
 *    static site" tool. Its ingest/media.py documents the `<slug>_<id>_o.<ext>`
 *    media-filename convention this importer's `parseMediaFilename` mirrors,
 *    and its checked-in `tests/fixtures/mini-export/photo_10000001.json` /
 *    `albums.json` are the fullest real-shaped sample of the JSON found for
 *    this task — this importer's own test fixtures reproduce that sample's
 *    field names and structure (see flickr.test.ts) rather than inventing one.
 *
 * Scope: photo/video metadata (title, description, date, geo, tags, license,
 * people, album membership) only. Flickr's export also ships a separate
 * contacts JSON and CSV activity log; neither is imported here — extending to
 * those is future work, not a gap this parser silently papers over.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { DirEntry, FileImporter, Recognition } from './registry';
import { registerDataSource } from './registry';
import type { Graph, ImportParams, Location } from './timeline';
import { fileTimestamp, mediaItemFromFile, timeframeContains } from './timeline';

/** Flickr's per-photo metadata sidecar filename: `photo_<numeric id>.json`. */
const PHOTO_JSON_RE = /^photo_(\d+)\.json$/i;

/**
 * Extensions Flickr's export actually uses for photo/video bytes, per
 * offlickr's ingest/media.py (see file header). Kept to what the citation
 * shows rather than a generic media-extension list — Flickr transcodes every
 * upload to one of these on the way out.
 */
const MEDIA_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.heic', '.heif', '.mp4', '.mov', '.m4v']);

/**
 * Parse Flickr's export media filename `[slug_parts..._]<photo id>[_secret]_o.<ext>`
 * into the photo id it belongs to, or null if `name` doesn't match the
 * convention. Mirrors offlickr's `parse_media_filename` (see file header):
 * split on `_`, require a trailing literal `o` token, then take the LEFTMOST
 * all-digit token before it — a secret/hash token, if present, sits between
 * the id and `o` and is also all-digit, so leftmost is what disambiguates them.
 */
function parseMediaFilename(name: string): { photoId: string } | null {
  const ext = path.extname(name).toLowerCase();
  if (!ext || !MEDIA_EXTS.has(ext)) {
    return null;
  }

  const stem = name.slice(0, name.length - ext.length);
  const tokens = stem.split('_');
  if (tokens.length < 2 || tokens[tokens.length - 1] !== 'o') {
    return null;
  }

  const pre = tokens.slice(0, -1);
  const idIdx = pre.findIndex((t) => /^\d+$/.test(t));
  if (idIdx === -1) {
    return null;
  }

  return { photoId: pre[idIdx] };
}

/** First-seen media file per photo id, built once per directory walk. */
function buildMediaIndex(dir: string): Map<string, string> {
  const index = new Map<string, string>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return index;
  }

  for (const name of names) {
    const parsed = parseMediaFilename(name);
    if (!parsed || index.has(parsed.photoId)) {
      continue;
    }

    index.set(parsed.photoId, path.join(dir, name));
  }

  return index;
}

interface FlickrGeo {
  latitude?: string;
  longitude?: string;
}
interface FlickrTag {
  tag?: string;
}
interface FlickrAlbumRef {
  title?: string;
}
interface FlickrPersonRef {
  nsid?: string;
  username?: string;
}

/**
 * Flickr's per-photo JSON sidecar — the fields this importer reads, named
 * exactly as the citations show them (see file header): `name` is the title,
 * `geo` wraps a single lat/lon block in a one-element array (empty when the
 * photo carries no location), and `albums[].title` (not `.name`) is the
 * membership Flickr's own metadata-export tool reads off a real archive.
 */
interface FlickrPhotoJson {
  id?: string | number;
  name?: string;
  description?: string;
  date_taken?: string;
  date_imported?: string;
  license?: string;
  geo?: FlickrGeo[];
  tags?: FlickrTag[];
  people?: FlickrPersonRef[];
  albums?: FlickrAlbumRef[];
  photopage?: string;
}

/** Flickr's sentinel for "no capture date on file" — a literal zero date, not absence of the field. */
const MISSING_DATE_SENTINEL = '0000-00-00 00:00:00';

/**
 * Flickr writes `date_taken`/`date_imported` as naive `YYYY-MM-DD HH:MM:SS`
 * local time, no zone (confirmed against the offlickr fixture — see file
 * header). Re-interpreted as UTC "floating local time", the same convention
 * google_photos.ts uses for offset-less EXIF: not the true instant, but
 * host-independent and sorts correctly against its own siblings.
 */
function parseFlickrDate(s: string | undefined): Date | undefined {
  if (!s || s === MISSING_DATE_SENTINEL) {
    return undefined;
  }

  const d = new Date(`${s.replace(' ', 'T')}Z`);

  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Flickr ships geo as a ONE-ELEMENT ARRAY (empty when the photo has no
 * location) of lat/lon in millionths of a degree as strings — both quirks
 * corroborated independently by the offlickr fixture and a reader correction
 * on philipmallis.com (see file header). Null-island guarded like every other
 * geo-bearing importer in this codebase.
 */
function parseFlickrGeo(geo: FlickrGeo[] | undefined): Location | null {
  const g = geo?.[0];
  if (g?.latitude == null || g?.longitude == null) {
    return null;
  }

  const latitude = Number(g.latitude) / 1_000_000;
  const longitude = Number(g.longitude) / 1_000_000;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) {
    return null;
  }

  return { latitude, longitude };
}

class FlickrFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = fs.statSync(root);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile()) {
      return PHOTO_JSON_RE.test(path.basename(root)) ? { confidence: 0.75 } : { confidence: 0 };
    }

    if (!st.isDirectory()) {
      return { confidence: 0 };
    }

    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return { confidence: 0, dir_threshold: 0.7 };
    }

    // photo_<id>.json is Flickr's own, distinctive sidecar filename — nothing
    // else in this codebase's corpus writes it. More than a couple present
    // raises confidence further, so a single stray same-named file elsewhere
    // can't outrank a real export.
    const photoJsonCount = names.filter((n) => PHOTO_JSON_RE.test(n)).length;
    if (photoJsonCount > 0) {
      return { confidence: photoJsonCount >= 3 ? 0.95 : 0.8, dir_threshold: 0.7 };
    }

    // A metadata-only partial drop (e.g. only the albums.json zip has
    // extracted so far) still deserves a soft directory-level claim.
    if (names.some((n) => n.toLowerCase() === 'albums.json')) {
      return { confidence: 0.4, dir_threshold: 0.7 };
    }

    return { confidence: 0, dir_threshold: 0.7 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let st: fs.Stats;
    try {
      st = fs.statSync(root);
    } catch {
      return;
    }

    const dir = st.isDirectory() ? root : path.dirname(root);
    const mediaIndex = buildMediaIndex(dir);

    let jsonPaths: string[];
    if (st.isFile()) {
      jsonPaths = PHOTO_JSON_RE.test(path.basename(root)) ? [root] : [];
    } else {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }

      jsonPaths = names.filter((n) => PHOTO_JSON_RE.test(n)).map((n) => path.join(dir, n));
    }

    for (const jsonPath of jsonPaths) {
      try {
        await this.importPhoto(jsonPath, mediaIndex, params);
      } catch (e) {
        params.log?.('error', `Failed to import ${path.basename(jsonPath)}`, {
          error: (e as Error).message,
        });
      }
    }
  }

  private async importPhoto(
    jsonPath: string,
    mediaIndex: Map<string, string>,
    params: ImportParams,
  ): Promise<void> {
    const raw = await fs.promises.readFile(jsonPath, 'utf8');
    const data = JSON.parse(raw) as FlickrPhotoJson;
    const id = data?.id != null ? String(data.id) : '';
    if (!id) {
      return;
    }

    const mediaPath = mediaIndex.get(id);
    if (!mediaPath) {
      // The metadata and image archives are two separate download links —
      // requesting (or unzipping) only the metadata one is common. With no
      // bytes to attach there is nothing a media item can point at, so this
      // photo is skipped rather than pushed content-less.
      params.log?.('debug', 'No media file for Flickr photo id', { id });

      return;
    }

    const item = mediaItemFromFile(mediaPath);
    item.metadata = item.metadata || {};
    item.metadata.Source = 'Flickr';

    const taken = parseFlickrDate(data.date_taken);
    const imported = parseFlickrDate(data.date_imported);
    if (taken) {
      item.timestamp = taken;
      item.metadata['Timestamp Source'] = 'date_taken';
    } else if (imported) {
      item.timestamp = imported;
      item.metadata['Timestamp Source'] = 'date_imported';
    } else {
      item.timestamp = fileTimestamp(mediaPath);
      item.metadata['Timestamp Source'] = 'File System';
    }

    if (!timeframeContains(params.timeframe, item.timestamp)) {
      return;
    }

    if (data.name) {
      item.metadata.Title = data.name;
    }

    if (data.description) {
      item.metadata.Description = data.description;
    }

    if (data.license) {
      item.metadata.License = data.license;
    }

    if (data.photopage) {
      item.metadata.URL = data.photopage;
    }

    const geo = parseFlickrGeo(data.geo);
    if (geo) {
      item.location = geo;
    }

    if (Array.isArray(data.tags) && data.tags.length) {
      const tags = data.tags.map((t) => t.tag).filter((t): t is string => !!t);
      if (tags.length) {
        item.metadata.Tags = tags;
      }
    }

    const graph: Graph = { item, edges: [] };

    // Album membership -> collection edges, same shape google_photos.ts uses
    // for a Takeout album folder: a bare collection item named by the title.
    for (const album of data.albums ?? []) {
      if (!album?.title) {
        continue;
      }

      graph.edges!.push({
        relation: 'in_collection',
        to: {
          item: {
            classification: 'collection',
            content: { filename: album.title, data: async () => Buffer.from(album.title!) },
            metadata: {},
          },
        },
      });
    }

    // People tagged in the photo -> person entity edges, keyed on Flickr's
    // own stable per-user id (nsid) the way google_photos.ts keys on Google's.
    for (const person of data.people ?? []) {
      if (!person?.nsid) {
        continue;
      }

      graph.edges!.push({
        relation: 'includes',
        to: {
          entity: {
            type: 'person',
            name: person.username || person.nsid,
            attributes: [{ name: 'flickr_nsid', value: person.nsid, identity: true }],
          },
        },
      });
    }

    item.metadata.RetrievalKey = `flickr::${id}`;
    params.pipeline.push(graph);
  }
}

registerDataSource({
  name: 'flickr',
  title: 'Flickr',
  icon: 'flickr.svg',
  description:
    "Flickr photo/video library from Flickr's self-serve data export (photo_<id>.json sidecars paired with their media).",
  newFileImporter: () => new FlickrFileImporter(),
});
