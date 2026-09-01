/* Timeline core models (TypeScript minimal port) */
import fs from 'node:fs';
import path from 'node:path';

import { lookup } from 'mime-types';

/**
 * One media file riding on a message (a tweet's photo/video, a DM attachment).
 *
 * Unlike a media *item* — which owns its own row and pushes as its own record —
 * an attachment belongs to the communication that carried it. The push uploads
 * `path` as a file, creates a content row of `type` pointed at `url` (the
 * media's address on the source service, not the uploaded copy's), and stamps
 * both ids into the communication's `attachments` column. See
 * ci-server/graphql.ts withCommunicationMedia.
 */
export interface AttachmentDescriptor {
  /**
   * Local path to the bytes to upload — ABSENT when the export names an
   * attachment whose bytes it does not ship (an iMessage attachment purged from
   * the Mac, a chat.db row whose file was never backed up). The descriptor is
   * still recorded: `guid`/`filename`/`mimetype` say WHAT was attached, which is
   * the difference between a message that reads as empty and one that reads as
   * "a photo was here". The upload lane skips path-less entries — see
   * push/canonical.ts communicationMediaAttachments.
   */
  path?: string;
  /** Original filename, for the content row's title. */
  filename?: string;
  /**
   * Content row type bucket ('file' for non-media attachments, e.g. a PDF).
   *
   * 'receipt_document' is the one non-MIME value: it is stamped when the PARENT
   * was classified a receipt (see datasources/receipt_detect.ts), so a PDF
   * invoice attached to an order confirmation is catalogued as the receipt
   * document it is instead of an anonymous 'file'.
   */
  type: 'image' | 'video' | 'audio' | 'media' | 'file' | 'receipt_document';
  mimetype?: string;
  /** The media's URL on the source service, when the export records one. */
  url?: string;
  /**
   * The source's own stable id for this attachment (iMessage `attachment.guid`).
   * The only durable handle on an attachment whose bytes are missing.
   */
  guid?: string;
}

/** An {@link AttachmentDescriptor} whose bytes resolved to a local file. */
export type MediaAttachment = AttachmentDescriptor & { path: string };

/**
 * A structured metadata entry: a flat record of primitives. Used by accumulating
 * keys whose fields only mean something together — an Uber Eats dish records one
 * `{ date, restaurant, price }` per order, because what it cost is a fact about
 * a place and a night, not about the dish alone.
 */
export type MetadataRecord = Record<string, string | number | boolean | null | undefined>;

/**
 * One object identifier as a datasource states it — a book's ISBN, a product's
 * ASIN, a device's serial. Normalized (and possibly re-namespaced: an all-digit
 * ASIN is an ISBN) by `push/canonical.ts` when the canonical record is built,
 * against the SHARED rule in `@ci/domains/graph` `normalizeObjectIdentifier`.
 */
export interface ObjectIdentifierRef {
  namespace: string;
  value: string;
  /** 0..1, when the source is guessing (OCR off a receipt) rather than stating. */
  confidence?: number;
}

/**
 * One line of a receipt as a datasource states it: the same primitive metadata
 * a {@link MetadataRecord} holds, plus the line's own identifiers. Rides in
 * `metadata.LineItems`; see `push/inputs.ts` toReceiptLineItemInputs.
 */
export type LineItemRecord = Record<
  string,
  string | number | boolean | null | undefined | ObjectIdentifierRef[]
>;

export type MetadataValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | number[]
  | string[]
  | MetadataRecord[]
  | AttachmentDescriptor[]
  | ObjectIdentifierRef[]
  | LineItemRecord[];
export type Metadata = Record<string, MetadataValue>;

export interface Location {
  latitude?: number | null;
  longitude?: number | null;
}

export interface ItemData {
  /** Absent for pure-event items (e.g. money movements) that carry no document/media. */
  filename?: string;
  mediaType?: string;
  data?: () => Promise<Buffer>; // lazy loader
}

export interface EntityAttribute {
  name: string;
  value?: string | number | boolean | null;
  identity?: boolean;
}
export interface Entity {
  id?: string | number;
  type?: string;
  name?: string;
  metadata?: Metadata;
  attributes?: EntityAttribute[];
  /**
   * Metadata keys that ACCUMULATE across sightings instead of being frozen at
   * the first one.
   *
   * An entity upserts on identity, so the second time a source describes the
   * same thing the existing row normally wins and the new description is
   * dropped — right for a display name, wrong for a fact that legitimately
   * differs per sighting. The price of an Uber Eats burger is the motivating
   * case: $10.19 in January and $15.92 in March are both true, and the useful
   * record is the set of them, not whichever arrived first.
   *
   * Values for a listed key are stored as a list of DISTINCT values in
   * first-seen order (see persistence.ts mergeAccumulatedMetadata). Sources
   * should emit these keys as arrays so the shape is the same on the first
   * write as on the tenth, and should name them plurally to match.
   *
   * Unlisted keys keep the existing first-write-wins behavior.
   */
  accumulate?: string[];
}

export interface Item {
  id?: string;
  /**
   * The source this record actually came from, when that differs from the
   * importer running the job. Set only where one importer delegates to another:
   * the Fitbit source also reads the Google Fit half of the same Takeout "Fit"
   * export, and those records are Google Fit's — they must be attributed (and
   * deduped) as `google_fit`, not as `fitbit`. Unset everywhere else, where the
   * job's own data source is already the right answer.
   */
  dataSource?: string;
  classification?: string;
  timestamp?: Date;
  timespanEnd?: Date;
  location?: Location;
  originalLocation?: string;
  intermediateLocation?: string;
  owner?: Entity;
  /** Absent for pure timeline records (e.g. transactions) that carry no file. */
  content?: ItemData;
  metadata?: Metadata;
}

export interface Relationship {
  relation: string;
  to: Graph;
  metadata?: Metadata;
}
export interface Graph {
  item?: Item;
  entity?: Entity;
  edges?: Relationship[];
}

/** The few extensions we don't take mime-db's word on. Everything else comes from
 *  mime-db via mime-types — ~1000 extensions maintained upstream, so a hand-kept
 *  table can't drift out of date.
 *
 *  The bar for overriding is deliberately high: mime-db's answer is the standard
 *  one, and the standard answer is right for the population of files even when
 *  it's wrong for a particular file. `.key` on this developer's drive is a
 *  KeePass keyfile, but Apple Keynote is the commoner meaning, so .key stays
 *  Keynote — same for .pem as an x509 cert and .pub as an MS Publisher document.
 *
 *  What clears the bar is the type steering kind derivation (an image/ video/
 *  audio/ type routes an item to capture.photo / .video / .audio via mapping.ts
 *  kindFor) or mime-db having no answer at all. Unknown extensions still return
 *  undefined — extension-less files (a real export's KeePassKey, KeePass_Ografy)
 *  can't be typed by name, and no type beats a wrong one. */
const MIME_OVERRIDES: Record<string, string> = {
  // mime-db: video/mp2t. A .ts on a personal drive is source code far more often
  // than an MPEG transport stream, and guessing video re-routes the item to
  // capture.video.
  '.ts': 'text/plain',
  // AVCHD camcorder clips — what a Sony/Panasonic/Canon card actually holds. Both
  // extensions are claimed by two IANA-registered types: video/mp2t and
  // model/vnd.mts, a 3D-model format. Which one the lookup returns is a mime-db
  // tie-break between two equally-sourced entries rather than a fact about the
  // file, and it has moved: older tables answer model/vnd.mts for .mts and have
  // no entry at all for .m2ts. Neither answer is a media type, so a real camera
  // export's video gets classification 'file' and routes to import.archive_item
  // instead of capture.video. Pin it so the tie-break can't decide that.
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  // Not in mime-db at all, and common enough to be worth carrying.
  '.py': 'text/x-python',
  '.tgz': 'application/gzip',
  '.gpg': 'application/pgp-encrypted',
  // RAW camera formats: absent from mime-db, so any importer with no local
  // override table (e.g. google_photos.ts) misclassified these as 'file'
  // instead of 'media', losing capture-kind routing apple_photos.ts's own
  // local table already gave the same extensions.
  '.dng': 'image/x-adobe-dng',
  '.cr2': 'image/x-canon-cr2',
  '.cr3': 'image/x-canon-cr3',
  '.nef': 'image/x-nikon-nef',
  '.arw': 'image/x-sony-arw',
};

/** Infer a MIME type from a filename's extension, or undefined if unknown. */
export function mimeForFile(filename: string): string | undefined {
  const ext = path.extname(filename).toLowerCase();
  if (!ext) {
    return undefined;
  }

  return MIME_OVERRIDES[ext] ?? (lookup(ext) || undefined);
}

/** Photo/video/audio — the MIME classes that make a file *media*. */
export function isMediaMime(mediaType: string | undefined | null): boolean {
  return !!mediaType && /^(image|video|audio)\//.test(mediaType);
}

/**
 * One item per file on disk, classified by what the file actually IS.
 *
 * `classification` used to be a flat 'media' for every file a directory walk
 * saw, which is only true of a photo library. Walking a real drive export
 * (OneDrive, Dropbox, a NAS folder) hands back tax PDFs, PowerShell profiles and
 * a KeePass database alongside the photos, and calling those 'media' had
 * consequences beyond the label: mapping.kindFor reads classification 'media' as
 * "some media file, let the MIME pick photo/video/audio", and a MIME that is
 * none of the three falls to its default — so every PDF reached CI-Server as a
 * capture.photo. 'file' is the honest classification, and it routes (via
 * kindFor) to import.archive_item, the same kind a non-media mail attachment
 * already gets.
 */
export function mediaItemFromFile(fpath: string): Item & { content: ItemData } {
  const filename = path.basename(fpath);
  const mediaType = mimeForFile(filename);

  return {
    classification: isMediaMime(mediaType) ? 'media' : 'file',
    intermediateLocation: fpath,
    content: {
      filename,
      mediaType,
      data: async () => fs.promises.readFile(fpath),
    },
    metadata: {},
  };
}

/**
 * Best-effort creation/modification time for a file, as a fallback when no
 * embedded date (EXIF, sidecar) is available.
 *
 * `stats.birthtime` is ALWAYS a Date, so a naive `birthtime || mtime` never
 * falls back: on filesystems that don't record a creation time — Docker's
 * overlay2, many Linux/ext4 setups, network mounts — Node returns birthtime as
 * `new Date(0)` (1970-01-01), which is truthy, so every file gets stamped at
 * the Unix epoch. Guard on `birthtimeMs > 0` and only then trust birthtime;
 * otherwise use mtime.
 */
export function fileTimestamp(fpath: string): Date {
  const stats = fs.statSync(fpath);

  return stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime;
}

export interface ImportPipeline {
  push: (g: Graph) => void;
  /**
   * Report a record the importer is dropping on the floor, with a short stable
   * `reason` slug (e.g. 'unsupported_variant', 'empty_after_parse',
   * 'reaction_only'). The job aggregates these into a per-import "drop ledger"
   * so silent data loss becomes a visible number instead of a mystery. Optional
   * so existing importers keep working unchanged; calling it is purely additive.
   */
  drop?: (reason: string, detail?: string) => void;
  /**
   * Report a record the importer KEPT that some gate would otherwise have
   * dropped, with a short stable `reason` slug (e.g. `receipt_kept_from_bulk`).
   * The writer aggregates these into a per-source KEEP ledger, separate from the
   * drop ledger, so a rescue is countable without being filed as a loss.
   *
   * Why not `drop()`: the drop ledger is DEFINED as "records that did not become
   * a staged row" — `parseUnit` folds it into the stage summary and the run UI
   * renders it as the loss report. Counting a kept record there inflates the
   * loss figure with its own opposite, which is exactly what the first attempt
   * at receipt discovery did. Optional, like `drop`.
   */
  keep?: (reason: string) => void;
  /**
   * Report N records this file/pass actually offered the parser — the floor
   * `reconciled` checks against — independent of how many became rows or
   * drops. Optional: a parser that never calls this keeps today's derived
   * floor (`consumed = produced + dropped`), which is definitionally always
   * reconciled and can never catch a record vanishing through a branch that
   * forgot `drop()`. Cheap for the common array/CSV-shaped parser (one call
   * per file with the array's own `.length`, not a per-row counter); only a
   * genuinely streaming/line-based parser needs a real per-iteration
   * increment.
   */
  consumed?: (n: number) => void;
}
export interface ImportParams {
  options?: unknown;
  timeframe?: Timeframe;
  pipeline: ImportPipeline;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Durable media store directory (server.ts MEDIA_STORE_DIR). Datasources that
   * extract binary attachments during ingest (e.g. MMS media) write them here
   * rather than a temp dir, so the CI-Server push can upload them AND the runner
   * can purge the local copy once the bytes are durably in Memory — the push's
   * purge-eligibility check (media.ts isPurgeCandidate) keys off this same dir.
   * Unset where there is no store (unit tests, ad-hoc CLI runs); datasources then
   * fall back to the OS temp dir.
   */
  mediaStoreDir?: string;
  /**
   * Subtrees a specialised recognizer already claimed inside this same run,
   * absolute paths. Threaded through from the surviving `generic` match's
   * `DataSourceRecognition.excludePaths` (see `registry.ts` and
   * `ParseStage.dropGenericWhenSpecialised`) so `generic`'s own walker can skip
   * them rather than re-stage what another importer already read.
   *
   * Every OTHER importer ignores this field — it only means something to a
   * directory walk with no other notion of "already consumed," which today is
   * `generic` alone. Unset for a run with no specialised claims to skip, and
   * always unset for every non-generic importer's call.
   */
  excludePaths?: readonly string[];
}

export interface Timeframe {
  since?: Date;
  until?: Date;
}
export function timeframeIsEmpty(tf?: Timeframe): boolean {
  return !tf || (!tf.since && !tf.until);
}

export function timeframeContains(tf: Timeframe | undefined, ts: Date | undefined): boolean {
  if (!tf || !ts) {
    return true;
  }

  if (ts.getTime() === 0) {
    return true;
  }

  if (tf.since && ts < tf.since) {
    return false;
  }

  if (tf.until && ts > tf.until) {
    return false;
  }

  return true;
}
