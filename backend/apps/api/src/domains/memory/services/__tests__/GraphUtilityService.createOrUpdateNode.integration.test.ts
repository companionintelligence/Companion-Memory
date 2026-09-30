import { DataSource, type QueryRunner, type Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { RelationshipEntity } from '../../entities/RelationshipEntity';
import { GraphEventListener } from '../../listeners/GraphEventListener';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A NODE WRITE UNDER AN ID ANOTHER OWNER'S ROW HOLDS — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ci.entities`' primary key is `entity_id` alone. createOrUpdateNode used to
 * look a write up by `(entity_id, owner_user_id)`; when that missed it built a
 * row under the given id and handed it to TypeORM's save(), which decides
 * insert-vs-update by loading the primary key alone. So an id held by someone
 * else's row became an UPDATE of that row: `owner_user_id` flipped to the
 * caller, name / description / search_content were overwritten, the linked key
 * cleared, the properties bag emptied — and the call reported `created: true`.
 *
 * Reachable from `write_knowledge`: `entity.create` with an `entityId` checks
 * for the row through an owner-scoped read, which sees another owner's id as
 * "no row", queues the write, and GraphEventListener hands it to
 * createOrUpdateNode.
 *
 * What only Postgres can show: the takeover itself (the control), the refusal
 * leaving the row byte-for-byte where it was, and the INSERT failing on
 * `entities_pkey` when the id is taken after the read.
 *
 * Every test runs in one transaction on one connection and rolls back. Opt-in
 * like the sibling suites: skips with the reason when nothing listens at
 * `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[GraphUtilityService.createOrUpdateNode.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = {
  setContext: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** What an import leaves on a contact, plus the keys later writers fold in. */
const IMPORTED_BAG = {
  emails: ['jo@example.com'],
  phones: ['+15551230001'],
  planner: { trust_mode: 'ask' },
};

interface StoredNode {
  /** The tuple's physical address: any UPDATE — even one writing the same values — moves it. */
  ctid: string;
  owner_user_id: string | null;
  entity_type: string;
  name: string | null;
  description: string | null;
  search_content: string | null;
  linked_table: string | null;
  linked_id: string | null;
  properties: Record<string, unknown>;
  is_active: boolean;
  is_archived: boolean;
}

describeWithDb(`GraphUtilityService.createOrUpdateNode (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let nodes: Repository<GraphNodeEntity>;
  let service: GraphUtilityService;
  let alice: string;
  let bob: string;
  /** Bob's imported contact — the row Alice's writes must never land on. */
  let bobsContact: string;
  let bobsContactAsImported: StoredNode;

  const newUser = (label: string) =>
    createSyntheticTestUser((sql: string, params?: unknown[]) => runner.query(sql, params), label);

  /** A Person as an import leaves it: owned, keyed to its source, carrying a bag. */
  const importedPerson = async (ownerId: string, name: string) => {
    const entityId = uuidv7();
    await runner.query(
      `INSERT INTO ci.entities
         (entity_id, entity_type, owner_user_id, name, description, search_content,
          linked_table, linked_id, properties)
       VALUES ($1, 'Person', $2, $3, $4, $5, 'import:google-contacts', $6, $7::jsonb)`,
      [
        entityId,
        ownerId,
        name,
        `${name}, from Google Contacts`,
        `${name} jo@example.com`,
        uuidv7(),
        JSON.stringify(IMPORTED_BAG),
      ],
    );

    return entityId;
  };

  const stored = async (entityId: string): Promise<StoredNode> => {
    const [row] = await runner.query(
      `SELECT ctid::text AS ctid, owner_user_id, entity_type, name, description, search_content,
              linked_table, linked_id, properties, is_active, is_archived
         FROM ci.entities
        WHERE entity_id = $1`,
      [entityId],
    );

    return row;
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
      entities: [GraphNodeEntity, RelationshipEntity],
      synchronize: false,
    });
    await dataSource.initialize();

    // SHARED: these tests row-lock ci.entities / ci.users inside their
    // transaction. See domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'GraphUtilityService.createOrUpdateNode');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    alice = await newUser('GraphUtility-nodeOwner-alice');
    bob = await newUser('GraphUtility-nodeOwner-bob');
    bobsContact = await importedPerson(bob, 'Jo Park');
    bobsContactAsImported = await stored(bobsContact);

    nodes = runner.manager.getRepository(GraphNodeEntity);
    service = new GraphUtilityService(
      nodes,
      runner.manager.getRepository(RelationshipEntity),
      logger as never,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await runner.rollbackTransaction();
    await runner.release();
  });

  it("control: save() of a node built under an id another owner's row holds takes that row over", async () => {
    // Field for field the row createOrUpdateNode used to build for
    // `{ entityId: bobsContact, entityType: 'Person', name: 'Written by Alice' }`
    // once its owner-scoped read had missed, and the save() it handed it to.
    await nodes.save(
      nodes.create({
        entity_id: bobsContact,
        owner_user_id: alice,
        entity_type: 'Person',
        name: 'Written by Alice',
        description: 'Written by Alice',
        properties: {},
        search_content: 'Written by Alice',
        linked_table: null,
        linked_id: null,
        is_active: true,
        is_archived: false,
      }),
    );

    expect(await stored(bobsContact)).toMatchObject({
      owner_user_id: alice,
      name: 'Written by Alice',
      description: 'Written by Alice',
      search_content: 'Written by Alice',
      linked_table: null,
      linked_id: null,
      properties: {},
    });
  });

  it.each([
    ['another user', async () => undefined],
    [
      'another user, who forgot it',
      async () =>
        runner.query(`UPDATE ci.entities SET is_active = false WHERE entity_id = $1`, [bobsContact]),
    ],
    [
      // `entities_owner_user_id_fkey` is ON DELETE SET NULL: deleting a user
      // leaves their rows behind with no owner.
      'no one',
      async () =>
        runner.query(`UPDATE ci.entities SET owner_user_id = NULL WHERE entity_id = $1`, [bobsContact]),
    ],
  ])(
    'refuses an entityId whose row belongs to %s, and leaves that row untouched',
    async (_label, arrange) => {
      await arrange();
      const before = await stored(bobsContact);

      await expect(
        service.createOrUpdateNode(alice, {
          entityId: bobsContact,
          entityType: 'Person',
          name: 'Written by Alice',
        }),
      ).rejects.toThrow(`is not owned by ${alice}`);

      expect(await stored(bobsContact)).toEqual(before);
    },
  );

  it("fails the job on the payload write_knowledge queues for another owner's id, instead of overwriting the row", async () => {
    // `entity.create` with Bob's id, as GraphEventService.upsertNode puts it on
    // the queue. Throwing is the whole point: the @OnEvent wrapper fails the
    // ack, and pg-boss retries the job into the dead letter queue.
    const send = jest.fn(async () => ['job']);
    const listener = new GraphEventListener(service, { send } as never, logger as never);

    await expect(
      listener.handleNodeUpserted({
        ownerId: alice,
        node: {
          entityId: bobsContact,
          entityType: 'Person',
          name: 'Written by Alice',
          description: null,
          properties: {},
          searchContent: null,
          linkedTable: null,
          linkedId: null,
          mergeProperties: false,
        },
      }),
    ).rejects.toThrow(`is not owned by ${alice}`);

    expect(send).not.toHaveBeenCalled();
    expect(await stored(bobsContact)).toEqual(bobsContactAsImported);
  });

  it("raises on the primary key when another owner's row takes the id between the read and the INSERT", async () => {
    // As if Bob's row committed just after this write looked the id up.
    jest.spyOn(nodes, 'findOne').mockResolvedValueOnce(null);

    await runner.query('SAVEPOINT before_write');
    await expect(
      service.createOrUpdateNode(alice, {
        entityId: bobsContact,
        entityType: 'Person',
        name: 'Written by Alice',
      }),
    ).rejects.toThrow('entities_pkey');
    await runner.query('ROLLBACK TO SAVEPOINT before_write');

    expect(await stored(bobsContact)).toEqual(bobsContactAsImported);
  });

  it('inserts a node under a fresh id with the defaults, and returns it as written', async () => {
    const { node, created } = await service.createOrUpdateNode(alice, {
      entityType: 'Concept',
      name: 'Bebop',
    });

    expect(created).toBe(true);
    expect(node).toMatchObject({ owner_user_id: alice, entity_type: 'Concept', name: 'Bebop' });
    // Filled in by Postgres and handed back by the INSERT.
    expect(node.created_at).toBeInstanceOf(Date);
    expect(node.updated_at).toBeInstanceOf(Date);
    expect(await stored(node.entity_id)).toMatchObject({
      owner_user_id: alice,
      entity_type: 'Concept',
      name: 'Bebop',
      description: 'Bebop',
      search_content: 'Bebop',
      linked_table: null,
      linked_id: null,
      properties: {},
      is_active: true,
      is_archived: false,
    });
  });

  it('inserts under an id the caller names when no row holds it', async () => {
    const entityId = uuidv7();
    const linkedId = uuidv7();

    const { node, created } = await service.createOrUpdateNode(alice, {
      entityId,
      entityType: 'Person',
      name: 'Sam Lee',
      properties: { emails: ['sam@example.com'] },
      linkedTable: 'import:google-contacts',
      linkedId,
    });

    expect(created).toBe(true);
    expect(node.entity_id).toBe(entityId);
    expect(await stored(entityId)).toMatchObject({
      owner_user_id: alice,
      name: 'Sam Lee',
      linked_table: 'import:google-contacts',
      linked_id: linkedId,
      properties: { emails: ['sam@example.com'] },
    });
  });

  describe("the caller's own node", () => {
    let alicesContact: string;
    let alicesContactAsImported: StoredNode;

    beforeEach(async () => {
      alicesContact = await importedPerson(alice, 'Sam Lee');
      alicesContactAsImported = await stored(alicesContact);
    });

    it('updates it by id: an omitted field keeps its value, null clears it, properties merge', async () => {
      const { node, created } = await service.createOrUpdateNode(alice, {
        entityId: alicesContact,
        name: 'Sam Q. Lee',
        description: null,
        properties: { occupation: 'dentist' },
      });

      expect(created).toBe(false);
      expect(node.entity_id).toBe(alicesContact);
      expect(await stored(alicesContact)).toMatchObject({
        owner_user_id: alice,
        entity_type: 'Person',
        name: 'Sam Q. Lee',
        description: null,
        search_content: alicesContactAsImported.search_content,
        linked_table: 'import:google-contacts',
        linked_id: alicesContactAsImported.linked_id,
        properties: { ...IMPORTED_BAG, occupation: 'dentist' },
      });
    });

    it('replaces the bag when mergeProperties is false', async () => {
      await service.createOrUpdateNode(alice, {
        entityId: alicesContact,
        properties: { occupation: 'dentist' },
        mergeProperties: false,
      });

      expect((await stored(alicesContact)).properties).toEqual({ occupation: 'dentist' });
    });

    it('finds it by id after it was forgotten and brings it back, rather than inserting beside it', async () => {
      await runner.query(`UPDATE ci.entities SET is_active = false WHERE entity_id = $1`, [alicesContact]);

      const { created } = await service.createOrUpdateNode(alice, {
        entityId: alicesContact,
        name: 'Sam Lee',
      });

      expect(created).toBe(false);
      expect(await stored(alicesContact)).toMatchObject({ owner_user_id: alice, is_active: true });
    });
  });
});
