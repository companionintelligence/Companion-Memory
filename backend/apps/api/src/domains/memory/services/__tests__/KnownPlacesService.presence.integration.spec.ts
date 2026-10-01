import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { KNOWN_PLACE_PRESENCE_SQL, KnownPlacesService } from '../KnownPlacesService';
import type { PlaceService } from '../PlaceService';

/**
 * Measured presence against Postgres. KnownPlacesService.presence.spec.ts
 * mocks the rows KNOWN_PLACE_PRESENCE_SQL returns; this spec proves the SQL
 * returns them from real `ci.position` rows, before and after their chunks are
 * compressed, and that buildKnownPlaces joins them to real `ci.events` in the
 * same grid cells.
 *
 * Fixtures are dated 1986, so compressing their chunks touches no real
 * history. The owner is on Tokyo time (UTC+9, no daylight saving), and each of
 * the owner's nights below is a night only on that clock: read in UTC, none is.
 *
 * Opt-in like the sibling integration specs: set MEMORY_TEST_DATABASE_URL.
 */
const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/KnownPlacesService.presence.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const SOURCE_SYSTEM = 'known_places_presence_spec';

/** Cell 3566,13975: fixes on nine days, and on four nights by the owner's clock. */
const HOME = { lat: 35.66, lng: 139.75 };
/** Also cell 3566,13975: a Location with more events than the cell's own. */
const STATION = { lat: 35.6612, lng: 139.7489 };
/** Cell 3567,13969: dense tracks on three days, far more fixes than home. */
const TRACK = { lat: 35.67, lng: 139.69 };
/**
 * Cell 3567,13976. At 139.765, floor(x * 100 + 0.5) gives 13976 in JavaScript
 * and in Postgres, and round(x::numeric * 100) gives 13977. An event and a fix
 * here share a candidate only if both sides compute the cell the same way.
 */
const HALFWAY = { lat: 35.67, lng: 139.765 };
/** Cell 3568,13977: ten days of fixes, all reporting 500 m accuracy. */
const COARSE = { lat: 35.68, lng: 139.77 };
/** Cell 3568,13970: the event rule's Work. */
const OFFICE = { lat: 35.68, lng: 139.7 };
/** Cell 3469,13550: the event rule's Home without presence, one night away. */
const TRIP = { lat: 34.69, lng: 135.5 };

describeWithDb(`KnownPlacesService measured presence against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: KnownPlacesService;
  let compressedChunks: string[] = [];

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const stranger = { userId: strangerId } as UserServiceContext;
  const stationLocationId = uuidv7();

  async function seedFix(
    userId: string,
    at: string,
    point: { lat: number; lng: number },
    accuracyMeters: number | null = null,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.position (time, user_id, location, accuracy_meters, source, source_system)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, 'gps', $6)`,
      [at, userId, point.lng, point.lat, accuracyMeters, SOURCE_SYSTEM],
    );
  }

  /** A track: one fix every 5 seconds from `from` to `to`, drifting east inside the cell. */
  async function seedTrack(userId: string, from: string, to: string, point: { lat: number; lng: number }) {
    await dataSource.query(
      `INSERT INTO ci.position (time, user_id, location, source, source_system)
       SELECT t, $1,
              ST_SetSRID(ST_MakePoint($4 + 0.000001 * extract(epoch FROM t - $2::timestamptz), $5), 4326)::geography,
              'gps', $6
         FROM generate_series($2::timestamptz, $3::timestamptz, interval '5 seconds') AS t`,
      [userId, from, to, point.lng, point.lat, SOURCE_SYSTEM],
    );
  }

  async function seedEvent(args: {
    userId: string;
    title: string;
    at: string;
    point: { lat: number; lng: number };
    placeName: string | null;
    locationEntityId?: string;
  }): Promise<void> {
    const eventId = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
      [eventId, args.title, args.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events
         (event_id, user_id, start_time, category, source_type, source_system, source_id,
          location_coordinates, location_name, location_entity_id)
       VALUES ($1::uuid, $2, $3, 'capture', 'ci.import', $8, $1::text,
               ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7)`,
      [
        eventId,
        args.userId,
        args.at,
        args.point.lng,
        args.point.lat,
        args.placeName,
        args.locationEntityId ?? null,
        SOURCE_SYSTEM,
      ],
    );
  }

  function presenceParams(userId: string, maxFixes: number): unknown[] {
    // The service's own parameters, except the fix cap.
    return [userId, 'Asia/Tokyo', 100, maxFixes, 100, 21, 6, 200];
  }

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });

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
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/KnownPlacesService.presence.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, timezone) VALUES
         ($1, 'Owner presence fixture', $2, 'Asia/Tokyo'),
         ($3, 'Stranger presence fixture', $4, 'UTC')`,
      [ownerId, `owner.${ownerId}@example.invalid`, strangerId, `stranger.${strangerId}@example.invalid`],
    );
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Location', 'Station', '{}'::jsonb, $2)`,
      [stationLocationId, ownerId],
    );

    // Home: 10:00 JST on nine days, one fix each.
    for (let day = 1; day <= 9; day++) {
      await seedFix(ownerId, `1986-09-0${day}T01:00:00Z`, HOME);
    }

    // Home at night: four nights from five fixes. A small-hours fix belongs to
    // the night before, so 01:00 on the 2nd joins 22:30 on the 1st, and 02:00
    // on the 4th is the night of the 3rd.
    await seedFix(ownerId, '1986-09-01T13:30:00Z', HOME, 20); // Mon 1st, 22:30 JST
    await seedFix(ownerId, '1986-09-01T16:00:00Z', HOME); // Tue 2nd, 01:00 JST
    await seedFix(ownerId, '1986-09-03T17:00:00Z', HOME); // Thu 4th, 02:00 JST
    await seedFix(ownerId, '1986-09-05T12:30:00Z', HOME); // Fri 5th, 21:30 JST
    await seedFix(ownerId, '1986-09-07T14:30:00Z', HOME); // Sun 7th, 23:30 JST

    // Three days of dense tracks, 09:00–09:33 JST: 1,203 fixes against home's fourteen.
    await seedTrack(ownerId, '1986-09-10T00:00:00Z', '1986-09-10T00:33:20Z', TRACK);
    await seedTrack(ownerId, '1986-09-11T00:00:00Z', '1986-09-11T00:33:20Z', TRACK);
    await seedTrack(ownerId, '1986-09-12T00:00:00Z', '1986-09-12T00:33:20Z', TRACK);

    for (const day of ['12', '13', '14']) {
      await seedFix(ownerId, `1986-09-${day}T01:00:00Z`, HALFWAY);
    }

    // Ten days of fixes too coarse to place in a cell: dropped, days and all.
    for (let day = 20; day <= 29; day++) {
      await seedFix(ownerId, `1986-09-${day}T01:00:00Z`, COARSE, 500);
    }

    // Sat 6th, 12:00 JST.
    await seedEvent({
      userId: ownerId,
      title: 'At home',
      at: '1986-09-06T03:00:00Z',
      point: HOME,
      placeName: 'Home base',
    });

    // 13:00 JST on the 10th to the 14th.
    for (let day = 10; day <= 14; day++) {
      await seedEvent({
        userId: ownerId,
        title: `Train ${day}`,
        at: `1986-09-${day}T04:00:00Z`,
        point: STATION,
        placeName: 'Station',
        locationEntityId: stationLocationId,
      });
    }

    // Sat 13th, 13:00 JST.
    await seedEvent({
      userId: ownerId,
      title: 'Corner store',
      at: '1986-09-13T04:00:00Z',
      point: HALFWAY,
      placeName: 'Corner store',
    });

    // Wed 10th and Thu 11th, 10:00 JST.
    for (const at of ['1986-09-10T01:00:00Z', '1986-09-11T01:00:00Z']) {
      await seedEvent({ userId: ownerId, title: 'Standup', at, point: OFFICE, placeName: null });
    }

    // Tue 16th, 22:30 JST.
    await seedEvent({
      userId: ownerId,
      title: 'Late dinner',
      at: '1986-09-16T13:30:00Z',
      point: TRIP,
      placeName: null,
    });

    // The stranger spends thirty nights in the owner's home cell.
    for (let day = 1; day <= 30; day++) {
      await seedFix(strangerId, `1986-08-${String(day).padStart(2, '0')}T23:00:00Z`, HOME);
    }

    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as LoggerService;

    service = new KnownPlacesService(dataSource, logger, {} as PlaceService);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const users = [ownerId, strangerId];
      for (const chunk of compressedChunks) {
        await dataSource.query(`SELECT decompress_chunk($1::regclass, if_compressed => true)`, [chunk]);
      }

      await dataSource.query('DELETE FROM ci.position WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  async function ownerSummary() {
    const candidates = await service.buildKnownPlaces(owner);

    return candidates.map((c) => [
      c.kind,
      c.label,
      c.eventCount,
      c.presenceDays,
      c.presenceNights,
      c.confidence,
    ]);
  }

  // [kind, label, events, presence days, presence nights, confidence]. The
  // confidence pool is 10 events and 14 days; the 500 m fixes' days are not in it.
  const EXPECTED_OWNER = [
    ['home', 'Home base', 1, 9, 4, Number((0.4 + 10 / 24).toFixed(3))],
    ['other', 'Station', 5, 0, 0, Number((0.4 + 5 / 24).toFixed(3))],
    ['other', 'Corner store', 1, 3, 0, Number((0.4 + 4 / 24).toFixed(3))],
    ['other', 'Unknown place', 0, 3, 0, Number((0.4 + 3 / 24).toFixed(3))],
    ['work', 'Unknown place', 2, 0, 0, Number((0.4 + 2 / 24).toFixed(3))],
    ['other', 'Unknown place', 1, 0, 0, Number((0.4 + 1 / 24).toFixed(3))],
  ];

  it('counts days and nights per cell on the owner clock, joins them to the grid candidates, and picks Home', async () => {
    expect(await ownerSummary()).toEqual(EXPECTED_OWNER);
  });

  it('puts the dense track in its cell as three days, not 1,203 fixes', async () => {
    const track = (await service.buildKnownPlaces(owner)).find(
      (candidate) => candidate.eventCount === 0 && candidate.presenceDays > 0,
    );

    expect(track).toMatchObject({ presenceDays: 3, presenceNights: 0, label: 'Unknown place' });
    expect(track?.lat).toBeCloseTo(TRACK.lat, 4);
  });

  it("never reads another user's fixes", async () => {
    const candidates = await service.buildKnownPlaces(stranger);

    expect(candidates).toEqual([
      expect.objectContaining({ kind: 'home', eventCount: 0, presenceDays: 30, presenceNights: 30 }),
    ]);
  });

  it('keeps only the newest usable fixes under the cap', async () => {
    // The newest usable fixes are the three HALFWAY ones (12th–14th), then
    // the end of the 12th's track. The 500 m fixes are newer still, but never
    // usable, so they take no place under the cap.
    const cells = async (maxFixes: number) =>
      (
        (await dataSource.query(KNOWN_PLACE_PRESENCE_SQL, presenceParams(ownerId, maxFixes))) as Array<
          Record<string, unknown>
        >
      ).map((row) => [Number(row.lat_cell), Number(row.lng_cell), Number(row.days), Number(row.total_days)]);

    expect(await cells(3)).toEqual([[3567, 13976, 3, 3]]);
    expect(await cells(5)).toEqual([
      [3567, 13976, 3, 3],
      [3567, 13969, 1, 3],
    ]);
  });

  it('reads compressed chunks the same way', async () => {
    const chunks: Array<{ chunk: string }> = await dataSource.query(
      `SELECT DISTINCT tableoid::regclass::text AS chunk FROM ci.position WHERE user_id = ANY($1)`,
      [[ownerId, strangerId]],
    );
    compressedChunks = chunks.map((row) => row.chunk);
    expect(compressedChunks.length).toBeGreaterThan(0);

    for (const chunk of compressedChunks) {
      await dataSource.query(`SELECT compress_chunk($1::regclass, if_not_compressed => true)`, [chunk]);
    }

    const [{ uncompressed }] = await dataSource.query(
      `SELECT count(*)::int AS uncompressed
         FROM timescaledb_information.chunks
        WHERE format('%I.%I', chunk_schema, chunk_name)::regclass::text = ANY($1)
          AND NOT is_compressed`,
      [compressedChunks],
    );
    expect(uncompressed).toBe(0);

    expect(await ownerSummary()).toEqual(EXPECTED_OWNER);
  });
});
