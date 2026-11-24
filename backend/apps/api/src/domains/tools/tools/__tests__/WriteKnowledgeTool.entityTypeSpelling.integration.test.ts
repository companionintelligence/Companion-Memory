import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';

import { DataSource, type QueryRunner } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { Events } from '@ci/domains/events';
import {
  EntityIdentifierEntity,
  EntityIdentifierService,
  GraphIngestService,
  NodeEntity,
  RelationshipEntity as IngestRelationshipEntity,
} from '@ci/domains/graph';
import {
  BaseEntity,
  ConceptEntity,
  GraphDeltaWriter,
  GraphEventService,
  GraphNodeEntity,
  GraphQueryService,
  GraphUtilityService,
  PersonEntity,
  RelationshipEntity,
} from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { WriteKnowledgeTool } from '../WriteKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ENTITY TYPE IN THE MODEL'S SPELLING, ON REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.remember` sent `entityType` as the model wrote it, and Qwen writes
 * `person` and `place`. Two different things then happened in Postgres:
 *
 * - `valid_entity_type` (`^[A-Z][A-Za-z]*$`) refuses a lower-case first letter,
 *   so the listener's write failed and the job dead-lettered — the entity never
 *   existed, or the update never landed, after the tool had answered.
 * - A `PERSON` passes the CHECK and is stored. PersonService's STI repository
 *   cannot see it, and `entities_linked_uniq` compares the type byte for byte,
 *   so it sits beside the `Person` twin on the same linked key: a third
 *   spelling where the linked-key refusal meant to stop at two.
 *
 * The controls below show both on the old spellings. The rest is the fix: the
 * tool spells a known type the way ci.entities stores it, the write folds a
 * payload queued before that (the jobs page replays a dead letter verbatim), and
 * migration 20260930165839 repairs the variants the CHECK let through.
 *
 * Harness as in WriteKnowledgeTool.importKey.integration.test.ts: the tool,
 * GraphEventService, GraphUtilityService, GraphQueryService, GraphIngestService
 * and the schema are real; the queue is a JSON round-trip held until `flush()`.
 * Every test runs in one transaction and rolls back. Skips with the reason when
 * nothing listens at `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[WriteKnowledgeTool.entityTypeSpelling.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const MIGRATION = '20260930165839_canonicalize_entity_type_case_variants.sql';
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/postgres/migrations');

/** The `-- migrate:up` half of the migration, as dbmate runs it. */
function migrationUpSql(): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  return down === -1 ? sql : sql.slice(0, down);
}

const logger = {
  setContext: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A contact as the Google Contacts importer sends it. */
const ALEX = {
  key: 'google-contacts:contact:alex@example.com',
  entityType: 'Person',
  name: 'Alex Rivera',
  sourceSystem: 'google-contacts',
  properties: { emails: ['alex@example.com'] },
};

/** A saved place, filed under the legacy Place type the importer writes. */
const HOME = {
  key: 'google-maps:place:home',
  entityType: 'Location',
  name: 'Home',
  sourceSystem: 'google-maps',
  properties: { address: '1 Main St' },
};

const LINKED_ID = GraphIngestService.linkedIdFor(ALEX.key);
const HELD = `the Person linked to import:google-contacts record ${LINKED_ID}`;

describeWithDb(`memory.remember entity types in any spelling (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let owner: string;
  let context: UserServiceContext;
  let ingest: GraphIngestService;
  let graphEvents: GraphEventService;
  let tool: WriteKnowledgeTool;
  let flush: () => Promise<void>;

  const row = async (entityId: string) => {
    const [found] = await runner.query(
      `SELECT entity_type, name, linked_table, linked_id, properties, is_active
         FROM ci.entities WHERE entity_id = $1`,
      [entityId],
    );

    return found as
      | {
          entity_type: string;
          name: string | null;
          linked_table: string | null;
          linked_id: string | null;
          properties: Record<string, unknown>;
          is_active: boolean;
        }
      | undefined;
  };

  /** What PersonService reads: its STI child repository, scoped to `entity_type = 'Person'`. */
  const asPerson = (entityId: string) =>
    runner.manager.getRepository(PersonEntity).findOne({ where: { id: entityId } });

  const importOne = async (entity: Parameters<GraphIngestService['ingest']>[1]['entities'][number]) => {
    const result = await ingest.ingest(context, { entities: [entity], relationships: [] });
    expect(result.errors).toEqual([]);

    return result.entities[0].entityId;
  };

  /** ALEX as the Concept an older parser filed him as — and, unless `withPerson` is false, as a Person too. */
  const importTwins = async (withPerson = true) => ({
    conceptId: await importOne({ ...ALEX, entityType: 'Concept' }),
    personId: withPerson ? await importOne(ALEX) : '',
  });

  /** The rows on Alex's linked key, by type — sorted here: the database's collation is not the test's. */
  const rowsOnAlexKey = async () => {
    const rows: Array<{ entity_id: string; entity_type: string }> = await runner.query(
      `SELECT entity_id, entity_type FROM ci.entities
        WHERE owner_user_id = $1 AND linked_table = 'import:google-contacts' AND linked_id = $2`,
      [owner, LINKED_ID],
    );

    return rows.sort((a, b) => (a.entity_type < b.entity_type ? -1 : a.entity_type > b.entity_type ? 1 : 0));
  };

  beforeAll(async () => {
    const connection = resolveConnection(ENV);

    if (connection == null) {
      throw new Error('availability said yes but no connection resolved');
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
      entities: [
        GraphNodeEntity,
        RelationshipEntity,
        NodeEntity,
        IngestRelationshipEntity,
        EntityIdentifierEntity,
        BaseEntity,
        PersonEntity,
        ConceptEntity,
      ],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();

    // SHARED: these tests row-lock ci.entities / ci.users inside their
    // transaction. See domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'WriteKnowledgeTool.entityTypeSpelling');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    const query = (sql: string, params?: unknown[]) => runner.query(sql, params);
    owner = await createSyntheticTestUser(query, 'WriteKnowledgeTool-entityTypeSpelling');
    context = { userId: owner } as UserServiceContext;

    const manager = runner.manager;
    ingest = new GraphIngestService(
      manager.getRepository(NodeEntity),
      manager.getRepository(IngestRelationshipEntity),
      new EntityIdentifierService(manager.getRepository(EntityIdentifierEntity), logger as never),
      logger as never,
      new GraphDeltaWriter({ query } as never, logger as never),
    );

    const graphUtility = new GraphUtilityService(
      manager.getRepository(GraphNodeEntity),
      manager.getRepository(RelationshipEntity),
      logger as never,
    );

    const queued: Array<{ event: string; body: string }> = [];
    graphEvents = new GraphEventService(
      {
        send: async (event: string, body: unknown) => {
          queued.push({ event, body: JSON.stringify(body) });

          return ['job'];
        },
      } as never,
      logger as never,
    );
    flush = async () => {
      for (const { event, body } of queued.splice(0)) {
        const wire = JSON.parse(body);
        if (event === Events.GRAPH_NODE_UPSERTED) {
          await graphUtility.createOrUpdateNode(wire.ownerId, wire.node);
        } else if (event === Events.GRAPH_RELATIONSHIP_UPSERTED) {
          await graphUtility.createOrUpdateRelationship(wire.ownerId, wire.relationship);
        }
      }
    };

    tool = new WriteKnowledgeTool(
      graphEvents,
      new GraphQueryService({} as never, graphUtility),
      logger as never,
      { getSelfIdentity: async () => null } as never,
    );
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  describe('controls: what the old spellings did', () => {
    it('valid_entity_type refuses `person`, so the write the tool used to queue for it dead-lettered', async () => {
      // Field for field the row createOrUpdateNode built from that payload before the fix.
      const nodes = runner.manager.getRepository(GraphNodeEntity);
      const node = nodes.create({
        entity_id: randomUUID(),
        owner_user_id: owner,
        entity_type: 'person',
        name: 'Jordan Lee',
        properties: {},
        is_active: true,
        is_archived: false,
      });

      await expect(nodes.save(node)).rejects.toThrow('valid_entity_type');
    });

    it('`PERSON` is stored beside the Person twin on its linked key, and PersonService cannot see it', async () => {
      const { conceptId, personId } = await importTwins();

      // The retype as the tool used to send it: the CHECK lets it through, and
      // entities_linked_uniq reads `PERSON` as a key of its own.
      await runner.query(`UPDATE ci.entities SET entity_type = 'PERSON' WHERE entity_id = $1`, [conceptId]);

      expect(await rowsOnAlexKey()).toEqual([
        { entity_id: conceptId, entity_type: 'PERSON' },
        { entity_id: personId, entity_type: 'Person' },
      ]);
      expect(await asPerson(conceptId)).toBeNull();
      expect(await asPerson(personId)).not.toBeNull();
    });
  });

  describe('the tool', () => {
    it('creates a `person` as a Person that PersonService reads', async () => {
      const written = await tool.execute(context, {
        operations: [{ kind: 'entity.create', entityType: 'person', name: 'Jordan Lee' }],
      });
      await flush();

      expect(written.data).toMatchObject({ createdNodes: 1, failures: 0 });
      const entityId = written.data!.results[0].entityId!;
      expect(await row(entityId)).toMatchObject({ entity_type: 'Person', name: 'Jordan Lee' });
      expect(await asPerson(entityId)).toMatchObject({ id: entityId, name: 'Jordan Lee' });
    });

    it('retypes an imported Concept with `person`, and the next Person import of that card finds it', async () => {
      const { conceptId } = await importTwins(false);

      const written = await tool.execute(context, {
        operations: [
          { kind: 'entity.update', entityId: conceptId, entityType: 'person', properties: { a: 1 } },
        ],
      });
      await flush();

      expect(written.data).toMatchObject({ updatedNodes: 1, failures: 0 });
      expect(await row(conceptId)).toMatchObject({ entity_type: 'Person', linked_id: LINKED_ID });
      expect(await asPerson(conceptId)).not.toBeNull();
      expect(
        await runner.manager.getRepository(ConceptEntity).findOne({ where: { id: conceptId } }),
      ).toBeNull();
      expect(await importOne(ALEX)).toBe(conceptId);
    });

    it.each(['person', 'PERSON'])(
      'refuses %j onto the key the Person twin holds, names the twin, and writes nothing',
      async (entityType) => {
        const { conceptId, personId } = await importTwins();
        const before = [await row(conceptId), await row(personId)];

        const written = await tool.execute(context, {
          operations: [{ kind: 'entity.update', entityId: conceptId, entityType, properties: { a: 1 } }],
        });
        await flush();

        expect(written.data).toMatchObject({ updatedNodes: 0, failures: 1 });
        expect(written.data?.results[0].message).toBe(
          `Entity ${conceptId} cannot become ${HELD}: entity ${personId} already is. Update ${personId} ` +
            `instead, and forget ${conceptId} (memory.forget) if it is a duplicate of ${personId}.`,
        );
        expect([await row(conceptId), await row(personId)]).toEqual(before);
        expect(await rowsOnAlexKey()).toHaveLength(2);
      },
    );

    it('reads `contact` on an imported Person as a Person: the update lands and the next import finds the row', async () => {
      const personId = await importOne(ALEX);

      const written = await tool.execute(context, {
        operations: [
          {
            kind: 'entity.update',
            entityId: personId,
            entityType: 'contact',
            properties: { occupation: 'dentist' },
          },
        ],
      });
      await flush();

      expect(written.data).toMatchObject({ updatedNodes: 1, failures: 0 });
      expect(await row(personId)).toMatchObject({
        entity_type: 'Person',
        linked_id: LINKED_ID,
        properties: { ...ALEX.properties, occupation: 'dentist' },
      });
      expect(await importOne(ALEX)).toBe(personId);
    });

    it('reads `place` on an imported Location as that Location, so the next import does not mint a second Home', async () => {
      const homeId = await importOne(HOME);

      const written = await tool.execute(context, {
        operations: [
          { kind: 'entity.create', entityId: homeId, entityType: 'place', properties: { kind: 'home' } },
          { kind: 'entity.update', entityId: homeId, entityType: 'place', name: 'Home (Main St)' },
        ],
      });
      await flush();

      expect(written.data).toMatchObject({ updatedNodes: 2, failures: 0 });
      expect(await row(homeId)).toMatchObject({
        entity_type: 'Location',
        name: 'Home (Main St)',
        properties: { ...HOME.properties, kind: 'home' },
      });
      expect(await importOne(HOME)).toBe(homeId);
    });

    it('refuses a type no row can hold before queueing it, and writes a new type in a storable spelling as given', async () => {
      const refused = await tool.execute(context, {
        operations: [{ kind: 'entity.create', entityType: 'restaurant', name: 'Nopa' }],
      });
      const written = await tool.execute(context, {
        operations: [{ kind: 'entity.create', entityType: 'Restaurant', name: 'Nopa' }],
      });
      await flush();

      expect(refused.data).toMatchObject({ createdNodes: 0, failures: 1 });
      expect(refused.data?.results[0].message).toContain('Entity type "restaurant" cannot be stored');
      expect(written.data).toMatchObject({ createdNodes: 1, failures: 0 });
      const nopa = await runner.query(
        `SELECT entity_type FROM ci.entities WHERE owner_user_id = $1 AND name = 'Nopa'`,
        [owner],
      );
      expect(nopa).toEqual([{ entity_type: 'Restaurant' }]);
    });
  });

  describe('a dead letter queued before the fix, replayed verbatim', () => {
    it('an entity.create for a `person` lands as a Person', async () => {
      const entityId = randomUUID();

      // The payload the tool queued for { entityType: 'person', name: 'Jordan Lee' }.
      await graphEvents.upsertNode(owner, { entityId, entityType: 'person', name: 'Jordan Lee' });
      await flush();

      expect(await row(entityId)).toMatchObject({ entity_type: 'Person', name: 'Jordan Lee' });
      expect(await asPerson(entityId)).not.toBeNull();
    });

    it('an update naming an imported Person `person` applies, and the Person keeps its type and key', async () => {
      const personId = await importOne(ALEX);

      await graphEvents.upsertNode(owner, {
        entityId: personId,
        entityType: 'person',
        properties: { occupation: 'dentist' },
        mergeProperties: true,
      });
      await flush();

      expect(await row(personId)).toMatchObject({
        entity_type: 'Person',
        linked_id: LINKED_ID,
        properties: { ...ALEX.properties, occupation: 'dentist' },
      });
    });
  });

  describe(`migration ${MIGRATION}`, () => {
    const IMPORT = 'import:google-contacts';

    /** Insert a raw row, the way the old tool left it. */
    const insert = async (fields: {
      entityType: string;
      name: string;
      linkedId?: string;
      isActive?: boolean;
      createdAt?: string;
      mergedInto?: string;
    }) => {
      const entityId = randomUUID();
      await runner.query(
        `INSERT INTO ci.entities
           (entity_id, owner_user_id, entity_type, name, linked_table, linked_id, is_active, created_at,
            updated_at, merged_into_entity_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
        [
          entityId,
          owner,
          fields.entityType,
          fields.name,
          fields.linkedId ? IMPORT : null,
          fields.linkedId ?? null,
          fields.isActive ?? true,
          fields.createdAt ?? '2026-09-01T00:00:00Z',
          fields.mergedInto ?? null,
        ],
      );

      return entityId;
    };

    const typesOf = async (ids: Record<string, string>) => {
      const rows: Array<{ entity_id: string; entity_type: string }> = await runner.query(
        `SELECT entity_id, entity_type FROM ci.entities WHERE entity_id = ANY($1::uuid[])`,
        [Object.values(ids)],
      );
      const byId = new Map(rows.map((r) => [r.entity_id, r.entity_type]));

      return Object.fromEntries(Object.entries(ids).map(([label, id]) => [label, byId.get(id)]));
    };

    it('spells each case variant of a known type canonically, and leaves everything else alone', async () => {
      const [freeKey, twinKey, sharedKey, tombstoneKey] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      const survivor = await insert({ entityType: 'Person', name: 'Survivor' });

      const ids = {
        // No linked key: outside entities_linked_uniq, always moves.
        upperPerson: await insert({ entityType: 'PERSON', name: 'Jordan' }),
        upperConcept: await insert({ entityType: 'CONCEPT', name: 'Pilates' }),
        mixedPlace: await insert({ entityType: 'PLaCE', name: 'Gym' }),
        upperOrganization: await insert({ entityType: 'ORGANIZATION', name: 'Acme' }),
        // A linked key nobody holds under the canonical type.
        onFreeKey: await insert({ entityType: 'PerSon', name: 'Sam', linkedId: freeKey }),
        // A linked key the canonical twin already holds: the twin keeps it.
        twin: await insert({ entityType: 'Person', name: 'Alex', linkedId: twinKey }),
        besideTwin: await insert({ entityType: 'PERSON', name: 'Alex', linkedId: twinKey }),
        // Two variants wanting one key: the older takes it.
        olderVariant: await insert({
          entityType: 'PERSON',
          name: 'Kim',
          linkedId: sharedKey,
          createdAt: '2026-08-01T00:00:00Z',
        }),
        newerVariant: await insert({
          entityType: 'PErson',
          name: 'Kim',
          linkedId: sharedKey,
          createdAt: '2026-09-01T00:00:00Z',
        }),
        // A merge tombstone still holds its key, and moves with it.
        tombstone: await insert({
          entityType: 'PERSON',
          name: 'Old Kim',
          linkedId: tombstoneKey,
          isActive: false,
          mergedInto: survivor,
        }),
        // Not a case variant of anything known, or already canonical.
        unknown: await insert({ entityType: 'RESTAURANT', name: 'Nopa' }),
        alias: await insert({ entityType: 'Contact', name: 'Taylor' }),
        canonical: survivor,
      };

      await runner.query(migrationUpSql());

      expect(await typesOf(ids)).toEqual({
        upperPerson: 'Person',
        upperConcept: 'Concept',
        mixedPlace: 'Place',
        upperOrganization: 'Organization',
        onFreeKey: 'Person',
        twin: 'Person',
        besideTwin: 'PERSON',
        olderVariant: 'Person',
        newerVariant: 'PErson',
        tombstone: 'Person',
        unknown: 'RESTAURANT',
        alias: 'Contact',
        canonical: 'Person',
      });
      expect(await asPerson(ids.upperPerson)).not.toBeNull();

      // Nothing left to do: a second run updates no row. `ctid` moves on every
      // UPDATE; `updated_at` cannot tell, since now() is fixed per transaction.
      const locations = () =>
        runner.query(
          `SELECT entity_id, ctid::text AS ctid FROM ci.entities WHERE owner_user_id = $1 ORDER BY 1`,
          [owner],
        );
      const before = await locations();
      await runner.query(migrationUpSql());
      expect(await locations()).toEqual(before);
    });

    it('puts a repaired import row back on the coordinate the importer looks at, so the next import finds it', async () => {
      const conceptId = await importOne({ ...ALEX, entityType: 'Concept' });
      // The old tool's retype of the card's Concept, before any Person import of it.
      await runner.query(`UPDATE ci.entities SET entity_type = 'PERSON' WHERE entity_id = $1`, [conceptId]);

      await runner.query(migrationUpSql());

      expect(await row(conceptId)).toMatchObject({ entity_type: 'Person', linked_id: LINKED_ID });
      expect(await importOne(ALEX)).toBe(conceptId);
      expect(await rowsOnAlexKey()).toEqual([{ entity_id: conceptId, entity_type: 'Person' }]);
    });
  });
});
