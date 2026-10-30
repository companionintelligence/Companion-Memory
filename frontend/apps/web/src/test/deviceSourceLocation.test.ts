import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import {
  MIN_DISTANCE_METERS,
  MIN_INTERVAL_MS,
  buildPositionRecord,
  captureLocationFix,
  createLocationSampler,
  fixFromNativeLocationEvent,
  fixFromGeolocationPosition,
  type NativeLocationEvent,
  haversineMeters,
  positionSourceId,
  type DeviceLocationFix,
} from '@ci/common/src/utils/deviceSources/location';
import {
  LOCATION_ENABLED_STORAGE_KEY,
  LOCATION_MODE_STORAGE_KEY,
  isLocationTrackingEnabled,
  readLocationTrackingMode,
  writeLocationTrackingMode,
} from '@ci/common/src/utils/deviceSources/locationMode';
import type { OutboxItem } from '@ci/common/src/utils/outbox';
import {
  INGEST_FINISH_PATH,
  POSITION_OUTBOX_KIND,
  finishStagesFor,
  flushOutbox,
  outboxEndpointFor,
  resetIngestFinishState,
} from '@ci/common/src/utils/outboxFlush';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GlobalWithWindow = { window?: unknown };

const HUB_BASE = 'http://127.0.0.1:4100';
const HUB_TOKEN = 'tok-abc';
const DEVICE_KEY = 'device-key-1';

/**
 * San Francisco. Chosen because latitude and longitude differ in BOTH magnitude and
 * sign — transposing them produces a value no assertion here can accidentally accept.
 */
const SF_LAT = 37.7749;
const SF_LNG = -122.4194;

/** Epoch ms of 2026-08-13T10:00:00.000Z — the *capture* instant in every test below. */
const CAPTURED_AT = Date.UTC(2026, 7, 13, 10, 0, 0);

function setWindow(value: unknown): void {
  (globalThis as GlobalWithWindow).window = value;
}

function urlOf(input: RequestInfo): string {
  return typeof input === 'string' ? input : (input as Request).url;
}

/** Native shell with the LocalHub sidecar present, signed in (the outbox queues only under an account). */
function setNativeWindow(): void {
  setApiKey('device-key');
  setWindow({
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: {
        LocalHub: {
          start: vi.fn(async () => ({ baseUrl: HUB_BASE, token: HUB_TOKEN })),
          stop: vi.fn(),
          getStatus: vi.fn(),
        },
      },
    },
  });
}

function jsonResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

interface RecordedCall {
  url: string;
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

type Handler = (call: RecordedCall) => Response;

function installFetch(handler: Handler): RecordedCall[] {
  const calls: RecordedCall[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = urlOf(input);

      const call: RecordedCall = {
        url,
        path: url.startsWith(HUB_BASE) ? url.slice(HUB_BASE.length) : url,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };

      calls.push(call);

      return handler(call);
    }),
  );

  return calls;
}

/**
 * Minimum viable stand-in for the sidecar's SQLite queue: enqueue (idempotent on
 * `idempotencyKey`), list by `seq`, read one with its payload, and report an attempt.
 * Deliberately local to this file rather than shared with `outbox.test.ts` — that file
 * asserts the queue contract, this one asserts the location source's use of it.
 */
function fakeSidecar() {
  const store = new Map<string, OutboxItem>();
  const byKey = new Map<string, string>();
  let nextSeq = 1;

  const handler: Handler = (call) => {
    const [rawPath, query] = call.path.split('?');
    const segments = rawPath.split('/').filter(Boolean); // ['api','outbox', id?, verb?]
    const id = segments[2];
    const verb = segments[3];

    if (call.method === 'GET' && !id) {
      const status = new URLSearchParams(query ?? '').get('status');
      const all = [...store.values()].sort((a, b) => a.seq - b.seq);
      const items = all
        .filter((entry) => status == null || status === 'all' || entry.status === status)
        // The list route deliberately omits `payload` (it can be large); only
        // GET /api/outbox/{id} returns it. Spelled out field by field rather
        // than destructure-and-drop, both because the eslint config rejects the
        // unused rest-sibling binding that idiom needs, and because naming the
        // fields is what makes this a contract mock: if the sidecar's list
        // shape changes, this stops matching instead of silently passing the
        // new field through.
        .map(({ id: itemId, kind, capturedAt, seq, status: itemStatus, attempts, lastError }) => ({
          id: itemId,
          kind,
          capturedAt,
          seq,
          status: itemStatus,
          attempts,
          lastError,
        }));

      return jsonResponse(200, {
        items,
        counts: { pending: all.length, needsAttention: 0, total: all.length },
        capacity: { max: 5000, used: all.length, warnAt: 4000 },
      });
    }

    if (call.method === 'POST' && !id) {
      const body = call.body as {
        kind: string;
        payload: Record<string, unknown>;
        capturedAt: string;
        idempotencyKey: string;
      };
      const existingId = byKey.get(body.idempotencyKey);

      if (existingId) {
        const existing = store.get(existingId)!;

        return jsonResponse(201, {
          id: existing.id,
          status: 'pending',
          capturedAt: existing.capturedAt,
          seq: existing.seq,
        });
      }

      const created: OutboxItem = {
        id: `row-${nextSeq}`,
        seq: nextSeq,
        kind: body.kind,
        capturedAt: body.capturedAt,
        status: 'pending',
        attempts: 0,
        lastError: null,
        payload: body.payload,
      };

      nextSeq += 1;
      store.set(created.id, created);
      byKey.set(body.idempotencyKey, created.id);

      return jsonResponse(201, {
        id: created.id,
        status: 'pending',
        capturedAt: created.capturedAt,
        seq: created.seq,
      });
    }

    const target = id ? store.get(id) : undefined;

    if (!target) {
      return jsonResponse(404, { error: 'not_found' });
    }

    if (call.method === 'GET') {
      return jsonResponse(200, target);
    }

    if (call.method === 'POST' && verb === 'attempt') {
      const outcome = call.body as { ok: boolean; error?: string; permanent?: boolean };

      if (outcome.ok) {
        store.delete(id);

        return jsonResponse(204);
      }

      target.attempts += 1;
      target.lastError = outcome.error ?? null;
      target.status = outcome.permanent || target.attempts >= 5 ? 'needs_attention' : 'pending';

      return jsonResponse(200, target);
    }

    return jsonResponse(404, { error: 'not_found' });
  };

  return { store, handler };
}

/** Routes sidecar traffic to `sidecar` and everything else (the appliance) to `appliance`. */
function route(sidecar: Handler, appliance: Handler): Handler {
  return (call) => (call.url.startsWith(HUB_BASE) ? sidecar(call) : appliance(call));
}

const applianceAccepts: Handler = () => jsonResponse(200, { ingested: 1, duplicate: 0, rejected: [] });

/** Lets fire-and-forget follow-ups (the finish call) settle before assertions run. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fix(overrides: Partial<DeviceLocationFix> = {}): DeviceLocationFix {
  return { latitude: SF_LAT, longitude: SF_LNG, capturedAtMs: CAPTURED_AT, ...overrides };
}

afterEach(() => {
  delete (globalThis as GlobalWithWindow).window;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setApiBaseUrl('');
  setApiKey(null);
  resetIngestFinishState();
});

describe('buildPositionRecord — the wire contract with createPositionSchemaRoot', () => {
  it('puts LONGITUDE in location.x and LATITUDE in location.y', () => {
    const record = buildPositionRecord(fix(), { deviceKey: DEVICE_KEY });

    // PositionService does `coordinates: [x, y]` into GEOGRAPHY(POINT,4326), which is
    // GeoJSON order — longitude first. Inverting is silent: the row inserts happily and
    // lands off the coast of Turkey instead of in San Francisco.
    expect(record?.location.x).toBe(SF_LNG);
    expect(record?.location.y).toBe(SF_LAT);

    // Restated as the property that actually matters, so the failure message is legible
    // if someone "fixes" the two lines above by swapping both of them.
    expect(record?.location.x).toBeLessThan(0);
    expect(record?.location.y).toBeGreaterThan(0);
    expect(record?.location).not.toEqual({ x: SF_LAT, y: SF_LNG });
  });

  it('emits exactly the fields the schema declares, in its snake_case vocabulary', () => {
    const record = buildPositionRecord(
      fix({
        accuracyMeters: 12.5,
        altitudeMeters: 8,
        headingDegrees: 91,
        speedMetersPerSecond: 1.4,
      }),
      { deviceKey: DEVICE_KEY, provider: 'companion-mobile' },
    );

    expect(record).toEqual({
      time: '2026-08-13T10:00:00.000Z',
      location: { x: SF_LNG, y: SF_LAT },
      accuracy_meters: 12.5,
      altitude_meters: 8,
      heading_degrees: 91,
      speed_meters_per_second: 1.4,
      source: 'gps',
      provider: 'companion-mobile',
      source_type: 'device',
      source_system: 'companion-device',
      source_id: `${DEVICE_KEY}:${CAPTURED_AT}`,
    });
  });

  it('carries the CAPTURE instant as `time`, not the moment it was built', () => {
    const yesterday = CAPTURED_AT - 24 * 60 * 60 * 1000;
    const record = buildPositionRecord(fix({ capturedAtMs: yesterday }), { deviceKey: DEVICE_KEY });

    expect(record?.time).toBe(new Date(yesterday).toISOString());
  });

  it('omits `device_id` entirely rather than inventing a uuid the appliance cannot resolve', () => {
    const record = buildPositionRecord(fix(), { deviceKey: DEVICE_KEY });

    // The schema accepts a ci.devices.device_id and PositionService only *warns* on an
    // unknown one — so a fabricated uuid would be stored as a dangling FK that looks
    // registered. Device identity rides the provenance triple instead.
    expect(record).not.toHaveProperty('device_id');
    expect(record?.source_id.startsWith(`${DEVICE_KEY}:`)).toBe(true);
  });

  it('omits a non-positive accuracy: zod .positive() plus a DB CHECK would 400 the whole batch', () => {
    expect(buildPositionRecord(fix({ accuracyMeters: 0 }), { deviceKey: DEVICE_KEY })).not.toHaveProperty(
      'accuracy_meters',
    );
    expect(buildPositionRecord(fix({ accuracyMeters: -3 }), { deviceKey: DEVICE_KEY })).not.toHaveProperty(
      'accuracy_meters',
    );
    expect(buildPositionRecord(fix({ accuracyMeters: 5 }), { deviceKey: DEVICE_KEY })?.accuracy_meters).toBe(
      5,
    );
  });

  it('omits a heading outside 0-360, which normalizeHeading would silently discard anyway', () => {
    expect(buildPositionRecord(fix({ headingDegrees: -1 }), { deviceKey: DEVICE_KEY })).not.toHaveProperty(
      'heading_degrees',
    );
    expect(buildPositionRecord(fix({ headingDegrees: 450 }), { deviceKey: DEVICE_KEY })).not.toHaveProperty(
      'heading_degrees',
    );
    expect(buildPositionRecord(fix({ headingDegrees: 0 }), { deviceKey: DEVICE_KEY })?.heading_degrees).toBe(
      0,
    );
    expect(
      buildPositionRecord(fix({ headingDegrees: 360 }), { deviceKey: DEVICE_KEY })?.heading_degrees,
    ).toBe(360);
  });

  it('omits a negative speed and any non-finite optional', () => {
    expect(
      buildPositionRecord(fix({ speedMetersPerSecond: -1 }), { deviceKey: DEVICE_KEY }),
    ).not.toHaveProperty('speed_meters_per_second');
    expect(
      buildPositionRecord(fix({ altitudeMeters: Number.NaN }), { deviceKey: DEVICE_KEY }),
    ).not.toHaveProperty('altitude_meters');
    expect(buildPositionRecord(fix({ accuracyMeters: null }), { deviceKey: DEVICE_KEY })).not.toHaveProperty(
      'accuracy_meters',
    );
  });

  it('refuses a fix whose coordinates are out of range — the transposition guard', () => {
    // Latitude and longitude swapped at the call site: -122 is not a latitude.
    expect(buildPositionRecord(fix({ latitude: SF_LNG, longitude: SF_LAT }), { deviceKey: DEVICE_KEY })).toBe(
      null,
    );
    expect(buildPositionRecord(fix({ latitude: Number.NaN }), { deviceKey: DEVICE_KEY })).toBe(null);
    expect(buildPositionRecord(fix({ longitude: 181 }), { deviceKey: DEVICE_KEY })).toBe(null);
    expect(buildPositionRecord(fix({ capturedAtMs: Number.NaN }), { deviceKey: DEVICE_KEY })).toBe(null);
  });
});

describe('buildPositionRecord — parity fixture shared with the Android native builder', () => {
  // The SAME inputs and expected record live in
  // frontend/packages/capacitor-local-hub/android/src/test/.../PositionRecordJsonTest.kt.
  // Android's motion-gated tracker builds this record natively, from a process that may
  // have no JavaScript, and the two must stay byte-for-byte equivalent: a drift here means
  // a background fix and its web-side re-enqueue stop collapsing on `source_id`, or one of
  // them starts failing the server's schema. Change both or neither.
  const deviceKey = 'cd12ea3d-b4d5-4ba6-a1e1-b02d18653e93';

  it('builds the fixture record', () => {
    const record = buildPositionRecord(
      {
        latitude: 33.6767,
        longitude: -117.7972,
        accuracyMeters: 4,
        altitudeMeters: 61.5,
        headingDegrees: 275.25,
        speedMetersPerSecond: 14.5,
        capturedAtMs: 1791520516942,
      },
      { deviceKey, provider: 'companion-mobile' },
    );

    expect(record).toEqual({
      time: '2026-10-09T04:35:16.942Z',
      location: { x: -117.7972, y: 33.6767 },
      accuracy_meters: 4,
      altitude_meters: 61.5,
      heading_degrees: 275.25,
      speed_meters_per_second: 14.5,
      source: 'gps',
      provider: 'companion-mobile',
      source_type: 'device',
      source_system: 'companion-device',
      source_id: `${deviceKey}:1791520516942`,
    });
  });

  it('omits the optional fields the server would reject or discard', () => {
    const record = buildPositionRecord(
      {
        latitude: 33.6767,
        longitude: -117.7972,
        accuracyMeters: 0,
        altitudeMeters: null,
        headingDegrees: 361,
        speedMetersPerSecond: -1,
        capturedAtMs: 1791520516000,
      },
      { deviceKey, provider: 'companion-mobile' },
    );

    expect(record).toEqual({
      time: '2026-10-09T04:35:16.000Z',
      location: { x: -117.7972, y: 33.6767 },
      source: 'gps',
      provider: 'companion-mobile',
      source_type: 'device',
      source_system: 'companion-device',
      source_id: `${deviceKey}:1791520516000`,
    });
  });
});

describe('positionSourceId — determinism is what makes a replay free', () => {
  it('is a pure function of the device and the capture instant', () => {
    expect(positionSourceId(DEVICE_KEY, CAPTURED_AT)).toBe(positionSourceId(DEVICE_KEY, CAPTURED_AT));
    expect(positionSourceId(DEVICE_KEY, CAPTURED_AT)).toBe(`${DEVICE_KEY}:${CAPTURED_AT}`);
  });

  it('separates devices and separates instants', () => {
    expect(positionSourceId('a', CAPTURED_AT)).not.toBe(positionSourceId('b', CAPTURED_AT));
    expect(positionSourceId(DEVICE_KEY, CAPTURED_AT)).not.toBe(positionSourceId(DEVICE_KEY, CAPTURED_AT + 1));
  });

  it('completes the provenance triple the appliance dedupes on', () => {
    const first = buildPositionRecord(fix(), { deviceKey: DEVICE_KEY });
    const replay = buildPositionRecord(fix(), { deviceKey: DEVICE_KEY });

    // (source_type, source_system, source_id) is the capture log's ON CONFLICT key.
    expect([replay?.source_type, replay?.source_system, replay?.source_id]).toEqual([
      first?.source_type,
      first?.source_system,
      first?.source_id,
    ]);
  });
});

describe('the sampling gate — 150 m or 5 minutes, whichever comes first', () => {
  it('always records the first fix', () => {
    expect(createLocationSampler().shouldCapture(fix())).toBe(true);
  });

  it('SUPPRESSES a fix that is neither far enough nor late enough', () => {
    const sampler = createLocationSampler();

    sampler.accept(fix());

    // ~11 m away, 30 s later.
    expect(
      sampler.shouldCapture({
        latitude: SF_LAT + 0.0001,
        longitude: SF_LNG,
        capturedAtMs: CAPTURED_AT + 30_000,
      }),
    ).toBe(false);
  });

  it('records once we have moved at least 150 m, however soon', () => {
    const sampler = createLocationSampler();

    sampler.accept(fix());

    // ~222 m north.
    const moved = { latitude: SF_LAT + 0.002, longitude: SF_LNG, capturedAtMs: CAPTURED_AT + 1_000 };

    expect(haversineMeters(SF_LAT, SF_LNG, moved.latitude, moved.longitude)).toBeGreaterThan(
      MIN_DISTANCE_METERS,
    );
    expect(sampler.shouldCapture(moved)).toBe(true);
  });

  it('records once 5 minutes have passed, however still we are', () => {
    const sampler = createLocationSampler();

    sampler.accept(fix());

    expect(sampler.shouldCapture(fix({ capturedAtMs: CAPTURED_AT + MIN_INTERVAL_MS }))).toBe(true);
    expect(sampler.shouldCapture(fix({ capturedAtMs: CAPTURED_AT + MIN_INTERVAL_MS - 1 }))).toBe(false);
  });

  it('does not advance until accept() is called, so a failed capture is retried', () => {
    const sampler = createLocationSampler();
    const next = fix({ capturedAtMs: CAPTURED_AT + 1_000 });

    expect(sampler.shouldCapture(next)).toBe(true);
    // No accept() — the gate is still open for the very next callback.
    expect(sampler.shouldCapture(next)).toBe(true);

    sampler.accept(next);

    expect(sampler.shouldCapture(next)).toBe(false);
  });

  it('reset() reopens the gate so re-enabling tracking records immediately', () => {
    const sampler = createLocationSampler();

    sampler.accept(fix());
    expect(sampler.shouldCapture(fix())).toBe(false);

    sampler.reset();
    expect(sampler.shouldCapture(fix())).toBe(true);
  });
});

describe('captureLocationFix — native: durable first, delivered later', () => {
  it('enqueues a fix taken with NO connectivity instead of losing it', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar();
    // The appliance is unreachable; only the sidecar answers.
    const calls = installFetch(
      route(handler, () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const outcome = await captureLocationFix(fix({ accuracyMeters: 9 }), { deviceKey: DEVICE_KEY });

    expect(outcome.status).toBe('queued');
    expect(store.size).toBe(1);

    // The queued payload is the endpoint's envelope, ready to POST verbatim.
    const [queued] = [...store.values()];
    expect(queued.kind).toBe(POSITION_OUTBOX_KIND);
    expect(queued.payload).toEqual({
      records: [expect.objectContaining({ location: { x: SF_LNG, y: SF_LAT }, source: 'gps' })],
    });

    // Nothing was attempted against the appliance during capture — durability first.
    expect(calls.every((call) => call.url.startsWith(HUB_BASE))).toBe(true);
  });

  it('uses the deterministic source_id as the outbox idempotency key, so a replay is one row', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar();
    const calls = installFetch(route(handler, applianceAccepts));

    const first = await captureLocationFix(fix(), { deviceKey: DEVICE_KEY });
    const replay = await captureLocationFix(fix(), { deviceKey: DEVICE_KEY });

    expect(first.status).toBe('queued');
    expect(replay.status).toBe('queued');
    expect(first.status === 'queued' && replay.status === 'queued' && first.id === replay.id).toBe(true);
    expect(store.size).toBe(1);

    const enqueues = calls.filter((call) => call.method === 'POST' && call.path === '/api/outbox');
    expect(enqueues).toHaveLength(2);
    expect(enqueues[0].body?.idempotencyKey).toBe(`${DEVICE_KEY}:${CAPTURED_AT}`);
    expect(enqueues[1].body?.idempotencyKey).toBe(enqueues[0].body?.idempotencyKey);
  });

  it('throttles through the sampler and does not touch the queue when suppressed', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar();
    const calls = installFetch(route(handler, applianceAccepts));
    const sampler = createLocationSampler();

    await captureLocationFix(fix(), { deviceKey: DEVICE_KEY, sampler });
    const suppressed = await captureLocationFix(
      fix({ latitude: SF_LAT + 0.0001, capturedAtMs: CAPTURED_AT + 30_000 }),
      { deviceKey: DEVICE_KEY, sampler },
    );

    expect(suppressed).toEqual({ status: 'throttled' });
    expect(store.size).toBe(1);
    expect(calls.filter((call) => call.method === 'POST' && call.path === '/api/outbox')).toHaveLength(1);
  });

  it('does not advance the gate when the enqueue fails, so the fix is retried', async () => {
    setNativeWindow();
    // Sidecar present but refusing (queue full) — NOT "unavailable", so no write-through.
    const calls = installFetch(() => jsonResponse(507, { error: 'queue_full' }));
    const sampler = createLocationSampler();

    const outcome = await captureLocationFix(fix(), { deviceKey: DEVICE_KEY, sampler });

    expect(outcome.status).toBe('failed');
    expect(sampler.last).toBe(null);
    // Nothing leaked to the appliance behind the queue's back.
    expect(calls.every((call) => call.url.startsWith(HUB_BASE))).toBe(true);
  });
});

describe('captureLocationFix — web: no sidecar, so say so and write through', () => {
  it('POSTs the { records: [...] } envelope to /api/v1/positions', async () => {
    setWindow({});
    const calls = installFetch(applianceAccepts);

    const outcome = await captureLocationFix(fix({ accuracyMeters: 9 }), { deviceKey: DEVICE_KEY });

    expect(outcome.status).toBe('sent');

    const post = calls.find((call) => call.url === '/api/v1/positions');
    expect(post?.method).toBe('POST');
    expect(post?.body).toEqual({
      records: [
        {
          time: '2026-08-13T10:00:00.000Z',
          location: { x: SF_LNG, y: SF_LAT },
          accuracy_meters: 9,
          source: 'gps',
          provider: 'browser',
          source_type: 'device',
          source_system: 'companion-device',
          source_id: `${DEVICE_KEY}:${CAPTURED_AT}`,
        },
      ],
    });

    // Never the legacy route: 100kb body limit, and no capture-log dedupe.
    expect(calls.some((call) => call.url === '/api/position')).toBe(false);
  });

  it('closes the deferred-indexing loop itself, since no flush loop runs on web', async () => {
    setWindow({});
    const calls = installFetch(applianceAccepts);

    await captureLocationFix(fix(), { deviceKey: DEVICE_KEY });
    await flushMicrotasks();

    const finish = calls.find((call) => call.url === INGEST_FINISH_PATH);
    expect(finish?.method).toBe('POST');
    expect(finish?.body).toEqual({ stages: ['reverse_position', 'estimate_locations'] });
  });

  it('reports a transient failure without advancing the gate', async () => {
    setWindow({});
    installFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const sampler = createLocationSampler();

    const outcome = await captureLocationFix(fix(), { deviceKey: DEVICE_KEY, sampler });

    expect(outcome.status).toBe('failed');
    expect(sampler.last).toBe(null);
  });

  it('advances the gate on a permanent rejection, so one bad fix cannot pin the sampler', async () => {
    setWindow({});
    installFetch(() => jsonResponse(422, { message: 'unprocessable' }));
    const sampler = createLocationSampler();

    const outcome = await captureLocationFix(fix(), { deviceKey: DEVICE_KEY, sampler });

    expect(outcome.status).toBe('rejected');
    expect(sampler.last).toMatchObject({ latitude: SF_LAT, longitude: SF_LNG });
  });
});

describe('flushing positions — routing and the ingest-finish loop', () => {
  it('drains queued fixes to /api/v1/positions and never to /api/position', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar();
    const calls = installFetch(route(handler, applianceAccepts));

    await captureLocationFix(fix(), { deviceKey: DEVICE_KEY });

    const summary = await flushOutbox();

    expect(summary).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(store.size).toBe(0);

    const posts = calls.filter((call) => call.url === '/api/v1/positions');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      records: [expect.objectContaining({ source_id: `${DEVICE_KEY}:${CAPTURED_AT}` })],
    });
    expect(calls.some((call) => call.url === '/api/position')).toBe(false);
  });

  it('routes the kind explicitly, so the two position endpoints cannot be confused', () => {
    expect(outboxEndpointFor(POSITION_OUTBOX_KIND)).toBe('/api/v1/positions');
    expect(outboxEndpointFor('position')).toBe('/api/position');
  });

  it('calls POST /v1/ingest/finish after the drain — /v1 defers ALL indexing to the client', async () => {
    setNativeWindow();
    const { handler } = fakeSidecar();
    const calls = installFetch(route(handler, applianceAccepts));

    await captureLocationFix(fix(), { deviceKey: DEVICE_KEY });
    await flushOutbox();

    const finish = calls.find((call) => call.url === INGEST_FINISH_PATH);
    expect(finish?.method).toBe('POST');
    // Positions are not a backfillable search entity; what they need is the geo legs.
    expect(finish?.body).toEqual({ stages: ['reverse_position', 'estimate_locations'] });

    // Ordering matters: the rows must exist before the enrichment sweep runs.
    const positionsAt = calls.findIndex((call) => call.url === '/api/v1/positions');
    const finishAt = calls.findIndex((call) => call.url === INGEST_FINISH_PATH);
    expect(positionsAt).toBeGreaterThanOrEqual(0);
    expect(finishAt).toBeGreaterThan(positionsAt);
  });

  it('keeps the stages owed when the finish fails, and retries them on the next drain', async () => {
    setNativeWindow();
    const { handler } = fakeSidecar();
    const calls = installFetch(
      route(handler, (call) =>
        call.url === INGEST_FINISH_PATH
          ? jsonResponse(409, { message: 'orchestration already running' })
          : applianceAccepts(call),
      ),
    );

    await captureLocationFix(fix(), { deviceKey: DEVICE_KEY });
    await flushOutbox();

    expect(calls.filter((call) => call.url === INGEST_FINISH_PATH)).toHaveLength(1);

    // A second drain has nothing to flush — and is exactly when the stranded debt would
    // otherwise be lost. It must still retry the finish.
    calls.length = 0;
    await flushOutbox();

    const retried = calls.filter((call) => call.url === INGEST_FINISH_PATH);
    expect(retried).toHaveLength(1);
    expect(retried[0].body).toEqual({ stages: ['reverse_position', 'estimate_locations'] });
  });

  it('owes nothing for the legacy /api/position kind, which still emits its own events', async () => {
    setNativeWindow();
    const { handler } = fakeSidecar();
    const calls = installFetch(route(handler, applianceAccepts));

    expect(finishStagesFor('position')).toEqual([]);
    expect(finishStagesFor(POSITION_OUTBOX_KIND)).toEqual(['reverse_position', 'estimate_locations']);
    // Unknown kinds are unroutable, so they owe nothing either.
    expect(finishStagesFor('no-such-kind')).toEqual([]);

    await flushOutbox();

    expect(calls.some((call) => call.url === INGEST_FINISH_PATH)).toBe(false);
  });

  it('does not finish when the flush failed — nothing landed to enrich', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar();
    const calls = installFetch(route(handler, () => jsonResponse(503, { message: 'appliance restarting' })));

    await captureLocationFix(fix(), { deviceKey: DEVICE_KEY });
    const summary = await flushOutbox();

    expect(summary).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    // The fix is still queued, not lost.
    expect(store.size).toBe(1);
    expect(calls.some((call) => call.url === INGEST_FINISH_PATH)).toBe(false);
  });
});

/**
 * `useLocationTracking` is the only caller, and it mocks this adapter away entirely
 * (correctly — it isn't the hook's own logic to test). That leaves the adapter itself
 * with no direct coverage anywhere, despite owning a real invariant: `time` must be the
 * OS's fix instant, never the moment the app got around to reading it.
 */
describe('fixFromGeolocationPosition', () => {
  function geolocationPosition(overrides: Partial<GeolocationCoordinates> = {}): GeolocationPosition {
    return {
      coords: {
        latitude: SF_LAT,
        longitude: SF_LNG,
        accuracy: 12,
        altitude: 15,
        altitudeAccuracy: 5,
        heading: 270,
        speed: 3.5,
        ...overrides,
      },
      timestamp: CAPTURED_AT,
    } as unknown as GeolocationPosition;
  }

  it('carries every coordinate field straight across, unrenamed', () => {
    const fix = fixFromGeolocationPosition(geolocationPosition());

    expect(fix).toEqual({
      latitude: SF_LAT,
      longitude: SF_LNG,
      accuracyMeters: 12,
      altitudeMeters: 15,
      headingDegrees: 270,
      speedMetersPerSecond: 3.5,
      capturedAtMs: CAPTURED_AT,
    });
  });

  it('uses the fix instant the OS reports, not the moment the app read it', () => {
    // Distinct from "now" on purpose — a fix pulled off `getCurrentPosition` after sitting
    // in the queue overnight still belongs to the night it was actually taken.
    const takenLastNight = CAPTURED_AT - 8 * 60 * 60 * 1000;

    const fix = fixFromGeolocationPosition(geolocationPosition());
    expect(fix.capturedAtMs).toBe(CAPTURED_AT);

    const fixFromLastNight = fixFromGeolocationPosition({
      ...geolocationPosition(),
      timestamp: takenLastNight,
    } as GeolocationPosition);
    expect(fixFromLastNight.capturedAtMs).toBe(takenLastNight);
  });

  it('falls back to the current time only when the platform reports no timestamp at all', () => {
    const before = Date.now();
    const fix = fixFromGeolocationPosition({ ...geolocationPosition(), timestamp: 0 } as GeolocationPosition);
    const after = Date.now();

    expect(fix.capturedAtMs).toBeGreaterThanOrEqual(before);
    expect(fix.capturedAtMs).toBeLessThanOrEqual(after);
  });

  it('passes through null optional fields rather than coercing them to 0', () => {
    const fix = fixFromGeolocationPosition(
      geolocationPosition({ altitude: null, heading: null, speed: null }),
    );

    expect(fix.altitudeMeters).toBeNull();
    expect(fix.headingDegrees).toBeNull();
    expect(fix.speedMetersPerSecond).toBeNull();
  });
});

/**
 * The native `significantLocation` event counterpart to `fixFromGeolocationPosition` — same
 * adapter contract, different field names (`bearing`/`time` rather than
 * `heading`/`timestamp`).
 */
describe('fixFromNativeLocationEvent', () => {
  function backgroundLocation(overrides: Partial<NativeLocationEvent> = {}): NativeLocationEvent {
    return {
      latitude: SF_LAT,
      longitude: SF_LNG,
      accuracy: 12,
      altitude: 15,
      altitudeAccuracy: 5,
      bearing: 270,
      speed: 3.5,
      time: CAPTURED_AT,
      ...overrides,
    };
  }

  it('carries every field across, renamed to the DeviceLocationFix contract', () => {
    const fix = fixFromNativeLocationEvent(backgroundLocation());

    expect(fix).toEqual({
      latitude: SF_LAT,
      longitude: SF_LNG,
      accuracyMeters: 12,
      altitudeMeters: 15,
      headingDegrees: 270,
      speedMetersPerSecond: 3.5,
      capturedAtMs: CAPTURED_AT,
    });
  });

  it('falls back to the current time only when the plugin reports no timestamp at all', () => {
    const before = Date.now();
    const fix = fixFromNativeLocationEvent(backgroundLocation({ time: 0 }));
    const after = Date.now();

    expect(fix.capturedAtMs).toBeGreaterThanOrEqual(before);
    expect(fix.capturedAtMs).toBeLessThanOrEqual(after);
  });

  it('passes through null optional fields rather than coercing them to 0', () => {
    const fix = fixFromNativeLocationEvent(
      backgroundLocation({ altitude: null, bearing: null, speed: null }),
    );

    expect(fix.altitudeMeters).toBeNull();
    expect(fix.headingDegrees).toBeNull();
    expect(fix.speedMetersPerSecond).toBeNull();
  });
});

describe('location tracking mode persistence', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    setWindow({
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => store.clear(),
      },
    });
  });

  afterEach(() => {
    (window.localStorage as { clear: () => void }).clear();
  });

  it('defaults to off', () => {
    expect(readLocationTrackingMode()).toBe('off');
    expect(isLocationTrackingEnabled()).toBe(false);
  });

  it('migrates the legacy enabled flag to while using, never to always', () => {
    window.localStorage.setItem(LOCATION_ENABLED_STORAGE_KEY, 'true');

    expect(readLocationTrackingMode()).toBe('when_in_use');
    expect(isLocationTrackingEnabled()).toBe(true);
  });

  it('prefers the explicit mode key over the legacy boolean', () => {
    window.localStorage.setItem(LOCATION_ENABLED_STORAGE_KEY, 'true');
    window.localStorage.setItem(LOCATION_MODE_STORAGE_KEY, 'off');

    expect(readLocationTrackingMode()).toBe('off');
  });

  it('writes both keys so older readers still see the boolean', () => {
    writeLocationTrackingMode('always');

    expect(window.localStorage.getItem(LOCATION_MODE_STORAGE_KEY)).toBe('always');
    expect(window.localStorage.getItem(LOCATION_ENABLED_STORAGE_KEY)).toBe('true');

    writeLocationTrackingMode('off');

    expect(window.localStorage.getItem(LOCATION_ENABLED_STORAGE_KEY)).toBe('false');
  });
});
