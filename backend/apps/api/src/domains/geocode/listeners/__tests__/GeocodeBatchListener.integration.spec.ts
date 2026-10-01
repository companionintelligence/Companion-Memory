import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  BaseEntity,
  CalendarEventService,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
  PlaceEntity,
  PlaceService,
} from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import {
  EVENT_LIFECYCLE_CASES,
  EVENT_STATUSES,
  eventStatusVocabulary,
  HAPPENED,
  insertEvent,
  type LifecycleCase,
} from '../../../__tests__/support/eventLifecycleFixtures';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import type { GeocodeOutcome, GeocodeService, ReverseGeocodeOutcome } from '../../services/GeocodeService';
import { GeocodeBatchListener } from '../GeocodeBatchListener';

/**
 * GeocodeBatchListener against Postgres: what it writes onto `ci.events`, which
 * the unit suite only ever sees as strings handed to a mocked query builder and
 * calls to a mocked event service.
 *
 * ── Reverse leg: where a coordinate came from ──────────────────────────────
 *
 * Whether an event is named is decided by the SQL in selectReverseCandidates.
 * Until this spec nothing ran that SQL, and nothing in it asked where a
 * coordinate came from: an ESTIMATE — a neighbouring GPS fix the location
 * estimator copied onto an event that had none — was named, linked to a Place
 * as a visit, and re-tagged `reverse_geocoded`, which erased the only marker
 * that said it was an estimate.
 *
 * The stub provider below knows a name for every coordinate, the estimates'
 * included, and each estimated event differs from its measured control only in
 * what the estimator writes. So the selection is the only thing standing
 * between an estimate and a fabricated visit, and the controls prove the leg
 * still names what it should.
 *
 * ── Both legs: whether the event happened ──────────────────────────────────
 *
 * The listener also writes `location_entity_id`, the link `promote.place`
 * writes, and it used to write it onto anything it resolved. A meeting called
 * off at its source stays in `ci.events` with its venue, so the link counted it
 * as a visit, widened the Location's footprint, and let `promote.edge_event`
 * project Event -LOCATED_AT-> Place for an event that never took place. The
 * rule is the one `promote.place` applies (`eventHappenedSql`), in the memory
 * domain's text (`EVENT_HAPPENED_SQL`, which the listener reads), and the cases
 * are the list every reader that asks the question is held to
 * (`EVENT_LIFECYCLE_CASES`): each class it refuses, and the controls that stop
 * it being widened to "anything but confirmed". A status added to
 * `ci.events` fails the vocabulary check below until that list says whether an
 * event carrying it happened.
 *
 * What these cases assert for an event that did not happen is deliberately
 * asymmetric: the coordinate or name IS written (`enrich.geocode` writes it
 * too, and it is right about the venue), and the Place link is not, nor is the
 * Location entity the link would have minted. A tombstone is the exception to
 * the first half, because `CalendarEventService.update` refuses to write one.
 * Two further cases change the row WHILE the provider call is in flight,
 * because a batch is minutes long and the answer must follow the row as it is
 * when the link is written, not as it was when the candidate was selected.
 *
 * Opt-in like the sibling integration specs: set GEOCODE_TEST_DATABASE_URL.
 */
const availability = databaseAvailability({ urlEnvVar: 'GEOCODE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[geocode/GeocodeBatchListener.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

interface Point {
  lat: number;
  lng: number;
}

/** An event this spec seeded, and where its coordinate is, or will be once the provider answers. */
interface Seeded {
  id: string;
  point: Point;
}

/** The GPS fix the estimator copied onto every estimated event below. */
const HOME: Point = { lat: 34.0522, lng: -118.2437 };
const OFFICE: Point = { lat: 37.4143, lng: -122.0774 };
const HOTEL: Point = { lat: 40.7128, lng: -74.006 };

const HOME_ADDRESS = '123 Home Street, Los Angeles, CA';
const OFFICE_ADDRESS = '1401 N Shoreline Blvd, Mountain View, CA';
const HOTEL_ADDRESS = '20 W 34th St, New York, NY';

const cellOf = (p: Point): string => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

const PROVIDER_NAMES = new Map([
  [cellOf(HOME), HOME_ADDRESS],
  [cellOf(OFFICE), OFFICE_ADDRESS],
  [cellOf(HOTEL), HOTEL_ADDRESS],
]);

/**
 * What both estimators (EstimateLocationStage and LocationEstimateService)
 * write onto an event they locate: the donor's point, plus these four columns.
 */
const ESTIMATE = {
  metadata: { location_source: 'estimated' },
  isInferred: true,
  inferenceSources: {
    method: 'temporal_nn',
    donor: 'position',
    donor_id: '1',
    delta_seconds: 1800,
    accuracy_meters: 12,
    max_gap_hours: 24,
  },
  confidenceScore: 0.4,
};

/** A coordinate the event arrived with: the column defaults, nothing inferred. */
const MEASURED = {
  metadata: {},
  isInferred: false,
  inferenceSources: {},
  confidenceScore: 1.0,
};

/**
 * The confidence the stub provider reports for every forward hit, so a test can
 * tell the listener's write from the seed's (1.0).
 */
const GEOCODED_CONFIDENCE = 0.95;

/** Any fixed hour: the listener never reads an event's time. */
const AT = Date.parse('2026-09-01T18:00:00Z');

describeWithDb(`GeocodeBatchListener against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let listener: GeocodeBatchListener;

  /** Every coordinate the provider was asked to name, as a 4dp cell. */
  const askedAbout: string[] = [];

  /** Every venue string the provider was asked to place. */
  const askedToPlace: string[] = [];

  /** The point the stub provider answers for a venue string. */
  const venuePoints = new Map<string, Point>();

  /**
   * Run while the provider "call" for a venue (forward) or a 4dp cell (reverse)
   * is in flight, before it answers. This is how a test changes a row between
   * the moment the listener selected it and the moment it writes.
   */
  const whileInFlight = new Map<string, () => Promise<void>>();

  /** The listener's own log lines, in order. */
  const logLines: Array<{ message: string; data: Record<string, unknown> }> = [];

  const autoUserId = uuidv7();
  const explicitUserId = uuidv7();
  const forwardUserId = uuidv7();
  const reverseDeadUserId = uuidv7();

  /**
   * A point of its own for every call, 0.5 degrees (about 55 km) from every
   * other. A Location this spec's assertions look for lives within 200 m of its
   * event's point, so no two cases can see each other's.
   */
  let pointsIssued = 0;
  function freshPoint(): Point {
    return { lat: 10 + 0.5 * pointsIssued++, lng: 30 };
  }

  const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);

  async function seedEvent(args: {
    userId: string;
    title: string;
    point: Point;
    locationName?: string;
    metadata: Record<string, unknown> | null;
    isInferred: boolean;
    inferenceSources: Record<string, unknown>;
    confidenceScore: number;
  }): Promise<string> {
    const eventId = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
      [eventId, args.title, args.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events
         (event_id, user_id, start_time, category, source_type, source_system, source_id,
          location_coordinates, location_name, metadata, is_inferred, inference_sources, confidence_score)
       VALUES ($1::uuid, $2, '2026-09-01T18:00:00Z', 'capture', 'ci.import', 'reverse_geocode_spec', $1::text,
               ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6::jsonb, $7, $8::jsonb, $9)`,
      [
        eventId,
        args.userId,
        args.point.lng,
        args.point.lat,
        args.locationName ?? null,
        args.metadata == null ? null : JSON.stringify(args.metadata),
        args.isInferred,
        JSON.stringify(args.inferenceSources),
        args.confidenceScore,
      ],
    );

    return eventId;
  }

  /**
   * One event of a lifecycle case (or any lifecycle), by the insert every spec
   * that asks "did this event happen" shares. `point` null is an event with a
   * name and no coordinate yet; `locationName` null is the reverse.
   */
  async function seedLifecycle(
    userId: string,
    title: string,
    lifecycle: LifecycleCase['lifecycle'],
    point: Point | null,
    locationName: string | null,
  ): Promise<string> {
    const id = uuidv7();

    await insertEvent(query, userId, { id, title, at: AT, lifecycle, point, locationName });

    return id;
  }

  /** What the forward leg writes: the coordinate, its confidence, and the link. */
  async function readLocated(eventId: string): Promise<Record<string, unknown> | undefined> {
    const [row] = await dataSource.query(
      `SELECT e.location_coordinates IS NOT NULL      AS located,
              ST_Y(e.location_coordinates::geometry)  AS lat,
              ST_X(e.location_coordinates::geometry)  AS lng,
              e.confidence_score,
              e.location_entity_id IS NOT NULL        AS linked,
              l.entity_type                           AS place_type
         FROM ci.events e
         LEFT JOIN ci.entities l ON l.entity_id = e.location_entity_id
        WHERE e.event_id = $1`,
      [eventId],
    );

    return row;
  }

  /** The columns the reverse leg writes, and the columns an estimate lives in. */
  async function readEvent(eventId: string): Promise<Record<string, unknown>> {
    const [row] = await dataSource.query(
      `SELECT e.location_name,
              e.metadata->>'location_source'     AS location_source,
              e.is_inferred,
              e.inference_sources->>'method'     AS inference_method,
              e.confidence_score,
              l.entity_type                      AS place_type,
              l.name                             AS place_name
         FROM ci.events e
         LEFT JOIN ci.entities l ON l.entity_id = e.location_entity_id
        WHERE e.event_id = $1`,
      [eventId],
    );

    return row;
  }

  /** Locations a user owns within ~200 m of a point — where a minted visit would sit. */
  async function placesNear(userId: string, p: Point): Promise<number> {
    const [{ count }] = await dataSource.query(
      `SELECT count(*)::int AS count
         FROM ci.entities
        WHERE entity_type = 'Location'
          AND owner_user_id = $1
          AND ST_DWithin(location_point, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 200)`,
      [userId, p.lng, p.lat],
    );

    return count;
  }

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'GEOCODE_TEST_DATABASE_URL' });

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      entities: [BaseEntity, EventBaseEntity, EventEntity, PlaceEntity, UserEntity],
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'geocode/GeocodeBatchListener.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, timezone) VALUES
         ($1, 'Reverse-geocode auto fixture', $2, 'UTC'),
         ($3, 'Reverse-geocode explicit fixture', $4, 'UTC'),
         ($5, 'Geocode forward did-not-happen fixture', $6, 'UTC'),
         ($7, 'Reverse-geocode did-not-happen fixture', $8, 'UTC')`,
      [
        autoUserId,
        `auto.${autoUserId}@example.invalid`,
        explicitUserId,
        `explicit.${explicitUserId}@example.invalid`,
        forwardUserId,
        `forward.${forwardUserId}@example.invalid`,
        reverseDeadUserId,
        `reverse-dead.${reverseDeadUserId}@example.invalid`,
      ],
    );

    const logger = {
      setContext: jest.fn(),
      log: jest.fn((message: string, data: Record<string, unknown> = {}) => {
        logLines.push({ message, data });
      }),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as LoggerService;
    const signalling = { send: jest.fn(async () => []) } as unknown as EventService;
    const graphDeltaWriter = new GraphDeltaWriter(dataSource, logger);

    const geocodeService = {
      geocode: jest.fn(async (location: string): Promise<GeocodeOutcome> => {
        askedToPlace.push(location);
        await whileInFlight.get(location)?.();
        const point = venuePoints.get(location);

        return point == null
          ? { status: 'ZERO_RESULTS', point: null, confidence: null, cached: false, retryable: false }
          : {
              status: 'OK',
              point: { type: 'Point', coordinates: [point.lng, point.lat] },
              confidence: GEOCODED_CONFIDENCE,
              cached: false,
              retryable: false,
            };
      }),
      reverseGeocode: jest.fn(async (lat: number, lng: number): Promise<ReverseGeocodeOutcome> => {
        const cell = cellOf({ lat, lng });
        askedAbout.push(cell);
        await whileInFlight.get(cell)?.();
        const placeName = PROVIDER_NAMES.get(cell) ?? null;

        return placeName == null
          ? { status: 'ZERO_RESULTS', placeName: null, cached: false, retryable: false }
          : { status: 'OK', placeName, cached: false, retryable: false };
      }),
    } as unknown as GeocodeService;

    listener = new GeocodeBatchListener(
      dataSource,
      geocodeService,
      new CalendarEventService(
        dataSource.getRepository(EventEntity),
        dataSource.getRepository(EventBaseEntity),
        signalling,
        dataSource,
        graphDeltaWriter,
      ),
      new PlaceService(dataSource.getRepository(PlaceEntity), signalling, graphDeltaWriter),
      logger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const users = [autoUserId, explicitUserId, forwardUserId, reverseDeadUserId];
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  describe('auto-selection (coordinates present, no name)', () => {
    let measuredId: string;
    let estimatedId: string;

    beforeAll(async () => {
      measuredId = await seedEvent({ userId: autoUserId, title: 'Standup', point: OFFICE, ...MEASURED });
      estimatedId = await seedEvent({ userId: autoUserId, title: 'Amazon order', point: HOME, ...ESTIMATE });

      askedAbout.length = 0;
      await listener.handleBatch({ userId: autoUserId, direction: 'reverse' });
    });

    it('names a measured coordinate, links it to a Place and tags it reverse_geocoded', async () => {
      expect(await readEvent(measuredId)).toEqual({
        location_name: OFFICE_ADDRESS,
        location_source: 'reverse_geocoded',
        is_inferred: false,
        inference_method: null,
        confidence_score: 1,
        place_type: 'Location',
        place_name: OFFICE_ADDRESS,
      });
    });

    it('never offers an estimated coordinate to the provider', () => {
      expect(askedAbout).toEqual([cellOf(OFFICE)]);
    });

    it('leaves the estimate as the estimator wrote it: unnamed, unlinked, still marked estimated', async () => {
      expect(await readEvent(estimatedId)).toEqual({
        location_name: null,
        location_source: 'estimated',
        is_inferred: true,
        inference_method: 'temporal_nn',
        confidence_score: 0.4,
        place_type: null,
        place_name: null,
      });
      expect(await placesNear(autoUserId, HOME)).toBe(0);
    });
  });

  describe('an explicit eventIds set, which skips the name filter', () => {
    let measuredId: string;
    let estimatedId: string;

    beforeAll(async () => {
      // NULL metadata, not '{}': the estimate filter must not drop a row that
      // has no metadata at all.
      measuredId = await seedEvent({
        userId: explicitUserId,
        title: 'Hotel check-in',
        point: HOTEL,
        ...MEASURED,
        metadata: null,
      });
      // An event that names its own location, pinned to home by the estimator
      // anyway (the shape companionintelligence/CI-Server#2800 repairs). The
      // name filter is what keeps the auto-selection off it; an explicit id
      // skips that filter, so without the estimate check its own name would be
      // overwritten with the home address.
      estimatedId = await seedEvent({
        userId: explicitUserId,
        title: 'Flight to Taipei',
        point: HOME,
        locationName: 'Bangkok BKK',
        ...ESTIMATE,
      });

      askedAbout.length = 0;
      await listener.handleBatch({
        userId: explicitUserId,
        direction: 'reverse',
        eventIds: [measuredId, estimatedId],
      });
    });

    it('still names a measured coordinate it was asked for', async () => {
      expect(await readEvent(measuredId)).toMatchObject({
        location_name: HOTEL_ADDRESS,
        location_source: 'reverse_geocoded',
        place_name: HOTEL_ADDRESS,
      });
    });

    it('never offers the estimate to the provider, even by id', () => {
      expect(askedAbout).toEqual([cellOf(HOTEL)]);
    });

    it("refuses an estimate even when asked for it by id, and keeps the event's own name", async () => {
      expect(await readEvent(estimatedId)).toEqual({
        location_name: 'Bangkok BKK',
        location_source: 'estimated',
        is_inferred: true,
        inference_method: 'temporal_nn',
        confidence_score: 0.4,
        place_type: null,
        place_name: null,
      });
      expect(await placesNear(explicitUserId, HOME)).toBe(0);
    });
  });

  describe('forward leg (a name, no coordinate): an event that did not happen is geocoded, not linked', () => {
    const byCase = new Map<string, Seeded & { venue: string }>();
    let cancelledInFlight: Seeded & { venue: string };
    let vanishedInFlight: Seeded & { venue: string };

    /** An event with a venue name the stub provider can place, at a point of its own. */
    async function seedUnlocated(title: string, lifecycle: LifecycleCase['lifecycle']) {
      const point = freshPoint();
      const venue = `Venue (${title})`;
      venuePoints.set(venue, point);

      return { id: await seedLifecycle(forwardUserId, title, lifecycle, null, venue), point, venue };
    }

    beforeAll(async () => {
      for (const { name, lifecycle } of EVENT_LIFECYCLE_CASES) {
        byCase.set(name, await seedUnlocated(name, lifecycle));
      }

      // Live when the candidate is selected, called off while the provider call
      // is in flight: a calendar sync landing mid-batch.
      cancelledInFlight = await seedUnlocated('cancelled in flight', HAPPENED);
      whileInFlight.set(cancelledInFlight.venue, async () => {
        await dataSource.query(`UPDATE ci.events SET status = 'cancelled' WHERE event_id = $1`, [
          cancelledInFlight.id,
        ]);
      });

      // Gone altogether while the provider call is in flight.
      vanishedInFlight = await seedUnlocated('vanished in flight', HAPPENED);
      whileInFlight.set(vanishedInFlight.venue, async () => {
        await dataSource.query('DELETE FROM ci.events WHERE event_id = $1', [vanishedInFlight.id]);
        await dataSource.query('DELETE FROM ci.entities WHERE entity_id = $1', [vanishedInFlight.id]);
      });

      askedToPlace.length = 0;
      logLines.length = 0;
      await listener.handleBatch({ userId: forwardUserId });
    });

    it('classifies every status ci.events allows', async () => {
      // A status added to the CHECK constraint fails here until the shared case
      // table says whether an event carrying it happened.
      expect([...(await eventStatusVocabulary(query))].sort()).toEqual([...EVENT_STATUSES].sort());
    });

    it.each(EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened, c.lifecycle.isDeleted] as const))(
      '%s (happened: %s): linked to a Place only if it happened',
      async (name, happened, isDeleted) => {
        const { id, point } = byCase.get(name)!;
        const row = await readLocated(id);

        // CalendarEventService.update refuses a tombstone, so nothing lands on one.
        expect(row).toMatchObject({
          located: !isDeleted,
          linked: happened,
          place_type: happened ? 'Location' : null,
        });
        if (!isDeleted) {
          expect(row).toMatchObject({ confidence_score: GEOCODED_CONFIDENCE });
          expect(row?.lat).toBeCloseTo(point.lat, 6);
          expect(row?.lng).toBeCloseTo(point.lng, 6);
        }

        // The Location the link would have minted does not exist either.
        expect(await placesNear(forwardUserId, point)).toBe(happened ? 1 : 0);
      },
    );

    it('still asks the provider about every event that was called off: the coordinate is not what is refused', () => {
      for (const { name, lifecycle } of EVENT_LIFECYCLE_CASES) {
        if (!lifecycle.isDeleted) {
          expect(askedToPlace).toContain(`Venue (${name})`);
        }
      }
    });

    it('an event cancelled while its provider call was in flight gets the coordinate and no link', async () => {
      expect(await readLocated(cancelledInFlight.id)).toMatchObject({
        located: true,
        confidence_score: GEOCODED_CONFIDENCE,
        linked: false,
        place_type: null,
      });
      expect(await placesNear(forwardUserId, cancelledInFlight.point)).toBe(0);
    });

    it('an event that disappeared while its provider call was in flight mints no Location', async () => {
      expect(await readLocated(vanishedInFlight.id)).toBeUndefined();
      expect(await placesNear(forwardUserId, vanishedInFlight.point)).toBe(0);
    });

    it('counts, in the batch log, what it resolved without linking', () => {
      const done = logLines.find((line) => line.message === 'Completed geocode backfill batch');
      const linkedCount = EVENT_LIFECYCLE_CASES.filter((c) => c.happened).length;

      expect(done).toBeDefined();
      expect((done!.data.resolved as number) - (done!.data.unlinked as number)).toBe(linkedCount);
      expect(done!.data.unlinked).toBeGreaterThanOrEqual(EVENT_LIFECYCLE_CASES.length - linkedCount);
    });
  });

  describe('reverse leg (a coordinate, no name): an event that did not happen is named, not linked', () => {
    const byCase = new Map<string, Seeded>();
    const addressOf = (title: string): string => `${title}, 1 Spec Street`;
    let cancelledInFlight: Seeded;
    let vanishedInFlight: Seeded;

    /** An event with a measured coordinate and no name, at a point the stub provider can name. */
    async function seedLocated(title: string, lifecycle: LifecycleCase['lifecycle']): Promise<Seeded> {
      const point = freshPoint();
      PROVIDER_NAMES.set(cellOf(point), addressOf(title));

      return { id: await seedLifecycle(reverseDeadUserId, title, lifecycle, point, null), point };
    }

    beforeAll(async () => {
      for (const { name, lifecycle } of EVENT_LIFECYCLE_CASES) {
        byCase.set(name, await seedLocated(name, lifecycle));
      }

      cancelledInFlight = await seedLocated('cancelled in flight', HAPPENED);
      whileInFlight.set(cellOf(cancelledInFlight.point), async () => {
        await dataSource.query(`UPDATE ci.events SET status = 'cancelled' WHERE event_id = $1`, [
          cancelledInFlight.id,
        ]);
      });

      vanishedInFlight = await seedLocated('vanished in flight', HAPPENED);
      whileInFlight.set(cellOf(vanishedInFlight.point), async () => {
        await dataSource.query('DELETE FROM ci.events WHERE event_id = $1', [vanishedInFlight.id]);
        await dataSource.query('DELETE FROM ci.entities WHERE entity_id = $1', [vanishedInFlight.id]);
      });

      askedAbout.length = 0;
      logLines.length = 0;
      await listener.handleBatch({ userId: reverseDeadUserId, direction: 'reverse' });
    });

    it.each(EVENT_LIFECYCLE_CASES.map((c) => [c.name, c.happened, c.lifecycle.isDeleted] as const))(
      '%s (happened: %s): linked to a Place only if it happened',
      async (name, happened, isDeleted) => {
        const { id, point } = byCase.get(name)!;

        // CalendarEventService.update refuses a tombstone, so nothing lands on one.
        expect(await readEvent(id)).toMatchObject({
          location_name: isDeleted ? null : addressOf(name),
          location_source: isDeleted ? null : 'reverse_geocoded',
          place_type: happened ? 'Location' : null,
          place_name: happened ? addressOf(name) : null,
        });
        expect(await placesNear(reverseDeadUserId, point)).toBe(happened ? 1 : 0);
      },
    );

    it('an event cancelled while its provider call was in flight is named and not linked', async () => {
      expect(await readEvent(cancelledInFlight.id)).toMatchObject({
        location_name: addressOf('cancelled in flight'),
        place_type: null,
      });
      expect(await placesNear(reverseDeadUserId, cancelledInFlight.point)).toBe(0);
    });

    it('an event that disappeared while its provider call was in flight mints no Location', async () => {
      expect(await readEvent(vanishedInFlight.id)).toBeUndefined();
      expect(await placesNear(reverseDeadUserId, vanishedInFlight.point)).toBe(0);
    });

    it('counts, in the batch log, what it resolved without linking', () => {
      const done = logLines.find((line) => line.message === 'Completed reverse-geocode backfill batch');
      const linkedCount = EVENT_LIFECYCLE_CASES.filter((c) => c.happened).length;

      expect(done).toBeDefined();
      expect((done!.data.resolved as number) - (done!.data.unlinked as number)).toBe(linkedCount);
      expect(done!.data.unlinked).toBeGreaterThanOrEqual(EVENT_LIFECYCLE_CASES.length - linkedCount);
    });
  });

  describe('an explicit eventIds set does not carry an event that did not happen past the rule', () => {
    let heldId: string;
    let calledOffId: string;
    let calledOffPoint: Point;

    beforeAll(async () => {
      // Both already have a coordinate AND a stale name, which the explicit set
      // skips the name filter for. The cancelled one is still wanted by the
      // operator who asked for it, so it is renamed; it must not be linked.
      const heldPoint = freshPoint();
      calledOffPoint = freshPoint();
      PROVIDER_NAMES.set(cellOf(heldPoint), 'Held, 2 Spec Street');
      PROVIDER_NAMES.set(cellOf(calledOffPoint), 'Called off, 2 Spec Street');

      heldId = await seedLifecycle(reverseDeadUserId, 'Explicit, held', HAPPENED, heldPoint, 'Stale name');
      calledOffId = await seedLifecycle(
        reverseDeadUserId,
        'Explicit, called off',
        { ...HAPPENED, status: 'cancelled' },
        calledOffPoint,
        'Stale name',
      );

      await listener.handleBatch({
        userId: reverseDeadUserId,
        direction: 'reverse',
        eventIds: [heldId, calledOffId],
      });
    });

    it('links the event that happened', async () => {
      expect(await readEvent(heldId)).toMatchObject({
        location_name: 'Held, 2 Spec Street',
        place_type: 'Location',
      });
    });

    it('renames the one that was called off, because it was asked for, and does not link it', async () => {
      expect(await readEvent(calledOffId)).toMatchObject({
        location_name: 'Called off, 2 Spec Street',
        location_source: 'reverse_geocoded',
        place_type: null,
      });
      expect(await placesNear(reverseDeadUserId, calledOffPoint)).toBe(0);
    });
  });
});
