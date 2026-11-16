import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PlaceEntity } from '../../entities/PlaceEntity';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { type PlaceMergeCounts, PlaceMergeService } from '../PlaceMergeService';

/**
 * The counts a place merge reports — in the `mergePlaces` payload and in each
 * `ci.entity_merges` audit row — checked against the rows it moved, in
 * Postgres.
 *
 * They used to be `….length` of bare `UPDATE/DELETE … RETURNING 1`
 * statements, which TypeORM's Postgres runner resolves to the PAIR
 * `[rows, rowCount]`: a constant 2 per statement (4 for the two-statement
 * fields, 6 for relationshipsDropped) whatever moved. Every expected number
 * below differs from those constants.
 *
 * The counting statements are now data-modifying CTEs, and two of them
 * re-point `ci.position` — a TimescaleDB hypertable with COMPRESSED chunks. So
 * the fixture puts position fixes in a chunk it compresses itself, then adds
 * late arrivals to that chunk (a partially compressed chunk, the state the
 * compression policy leaves behind), plus one fix in an uncompressed chunk. The
 * merge must find, move and count all of them.
 *
 * The fixes are dated January and June 1985, before any real GPS history, so
 * compressing their chunk touches nothing but this fixture.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a database with
 * the migrations applied; with nothing reachable this suite SKIPS legibly.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest PlaceMergeService.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/PlaceMergeService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`PlaceMergeService — counts, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let merger: PlaceMergeService;

  const owner = { userId: uuidv7() } as UserServiceContext;

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

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/PlaceMergeService.integration');

    await dataSource.query(`INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3)`, [
      owner.userId,
      'Place merge counts fixture',
      `place-merge.${owner.userId}@example.invalid`,
    ]);

    merger = new PlaceMergeService(
      {
        // Every merge statement runs on the real manager, in one real
        // transaction; only the target's read-back for the payload is stubbed
        // (it joins ci.users through the entity graph, which is not under test).
        manager: dataSource.manager,
        findOne: async () => Object.assign(new PlaceEntity(), { id: uuidv7(), properties: {} }),
      } as never,
      noopLogger,
      { send: async () => [] } as never,
      new GraphDeltaWriter(dataSource, noopLogger),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.position WHERE user_id = $1', [owner.userId]);
      await dataSource.query(
        `DELETE FROM ci_search.entity_tag
          WHERE entity_id IN (SELECT entity_id FROM ci.entities WHERE owner_user_id = $1)`,
        [owner.userId],
      );
      await dataSource.query('DELETE FROM ci_search.tags WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.entity_merges WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.entity_identifiers WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.object_observations WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.receipts WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.objects WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const insertEntity = async (
    type: string,
    name: string,
    parentPlaceId: string | null = null,
  ): Promise<string> => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, parent_place_id)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $5)`,
      [id, type, name, owner.userId, parentPlaceId],
    );

    return id;
  };

  /** An event at a place, plus its CTI base row. */
  const insertEventAt = async (placeId: string): Promise<void> => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, 'events', $1)`,
      [id, owner.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, location_entity_id) VALUES ($1, $2, now(), $3)`,
      [id, owner.userId, placeId],
    );
  };

  /** An owned thing plus its CTI base row. */
  const insertObject = async (columns: { lastSeenAt?: string; acquiredFrom?: string }): Promise<void> => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Item', $2, 'objects', $1)`,
      [id, owner.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.objects (object_id, user_id, owner_user_id, last_seen_place_entity_id, acquired_from_entity_id)
       VALUES ($1, $2, $2, $3, $4)`,
      [id, owner.userId, columns.lastSeenAt ?? null, columns.acquiredFrom ?? null],
    );
  };

  /** One GPS fix per minute from `start`; PK is (time, user_id), so each needs its own minute. */
  const insertFixes = async (
    start: string,
    count: number,
    columns: { at?: string | null; reference?: string | null },
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO ci.position (time, user_id, location, source, location_entity_id, reference_entity_id)
       SELECT $1::timestamptz + make_interval(mins => i), $2, 'SRID=4326;POINT(-117.748 33.695)'::geography,
              'gps', $3, $4
         FROM generate_series(0, $5::int - 1) AS i`,
      [start, owner.userId, columns.at ?? null, columns.reference ?? null, count],
    );
  };

  const insertSearchRows = async (table: 'embeddings' | 'vectors', entityId: string): Promise<void> => {
    await dataSource.query(
      `INSERT INTO ci_search.${table} (id, entity_type, entity_id, user_id) VALUES ($1, 'place', $2, $3)`,
      [uuidv7(), entityId, owner.userId],
    );
  };

  const insertTag = async (label: string, entityIds: string[]): Promise<void> => {
    const tagId = uuidv7();

    await dataSource.query(`INSERT INTO ci_search.tags (id, user_id, label) VALUES ($1, $2, $3)`, [
      tagId,
      owner.userId,
      `${label}-${owner.userId}`,
    ]);

    for (const entityId of entityIds) {
      await dataSource.query(
        `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ('place', $1, $2)`,
        [entityId, tagId],
      );
    }
  };

  const insertEdge = async (from: string, to: string, type: string): Promise<void> => {
    await dataSource.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
       VALUES ($1, $2, $3, $4)`,
      [from, to, type, owner.userId],
    );
  };

  /** Fixture rows of this owner that sit in the chunk's own heap, i.e. are NOT compressed. */
  const uncompressedFixes = async (chunk: string): Promise<number> => {
    const [{ count }] = await dataSource.query(
      `SELECT count(*)::int AS count FROM ONLY ${chunk} WHERE user_id = $1`,
      [owner.userId],
    );

    return count;
  };

  it('counts what it moved, including GPS fixes in a compressed hypertable chunk', async () => {
    const target = await insertEntity('Location', '61 Plantation, Irvine');
    const a = await insertEntity('Location', '61 Plantation');
    const b = await insertEntity('Location', '61 Plantation, Irvine, CA');
    const elsewhere = await insertEntity('Location', 'Irvine');
    const x = await insertEntity('Person', 'Xavier');
    const y = await insertEntity('Person', 'Yolanda');
    const w = await insertEntity('Person', 'Wren');

    // Events: 2 at a, 1 at b; the target's own stays put.
    await insertEventAt(a);
    await insertEventAt(a);
    await insertEventAt(b);
    await insertEventAt(target);

    // Position fixes, January 1985: 5 at a, 2 at b, 3 at no place — then the
    // chunk holding them is compressed.
    await insertFixes('1985-01-15T00:00:00Z', 5, { at: a });
    await insertFixes('1985-01-15T01:00:00Z', 2, { at: b });
    await insertFixes('1985-01-15T02:00:00Z', 3, {});
    const chunks: Array<{ chunk: string }> = await dataSource.query(
      `SELECT DISTINCT tableoid::regclass::text AS chunk FROM ci.position WHERE user_id = $1`,
      [owner.userId],
    );
    expect(chunks).toHaveLength(1);
    const [{ chunk }] = chunks;
    await dataSource.query(`SELECT compress_chunk($1::regclass, if_not_compressed => true)`, [chunk]);
    expect(await uncompressedFixes(chunk)).toBe(0);

    // Late arrivals INTO the compressed chunk (2 at a; 1 more referencing b),
    // and one fix in a chunk that is never compressed (at b).
    await insertFixes('1985-01-15T03:00:00Z', 2, { at: a });
    await insertFixes('1985-01-15T04:00:00Z', 1, { reference: b });
    await insertFixes('1985-06-15T00:00:00Z', 1, { at: b });
    expect(await uncompressedFixes(chunk)).toBe(3);

    // Child places: 2 under a, 1 under b.
    await insertEntity('Location', 'Unit 1', a);
    await insertEntity('Location', 'Unit 2', a);
    await insertEntity('Location', 'Garage', b);

    // Things: one last seen at a; two acquired from b.
    await insertObject({ lastSeenAt: a });
    await insertObject({ acquiredFrom: b });
    await insertObject({ acquiredFrom: b });

    // One sighting at a.
    await dataSource.query(
      `INSERT INTO ci.object_observations (user_id, observed_at, label, place_entity_id)
       VALUES ($1, now(), 'bicycle', $2)`,
      [owner.userId, a],
    );

    // Receipts: two at a, one naming b as the merchant.
    for (const [placeId, merchantId] of [
      [a, null],
      [a, null],
      [null, b],
    ]) {
      await dataSource.query(
        `INSERT INTO ci.receipts (user_id, place_entity_id, merchant_entity_id) VALUES ($1, $2, $3)`,
        [owner.userId, placeId, merchantId],
      );
    }

    // One identifier claim on a.
    await dataSource.query(
      `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized)
       VALUES ($1, $2, 'handle', $3)`,
      [a, owner.userId, `place-${uuidv7()}`],
    );

    // Edges. a→b only joined the duplicates (dropped); y→b duplicates the
    // target's own y→target VISITED (dropped); the rest re-point.
    await insertEdge(a, b, 'NEAR');
    await insertEdge(x, a, 'LIVES_IN');
    await insertEdge(x, b, 'WORKS_AT');
    await insertEdge(w, a, 'VISITED');
    await insertEdge(y, b, 'VISITED');
    await insertEdge(y, target, 'VISITED');
    await insertEdge(a, elsewhere, 'PART_OF');

    // Search rows: both stores for a, the embedding only for b.
    await insertSearchRows('embeddings', a);
    await insertSearchRows('vectors', a);
    await insertSearchRows('embeddings', b);

    // Tags: one only a has, one a and b share (moves once), one only b has,
    // and one the target already holds (stays behind).
    await insertTag('home', [a]);
    await insertTag('family', [a, b]);
    await insertTag('garden', [b]);
    await insertTag('irvine', [b, target]);

    const { counts } = await merger.mergePlaces(owner, [a, b], target);

    const expected: PlaceMergeCounts = {
      events: 3,
      positions: 11, // 5 + 2 compressed, 2 late in the compressed chunk, 1 uncompressed; + 1 reference
      childPlaces: 3,
      objects: 3,
      observations: 1,
      receipts: 3,
      identifiers: 1,
      relationshipsFrom: 1,
      relationshipsTo: 3,
      relationshipsDropped: 2,
      // Nothing commits to a source mid-merge here, so the sweeps find only the
      // duplicates the guarded UPDATEs declined and drop them, as they always did.
      // The race itself is pinned by
      // pipeline/stages/__tests__/PlaceMergeRacesEdgeProjection.integration.spec.ts.
      relationshipsRescued: 0,
      searchRowsDeleted: 3,
      tagLinksMoved: 3,
    };

    expect(counts).toEqual(expected);

    const audits: Array<{ details: { counts: PlaceMergeCounts } }> = await dataSource.query(
      `SELECT details FROM ci.entity_merges WHERE owner_user_id = $1 AND target_entity_id = $2`,
      [owner.userId, target],
    );
    expect(audits.map((row) => row.details.counts)).toEqual([expected, expected]);

    // The position counts are rows that really moved — compressed ones too.
    const [fixes] = await dataSource.query(
      `SELECT count(*) FILTER (WHERE location_entity_id = $2)::int AS at_target,
              count(*) FILTER (WHERE reference_entity_id = $2)::int AS referencing_target,
              count(*) FILTER (WHERE location_entity_id = ANY($3::uuid[])
                                  OR reference_entity_id = ANY($3::uuid[]))::int AS on_sources,
              count(*)::int AS total
         FROM ci.position WHERE user_id = $1`,
      [owner.userId, target, [a, b]],
    );
    expect(fixes).toEqual({ at_target: 10, referencing_target: 1, on_sources: 0, total: 14 });

    // And nothing else still names a source.
    const [refs] = await dataSource.query(
      `SELECT
         (SELECT count(*)::int FROM ci.events WHERE user_id = $1 AND location_entity_id = ANY($2::uuid[])) AS events,
         (SELECT count(*)::int FROM ci.entities WHERE owner_user_id = $1 AND parent_place_id = ANY($2::uuid[])) AS children,
         (SELECT count(*)::int FROM ci.objects WHERE user_id = $1
             AND (last_seen_place_entity_id = ANY($2::uuid[]) OR acquired_from_entity_id = ANY($2::uuid[]))) AS objects,
         (SELECT count(*)::int FROM ci.receipts WHERE user_id = $1
             AND (place_entity_id = ANY($2::uuid[]) OR merchant_entity_id = ANY($2::uuid[]))) AS receipts,
         (SELECT count(*)::int FROM ci.relationships WHERE owner_user_id = $1
             AND (from_entity_id = ANY($2::uuid[]) OR to_entity_id = ANY($2::uuid[]))) AS relationships,
         (SELECT count(*)::int FROM ci_search.entity_tag WHERE entity_type = 'place' AND entity_id = ANY($2::uuid[])) AS tags`,
      [owner.userId, [a, b]],
    );
    expect(refs).toEqual({ events: 0, children: 0, objects: 0, receipts: 0, relationships: 0, tags: 0 });
  });

  it('never closes a parent loop through a place the merge moves under the target', async () => {
    const target = await insertEntity('Location', 'Ferry Building');
    const marketplace = await insertEntity('Location', 'Ferry Building Marketplace');
    const shop = await insertEntity('Location', 'Ferry Building Shop', marketplace);
    const pin = await insertEntity('Location', 'Ferry Bldg', shop);
    const stall = await insertEntity('Location', 'Ferry Building Stall', target);
    const kiosk = await insertEntity('Location', 'Ferry Bldg Kiosk', stall);

    // The marketplace is merged away, so the shop under it moves under the
    // target: the pin's parent is then below the target. So is the kiosk's.
    await merger.mergePlaces(owner, [pin, marketplace, kiosk], target);

    const rows: Array<{ entity_id: string; parent_place_id: string | null }> = await dataSource.query(
      `SELECT entity_id, parent_place_id FROM ci.entities WHERE entity_id = ANY($1::uuid[])`,
      [[target, shop, stall]],
    );
    const parentOf = new Map(rows.map((row) => [row.entity_id, row.parent_place_id]));

    expect(parentOf.get(target)).toBeNull();
    expect(parentOf.get(shop)).toBe(target);
    expect(parentOf.get(stall)).toBe(target);
  });

  describe('when the kept place takes a key only the other place holds', () => {
    // The pin's snap cell, the provider place_id and a city's (kind, name,
    // parent) are each unique per owner, tombstones included. The fold used to
    // copy one onto the kept place while the other place still held it, and the
    // whole merge failed with a duplicate key.
    const insertPlace = async (place: {
      name: string;
      kind?: string;
      parent?: string;
      lngLat?: [number, number];
      properties?: Record<string, unknown>;
    }): Promise<string> => {
      const id = uuidv7();

      await dataSource.query(
        `INSERT INTO ci.entities
                (entity_id, entity_type, name, properties, owner_user_id, place_kind, parent_place_id, location_point)
         VALUES ($1, 'Location', $2, $3::jsonb, $4, $5, $6,
                 CASE WHEN $7::float8 IS NULL THEN NULL
                      ELSE ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography END)`,
        [
          id,
          place.name,
          JSON.stringify(place.properties ?? {}),
          owner.userId,
          place.kind ?? null,
          place.parent ?? null,
          place.lngLat?.[0] ?? null,
          place.lngLat?.[1] ?? null,
        ],
      );

      return id;
    };

    const readPlaces = async (
      ids: string[],
    ): Promise<
      Map<
        string,
        {
          merged_into_entity_id: string | null;
          parent_place_id: string | null;
          place_id: string | null;
          point: string | null;
        }
      >
    > => {
      const rows: Array<{
        entity_id: string;
        merged_into_entity_id: string | null;
        parent_place_id: string | null;
        place_id: string | null;
        point: string | null;
      }> = await dataSource.query(
        `SELECT entity_id, merged_into_entity_id, parent_place_id, properties->>'place_id' AS place_id,
                ST_AsText(location_point) AS point
           FROM ci.entities WHERE entity_id = ANY($1::uuid[])`,
        [ids],
      );

      return new Map(rows.map(({ entity_id, ...row }) => [entity_id, row]));
    };

    it('takes the pin when only the other place has one', async () => {
      const kept = await insertPlace({ name: 'Pier 39 Cafe' });
      const other = await insertPlace({ name: 'Pier 39 Cafe', lngLat: [-122.4098, 37.8087] });

      await merger.mergePlaces(owner, [other], kept);

      const places = await readPlaces([kept, other]);
      expect(places.get(kept)).toEqual(expect.objectContaining({ point: 'POINT(-122.4098 37.8087)' }));
      expect(places.get(other)).toEqual(
        expect.objectContaining({ merged_into_entity_id: kept, point: null }),
      );

      // Both pages still list the merge: the kept place's row names the other
      // one and the pin it gained, the other's row the move.
      const deltas: Array<{ entity_id: string; changed_fields: Record<string, unknown> }> =
        await dataSource.query(
          `SELECT entity_id, changed_fields FROM ci.graph_deltas
          WHERE change_type = 'merged' AND entity_id = ANY($1::uuid[])`,
          [[kept, other]],
        );
      expect(deltas.find((row) => row.entity_id === kept)?.changed_fields).toEqual({
        coordinates: { old: null, new: [-122.4098, 37.8087] },
        merged_from_entity_ids: { old: null, new: [other] },
      });
      expect(deltas.find((row) => row.entity_id === other)?.changed_fields).toEqual({
        is_active: { old: true, new: false },
        merged_into_entity_id: { old: null, new: kept },
      });
    });

    it("takes the provider place_id when only the other place has one, as the Places page's duplicate card offers", async () => {
      // Two pins 133 m apart, either side of a snap-cell edge: the card's
      // "Same name, within 150 m" pair, the second one geocoded.
      const kept = await insertPlace({ name: 'Pine Cafe', lngLat: [-122.39, 37.8202] });
      const other = await insertPlace({
        name: 'Pine Cafe',
        lngLat: [-122.39, 37.8214],
        properties: { place_id: 'merge-test-pine-cafe' },
      });

      await merger.mergePlaces(owner, [other], kept);

      const places = await readPlaces([kept, other]);
      expect(places.get(kept)).toEqual(
        expect.objectContaining({ place_id: 'merge-test-pine-cafe', point: 'POINT(-122.39 37.8202)' }),
      );
      // The other place keeps its own pin, which the kept one did not take.
      expect(places.get(other)).toEqual(
        expect.objectContaining({
          merged_into_entity_id: kept,
          place_id: null,
          point: 'POINT(-122.39 37.8214)',
        }),
      );

      const [audit]: Array<{ details: { sourceProperties: Record<string, unknown> } }> =
        await dataSource.query(`SELECT details FROM ci.entity_merges WHERE source_entity_id = $1`, [other]);
      expect(audit.details.sourceProperties).toEqual({ place_id: 'merge-test-pine-cafe' });
    });

    it('takes the region of a same-named city when the kept city has none', async () => {
      const region = await insertPlace({ name: 'Merge Test Region', kind: 'region' });
      const kept = await insertPlace({ name: 'Springfield', kind: 'city' });
      const other = await insertPlace({ name: 'Springfield', kind: 'city', parent: region });

      await merger.mergePlaces(owner, [other], kept);

      const places = await readPlaces([kept, other]);
      expect(places.get(kept)).toEqual(expect.objectContaining({ parent_place_id: region }));
      expect(places.get(other)).toEqual(
        expect.objectContaining({ merged_into_entity_id: kept, parent_place_id: null }),
      );
    });

    it('merges more same-named cities later, one call or one after another', async () => {
      // Each merge leaves a parentless merged-away Shelbyville. A city's key
      // leaves merged-away places out, so they don't collide with each other or
      // with a live Shelbyville that has no region either.
      const [north, south, east] = await Promise.all(
        ['Merge Test North', 'Merge Test South', 'Merge Test East'].map((name) =>
          insertPlace({ name, kind: 'region' }),
        ),
      );
      const kept = await insertPlace({ name: 'Shelbyville', kind: 'city' });
      const first = await insertPlace({ name: 'Shelbyville', kind: 'city', parent: north });
      const second = await insertPlace({ name: 'Shelbyville', kind: 'city', parent: south });
      const third = await insertPlace({ name: 'Shelbyville', kind: 'city', parent: east });

      await merger.mergePlaces(owner, [first], kept);
      await merger.mergePlaces(owner, [second, third], kept);
      const newer = await insertPlace({ name: 'Shelbyville', kind: 'city' });

      const places = await readPlaces([kept, first, second, third, newer]);
      expect(places.get(kept)).toEqual(
        expect.objectContaining({ merged_into_entity_id: null, parent_place_id: north }),
      );
      for (const id of [first, second, third]) {
        expect(places.get(id)).toEqual(
          expect.objectContaining({ merged_into_entity_id: kept, parent_place_id: null }),
        );
      }

      expect(places.get(newer)).toEqual(
        expect.objectContaining({ merged_into_entity_id: null, parent_place_id: null }),
      );
    });

    it('merges two same-named regions after their same-named cities were merged', async () => {
      const country = await insertPlace({ name: 'Merge Test Country', kind: 'country' });
      const keptRegion = await insertPlace({ name: 'Merge Test State', kind: 'region', parent: country });
      const otherRegion = await insertPlace({ name: 'Merge Test State', kind: 'region' });
      const keptCity = await insertPlace({ name: 'Ogdenville', kind: 'city', parent: keptRegion });
      const otherCity = await insertPlace({ name: 'Ogdenville', kind: 'city', parent: otherRegion });

      await merger.mergePlaces(owner, [otherCity], keptCity);
      await merger.mergePlaces(owner, [otherRegion], keptRegion);

      const places = await readPlaces([keptCity, otherCity, otherRegion]);
      expect(places.get(keptCity)).toEqual(
        expect.objectContaining({ merged_into_entity_id: null, parent_place_id: keptRegion }),
      );
      expect(places.get(otherRegion)).toEqual(
        expect.objectContaining({ merged_into_entity_id: keptRegion, parent_place_id: null }),
      );
      expect(places.get(otherCity)).toEqual(
        expect.objectContaining({ merged_into_entity_id: keptCity, parent_place_id: null }),
      );
    });

    it('merges a kept city into a newer same-named one', async () => {
      const region = await insertPlace({ name: 'Merge Test Valley', kind: 'region' });
      const older = await insertPlace({ name: 'Capital City', kind: 'city' });
      const other = await insertPlace({ name: 'Capital City', kind: 'city', parent: region });

      await merger.mergePlaces(owner, [other], older);
      const newer = await insertPlace({ name: 'Capital City', kind: 'city' });
      await merger.mergePlaces(owner, [older], newer);

      const places = await readPlaces([newer, older, other]);
      expect(places.get(newer)).toEqual(
        expect.objectContaining({ merged_into_entity_id: null, parent_place_id: region }),
      );
      // Path compression: the first merged-away city now points at the newer one.
      expect(places.get(older)).toEqual(
        expect.objectContaining({ merged_into_entity_id: newer, parent_place_id: null }),
      );
      expect(places.get(other)).toEqual(
        expect.objectContaining({ merged_into_entity_id: newer, parent_place_id: null }),
      );
    });
  });

  it('reports zeros when the sources are referenced by nothing — the old code reported 2, 4 and 6', async () => {
    const target = await insertEntity('Location', 'Blue Bottle, Mint Plaza');
    const source = await insertEntity('Location', 'Blue Bottle Coffee');

    const { counts } = await merger.mergePlaces(owner, [source], target);

    expect(counts).toEqual({
      events: 0,
      positions: 0,
      childPlaces: 0,
      objects: 0,
      observations: 0,
      receipts: 0,
      identifiers: 0,
      relationshipsFrom: 0,
      relationshipsTo: 0,
      relationshipsDropped: 0,
      relationshipsRescued: 0,
      searchRowsDeleted: 0,
      tagLinksMoved: 0,
    });
  });
});
