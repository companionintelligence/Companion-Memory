import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { PlaceRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import {
  BARE_FOOTPRINT,
  emptyFootprint,
  insertNode,
  readFootprint,
  seedBareFootprint,
  wipeGraphEntities,
} from '../../../__tests__/support/graphEntityFootprint';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { PlaceEntity } from '../../entities/PlaceEntity';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { PlaceService } from '../PlaceService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PURGED PLACE LEAVES NOTHING BEHIND, AND ITS CHILDREN KEEP THEIR PLACE IN THE WORLD. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.forget`'s `archive_and_delete` deleted a place by deleting its `ci.entities` row and its
 * edges, and nothing else: nine tables that name a node with no foreign key, the identifiers it was
 * known by, its merge history and every duplicate that had been merged into it stayed. And the delete
 * itself could be refused for a reason that has nothing to do with the user's own node.
 * `ci.entities.parent_place_id` is `ON DELETE SET NULL`, and a city, region or country is unique per
 * (owner, kind, name, parent) in `entities_admin_place_uniq`, with a missing parent counting as its own
 * value. A city whose region is deleted collides with a parentless city of the same name, and the place
 * is undeletable. `PlaceService.remove` grafts the children onto the place's own parent first, for that
 * reason, and so does the purge.
 *
 * Each case seeds a doomed place and a CONTROL one with a row in every table the purge is meant to
 * clean, asserts every one is non-zero before the purge, and checks that the doomed place reads zero
 * everywhere afterwards and the control place has not moved.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your OWN, or run
 * `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/PlaceService.purge.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

/** One place, and a record of each kind that was at it. */
interface Aggregate {
  placeId: string;
  eventId: string;
  /** A position fix is keyed on (time, user) and its `id` column is not unique, so its time names it, as text to keep the microseconds. */
  fixTime: string;
  receiptId: string;
  itemId: string;
  observationId: string;
  childId: string;
}

/** What is particular to a place, on top of what every graph entity is named by. */
const PLACE_FOOTPRINT: ReadonlyArray<readonly [label: string, sql: string]> = [
  ...BARE_FOOTPRINT,
  ['ci.events.location_entity_id', `SELECT count(*) FROM ci.events WHERE location_entity_id = $1`],
  ['ci.position.location_entity_id', `SELECT count(*) FROM ci."position" WHERE location_entity_id = $1`],
  ['ci.receipts.place_entity_id', `SELECT count(*) FROM ci.receipts WHERE place_entity_id = $1`],
  [
    'ci.objects.last_seen_place_entity_id',
    `SELECT count(*) FROM ci.objects WHERE last_seen_place_entity_id = $1`,
  ],
  [
    'ci.object_observations.place_entity_id',
    `SELECT count(*) FROM ci.object_observations WHERE place_entity_id = $1`,
  ],
  [
    'ci.entities.parent_place_id (its children)',
    `SELECT count(*) FROM ci.entities WHERE parent_place_id = $1`,
  ],
];

describeWithDb(`PlaceService.purge against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let places: PlaceService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const stranger = { userId: strangerId } as UserServiceContext;

  const published: Array<{ name: string; payload: unknown }> = [];

  /** Every id a case seeded, for the tables that carry no owner to wipe by. */
  let seeded: string[] = [];

  const signalling = {
    send: jest.fn(async (name: string, payload: unknown) => {
      published.push({ name, payload });

      return [];
    }),
  } as unknown as EventService;

  const announced = (): string[] =>
    published
      .filter((event) => event.name === PlaceRemovedEvent)
      .map((event) => (event.payload as { placeId: string }).placeId)
      .sort();

  const query = (sql: string, params?: unknown[]) => dataSource.query(sql, params);
  const track = (id: string) => seeded.push(id);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, UserEntity, PlaceEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/PlaceService.purge');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'PlacePurge', userId);
    }

    places = new PlaceService(
      dataSource.getRepository(PlaceEntity),
      signalling,
      new GraphDeltaWriter(dataSource, logger()),
    );
  });

  async function wipe(): Promise<void> {
    const users = [ownerId, strangerId];

    await dataSource.query('DELETE FROM ci.object_observations WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.receipts WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci."position" WHERE user_id = ANY($1::uuid[])', [users]);
    await wipeGraphEntities(query, users, seeded);
    // One statement, so a hierarchy and the places under it go together, and the base rows take the detail rows
    // of the events and items with them.
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE entity_id = ANY($1::uuid[])', [seeded]);
    seeded = [];
  }

  beforeEach(() => {
    published.length = 0;
  });

  afterEach(wipe);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  /**
   * A place the way the geocoder leaves one, and everything the appliance hangs off it: an event that was
   * there, a position fix, a receipt, a thing last seen there and a sighting (each of which keeps the place
   * on a column the schema sets to NULL), a child place, and everything every graph entity is named by.
   */
  async function venue(
    name: string,
    forUser = ownerId,
    extra: { entityType?: string; mergedInto?: string } = {},
  ): Promise<Aggregate> {
    const entityType = extra.entityType ?? 'Location';
    const placeId = await insertNode(
      query,
      track,
      { entityType, name, ownerId: forUser },
      { ...(extra.mergedInto === undefined ? {} : { mergedInto: extra.mergedInto }), placeKind: 'venue' },
    );

    await seedBareFootprint(query, track, {
      entityId: placeId,
      entityType,
      searchType: 'place',
      name,
      ownerId: forUser,
    });

    // A tombstone also has the audit row of the merge that folded IT away: it is the source, and the row keeps a
    // snapshot of the tombstone's own data. It names the survivor as its target, so a survivor's purge finds it by
    // the survivor, and a purge of the tombstone alone can only find it by the tombstone.
    if (extra.mergedInto !== undefined) {
      await query(
        `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
         VALUES ($1, $2, $3, $4, jsonb_build_object('source', jsonb_build_object('name', $5::text)))`,
        [forUser, placeId, extra.mergedInto, entityType, name],
      );
    }

    const eventId = uuidv7();

    track(eventId);
    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3)`,
      [eventId, `dinner at ${name}`, forUser],
    );
    await query(
      `INSERT INTO ci.events (event_id, user_id, start_time, location_entity_id) VALUES ($1, $2, now(), $3)`,
      [eventId, forUser, placeId],
    );

    const [{ time: fixTime }] = await query(
      `INSERT INTO ci."position" (time, user_id, source, location, location_entity_id)
       VALUES (clock_timestamp(), $1, 'manual', ST_SetSRID(ST_MakePoint(-122.4, 37.8), 4326)::geography, $2)
       RETURNING time::text AS time`,
      [forUser, placeId],
    );
    const [{ receipt_id: receiptId }] = await query(
      `INSERT INTO ci.receipts (user_id, place_entity_id) VALUES ($1, $2) RETURNING receipt_id`,
      [forUser, placeId],
    );

    const itemId = uuidv7();

    track(itemId);
    await query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Item', $2, '{}'::jsonb, $3)`,
      [itemId, `umbrella left at ${name}`, forUser],
    );
    await query(
      `INSERT INTO ci.objects (object_id, user_id, last_seen_place_entity_id) VALUES ($1, $2, $3)`,
      [itemId, forUser, placeId],
    );

    const [{ observation_id: observationId }] = await query(
      `INSERT INTO ci.object_observations (user_id, observed_at, label, place_entity_id)
       VALUES ($1, now(), 'an umbrella', $2) RETURNING observation_id`,
      [forUser, placeId],
    );

    const childId = await insertNode(
      query,
      track,
      { entityType, name: `${name} (back room)`, ownerId: forUser },
      { parentPlaceId: placeId, placeKind: 'room' },
    );

    return { placeId, eventId, fixTime, receiptId, itemId, observationId, childId };
  }

  /** A place of a given kind under another, without the rest of a venue. */
  const area = (name: string, placeKind: string, parentPlaceId?: string, forUser = ownerId) =>
    insertNode(
      query,
      track,
      { entityType: 'Location', name, ownerId: forUser },
      { placeKind, ...(parentPlaceId === undefined ? {} : { parentPlaceId }) },
    );

  const parentOf = async (id: string): Promise<string | null> => {
    const [row] = await dataSource.query('SELECT parent_place_id FROM ci.entities WHERE entity_id = $1', [
      id,
    ]);

    return row.parent_place_id;
  };

  // ── Probes ────────────────────────────────────────────────────────────────

  const footprint = (aggregate: Aggregate) => readFootprint(query, PLACE_FOOTPRINT, aggregate.placeId);

  /** What `footprint` reads when every row is gone. */
  const EMPTY = emptyFootprint(PLACE_FOOTPRINT);

  function expectEveryTableTouched(counts: Record<string, number>): void {
    for (const [label, count] of Object.entries(counts)) {
      // A fixture that wrote nothing here would let the purge "clean" an empty table.
      expect({ label, count: count > 0 }).toEqual({ label, count: true });
    }
  }

  async function nodeExists(id: string): Promise<boolean> {
    const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.entities WHERE entity_id = $1', [id]);

    return Number(count) > 0;
  }

  // ── Cases ─────────────────────────────────────────────────────────────────

  it('removes the place, its node and every row that points at it, and nothing else', async () => {
    const doomed = await venue('Chez Panisse');
    const control = await venue('Zuni Café');

    const doomedBefore = await footprint(doomed);
    const controlBefore = await footprint(control);

    expectEveryTableTouched(doomedBefore);
    expectEveryTableTouched(controlBefore);

    const purged = await places.purge(owner, [doomed.placeId]);

    expect(purged).toEqual({ placeIds: [doomed.placeId], duplicateIds: [] });
    expect(await footprint(doomed)).toEqual(EMPTY);
    // The control place is exactly as it was, row for row.
    expect(await footprint(control)).toEqual(controlBefore);
  });

  it('keeps the events, fixes, receipts, things and sightings that were at the place, which the schema leaves unpointed', async () => {
    const doomed = await venue('Chez Panisse');

    await places.purge(owner, [doomed.placeId]);

    // Records in their own right: the place was derived from where they were, and they remain where they were.
    expect(
      await dataSource.query('SELECT location_entity_id FROM ci.events WHERE event_id = $1', [
        doomed.eventId,
      ]),
    ).toEqual([{ location_entity_id: null }]);
    expect(
      await dataSource.query(
        'SELECT location_entity_id FROM ci."position" WHERE time::text = $1 AND user_id = $2',
        [doomed.fixTime, ownerId],
      ),
    ).toEqual([{ location_entity_id: null }]);
    expect(
      await dataSource.query('SELECT place_entity_id FROM ci.receipts WHERE receipt_id = $1', [
        doomed.receiptId,
      ]),
    ).toEqual([{ place_entity_id: null }]);
    expect(
      await dataSource.query('SELECT last_seen_place_entity_id FROM ci.objects WHERE object_id = $1', [
        doomed.itemId,
      ]),
    ).toEqual([{ last_seen_place_entity_id: null }]);
    expect(
      await dataSource.query('SELECT place_entity_id FROM ci.object_observations WHERE observation_id = $1', [
        doomed.observationId,
      ]),
    ).toEqual([{ place_entity_id: null }]);
  });

  describe('the places under it', () => {
    it('are grafted onto its own parent, so a city keeps its country when its region is removed', async () => {
      const country = await area('France', 'country');
      const region = await area('Île-de-France', 'region', country);
      const city = await area('Paris', 'city', region);
      const venueInCity = await area('Le Louvre', 'venue', city);

      await places.purge(owner, [region]);

      expect(await nodeExists(region)).toBe(false);
      expect(await parentOf(city)).toBe(country);
      // And what is under the city did not move.
      expect(await parentOf(venueInCity)).toBe(city);
    });

    it('would otherwise refuse the delete, which is what happens when the parent is nulled instead', async () => {
      // The control for the case below: the same hierarchy, deleted the way the generic path deletes a node.
      const country = await area('France', 'country');
      const region = await area('Île-de-France', 'region', country);

      await area('Paris', 'city', region);
      await area('Paris', 'city');

      await expect(
        dataSource.query('DELETE FROM ci.entities WHERE entity_id = $1', [region]),
      ).rejects.toThrow(/entities_admin_place_uniq/);
    });

    it('are grafted, and the purge is not refused, where nulling their parent would collide with a place of the same name', async () => {
      const country = await area('France', 'country');
      const region = await area('Île-de-France', 'region', country);
      const city = await area('Paris', 'city', region);
      // A parentless city of the same name: the unique index counts a missing parent as its own value.
      const stray = await area('Paris', 'city');

      const purged = await places.purge(owner, [region]);

      expect(purged.placeIds).toEqual([region]);
      expect(await nodeExists(region)).toBe(false);
      expect(await parentOf(city)).toBe(country);
      expect(await parentOf(stray)).toBeNull();
    });

    it('climb past every place that is going, to the nearest ancestor that stays', async () => {
      const country = await area('France', 'country');
      const region = await area('Île-de-France', 'region', country);
      const city = await area('Paris', 'city', region);
      const district = await area('Le Marais', 'neighborhood', city);

      // The region AND the city are forgotten together: the district lands on the country, not on either.
      await places.purge(owner, [region, city]);

      expect(await nodeExists(region)).toBe(false);
      expect(await nodeExists(city)).toBe(false);
      expect(await parentOf(district)).toBe(country);
    });

    it('end up without a parent when everything above them is going', async () => {
      const country = await area('France', 'country');
      const region = await area('Île-de-France', 'region', country);
      const city = await area('Paris', 'city', region);

      await places.purge(owner, [country, region]);

      expect(await parentOf(city)).toBeNull();
    });

    it('are only moved when they are the caller’s own, whatever else names the place as its parent', async () => {
      const country = await area('France', 'country');
      const region = await area('Île-de-France', 'region', country);
      // A place of a stranger's that names my region as its parent. It should not exist, and what the schema does
      // with it is not ours to improve on: the foreign key sets it to NULL. It is not grafted onto my country.
      const theirs = await area('Their Paris', 'city', region, strangerId);

      await places.purge(owner, [region]);

      expect(await nodeExists(region)).toBe(false);
      expect(await parentOf(theirs)).toBeNull();
    });
  });

  describe('the duplicates that were merged into a place', () => {
    it('go with it, in the same transaction, with everything that names them', async () => {
      const survivor = await venue('Chez Panisse');
      const duplicate = await venue('Chez Panisse (duplicate)', ownerId, { mergedInto: survivor.placeId });
      const control = await venue('Zuni Café');
      const controlBefore = await footprint(control);

      expectEveryTableTouched(await footprint(duplicate));

      const purged = await places.purge(owner, [survivor.placeId]);

      expect(purged).toEqual({ placeIds: [survivor.placeId], duplicateIds: [duplicate.placeId] });
      expect(await footprint(survivor)).toEqual(EMPTY);
      expect(await footprint(duplicate)).toEqual(EMPTY);
      expect(await footprint(control)).toEqual(controlBefore);
    });

    it('go alone when a duplicate is asked for by name, and leave the survivor as it was', async () => {
      const survivor = await venue('Chez Panisse');
      const duplicate = await venue('Chez Panisse (duplicate)', ownerId, { mergedInto: survivor.placeId });
      const survivorBefore = await footprint(survivor);

      const purged = await places.purge(owner, [duplicate.placeId]);

      expect(purged).toEqual({ placeIds: [duplicate.placeId], duplicateIds: [] });
      expect(await footprint(duplicate)).toEqual(EMPTY);
      // The survivor's own rows are as they were, except the one audit row that was about the duplicate that went:
      // it names the survivor as its target and the duplicate as its source, and keeps the duplicate's own data, so
      // it goes with the duplicate and with nothing else.
      expect(await footprint(survivor)).toEqual({
        ...survivorBefore,
        'ci.entity_merges': survivorBefore['ci.entity_merges'] - 1,
      });
    });
  });

  it('takes a place under either spelling the graph holds one in', async () => {
    const geocoded = await venue('Chez Panisse', ownerId, { entityType: 'Location' });
    const remembered = await venue('Zuni Café', ownerId, { entityType: 'Place' });

    const purged = await places.purge(owner, [geocoded.placeId, remembered.placeId]);

    expect(purged.placeIds.sort()).toEqual([geocoded.placeId, remembered.placeId].sort());
    expect(await footprint(geocoded)).toEqual(EMPTY);
    expect(await footprint(remembered)).toEqual(EMPTY);
  });

  it('announces each removal, the duplicates too, after it has committed, and nothing for the ids it did not take', async () => {
    const survivor = await venue('Chez Panisse');
    const duplicate = await venue('Chez Panisse (duplicate)', ownerId, { mergedInto: survivor.placeId });
    const found: number[] = [];

    (signalling.send as jest.Mock).mockImplementationOnce(async (name: string, payload: unknown) => {
      // A listener reads on its own connection. Were the delete not committed yet, it would still find the row.
      const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.entities WHERE entity_id = $1', [
        survivor.placeId,
      ]);

      found.push(Number(count));
      published.push({ name, payload });

      return [];
    });

    published.length = 0;

    await places.purge(owner, [survivor.placeId, uuidv7()]);

    expect(announced()).toEqual([survivor.placeId, duplicate.placeId].sort());
    expect(found).toEqual([0]);
  });

  it('leaves a node of another kind alone, whatever id it is asked for under', async () => {
    const person = await insertNode(query, track, { entityType: 'Person', name: 'Dana', ownerId });
    const concept = await insertNode(query, track, { entityType: 'Concept', name: 'Pottery', ownerId });

    expect(await places.purge(owner, [person, concept])).toEqual({ placeIds: [], duplicateIds: [] });
    expect(await nodeExists(person)).toBe(true);
    expect(await nodeExists(concept)).toBe(true);
    expect(published).toEqual([]);
  });

  it('leaves somebody else’s place alone, and ignores ids that do not exist', async () => {
    const theirs = await venue('Their Café', strangerId);
    const theirsBefore = await footprint(theirs);

    const purged = await places.purge(owner, [theirs.placeId, uuidv7()]);

    expect(purged).toEqual({ placeIds: [], duplicateIds: [] });
    expect(await footprint(theirs)).toEqual(theirsBefore);
    expect(published).toEqual([]);

    // And in the other direction: the stranger can purge their own.
    expect((await places.purge(stranger, [theirs.placeId])).placeIds).toEqual([theirs.placeId]);
    expect(await footprint(theirs)).toEqual(EMPTY);
  });

  it('does nothing for an empty request', async () => {
    expect(await places.purge(owner, [])).toEqual({ placeIds: [], duplicateIds: [] });
    expect(published).toEqual([]);
  });

  it('is all or nothing when something it does not know about blocks the delete', async () => {
    const doomed = await venue('Chez Panisse');
    const doomedBefore = await footprint(doomed);

    // `ci.users.entity_id` references ci.entities with no ON DELETE action. Pointing it at the place's node
    // stands in for a table this teardown has never heard of.
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [doomed.placeId, strangerId]);

    published.length = 0;

    await expect(places.purge(owner, [doomed.placeId])).rejects.toThrow(/foreign key/i);

    // Every delete that ran before the one that failed was rolled back with it, the graft included.
    expect(await footprint(doomed)).toEqual(doomedBefore);
    expect(await parentOf(doomed.childId)).toBe(doomed.placeId);
    expect(published).toEqual([]);
  });
});
