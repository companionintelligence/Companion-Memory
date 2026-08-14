/**
 * **Device-native ETL sources** — the phone (or browser) as a data source for the user's
 * own appliance.
 *
 * Every source in here follows the same three-step shape, and `location.ts` is the
 * reference implementation:
 *
 *   1. **Sample.** Read the OS API and apply a gate that keeps the volume honest — a raw
 *      sensor feed is thousands of times larger than the signal in it.
 *   2. **Shape.** Build the exact record an existing `/v1` bulk-ingest endpoint accepts,
 *      with a **deterministic** `source_id` so a replay dedupes instead of duplicating.
 *   3. **Enqueue.** Hand it to the durable outbox, which commits to disk before resolving,
 *      so a capture taken offline is not a capture lost.
 *
 * The appliance side of MOST sources already exists: `/v1/{events,communications,contents,
 * inventory,browser-activity,positions}`, so a new source is usually a client-side record
 * mapping and a routing-table entry in `outboxFlush.ts`, and nothing else.
 *
 * `note.ts` is the exception, and it is worth knowing why before assuming the pattern
 * holds. Notes had no REST ingest route at all — only the GraphQL `createNote` mutation
 * and `/v1/contents`, which materializes a *content*, not a note. Routing a note to
 * `/v1/contents` would have inverted a decision the platform had already made: the
 * `fold_notes` maintenance leg (#1945) mirrors `ci.notes` INTO same-id Content entities,
 * so notes are the source and content is the derived copy. A note arriving as a content
 * would produce a row that no notes list shows and no fold can ever mirror. `POST /v1/notes`
 * was added instead. Step 2's "shape it for an existing endpoint" is a strong default, not
 * a rule — when no endpoint means the same thing the source means, the endpoint is missing.
 */

export {
  buildNoteRecord,
  captureNote,
  forgetQueuedNote,
  isQueuedNote,
  newNoteId,
  rememberQueuedNote,
} from './note';
export type { NoteCaptureOutcome, NoteRecord } from './note';
export {
  MIN_DISTANCE_METERS,
  MIN_INTERVAL_MS,
  buildPositionRecord,
  captureLocationFix,
  createLocationSampler,
  deviceSourceKey,
  fixFromGeolocationPosition,
  haversineMeters,
  positionSourceId,
} from './location';
export type {
  CaptureLocationOptions,
  DeviceLocationFix,
  LocationCaptureOutcome,
  LocationSample,
  LocationSampler,
  LocationSourceKind,
  PositionRecord,
  PositionRecordOptions,
} from './location';
