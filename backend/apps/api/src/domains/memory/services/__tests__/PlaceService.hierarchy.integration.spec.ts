import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { PlaceService } from '../PlaceService';

/**
 * The geocode containment chain — country → region → city → place — built in
 * Postgres.
 *
 * `findOrCreateAdminPlace` first tries to ADOPT an unparented node of the same
 * kind and name, with an `UPDATE … RETURNING entity_id` it read as rows. For a
 * bare UPDATE, TypeORM's Postgres runner returns the PAIR `[rows, rowCount]`,
 * so `adopted.length > 0` always held and `adopted[0].entity_id` — a property
 * of the rows ARRAY — was `undefined`. Every level that had a parent therefore
 * came back as `undefined` without being created, and the chain broke below
 * it: no region was ever minted under a country, and the city started a fresh
 * unparented chain. `PlaceService.geocode.spec.ts` could not see it: its stub
 * answered the UPDATE with plain rows.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a database with
 * the migrations applied; with nothing reachable this suite SKIPS legibly.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest PlaceService.hierarchy.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/PlaceService.hierarchy.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const components = (city: string) => ({
  address_components: [
    { long_name: city, types: ['locality', 'political'] },
    { long_name: 'California', types: ['administrative_area_level_1', 'political'] },
    { long_name: 'United States', types: ['country', 'political'] },
  ],
});

interface PlaceRow {
  entity_id: string;
  name: string;
  place_kind: string | null;
  parent_place_id: string | null;
}

describeWithDb(`PlaceService — geocode hierarchy, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: PlaceService;
  const owners: string[] = [];

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as LoggerService;

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

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/PlaceService.hierarchy.integration');

    service = new PlaceService(
      { manager: dataSource.manager } as never,
      { send: async () => [] } as never,
      new GraphDeltaWriter(dataSource, noopLogger),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [owners]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [owners]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [owners]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /** A fresh owner per case, so no case finds another's admin nodes. */
  const newOwner = async (): Promise<UserServiceContext> => {
    const userId = uuidv7();
    owners.push(userId);

    await dataSource.query(`INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3)`, [
      userId,
      'Place hierarchy fixture',
      `place-hierarchy.${userId}@example.invalid`,
    ]);

    return { userId } as UserServiceContext;
  };

  const places = async (owner: UserServiceContext): Promise<Map<string, PlaceRow>> => {
    const rows: PlaceRow[] = await dataSource.query(
      `SELECT entity_id, name, place_kind, parent_place_id
         FROM ci.entities
        WHERE owner_user_id = $1 AND entity_type = 'Location'`,
      [owner.userId],
    );

    return new Map(rows.map((row) => [row.name, row]));
  };

  it('mints each level under the one above it: country, region, city, then the place', async () => {
    const owner = await newOwner();

    const { id } = await service.findOrCreateForGeocode(owner, {
      name: 'Googleplex',
      lat: 37.4221,
      lng: -122.0841,
      components: components('Mountain View'),
    });

    const byName = await places(owner);
    const country = byName.get('United States');
    const region = byName.get('California');
    const city = byName.get('Mountain View');

    expect(country).toMatchObject({ place_kind: 'country', parent_place_id: null });
    expect(region).toMatchObject({ place_kind: 'region', parent_place_id: country?.entity_id });
    expect(city).toMatchObject({ place_kind: 'city', parent_place_id: region?.entity_id });
    expect(byName.get('Googleplex')).toMatchObject({ entity_id: id, parent_place_id: city?.entity_id });
    expect(byName.size).toBe(4);
  });

  it('adopts the unparented city an earlier, partial geocode left behind, instead of minting a second one', async () => {
    const owner = await newOwner();

    // A provider answer with a locality but no region or country — common
    // outside the US, and exactly how an unparented city node comes to exist.
    const earlier = await service.findOrCreateForGeocode(owner, {
      name: 'Sunnyvale Public Library',
      lat: 37.3717,
      lng: -122.0391,
      components: { address_components: [{ long_name: 'Sunnyvale', types: ['locality', 'political'] }] },
    });
    const orphanCity = (await places(owner)).get('Sunnyvale');
    expect(orphanCity).toMatchObject({ place_kind: 'city', parent_place_id: null });

    const later = await service.findOrCreateForGeocode(owner, {
      name: 'Murphy Avenue',
      lat: 37.3772,
      lng: -122.0308,
      components: components('Sunnyvale'),
    });

    const byName = await places(owner);
    const region = byName.get('California');

    // The same city row, now parented under the region the second answer named.
    expect(byName.get('Sunnyvale')).toEqual({ ...orphanCity, parent_place_id: region?.entity_id });
    expect(region).toMatchObject({
      place_kind: 'region',
      parent_place_id: byName.get('United States')?.entity_id,
    });
    expect(byName.get('Murphy Avenue')).toMatchObject({
      entity_id: later.id,
      parent_place_id: orphanCity?.entity_id,
    });
    expect(byName.get('Sunnyvale Public Library')).toMatchObject({
      entity_id: earlier.id,
      parent_place_id: orphanCity?.entity_id,
    });

    const [{ cities }] = await dataSource.query(
      `SELECT count(*)::int AS cities FROM ci.entities
        WHERE owner_user_id = $1 AND entity_type = 'Location' AND place_kind = 'city'`,
      [owner.userId],
    );
    expect(cities).toBe(1);
  });
});
