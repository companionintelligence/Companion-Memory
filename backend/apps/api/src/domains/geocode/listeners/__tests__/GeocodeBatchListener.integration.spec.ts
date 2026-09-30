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
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import type { GeocodeService, ReverseGeocodeOutcome } from '../../services/GeocodeService';
import { GeocodeBatchListener } from '../GeocodeBatchListener';

/**
 * The reverse leg of GeocodeBatchListener against Postgres.
 *
 * Whether an event is named is decided by the SQL in selectReverseCandidates,
 * which the unit suite only ever sees as strings handed to a mocked query
 * builder. Until this spec nothing ran that SQL, and nothing in it asked where
 * a coordinate came from: an ESTIMATE — a neighbouring GPS fix the location
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

describeWithDb(`GeocodeBatchListener reverse leg against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let listener: GeocodeBatchListener;

  /** Every coordinate the provider was asked to name, as a 4dp cell. */
  const askedAbout: string[] = [];

  const autoUserId = uuidv7();
  const explicitUserId = uuidv7();

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
         ($3, 'Reverse-geocode explicit fixture', $4, 'UTC')`,
      [
        autoUserId,
        `auto.${autoUserId}@example.invalid`,
        explicitUserId,
        `explicit.${explicitUserId}@example.invalid`,
      ],
    );

    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as LoggerService;
    const signalling = { send: jest.fn(async () => []) } as unknown as EventService;
    const graphDeltaWriter = new GraphDeltaWriter(dataSource, logger);

    const geocodeService = {
      reverseGeocode: jest.fn(async (lat: number, lng: number): Promise<ReverseGeocodeOutcome> => {
        const cell = cellOf({ lat, lng });
        askedAbout.push(cell);
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
      const users = [autoUserId, explicitUserId];
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
});
