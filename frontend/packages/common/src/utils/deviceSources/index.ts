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
 * The appliance side of every source already exists: `/v1/{events,communications,contents,
 * inventory,browser-activity,positions}`. A new source is a client-side record mapping and
 * a routing-table entry in `outboxFlush.ts`, not a backend change.
 */

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
