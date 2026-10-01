import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  BaseEntity,
  type CalendarEventService,
  type CommunicationService,
  type ContentService,
  type FileService,
  GraphNodeEntity,
  GraphUtilityService,
  type ItemService,
  RelationshipEntity,
} from '@ci/domains/memory';
import { ConceptRemovedEvent, PersonRemovedEvent, PlaceRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import {
  insertEdge,
  insertNode,
  seedBareFootprint,
  wipeGraphEntities,
} from '../../../__tests__/support/graphEntityFootprint';
import { GRAPH_ENTITY_ENTITIES, graphEntityServices } from '../../../__tests__/support/graphEntityServices';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ForgetKnowledgeTool } from '../ForgetKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `memory.forget` ON A PERSON, A PLACE AND A CONCEPT. THE REAL TOOL, THE REAL SERVICES, POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `archive_and_delete` used to delete these by deleting their `ci.entities` row and their edges, and
 * said nothing about what it left: the identifiers that kept their addresses claimed, the claims that
 * resolved to them, the merge history, the duplicates that had been merged into them, nine tables of
 * bookkeeping, and for a person the pointers in their messages. They are now purged by
 * `PersonService.purge`, `PlaceService.purge` and `ConceptService.purge`. The unit suite for the tool
 * proves the routing against doubles. A double cannot say whether the node is then really gone, or that
 * the tool's own words about it are true, so this file drives the real thing and asks Postgres.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your OWN, or run
 * `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[tools/ForgetKnowledgeTool.graphEntity.integration] SKIPPED — ${availability.reason}`);
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

describeWithDb(
  `memory.forget on a Person, Place or Concept, against Postgres (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let tool: ForgetKnowledgeTool;

    const ownerId = uuidv7();
    const strangerId = uuidv7();
    const asOwner = { userId: ownerId } as RequestContext;

    /** Every domain event the code under test published, in order. */
    const published: Array<{ name: string; payload: unknown }> = [];
    const signalling = {
      send: jest.fn(async (name: string, payload: unknown) => {
        published.push({ name, payload });

        return [];
      }),
    } as unknown as EventService;

    let seeded: string[] = [];
    let phoneSequence = 5_550_200_000;

    const query = (sql: string, params?: unknown[]) => dataSource.query(sql, params);
    const track = (id: string) => seeded.push(id);

    function publishedOf(name: string): unknown[] {
      return published.filter((event) => event.name === name).map((event) => event.payload);
    }

    /** An item service that fails the test if the tool reaches for it: some cases prove it is not reached. */
    const untouchable = (what: string) =>
      new Proxy(
        {},
        {
          get: () => () => {
            throw new Error(`the tool must not reach for ${what} here`);
          },
        },
      );

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        ...dataSourceConnection(DATABASE_ENV),
        entities: [BaseEntity, GraphNodeEntity, RelationshipEntity, UserEntity, ...GRAPH_ENTITY_ENTITIES],
        synchronize: false,
        extra: { options: '-c search_path=ci,public' },
      });
      await dataSource.initialize();
      schemaLock = await acquireSchemaWriteLock(dataSource, 'tools/ForgetKnowledgeTool.graphEntity');

      for (const userId of [ownerId, strangerId]) {
        await createSyntheticTestUser(
          (sql, params) => dataSource.query(sql, params),
          'ForgetGraphEntity',
          userId,
        );
      }

      const graph = new GraphUtilityService(
        dataSource.getRepository(GraphNodeEntity),
        dataSource.getRepository(RelationshipEntity),
        logger(),
      );
      const services = graphEntityServices(dataSource, signalling, logger());

      // No case here names an event, content, a communication or a file, and the one that names an item proves
      // it is never reached, so those are things that fail loudly if they are.
      tool = new ForgetKnowledgeTool(
        graph,
        signalling,
        untouchable('events') as unknown as CalendarEventService,
        untouchable('content') as unknown as ContentService,
        untouchable('communications') as unknown as CommunicationService,
        untouchable('items') as unknown as ItemService,
        untouchable('files') as unknown as FileService,
        services.people,
        services.places,
        services.concepts,
        logger(),
      );
    });

    async function wipe(): Promise<void> {
      const users = [ownerId, strangerId];

      await dataSource.query('DELETE FROM ci.object_observations WHERE user_id = ANY($1::uuid[])', [users]);
      await wipeGraphEntities(query, users, seeded);
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

    const forget = (entityIds: string[], mode: 'archive' | 'archive_and_delete' = 'archive_and_delete') =>
      tool.execute(asOwner, { entityIds, mode });

    // ── Fixtures ──────────────────────────────────────────────────────────────

    /**
     * A person the way an import and the pipeline leave one: the node, the address, number and handle they are
     * known by, a message from them, and the footprint every graph entity has.
     */
    async function person(name: string, entityType = 'Person') {
      const personId = await insertNode(query, track, { entityType, name, ownerId });

      await seedBareFootprint(query, track, {
        entityId: personId,
        entityType,
        searchType: 'person',
        name,
        ownerId,
      });

      const email = `${personId}@example.invalid`;
      const phone = String(phoneSequence++);
      const handle = `x:@${personId}`;
      const identifiers: Array<[kind: string, value: string]> = [
        ['email', email],
        ['phone', phone],
        ['handle', handle],
      ];

      for (const [kind, value] of identifiers) {
        await query(
          `INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized) VALUES ($1, $2, $3, $4)`,
          [personId, ownerId, kind, value],
        );
      }

      const messageId = uuidv7();

      track(messageId);
      await query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Communication', 'a message', '{}'::jsonb, $2)`,
        [messageId, ownerId],
      );
      await query(
        `INSERT INTO ci.communications
         (id, time, user_id, communication_type, direction, content, participants_metadata, from_entity_id, to_entity_ids)
       VALUES ($1, now(), $2, 'email', 'inbound', 'hello', $3::jsonb, $4, $5)`,
        [messageId, ownerId, JSON.stringify({ from: email }), personId, [personId]],
      );

      return { personId, email, messageId };
    }

    const nodeExists = async (id: string): Promise<boolean> =>
      Number(
        (await dataSource.query('SELECT count(*) FROM ci.entities WHERE entity_id = $1', [id]))[0].count,
      ) > 0;

    const identifiersOf = async (id: string): Promise<number> =>
      Number(
        (await dataSource.query('SELECT count(*) FROM ci.entity_identifiers WHERE entity_id = $1', [id]))[0]
          .count,
      );

    const forgotten = async (): Promise<number> =>
      Number(
        (
          await dataSource.query('SELECT count(*) FROM ci.forgotten_identifiers WHERE owner_user_id = $1', [
            ownerId,
          ])
        )[0].count,
      );

    // ── People ────────────────────────────────────────────────────────────────

    it.each(['Person', 'Contact'])(
      'deletes a %s through its own purge: the node, its identifiers, the pointer in its message, and says what it kept',
      async (entityType) => {
        const doomed = await person('Dana Quill', entityType);

        const result = await forget([doomed.personId]);

        expect(result.success).toBe(true);
        expect(result.data?.archivedEntityIds).toEqual([doomed.personId]);
        expect(await nodeExists(doomed.personId)).toBe(false);
        expect(await identifiersOf(doomed.personId)).toBe(0);
        expect(
          await dataSource.query(
            'SELECT from_entity_id, to_entity_ids FROM ci.communications WHERE id = $1',
            [doomed.messageId],
          ),
        ).toEqual([{ from_entity_id: null, to_entity_ids: [] }]);

        // Said, because it was kept: the three that identify one person, as digests, and the messages stay.
        expect(await forgotten()).toBe(3);
        expect(result.data?.warnings).toEqual([
          '3 email address(es), phone number(s) and handle(s) they used are remembered as digests, so messages that still name them do not create them again. Their messages and events were not deleted.',
        ]);
        // Announced once, by the service, after the commit.
        expect(publishedOf(PersonRemovedEvent)).toEqual([{ personId: doomed.personId }]);
      },
    );

    it('says what went with a person that nobody named: the duplicates that had been merged into them', async () => {
      const survivor = await person('Dana Quill');
      const duplicate = await person('D. Quill (duplicate)');

      await dataSource.query(
        'UPDATE ci.entities SET merged_into_entity_id = $2, is_active = false WHERE entity_id = $1',
        [duplicate.personId, survivor.personId],
      );

      const result = await forget([survivor.personId]);

      expect(result.success).toBe(true);
      // Only the person that was named is one of the nodes the call deleted. The tombstone is a warning.
      expect(result.data?.archivedEntityIds).toEqual([survivor.personId]);
      expect(result.data?.warnings).toContain(
        `Also deleted, because each had been merged into a person named here: ${duplicate.personId}.`,
      );
      expect(await nodeExists(duplicate.personId)).toBe(false);
      expect(
        publishedOf(PersonRemovedEvent)
          .map((event) => (event as { personId: string }).personId)
          .sort(),
      ).toEqual([survivor.personId, duplicate.personId].sort());
    });

    it('refuses the user’s own person, says that retrying will not help, and changes nothing', async () => {
      const me = await person('Liam');

      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [me.personId, ownerId]);

      const result = await forget([me.personId]);

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { constraint: 'users_entity_id_fkey', table: 'users' },
      });
      expect(result.error?.message).toContain('Retrying will not change that');
      expect(result.error?.message).toContain('mode "archive"');
      // Nothing was destroyed, so nothing is claimed to have been.
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
      expect(await nodeExists(me.personId)).toBe(true);
      expect(await identifiersOf(me.personId)).toBe(4);
      expect(await forgotten()).toBe(0);
      expect(publishedOf(PersonRemovedEvent)).toEqual([]);
    });

    it('refuses the user’s own person before it has destroyed anything else the call named', async () => {
      const me = await person('Liam');
      const other = await person('Dana Quill');

      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [me.personId, ownerId]);

      // `other` is purged in the same transaction as `me`, which the foreign key refuses, so it is not destroyed.
      // The items that follow in the same call are not reached at all (the item service here fails the test).
      const item = await insertNode(query, track, { entityType: 'Item', name: 'A kettle', ownerId });
      const result = await forget([other.personId, me.personId, item]);

      // The refusal is the database's, so the item service was never reached, which would have thrown something else.
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { constraint: 'users_entity_id_fkey' },
      });
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
      expect(await nodeExists(other.personId)).toBe(true);
      expect(await nodeExists(item)).toBe(true);
      expect(await forgotten()).toBe(0);
    });

    it('keeps a person’s identifiers in archive mode, which only deactivates their node', async () => {
      const archived = await person('Dana Quill');

      const result = await forget([archived.personId], 'archive');

      expect(result.success).toBe(true);
      // Archive is the forget that does not erase: the person is hidden and the address is still theirs, which is
      // also why nothing mints them again. Nothing is remembered, because nothing was freed.
      expect(await nodeExists(archived.personId)).toBe(true);
      expect(await identifiersOf(archived.personId)).toBe(4);
      expect(await forgotten()).toBe(0);
      expect(result.data?.warnings).toBeUndefined();
      expect(publishedOf(PersonRemovedEvent)).toEqual([{ personId: archived.personId }]);
    });

    it('says it could not find a person who belongs to somebody else, and leaves them alone', async () => {
      const theirs = await insertNode(query, track, {
        entityType: 'Person',
        name: 'Their Dana',
        ownerId: strangerId,
      });

      const result = await forget([theirs]);

      expect(result.success).toBe(true);
      expect(result.data?.archivedEntityIds).toEqual([]);
      expect(result.data?.warnings).toEqual([`Entity ${theirs} not found or not owned by user`]);
      expect(await nodeExists(theirs)).toBe(true);
    });

    // ── Places ────────────────────────────────────────────────────────────────

    it.each(['Location', 'Place'])(
      'deletes a %s through its own purge, and moves the places under it up to its parent',
      async (entityType) => {
        const country = await insertNode(
          query,
          track,
          { entityType: 'Location', name: 'France', ownerId },
          { placeKind: 'country' },
        );
        const region = await insertNode(
          query,
          track,
          { entityType, name: 'Île-de-France', ownerId },
          { placeKind: 'region', parentPlaceId: country },
        );
        const city = await insertNode(
          query,
          track,
          { entityType: 'Location', name: 'Paris', ownerId },
          { placeKind: 'city', parentPlaceId: region },
        );

        await seedBareFootprint(query, track, {
          entityId: region,
          entityType,
          searchType: 'place',
          name: 'Île-de-France',
          ownerId,
        });

        const result = await forget([region]);

        expect(result.success).toBe(true);
        expect(result.data?.archivedEntityIds).toEqual([region]);
        expect(await nodeExists(region)).toBe(false);
        expect(await identifiersOf(region)).toBe(0);
        expect(
          (await dataSource.query('SELECT parent_place_id FROM ci.entities WHERE entity_id = $1', [city]))[0]
            .parent_place_id,
        ).toBe(country);
        expect(publishedOf(PlaceRemovedEvent)).toEqual([{ placeId: region }]);
      },
    );

    // ── Concepts ──────────────────────────────────────────────────────────────

    it('deletes a Concept through its own purge, and frees the names it was known by', async () => {
      const concept = await insertNode(query, track, { entityType: 'Concept', name: 'Pottery', ownerId });
      const edgeTo = await insertNode(query, track, { entityType: 'Person', name: 'Dana', ownerId });

      await seedBareFootprint(query, track, {
        entityId: concept,
        entityType: 'Concept',
        searchType: 'concept',
        name: 'Pottery',
        ownerId,
      });
      await insertEdge(query, ownerId, edgeTo, concept, 'LIKES');

      const result = await forget([concept]);

      expect(result.success).toBe(true);
      expect(result.data?.archivedEntityIds).toEqual([concept]);
      expect(result.data?.warnings).toBeUndefined();
      expect(await nodeExists(concept)).toBe(false);
      expect(await identifiersOf(concept)).toBe(0);
      // The person on the other end of the edge is a node in their own right.
      expect(await nodeExists(edgeTo)).toBe(true);
      expect(publishedOf(ConceptRemovedEvent)).toEqual([{ conceptId: concept }]);
    });

    // ── A mixed call ──────────────────────────────────────────────────────────

    it('purges each kind in its own transaction and deletes a node of any other kind the generic way', async () => {
      const dana = await person('Dana Quill');
      const concept = await insertNode(query, track, { entityType: 'Concept', name: 'Pottery', ownerId });
      const club = await insertNode(query, track, { entityType: 'Organization', name: 'Jazz Club', ownerId });

      const result = await forget([dana.personId, concept, club]);

      expect(result.success).toBe(true);
      expect(result.data?.archivedEntityIds).toEqual([dana.personId, concept, club]);
      expect(await nodeExists(dana.personId)).toBe(false);
      expect(await nodeExists(concept)).toBe(false);
      expect(await nodeExists(club)).toBe(false);
    });
  },
);
