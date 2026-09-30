import { DataSource, type QueryRunner, type Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { RelationshipEntity } from '../../entities/RelationshipEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WRITING AN EDGE THAT IS ALREADY THERE — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `relationships_unique_directed_idx` is UNIQUE on (from_entity_id,
 * to_entity_id, relationship_type) WHERE is_active. createOrUpdateRelationship
 * used to look a write up by `relationship_id` alone, so an edge restated under
 * no id or a fresh one — `memory.remember` restating what an import wrote — was
 * a plain INSERT beside the active edge, and died on that index. Through
 * GraphEventListener that failed the job, pg-boss retried it into the dead
 * letter queue, and the properties it carried were lost.
 *
 * What only Postgres can show: the index firing (the control), INSERT …
 * ON CONFLICT yielding to it without raising, the insert defaults, and a clash
 * on the primary key still raising. The coordinate match itself is covered
 * over an in-memory table in GraphUtilityService.createOrUpdate.test.ts.
 *
 * Every test runs in one transaction on one connection and rolls back. Opt-in
 * like the sibling suites: skips with the reason when nothing listens at
 * `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(
    `[GraphUtilityService.createOrUpdateRelationship.integration] SKIPPED — ${availability.reason}`,
  );
}

jest.setTimeout(60_000);

const logger = { setContext: () => undefined };

interface StoredEdge {
  relationship_id: string;
  owner_user_id: string | null;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  strength: number;
  is_bidirectional: boolean;
  properties: Record<string, unknown>;
  is_active: boolean;
}

describeWithDb(`GraphUtilityService.createOrUpdateRelationship (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let edges: Repository<RelationshipEntity>;
  let service: GraphUtilityService;
  let owner: string;
  let alex: string;
  let sam: string;

  const newUser = (prefix: string) =>
    createSyntheticTestUser((sql: string, params?: unknown[]) => runner.query(sql, params), prefix);

  const newPerson = async (ownerId: string, name: string) => {
    const entityId = uuidv7();
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Person', $2, '{}'::jsonb, $3)`,
      [entityId, name, ownerId],
    );

    return entityId;
  };

  /** An edge as an importer leaves it: owned, one-way, with properties of its own. */
  const importedEdge = async (fields: Partial<StoredEdge> = {}) => {
    const edge = {
      relationship_id: uuidv7(),
      owner_user_id: owner,
      from_entity_id: alex,
      to_entity_id: sam,
      relationship_type: 'KNOWS',
      strength: 0.4,
      is_bidirectional: false,
      properties: { source: 'google-contacts' },
      ...fields,
    };
    await runner.query(
      `INSERT INTO ci.relationships
         (relationship_id, owner_user_id, from_entity_id, to_entity_id, relationship_type,
          strength, is_bidirectional, properties, from_entity_type, to_entity_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'Person', 'Person')`,
      [
        edge.relationship_id,
        edge.owner_user_id,
        edge.from_entity_id,
        edge.to_entity_id,
        edge.relationship_type,
        edge.strength,
        edge.is_bidirectional,
        JSON.stringify(edge.properties),
      ],
    );

    return edge.relationship_id;
  };

  const edgesBetween = (from: string, to: string): Promise<StoredEdge[]> =>
    runner.query(
      `SELECT relationship_id, owner_user_id, from_entity_id, to_entity_id, relationship_type,
              strength, is_bidirectional, properties, is_active
         FROM ci.relationships
        WHERE from_entity_id = $1 AND to_entity_id = $2`,
      [from, to],
    );

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
      entities: [GraphNodeEntity, RelationshipEntity],
      synchronize: false,
    });
    await dataSource.initialize();

    // SHARED: these tests row-lock ci.entities / ci.users inside their
    // transaction. See domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'GraphUtilityService.createOrUpdateRelationship');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    owner = await newUser('GraphUtility-relationshipCoordinate');
    alex = await newPerson(owner, 'Alex Rivera');
    sam = await newPerson(owner, 'Sam Lee');

    edges = runner.manager.getRepository(RelationshipEntity);
    service = new GraphUtilityService(runner.manager.getRepository(GraphNodeEntity), edges, logger as never);
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it('control: a plain insert of an edge that is already active violates relationships_unique_directed_idx', async () => {
    // Field for field what createOrUpdateRelationship used to do with a write
    // whose id named no row: create the entity under that id and save() it.
    await importedEdge();

    await expect(
      edges.save(
        edges.create({
          relationship_id: uuidv7(),
          owner_user_id: owner,
          from_entity_id: alex,
          to_entity_id: sam,
          relationship_type: 'KNOWS',
          properties: { context: 'dentist' },
          strength: 1,
          is_bidirectional: false,
          is_active: true,
        }),
      ),
    ).rejects.toThrow('relationships_unique_directed_idx');
  });

  it.each([
    ['no relationshipId', () => undefined],
    ['a fresh relationshipId', () => uuidv7()],
  ])(
    'merges a restated edge carrying %s into the active one instead of inserting beside it',
    async (_label, id) => {
      const edgeId = await importedEdge();

      const { relationship, created } = await service.createOrUpdateRelationship(owner, {
        relationshipId: id(),
        fromEntityId: alex,
        toEntityId: sam,
        relationshipType: 'KNOWS',
        properties: { context: 'dentist' },
      });

      expect(created).toBe(false);
      expect(relationship.relationship_id).toBe(edgeId);
      expect(await edgesBetween(alex, sam)).toEqual([
        expect.objectContaining({
          relationship_id: edgeId,
          strength: 0.4,
          is_bidirectional: false,
          properties: { source: 'google-contacts', context: 'dentist' },
          is_active: true,
        }),
      ]);
    },
  );

  it('inserts a new edge with the defaults, and returns it as written', async () => {
    const { relationship, created } = await service.createOrUpdateRelationship(owner, {
      fromEntityId: alex,
      toEntityId: sam,
      relationshipType: 'KNOWS',
    });

    expect(created).toBe(true);
    expect(relationship.created_at).toBeInstanceOf(Date);
    expect(await edgesBetween(alex, sam)).toEqual([
      expect.objectContaining({
        relationship_id: relationship.relationship_id,
        owner_user_id: owner,
        strength: 1,
        is_bidirectional: false,
        properties: {},
        is_active: true,
      }),
    ]);
  });

  it('inserts beside a forgotten edge rather than bringing it back', async () => {
    const forgotten = await importedEdge();
    await runner.query(`UPDATE ci.relationships SET is_active = false WHERE relationship_id = $1`, [
      forgotten,
    ]);

    const { relationship, created } = await service.createOrUpdateRelationship(owner, {
      fromEntityId: alex,
      toEntityId: sam,
      relationshipType: 'KNOWS',
    });

    expect(created).toBe(true);
    const stored = await edgesBetween(alex, sam);
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationship_id: forgotten, is_active: false }),
        expect.objectContaining({ relationship_id: relationship.relationship_id, is_active: true }),
      ]),
    );
  });

  it('yields to an edge another writer lands between its read and its INSERT, and merges into that', async () => {
    const edgeId = await importedEdge();
    // As if the import's INSERT committed just after this write looked.
    jest.spyOn(service, 'findActiveRelationship').mockResolvedValueOnce(null);

    const { relationship, created } = await service.createOrUpdateRelationship(owner, {
      fromEntityId: alex,
      toEntityId: sam,
      relationshipType: 'KNOWS',
      properties: { context: 'dentist' },
    });

    expect(created).toBe(false);
    expect(relationship.relationship_id).toBe(edgeId);
    // Reading at all proves the transaction survived: a raised unique violation
    // would have aborted it.
    expect(await edgesBetween(alex, sam)).toEqual([
      expect.objectContaining({
        relationship_id: edgeId,
        properties: { source: 'google-contacts', context: 'dentist' },
      }),
    ]);
  });

  it("refuses to write onto an active edge on the coordinate that another owner's row holds", async () => {
    // Every edge writer stamps the endpoints' owner, so this row should not
    // exist — which is why the write stops rather than adopting it.
    const stranger = await newUser('GraphUtility-relationshipCoordinate-stranger');
    const foreignEdge = await importedEdge({ owner_user_id: stranger });

    await expect(
      service.createOrUpdateRelationship(owner, {
        fromEntityId: alex,
        toEntityId: sam,
        relationshipType: 'KNOWS',
        properties: { context: 'dentist' },
      }),
    ).rejects.toThrow(`does not belong to owner ${owner}`);

    expect(await edgesBetween(alex, sam)).toEqual([
      expect.objectContaining({
        relationship_id: foreignEdge,
        owner_user_id: stranger,
        properties: { source: 'google-contacts' },
      }),
    ]);
  });

  it("raises on a relationshipId another owner's row holds, instead of taking that row over", async () => {
    // TypeORM's save() looks a row up by primary key alone, so the old
    // create()+save() for a "new" id that another owner's row held turned into
    // an UPDATE of that row. The INSERT only yields on the coordinate index.
    const stranger = await newUser('GraphUtility-relationshipCoordinate-stranger');
    const [theirFrom, theirTo] = [await newPerson(stranger, 'Jo'), await newPerson(stranger, 'Kim')];
    const theirEdge = await importedEdge({
      owner_user_id: stranger,
      from_entity_id: theirFrom,
      to_entity_id: theirTo,
    });

    await runner.query('SAVEPOINT before_write');
    await expect(
      service.createOrUpdateRelationship(owner, {
        relationshipId: theirEdge,
        fromEntityId: alex,
        toEntityId: sam,
        relationshipType: 'KNOWS',
      }),
    ).rejects.toThrow('relationships_pkey');
    await runner.query('ROLLBACK TO SAVEPOINT before_write');

    expect(await edgesBetween(theirFrom, theirTo)).toEqual([
      expect.objectContaining({ relationship_id: theirEdge, owner_user_id: stranger }),
    ]);
    expect(await edgesBetween(alex, sam)).toEqual([]);
  });

  describe('a write by id that puts its row on a coordinate another active edge holds', () => {
    // The by-id branch assigned the payload's from/to/type and save()d, so a
    // retype, a move, or a forgotten row brought back onto a held coordinate
    // was an UPDATE this index refuses. Through GraphEventListener the job
    // dead-lettered — after `memory.remember` had answered "Updated
    // relationship". It now stops before any statement runs.
    const edge = async (relationshipId: string): Promise<StoredEdge> => {
      const [found] = await runner.query(
        `SELECT relationship_id, owner_user_id, from_entity_id, to_entity_id, relationship_type,
                strength, is_bidirectional, properties, is_active
           FROM ci.relationships WHERE relationship_id = $1`,
        [relationshipId],
      );

      return found as StoredEdge;
    };

    const forget = (relationshipId: string) =>
      runner.query(`UPDATE ci.relationships SET is_active = false WHERE relationship_id = $1`, [
        relationshipId,
      ]);

    it('control: the by-id retype as it used to be written — load, assign, save() — violates the index', async () => {
      const knows = await importedEdge();
      await importedEdge({ relationship_type: 'FRIENDS_WITH', properties: { met: 'school' } });

      const row = await edges.findOneOrFail({ where: { relationship_id: knows } });
      row.relationship_type = 'FRIENDS_WITH';

      await expect(edges.save(row)).rejects.toThrow('relationships_unique_directed_idx');
    });

    it.each([
      [
        'retypes it',
        async () => {
          const moved = await importedEdge();
          const held = await importedEdge({
            relationship_type: 'FRIENDS_WITH',
            properties: { met: 'school' },
          });

          return {
            moved,
            held,
            write: { fromEntityId: alex, toEntityId: sam, relationshipType: 'FRIENDS_WITH' },
          };
        },
      ],
      [
        'moves it to other endpoints',
        async () => {
          const jo = await newPerson(owner, 'Jo Park');
          const moved = await importedEdge();
          const held = await importedEdge({ to_entity_id: jo, properties: { met: 'work' } });

          return { moved, held, write: { fromEntityId: alex, toEntityId: jo, relationshipType: 'KNOWS' } };
        },
      ],
      [
        'brings a forgotten row back',
        async () => {
          const moved = await importedEdge();
          await forget(moved);
          const held = await importedEdge({ properties: { source: 'linkedin' } });

          return { moved, held, write: { fromEntityId: alex, toEntityId: sam, relationshipType: 'KNOWS' } };
        },
      ],
    ])(
      'refuses a write that %s before writing anything, and names the edge in the way',
      async (_label, arrange) => {
        const { moved, held, write } = await arrange();
        const [movedBefore, heldBefore] = [await edge(moved), await edge(held)];

        await expect(
          service.createOrUpdateRelationship(owner, {
            relationshipId: moved,
            ...write,
            properties: { context: 'dentist' },
            strength: 0.9,
          }),
        ).rejects.toThrow(
          `Relationship ${moved} cannot become ${write.fromEntityId} -[${write.relationshipType}]-> ` +
            `${write.toEntityId}: relationship ${held} is already the active edge there`,
        );

        // Reading at all proves no statement failed: a unique violation would
        // have aborted the transaction.
        expect(await edge(moved)).toEqual(movedBefore);
        expect(await edge(held)).toEqual(heldBefore);
      },
    );

    it('retypes a row onto a coordinate only a forgotten edge holds, which the partial index allows', async () => {
      const knows = await importedEdge();
      const forgotten = await importedEdge({ relationship_type: 'FRIENDS_WITH' });
      await forget(forgotten);

      const { relationship, created } = await service.createOrUpdateRelationship(owner, {
        relationshipId: knows,
        fromEntityId: alex,
        toEntityId: sam,
        relationshipType: 'FRIENDS_WITH',
        properties: { context: 'dentist' },
      });

      expect(created).toBe(false);
      expect(relationship.relationship_id).toBe(knows);
      expect(await edge(knows)).toMatchObject({
        relationship_type: 'FRIENDS_WITH',
        strength: 0.4,
        properties: { source: 'google-contacts', context: 'dentist' },
        is_active: true,
      });
      expect(await edge(forgotten)).toMatchObject({ relationship_type: 'FRIENDS_WITH', is_active: false });
    });

    it("refuses a coordinate another owner's edge holds, since the index is not scoped to an owner", async () => {
      const stranger = await newUser('GraphUtility-relationshipCoordinate-stranger');
      const knows = await importedEdge();
      const foreign = await importedEdge({ owner_user_id: stranger, relationship_type: 'FRIENDS_WITH' });

      await expect(
        service.createOrUpdateRelationship(owner, {
          relationshipId: knows,
          fromEntityId: alex,
          toEntityId: sam,
          relationshipType: 'FRIENDS_WITH',
        }),
      ).rejects.toThrow(`the active edge there does not belong to owner ${owner}`);

      expect(await edge(knows)).toMatchObject({ relationship_type: 'KNOWS', is_active: true });
      expect(await edge(foreign)).toMatchObject({ owner_user_id: stranger, is_active: true });
    });
  });
});
