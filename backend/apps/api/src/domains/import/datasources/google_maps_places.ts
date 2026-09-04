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

/**
 * Field separator for the natural keys below. U+001F UNIT SEPARATOR, and NOT
 * the more obvious `\0`: Postgres TEXT cannot hold a NUL byte at all (`chr(0)`
 * raises), so a NUL-joined key is one a migration can never recompute — see
 * {@link contentKey}.
 */
const KEY_SEP = '\u001f';

/**
 * The natural key for a record this file emits: a sha256 over the fields that
 * say what the record IS, joined by {@link KEY_SEP}.
 *
 * ## Every input must be a field the destination row STORES
 *
 * `item.id` becomes `source_id`, which is the destination's unique key — every
 * destination index is `(user_id, source_system, source_id)`. Changing this
 * function MOVES the identity of rows that already exist, and because
 * `INGEST_REFRESH_COLUMNS` is `[]` for both `content` and `event`
 * (find-or-return, never DO UPDATE) the next import does not converge onto the
 * old row: it inserts a second one, permanently, because nothing will ever
 * emit the old id again to reconcile them. A key change therefore REQUIRES a
 * migration that re-keys what is already stored.
 *
 * That migration can only exist if the key is recomputable from the row, which
 * is a hard constraint on what may go into it:
 *
 *  - **sha256, not sha1.** `sha256()` is a core Postgres function; sha1 lives
 *    only in `digest()` from pgcrypto, which this schema does not install.
 *  - **Only persisted fields.** The review key briefly included the raw `date`
 *    property. Takeout writes review dates at MICROSECOND precision
 *    (`2025-01-26T23:47:37.122457Z`) and `new Date()` truncates to
 *    milliseconds, so the exact string survives nowhere: not in `ci.content`
 *    (which has no time column at all), not in `staged_items.occurred_at`, not
 *    in metadata. A key nobody can recompute can only ever be "migrated" by
 *    DELETING the rows that carry it.
 *  - **Coordinates at fixed precision.** `toFixed(7)` (~1cm, far finer than a
 *    map pin needs) renders identically to Postgres
 *    `to_char(round(x::numeric, 7), 'FM9990.0000000')`; the default float
 *    rendering is not guaranteed to.
 *
 * Both halves were checked against the live SQL before this was written — see
 * `..._repair_google_maps_places_positional_ids.sql`, which recomputes exactly
 * these keys from `ci.content.source_data` / `ci.events.metadata`.
 */
function contentKey(parts: readonly (string | number | undefined)[]): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => (p === undefined ? '' : String(p))).join(KEY_SEP))
    .digest('hex');
}

/** A coordinate as the key sees it: fixed 7dp, or '' when there is no fix. */
function keyCoord(v: number | undefined): string {
  return v === undefined ? '' : v.toFixed(7);
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
    //
    // The url is IN the key, and it is what keeps a degenerate pin distinct.
    // A saved place with no name, no address and the [0,0] placeholder would
    // otherwise hash to a constant and collapse with every other such pin —
    // the one way this key could lose data that the parse index did not. It
    // cannot: a saved place IS a `?q=<address>` or `?cid=` url (that is how
    // Google stores the pin), and the unresolved ones additionally carry an
    // `&ftid=<hex>` place id. Measured over the reference corpus — 26 saved +
    // 5 labeled — every pin has a url, every cid-less pin has a `?q=`, and no
    // two rows share a key. `Comment` deliberately stays OUT: on all 18
    // cid-less pins it is Google's own constant boilerplate ("No location
    // information is available for this saved place"), so it discriminates
    // nothing and would only re-key the row if Google reworded it.
    const cid = cidFromUrl(url);
    const key = contentKey([name, address, asString(url) ?? '', keyCoord(c?.lat), keyCoord(c?.lon)]);
    params.pipeline.push({
      item: {
        id: `gmaps:place:${cid || key}`,
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
    // The url identifies the PLACE (`…/data=!4m2!3m1!1s0x0:<hex>`) and is the
    // load-bearing input, not decoration: Google allows one review per place
    // per account, so the place is most of the review's identity, and on the
    // reference corpus three reviews carry no name and no address at all —
    // two of those also have no text, leaving the star rating as the only
    // other field. Without the url those two are one row.
    //
    // The raw `date` is deliberately NOT here, though it looks like the
    // obvious discriminator. Takeout writes it at microsecond precision and
    // nothing downstream keeps it (see contentKey), so including it makes the
    // key unmigratable — and the date is the field most likely to drift
    // between two exports of the same review anyway. Consequence, stated
    // plainly: an edited review whose text or rating changed is a new row, and
    // one re-published unchanged converges onto the old one. That is the right
    // way round.
    const reviewKey = contentKey([
      name,
      address,
      asString(url) ?? '',
      typeof rating === 'number' ? rating : '',
      text,
    ]);
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
