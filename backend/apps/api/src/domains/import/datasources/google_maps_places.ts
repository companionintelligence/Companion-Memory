/* Google Maps (your places) — Takeout "Maps (your places)" export:
 * Saved Places.json (starred/saved places) + Reviews.json (your reviews).
 * Both are GeoJSON FeatureCollections of Point features. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { asRecord, asString, type JsonRecord } from './json';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

interface Feature {
  type?: string;
  geometry?: { type?: string; coordinates?: unknown };
  properties?: JsonRecord;
}
interface FeatureCollection {
  type?: string;
  features?: Feature[];
}

const SAVED_FILE = 'saved places.json';
const REVIEWS_FILE = 'reviews.json';
const LABELED_FILE = 'labeled places.json';
const SUPPORTED_FILES = new Set([SAVED_FILE, REVIEWS_FILE, LABELED_FILE]);

async function findSupportedFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 6) {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findSupportedFiles(full, depth + 1)));
    } else if (entry.isFile() && SUPPORTED_FILES.has(entry.name.toLowerCase())) {
      found.push(full);
    }
  }

  return found.sort();
}

function parseDate(s: unknown): Date | undefined {
  if (!s || typeof s !== 'string') {
    return undefined;
  }

  const d = new Date(s);

  return isNaN(d.getTime()) ? undefined : d;
}

function coords(feat: Feature): { lat: number; lon: number } | undefined {
  const c = feat.geometry?.coordinates;
  if (!Array.isArray(c) || c.length < 2) {
    return undefined;
  }

  const lon = parseFloat(String(c[0]));
  const lat = parseFloat(String(c[1]));
  if (isNaN(lat) || isNaN(lon)) {
    return undefined;
  }

  // Google emits [0,0] as a placeholder when it has no coordinates for a saved
  // place — treat that as "no location" rather than the Gulf of Guinea.
  if (lat === 0 && lon === 0) {
    return undefined;
  }

  return { lat, lon };
}

// The stable place id Google embeds in the maps url: `?cid=<digits>`.
function cidFromUrl(url: unknown): string | undefined {
  if (!url || typeof url !== 'string') {
    return undefined;
  }

  const m = url.match(/[?&]cid=(\d+)/);

  return m ? m[1] : undefined;
}

// Saved places with no resolved location carry only a `?q=<address>` in the url
// (the location object is absent). Decode it so the title isn't a generic label.
function addressFromUrl(url: unknown): string | undefined {
  if (!url || typeof url !== 'string') {
    return undefined;
  }

  const m = url.match(/[?&]q=([^&]+)/);
  if (!m) {
    return undefined;
  }

  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() || undefined;
  } catch {
    return m[1].replace(/\+/g, ' ').trim() || undefined;
  }
}

function isFeatureCollection(o: unknown): o is FeatureCollection {
  const rec = asRecord(o);

  return !!rec && rec.type === 'FeatureCollection' && Array.isArray(rec.features);
}

export class GoogleMapsPlacesFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(root);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile()) {
      const base = path.basename(root).toLowerCase();

      return SUPPORTED_FILES.has(base) ? { confidence: 0.9 } : { confidence: 0 };
    }

    if (st.isDirectory()) {
      // Current Takeout nests Labeled places.json under "My labeled places";
      // older exports put Saved Places.json / Reviews.json at the root.
      const dirName = path.basename(root).toLowerCase();
      const found = await findSupportedFiles(root);
      if (found.length && dirName.includes('maps')) {
        return { confidence: 0.95 };
      }

      if (found.length) {
        return { confidence: 0.9 };
      }

      return { confidence: 0, dir_threshold: 0.8 };
    }

    return { confidence: 0 };
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

    if (st.isFile()) {
      await this.processFile(root, params);
    } else if (st.isDirectory()) {
      for (const file of await findSupportedFiles(root)) {
        await this.processFile(file, params);
      }
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath).toLowerCase();
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    if (!isFeatureCollection(doc)) {
      params.log?.('warn', 'not a FeatureCollection', { file: base });

      return;
    }

    for (const feat of doc.features as Feature[]) {
      if (!feat || typeof feat !== 'object') {
        continue;
      }

      if (base === REVIEWS_FILE) {
        this.pushReview(feat, params);
      } else {
        this.pushPlace(feat, params, base === LABELED_FILE);
      }
    }
  }

  private pushPlace(feat: Feature, params: ImportParams, labeled = false): void {
    const props = feat.properties || {};
    const ts = parseDate(props.date);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const loc = asRecord(props.location) ?? {};
    const name = (asString(loc.name) || asString(props.name) || '').trim();
    const url = props.google_maps_url;
    // Address is in the location object when Google resolved the place, else in
    // the url's `?q=` query for an unresolved saved pin.
    const address =
      (asString(loc.address) || asString(props.address) || '').trim() || addressFromUrl(url) || '';
    // Title precedence: place name → address → a generic label (never the
    // bare filename, which is the same for every feature).
    const title = name || address || 'Saved place';
    const c = coords(feat);
    // Stable id: the place cid from the maps url when present, else a hash of
    // what identifies the pin. Saved Places share the "Saved Places.json"
    // filename and many have the [0,0] placeholder coordinate + no
    // distinguishing timestamp, so without a per-record key they would collapse
    // in hashItem (persistence.ts).
    //
    // SRC-06: the fallback used to be the PARSE INDEX for a non-labeled place,
    // which is not an identity — `source_id` is the destination's unique key,
    // and Takeout reorders. Content-derived on both lanes now.
    const cid = cidFromUrl(url);
    const contentKey = crypto
      .createHash('sha1')
      .update([name, address, c?.lat ?? '', c?.lon ?? ''].join('\0'))
      .digest('hex');
    params.pipeline.push({
      item: {
        id: `gmaps:place:${cid || contentKey}`,
        classification: 'place',
        timestamp: ts,
        ...(c && { location: { latitude: c.lat, longitude: c.lon } }),
        content: {
          filename: 'saved-place.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(title),
        },
        metadata: {
          Title: title,
          Name: name || undefined,
          Address: address || undefined,
          URL: typeof url === 'string' ? url : undefined,
          Comment: typeof props.Comment === 'string' ? props.Comment : undefined,
          Kind: labeled ? 'labeled_place' : 'saved_place',
          Source: 'Google Maps',
        },
      },
    });
  }

  private pushReview(feat: Feature, params: ImportParams): void {
    const props = feat.properties || {};
    const ts = parseDate(props.date);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const loc = asRecord(props.location) ?? {};
    const name = (asString(loc.name) || '').trim();
    const address = (asString(loc.address) || '').trim();
    const url = props.google_maps_url;
    const rating = props.five_star_rating_published;
    const text = (asString(props.review_text_published) || '').trim();
    const title = name || address || 'Map review';
    const c = coords(feat);
    // SRC-06. Reviews carry no place cid in the url, so this key is hashed from
    // what the review IS. It used to be the parse index, which is a POSITION,
    // not an identity: `source_id` is the destination's unique key (all eight
    // destination indexes are `(user_id, source_system, source_id)`), and
    // Takeout writes reviews newest-first — one new review shifts every id by
    // one and each row silently overwrites its neighbour on the next import.
    //
    // Two reviews of the same place on the same day with the same rating and
    // the same words are one review as far as this key is concerned; that
    // collapse is deliberate (they are indistinguishable in the export) and,
    // unlike the index, it does not move when the file grows. `date` is the
    // RAW property, not the parsed Date, so the key does not shift if the
    // parser's date handling ever changes.
    const reviewKey = crypto
      .createHash('sha1')
      .update(
        [name, address, asString(props.date) ?? '', typeof rating === 'number' ? rating : '', text].join(
          '\0',
        ),
      )
      .digest('hex');
    params.pipeline.push({
      item: {
        id: `gmaps:review:${reviewKey}`,
        classification: 'annotation',
        timestamp: ts,
        ...(c && { location: { latitude: c.lat, longitude: c.lon } }),
        content: {
          filename: 'review.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(text || title),
        },
        metadata: {
          Title: title,
          Name: name || undefined,
          Address: address || undefined,
          Rating: typeof rating === 'number' ? rating : undefined,
          Text: text || undefined,
          URL: typeof url === 'string' ? url : undefined,
          Kind: 'place_review',
          Source: 'Google Maps',
        },
      },
    });
  }
}

registerDataSource({
  name: 'google_maps_places',
  title: 'Google Maps (your places)',
  icon: '',
  description: 'Saved places and reviews from a Google Takeout "Maps (your places)" export.',
  newFileImporter: () => new GoogleMapsPlacesFileImporter(),
});
