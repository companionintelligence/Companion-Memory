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

  it('never adopts an unparented city that was merged into another', async () => {
    const owner = await newOwner();

    await service.findOrCreateForGeocode(owner, {
      name: 'Cupertino Library',
      lat: 37.3229,
      lng: -122.0322,
      components: components('Cupertino'),
    });
    const kept = (await places(owner)).get('Cupertino');
    expect(kept).toMatchObject({ place_kind: 'city' });

    // What a place merge leaves behind: the other Cupertino, merged into the
    // kept one and without a parent.
    const mergedAway = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.entities
              (entity_id, entity_type, name, properties, owner_user_id, place_kind, merged_into_entity_id, is_active)
       VALUES ($1, 'Location', 'Cupertino', '{}'::jsonb, $2, 'city', $3, FALSE)`,
      [mergedAway, owner.userId, kept?.entity_id],
    );

    const later = await service.findOrCreateForGeocode(owner, {
      name: 'Main Street Cupertino',
      lat: 37.3236,
      lng: -122.0105,
      components: components('Cupertino'),
    });

    const rows: PlaceRow[] = await dataSource.query(
      `SELECT entity_id, name, place_kind, parent_place_id FROM ci.entities WHERE entity_id = ANY($1::uuid[])`,
      [[later.id, mergedAway]],
    );
    const byId = new Map(rows.map((row) => [row.entity_id, row]));
    expect(byId.get(later.id)?.parent_place_id).toBe(kept?.entity_id);
    expect(byId.get(mergedAway)?.parent_place_id).toBeNull();
  });

  it('hangs a place under the city its region already has, leaving an unparented twin of that city alone', async () => {
    const owner = await newOwner();

    // A full answer mints Palo Alto under California; a later locality-only
    // answer mints a second, unparented Palo Alto beside it.
    await service.findOrCreateForGeocode(owner, {
      name: 'Palo Alto Library',
      lat: 37.4419,
      lng: -122.143,
      components: components('Palo Alto'),
    });
    await service.findOrCreateForGeocode(owner, {
      name: 'Palo Alto Station',
      lat: 37.4434,
      lng: -122.1651,
      components: { address_components: [{ long_name: 'Palo Alto', types: ['locality', 'political'] }] },
    });

    const later = await service.findOrCreateForGeocode(owner, {
      name: 'University Avenue',
      lat: 37.4476,
      lng: -122.1596,
      components: components('Palo Alto'),
    });

    const cities: PlaceRow[] = await dataSource.query(
      `SELECT entity_id, name, place_kind, parent_place_id
         FROM ci.entities
        WHERE owner_user_id = $1 AND entity_type = 'Location' AND place_kind = 'city'`,
      [owner.userId],
    );
    const parented = cities.find((city) => city.parent_place_id != null);
    const [placed]: PlaceRow[] = await dataSource.query(
      `SELECT entity_id, name, place_kind, parent_place_id FROM ci.entities WHERE entity_id = $1`,
      [later.id],
    );

    expect(cities).toHaveLength(2);
    expect(placed.parent_place_id).toBe(parented?.entity_id);
  });

  it('resolves a city to the place it was merged into, never to the merged-away place', async () => {
    const owner = await newOwner();
    const keptElsewhere = uuidv7();
    const mergedAway = uuidv7();

    // A parentless Gilroy merged into another place, the way a place merge
    // leaves it. It shares the key a parentless Gilroy city resolves to.
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, place_kind)
       VALUES ($1, 'Location', 'Gilroy, CA', '{}'::jsonb, $2, 'city')`,
      [keptElsewhere, owner.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.entities
              (entity_id, entity_type, name, properties, owner_user_id, place_kind, merged_into_entity_id, is_active)
       VALUES ($1, 'Location', 'Gilroy', '{}'::jsonb, $2, 'city', $3, FALSE)`,
      [mergedAway, owner.userId, keptElsewhere],
    );

    const later = await service.findOrCreateForGeocode(owner, {
      name: 'Gilroy Outlets',
      lat: 37.0258,
      lng: -121.5677,
      components: { address_components: [{ long_name: 'Gilroy', types: ['locality', 'political'] }] },
    });

    const [row]: PlaceRow[] = await dataSource.query(
      `SELECT p.entity_id, p.name, p.place_kind, p.parent_place_id
         FROM ci.entities v JOIN ci.entities p ON p.entity_id = v.parent_place_id
        WHERE v.entity_id = $1`,
      [later.id],
    );
    // The merge said the two are one city: the answer lands on the kept one
    // and no new Gilroy is minted beside it.
    expect(row).toMatchObject({ entity_id: keptElsewhere, name: 'Gilroy, CA', place_kind: 'city' });

    const [{ count }]: Array<{ count: number }> = await dataSource.query(
      `SELECT count(*)::int AS count
         FROM ci.entities
        WHERE owner_user_id = $1 AND place_kind = 'city' AND merged_into_entity_id IS NULL`,
      [owner.userId],
    );
    expect(count).toBe(1);
  });

  it('finds a city merged under its region again from an answer that names only the city', async () => {
    const owner = await newOwner();

    // The kept Morgan Hill sits under California; the one merged into it had
    // no region, as an answer with a locality only leaves a city.
    await service.findOrCreateForGeocode(owner, {
      name: 'Morgan Hill Library',
      lat: 37.1305,
      lng: -121.6544,
      components: components('Morgan Hill'),
    });
    const kept = (await places(owner)).get('Morgan Hill');
    expect(kept?.parent_place_id).not.toBeNull();

    const mergedAway = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.entities
              (entity_id, entity_type, name, properties, owner_user_id, place_kind, merged_into_entity_id, is_active)
       VALUES ($1, 'Location', 'Morgan Hill', '{}'::jsonb, $2, 'city', $3, FALSE)`,
      [mergedAway, owner.userId, kept?.entity_id],
    );

    const later = await service.findOrCreateForGeocode(owner, {
      name: 'Morgan Hill Station',
      lat: 37.1296,
      lng: -121.6505,
      components: { address_components: [{ long_name: 'Morgan Hill', types: ['locality', 'political'] }] },
    });

    const [placed]: PlaceRow[] = await dataSource.query(
      `SELECT entity_id, name, place_kind, parent_place_id FROM ci.entities WHERE entity_id = $1`,
      [later.id],
    );
    expect(placed.parent_place_id).toBe(kept?.entity_id);

    const cities: PlaceRow[] = await dataSource.query(
      `SELECT entity_id, name, place_kind, parent_place_id
         FROM ci.entities
        WHERE owner_user_id = $1 AND place_kind = 'city' AND merged_into_entity_id IS NULL`,
      [owner.userId],
    );
    expect(cities.map((city) => city.entity_id)).toEqual([kept?.entity_id]);
  });

  it('resolves the place_id of a pinless merged-away place without handing it a pin back', async () => {
    const owner = await newOwner();
    const kept = uuidv7();
    const mergedAway = uuidv7();

    // What a merge leaves when the kept place had its own place_id and no pin:
    // it took the other place's pin, and the other place kept its place_id.
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, location_point)
       VALUES ($1, 'Location', 'Pine Cafe', $3::jsonb, $2,
               ST_SetSRID(ST_MakePoint(-122.3934, 37.7955), 4326)::geography)`,
      [kept, owner.userId, JSON.stringify({ place_id: 'hierarchy-test-kept' })],
    );
    await dataSource.query(
      `INSERT INTO ci.entities
              (entity_id, entity_type, name, properties, owner_user_id, merged_into_entity_id, is_active)
       VALUES ($1, 'Location', 'Pine Cafe', $3::jsonb, $2, $4, FALSE)`,
      [mergedAway, owner.userId, JSON.stringify({ place_id: 'hierarchy-test-other' }), kept],
    );

    // A later answer names the other place_id at the same spot. Filling the
    // merged-away place's missing pin put it in the kept place's cell, and
    // the snap-cell index failed the whole resolution.
    await expect(
      service.findOrCreateForGeocode(owner, {
        name: 'Pine Cafe',
        lat: 37.7955,
        lng: -122.3934,
        placeId: 'hierarchy-test-other',
        components: null,
      }),
    ).resolves.toBeDefined();

    const [row]: Array<{ has_point: boolean }> = await dataSource.query(
      `SELECT location_point IS NOT NULL AS has_point FROM ci.entities WHERE entity_id = $1`,
      [mergedAway],
    );
    expect(row.has_point).toBe(false);
  });
});
