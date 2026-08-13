/**
 * **Location** as a device-native ETL source — the first one, and the shape the rest follow.
 *
 * The whole path is: OS geolocation → sampling gate → wire record → durable outbox →
 * `POST /v1/positions` → `POST /v1/ingest/finish`. This module owns the first three; the
 * outbox owns durability (`outbox.ts`) and the flush loop owns delivery
 * (`outboxFlush.ts`).
 *
 * ## Zero backend code
 *
 * `POST /v1/positions` already accepts exactly this record shape, already honors a
 * client-supplied capture time, and already dedupes on the provenance triple. Nothing was
 * added server-side for this source. Three properties of that endpoint are load-bearing
 * here and are easy to lose by "simplifying" onto the older `POST /api/position`:
 *
 * 1. **Body limit.** `BodyParserMiddleware` widens the JSON limit to 10mb only for paths
 *    under `/v1`; it is applied `forRoutes('*')` and runs *before* routing, so there is no
 *    per-route escape. `/api/position` gets the 100kb default — roughly 300-400 fixes per
 *    request. A day of backlog does not fit.
 * 2. **Dedupe.** `/v1/positions` runs `captureAndMaterialize`, whose raw log is idempotent
 *    on `(user_id, destination, source_type, source_system, source_id)`. `/api/position`
 *    bypasses the capture log entirely, leaving only `PositionService`'s
 *    `(user_id, time)` collapse. Since delivery through the outbox is deliberately
 *    **at-least-once**, a replay must be free rather than duplicative — hence
 *    {@link positionSourceId}, which is a pure function of the device and the fix instant.
 * 3. **Deferred indexing.** The bulk plane materializes with `emitCreated: false`: no
 *    per-row event fan-out, so nothing is enriched or search-indexed until the client
 *    calls `POST /v1/ingest/finish`. Both delivery paths below close that loop through
 *    `oweIngestFinish` / `settleIngestFinish`.
 *
 * ## Why `device_id` is omitted — a deliberate choice with a cost
 *
 * `createPositionSchemaRoot.device_id` is `z.string().uuid().optional()` and is meant to be
 * a real `ci.devices.device_id`. `PositionService` looks it up and, when it finds nothing,
 * only logs a warning — it does **not** reject the row. So sending a locally invented uuid
 * would "work", and would be wrong: it writes a dangling foreign key that looks like a
 * registered device and never resolves to one.
 *
 * This slice therefore **omits `device_id`** and carries device identity on the provenance
 * triple instead (`source_id` is prefixed with a stable per-install key). **The cost:
 * fixes are not attributable to a device row**, so "which of my phones recorded this"
 * cannot be answered by a join — only by parsing `source_id`. That is the right trade
 * until the appliance has a device-registration flow; when it does, populate `device_id`
 * and keep the triple as-is, and history stays intact.
 *
 * ## Foreground only
 *
 * Nothing here asks for background location. Per `DEVICE_DATA_COMPLIANCE.md` §3.4 that
 * would pull in Play's background-location declaration plus a video review, and a
 * "passive life timeline" framing reads to a reviewer as untargeted tracking. The capture
 * runs while the app is in the foreground; the outbox is what makes a fix taken with no
 * connectivity survive until there is one.
 */

import { fetchJson } from '../fetchJson';
import { enqueueOutboxItem } from '../outbox';
import {
  POSITION_OUTBOX_KIND,
  finishStagesFor,
  outboxEndpointFor,
  oweIngestFinish,
  settleIngestFinish,
} from '../outboxFlush';

/** `ci.position.source` vocabulary — the REQUIRED enum on the wire record. */
export type LocationSourceKind = 'gps' | 'wifi' | 'cell_tower' | 'manual' | 'inferred' | 'other';

/**
 * Don't record a new fix unless we moved this far...
 *
 * This gate is the difference between ~300 fixes a day and ~86,000. `watchPosition` fires
 * on every sensor update; without it the queue, the request volume and the hypertable all
 * grow by two orders of magnitude for no extra information.
 */
export const MIN_DISTANCE_METERS = 50;

/** ...or this much time passed since the last recorded fix. */
export const MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Mean Earth radius (metres) — the standard spherical approximation. */
const EARTH_RADIUS_METERS = 6371000;

/** localStorage key holding the stable per-install id that prefixes every `source_id`. */
const DEVICE_KEY_STORAGE_KEY = 'ci.deviceSources.deviceKey';

/** A single position fix, normalized away from any one platform's geolocation API. */
export interface DeviceLocationFix {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy. Must be > 0 to survive; anything else is dropped, not sent. */
  accuracyMeters?: number | null;
  altitudeMeters?: number | null;
  /** Degrees clockwise from true north. Outside 0-360 is dropped rather than clamped. */
  headingDegrees?: number | null;
  speedMetersPerSecond?: number | null;
  /** Epoch milliseconds of the **capture** instant — never the upload instant. */
  capturedAtMs: number;
}

/**
 * The wire record, matching `createPositionSchemaRoot` exactly.
 *
 * `location.x` is **longitude** and `location.y` is **latitude**. `PositionService` does
 * `coordinates: [x, y]` into `GEOGRAPHY(POINT, 4326)`, which is GeoJSON order — lon first.
 * Inverting them is silent: the row inserts fine and lands in the wrong hemisphere.
 */
export interface PositionRecord {
  time: string;
  location: { x: number; y: number };
  accuracy_meters?: number;
  altitude_meters?: number;
  heading_degrees?: number;
  speed_meters_per_second?: number;
  source: LocationSourceKind;
  provider: string;
  source_type: string;
  source_system: string;
  source_id: string;
}

export interface PositionRecordOptions {
  /** Stable per-install id; prefixes `source_id`. See {@link deviceSourceKey}. */
  deviceKey: string;
  /** Free-text producer, stored verbatim on the row. */
  provider?: string;
  source?: LocationSourceKind;
  sourceType?: string;
  sourceSystem?: string;
}

const DEFAULT_PROVIDER = 'browser';
const DEFAULT_SOURCE: LocationSourceKind = 'gps';
const DEFAULT_SOURCE_TYPE = 'device';
const DEFAULT_SOURCE_SYSTEM = 'companion-device';

/** Great-circle distance in metres. Used only for the movement gate, so spherical is ample. */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * The idempotency handle for a fix: `<deviceKey>:<epochMillis>`.
 *
 * Deterministic on purpose. Delivery is at-least-once — the outbox replays a row whose
 * `/attempt` report was lost — and this is what makes the replay collapse in the appliance's
 * capture log instead of writing a second fix. It is also the outbox's own
 * `idempotencyKey`, so a retried *enqueue* cannot queue the same fix twice either.
 */
export function positionSourceId(deviceKey: string, capturedAtMs: number): string {
  return `${deviceKey}:${Math.trunc(capturedAtMs)}`;
}

let cachedDeviceKey: string | null = null;

/** Random opaque id. Not a hardware identifier — nothing here fingerprints the device. */
function newDeviceKey(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;

  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }

  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The stable per-install device key, minted on first use and persisted to localStorage.
 *
 * Cached in module scope so that a storage failure (private mode) still yields ONE key for
 * the session rather than a fresh one per fix — a rotating key would silently break the
 * replay dedupe that {@link positionSourceId} exists to provide.
 */
export function deviceSourceKey(): string {
  if (cachedDeviceKey) {
    return cachedDeviceKey;
  }

  try {
    const stored = window.localStorage.getItem(DEVICE_KEY_STORAGE_KEY);

    if (stored) {
      cachedDeviceKey = stored;

      return stored;
    }
  } catch {
    // Storage unavailable — fall through and keep a session-only key.
  }

  const fresh = newDeviceKey();

  cachedDeviceKey = fresh;

  try {
    window.localStorage.setItem(DEVICE_KEY_STORAGE_KEY, fresh);
  } catch {
    // Session-only; documented above.
  }

  return fresh;
}

/** A finite number, or undefined — so an optional field is omitted rather than sent as junk. */
function finite(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Build the wire record, or `null` when the fix is not worth sending.
 *
 * Optional fields are **omitted** rather than coerced. Two of them would otherwise be
 * dropped or rejected downstream anyway, and sending a value the server discards makes the
 * client look like it recorded something it did not:
 * - `accuracy_meters` is `z.number().positive()` **and** carries a DB CHECK constraint, so
 *   a 0 or negative accuracy would 400 the entire batch — one bad fix losing 9,999 good ones.
 * - `heading_degrees` outside 0-360 is silently discarded by `PositionService.normalizeHeading`.
 */
export function buildPositionRecord(
  fix: DeviceLocationFix,
  options: PositionRecordOptions,
): PositionRecord | null {
  const latitude = finite(fix.latitude);
  const longitude = finite(fix.longitude);
  const capturedAtMs = finite(fix.capturedAtMs);

  if (latitude === undefined || longitude === undefined || capturedAtMs === undefined) {
    return null;
  }

  // A fix outside the valid range is a bug (commonly lat/lon transposed at the call site),
  // not data. Refuse it here rather than writing a point in the wrong hemisphere.
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return null;
  }

  const accuracy = finite(fix.accuracyMeters);
  const altitude = finite(fix.altitudeMeters);
  const heading = finite(fix.headingDegrees);
  const speed = finite(fix.speedMetersPerSecond);

  return {
    time: new Date(capturedAtMs).toISOString(),
    // x = longitude, y = latitude. See the PositionRecord docblock.
    location: { x: longitude, y: latitude },
    ...(accuracy !== undefined && accuracy > 0 ? { accuracy_meters: accuracy } : {}),
    ...(altitude !== undefined ? { altitude_meters: altitude } : {}),
    ...(heading !== undefined && heading >= 0 && heading <= 360 ? { heading_degrees: heading } : {}),
    ...(speed !== undefined && speed >= 0 ? { speed_meters_per_second: speed } : {}),
    source: options.source ?? DEFAULT_SOURCE,
    provider: options.provider ?? DEFAULT_PROVIDER,
    source_type: options.sourceType ?? DEFAULT_SOURCE_TYPE,
    source_system: options.sourceSystem ?? DEFAULT_SOURCE_SYSTEM,
    source_id: positionSourceId(options.deviceKey, capturedAtMs),
  };
}

/** The last fix this sampler accepted — the state the movement/interval gate compares against. */
export interface LocationSample {
  latitude: number;
  longitude: number;
  at: number;
}

export interface LocationSampler {
  /** Whether `fix` clears the distance-or-interval gate. Pure; does not mutate. */
  shouldCapture(fix: Pick<DeviceLocationFix, 'latitude' | 'longitude' | 'capturedAtMs'>): boolean;
  /** Advance the gate. Call only once a fix has actually been recorded somewhere durable. */
  accept(fix: Pick<DeviceLocationFix, 'latitude' | 'longitude' | 'capturedAtMs'>): void;
  /** Forget the last fix, so the next one always passes. */
  reset(): void;
  readonly last: LocationSample | null;
}

/**
 * The sampling gate: record a fix when we have **moved far enough OR waited long enough**.
 *
 * `accept()` is deliberately separate from `shouldCapture()` so the gate only advances once
 * a fix is durably recorded. Advancing on a *failed* capture would drop that fix and start
 * the 5-minute clock again, which is the one outcome this whole feature exists to avoid.
 */
export function createLocationSampler(
  options: { minDistanceMeters?: number; minIntervalMs?: number } = {},
): LocationSampler {
  const minDistance = options.minDistanceMeters ?? MIN_DISTANCE_METERS;
  const minInterval = options.minIntervalMs ?? MIN_INTERVAL_MS;
  let last: LocationSample | null = null;

  return {
    shouldCapture(fix) {
      if (!last) {
        return true;
      }

      const moved = haversineMeters(last.latitude, last.longitude, fix.latitude, fix.longitude);

      return moved >= minDistance || fix.capturedAtMs - last.at >= minInterval;
    },
    accept(fix) {
      last = { latitude: fix.latitude, longitude: fix.longitude, at: fix.capturedAtMs };
    },
    reset() {
      last = null;
    },
    get last() {
      return last;
    },
  };
}

/**
 * What happened to a fix. Every terminal state is named: a caller can always tell "durably
 * recorded" from "sent" from "lost", which the fire-and-forget predecessor could not.
 */
export type LocationCaptureOutcome =
  /** Committed to the sidecar's on-disk queue. Survives force-quit and reboot. */
  | { status: 'queued'; record: PositionRecord; id: string }
  /** No sidecar on this platform (web): POSTed straight to the appliance instead. */
  | { status: 'sent'; record: PositionRecord }
  /** Suppressed by the distance/interval gate. Not an error. */
  | { status: 'throttled' }
  /** Not a usable fix (non-finite or out-of-range coordinates). Nothing was recorded. */
  | { status: 'skipped'; reason: string }
  /** The appliance refused the record and will refuse it again. Nothing was recorded. */
  | { status: 'rejected'; record: PositionRecord; message: string }
  /** Transient failure. Nothing was recorded, and the gate has NOT advanced. */
  | { status: 'failed'; record: PositionRecord; message: string };

export interface CaptureLocationOptions extends Partial<PositionRecordOptions> {
  /** Gate to consult and advance. Omit to capture unconditionally (e.g. a manual "record now"). */
  sampler?: LocationSampler;
  /** Web session bearer for the no-sidecar path. Native auth rides on `x-api-key` already. */
  authToken?: string | null;
}

// Bounded so a hung appliance cannot wedge the geolocation callback. The queue path has
// its own (much tighter) bound inside outbox.ts.
const DIRECT_POST_TIMEOUT_MS = 15_000;

/**
 * Record one fix.
 *
 * Native: enqueued to the Local Hub sidecar, which commits it to SQLite **before this
 * resolves** — so a fix taken with no connectivity is durable, and the flush loop delivers
 * it later. Web: there is no sidecar and no honest local substitute for durability, so the
 * record is POSTed directly and the caller is told which of the two happened.
 */
export async function captureLocationFix(
  fix: DeviceLocationFix,
  options: CaptureLocationOptions = {},
): Promise<LocationCaptureOutcome> {
  const { sampler, authToken, deviceKey, ...recordOptions } = options;

  if (sampler && !sampler.shouldCapture(fix)) {
    return { status: 'throttled' };
  }

  const record = buildPositionRecord(fix, { ...recordOptions, deviceKey: deviceKey ?? deviceSourceKey() });

  if (!record) {
    return { status: 'skipped', reason: 'Fix has non-finite or out-of-range coordinates.' };
  }

  const queued = await enqueueOutboxItem({
    kind: POSITION_OUTBOX_KIND,
    // Posted onward verbatim, so the payload IS the endpoint's envelope.
    payload: { records: [record] },
    capturedAt: record.time,
    // Same deterministic handle the appliance dedupes on: a retried enqueue is a no-op.
    idempotencyKey: record.source_id,
  });

  if (queued.ok) {
    sampler?.accept(fix);

    return { status: 'queued', record, id: queued.value.id };
  }

  // `full` and `error` are real failures — the sidecar exists and refused. Writing through
  // to the network behind its back would defeat the queue's ordering and its capacity
  // signal. Only `unavailable` ("there is no sidecar on this platform") falls through.
  if (queued.reason !== 'unavailable') {
    return { status: 'failed', record, message: queued.message };
  }

  return postDirect(record, authToken, () => sampler?.accept(fix));
}

/** The web path: straight to the appliance, then close the deferred-indexing loop. */
async function postDirect(
  record: PositionRecord,
  authToken: string | null | undefined,
  accept: () => void,
): Promise<LocationCaptureOutcome> {
  const path = outboxEndpointFor(POSITION_OUTBOX_KIND);

  if (!path) {
    return { status: 'failed', record, message: `No endpoint registered for "${POSITION_OUTBOX_KIND}".` };
  }

  try {
    await fetchJson(path, {
      method: 'POST',
      timeout: DIRECT_POST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ records: [record] }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status;
    // A 4xx (bar the repairable ones the flusher also exempts) means this record is wrong
    // and always will be. Advance the gate so a permanently-bad fix cannot pin the sampler
    // and suppress every later, good one.
    const permanent =
      typeof status === 'number' &&
      status >= 400 &&
      status < 500 &&
      ![401, 403, 408, 425, 429].includes(status);

    if (permanent) {
      accept();

      return { status: 'rejected', record, message };
    }

    return { status: 'failed', record, message };
  }

  accept();

  // /v1 materializes with emitCreated:false — without this the row is written but never
  // reverse-geocoded and never feeds location estimates. Debounced inside settle.
  oweIngestFinish(finishStagesFor(POSITION_OUTBOX_KIND));
  void settleIngestFinish();

  return { status: 'sent', record };
}

/**
 * Adapt the browser/Capacitor Geolocation payload to {@link DeviceLocationFix}.
 *
 * `position.timestamp` is the instant the OS produced the fix, which is what `time` must
 * carry — a fix that sat in the queue overnight still belongs to last night on the timeline.
 */
export function fixFromGeolocationPosition(position: GeolocationPosition): DeviceLocationFix {
  const { latitude, longitude, accuracy, altitude, heading, speed } = position.coords;

  return {
    latitude,
    longitude,
    accuracyMeters: accuracy,
    altitudeMeters: altitude,
    headingDegrees: heading,
    speedMetersPerSecond: speed,
    capturedAtMs: position.timestamp || Date.now(),
  };
}
