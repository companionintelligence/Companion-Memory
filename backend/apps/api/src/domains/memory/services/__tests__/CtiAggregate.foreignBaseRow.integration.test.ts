import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { chunkedConflictInsert } from '@ci/common/persistence';
import type { EventService } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { CommunicationBaseEntity } from '../../entities/CommunicationBaseEntity';
import { CommunicationEntity } from '../../entities/CommunicationEntity';
import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { ItemBaseEntity } from '../../entities/ItemBaseEntity';
import { ItemEntity } from '../../entities/ItemEntity';
import { platformIdentity } from '../../identity';
import { CommunicationType, type CreateCommunicationDto } from '../../types';
import { CommunicationService } from '../CommunicationService';
import { ContentService } from '../ContentService';
import { CtiAggregate, type RepositoryProvider } from '../CtiAggregate';
import { ItemService } from '../ItemService';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A BULK CREATE UNDER AN ENTITY ID ANOTHER OWNER'S BASE ROW HOLDS — REAL PG.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A CTI aggregate is a detail row plus a `ci.entities` base row under one id,
 * and `ci.entities`' primary key is `entity_id` alone. The bulk writers insert
 * the detail row, then the base row with `ON CONFLICT (entity_id) DO NOTHING`
 * — CommunicationService with `DO UPDATE SET name, description`. So a caller-
 * named id already held by someone else's entity was not an error to that
 * INSERT but a conflict it resolved: DO NOTHING left the caller's detail row
 * hanging off the other owner's entity, and DO UPDATE rewrote its name and
 * description as well.
 *
 * The detail tables' `(id, entity_type)` foreign keys are DEFERRABLE INITIALLY
 * DEFERRED and reject another TYPE's entity at COMMIT. Nothing rejected another
 * OWNER's entity of the same type that has no detail row of its own — an entity
 * a graph ingest or `write_knowledge` wrote under that type, or a legacy row
 * the CTI conversions kept. Once attached, the caller's own update and remove
 * reach it too: CtiAggregate authorizes on the detail row, then writes the base
 * row by id alone.
 *
 * Reachable from `/v1/communications`, `/v1/contents` and `/v1/things`, whose
 * records take `id: z.string().uuid().optional()` and pass it through.
 *
 * Every test runs in one transaction on one connection and rolls back, so the
 * deferred foreign keys would never fire on their own: a test that has to show
 * what a COMMIT would keep runs `SET CONSTRAINTS ALL IMMEDIATE` first. Opt-in
 * like the sibling suites: skips with the reason when nothing listens at
 * `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[CtiAggregate.foreignBaseRow.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = {
  setContext: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

type AggregateType = 'Communication' | 'Content' | 'Item';

interface StoredEntity {
  /** The tuple's physical address: any UPDATE — even one writing the same values — moves it. */
  ctid: string;
  entity_type: string;
  owner_user_id: string | null;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
}

describeWithDb(`CTI bulk create under another owner's entity id (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let alice: string;
  let bob: string;
  let asAlice: UserServiceContext;
  let communications: CommunicationService;
  let contents: ContentService;
  let items: ItemService;

  const newUser = (label: string) =>
    createSyntheticTestUser((sql: string, params?: unknown[]) => runner.query(sql, params), label);

  /**
   * A typed entity with no detail row, as a graph ingest leaves one: the base
   * row alone, which is all the deferred foreign key needs to be satisfied.
   */
  const bareEntity = async (ownerId: string | null, entityType: AggregateType | 'Person') => {
    const entityId = uuidv7();
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, description, properties)
       VALUES ($1, $2, $3, 'Dr. Lee, re: results', 'Kept by its owner', '{"pinned": true}')`,
      [entityId, entityType, ownerId],
    );

    return entityId;
  };

  const stored = async (entityId: string): Promise<StoredEntity | undefined> => {
    const [row] = await runner.query(
      `SELECT ctid::text AS ctid, entity_type, owner_user_id, name, description, properties
         FROM ci.entities
        WHERE entity_id = $1`,
      [entityId],
    );

    return row;
  };

  /** Owner of the detail row under this id, in whichever detail table it lives. */
  const detailOwner = async (entityId: string): Promise<string | undefined> => {
    const [row] = await runner.query(
      `SELECT user_id FROM ci.communications WHERE id = $1
       UNION ALL SELECT user_id FROM ci.content WHERE id = $1
       UNION ALL SELECT user_id FROM ci.objects WHERE object_id = $1`,
      [entityId],
    );

    return row?.user_id;
  };

  /** What a COMMIT would check: the detail tables' deferred `(id, entity_type)` keys. */
  const checkDeferredKeys = () => runner.query('SET CONSTRAINTS ALL IMMEDIATE');

  /** One `/v1` record of each kind, as its flush hands it to the service. */
  const createUnder: Record<AggregateType, (id: string) => Promise<unknown>> = {
    Communication: (id) =>
      communications.createMany(asAlice, [
        {
          id,
          time: new Date('2026-09-30T12:00:00Z'),
          communication_type: CommunicationType.EMAIL,
          direction: 'inbound',
          subject: 'Written by Alice',
          content: 'Written by Alice',
        },
      ]),
    Content: (id) =>
      contents.createMany(asAlice, [
        { id, type: 'note', title: 'Written by Alice', text: 'Written by Alice' },
      ]),
    Item: (id) => items.createMany(asAlice, [{ id, name: 'Written by Alice' }]),
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
        BaseEntity,
        UserEntity,
        CommunicationBaseEntity,
        CommunicationEntity,
        ContentBaseEntity,
        ContentEntity,
        EventBaseEntity,
        EventEntity,
        ItemBaseEntity,
        ItemEntity,
      ],
      synchronize: false,
    });
    await dataSource.initialize();

    // SHARED: these tests row-lock ci.entities / ci.users inside their
    // transaction. See domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'CtiAggregate.foreignBaseRow');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    alice = await newUser('CtiAggregate-foreignBaseRow-alice');
    bob = await newUser('CtiAggregate-foreignBaseRow-bob');
    asAlice = { userId: alice } as UserServiceContext;

    const manager = runner.manager;
    const signalling = { send: jest.fn(async () => []) } as unknown as EventService;

    communications = new CommunicationService(
      manager.getRepository(CommunicationEntity),
      signalling,
      logger,
      dataSource,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      noopGraphDeltaWriter() as any,
    );
    contents = new ContentService(
      manager.getRepository(ContentEntity),
      manager.getRepository(ContentBaseEntity),
      manager.getRepository(EventEntity),
      signalling,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      noopGraphDeltaWriter() as any,
    );
    items = new ItemService(
      manager.getRepository(ItemEntity),
      manager.getRepository(ItemBaseEntity),
      logger,
      signalling,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      noopGraphDeltaWriter() as any,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await runner.rollbackTransaction();
    await runner.release();
  });

  describe("control: the base-row conflict resolved another owner's entity into the caller's write", () => {
    /** insertBaseRows before the fix, verbatim: the conflict insert and nothing after it. */
    async function insertBaseRowsBeforeTheFix(
      this: { options: { baseEntity: new () => BaseEntity } },
      manager: RepositoryProvider,
      rows: BaseEntity[],
      onConflict: string,
    ): Promise<void> {
      if (rows.length === 0) {
        return;
      }

      await chunkedConflictInsert(manager.getRepository(this.options.baseEntity), rows, onConflict);
    }

    beforeEach(() => {
      jest
        .spyOn(CtiAggregate.prototype, 'insertBaseRows')
        .mockImplementation(insertBaseRowsBeforeTheFix as never);
    });

    it("/v1/communications renamed Bob's entity and hung Alice's message off it", async () => {
      const bobsEntity = await bareEntity(bob, 'Communication');

      await createUnder.Communication(bobsEntity);
      await checkDeferredKeys();

      expect(await stored(bobsEntity)).toMatchObject({
        owner_user_id: bob,
        name: 'Written by Alice',
        description: null,
      });
      expect(await detailOwner(bobsEntity)).toBe(alice);
    });

    it("/v1/contents hung Alice's content off Bob's entity, and her remove then deleted it", async () => {
      const bobsEntity = await bareEntity(bob, 'Content');

      await createUnder.Content(bobsEntity);
      await checkDeferredKeys();

      expect(await stored(bobsEntity)).toMatchObject({ owner_user_id: bob, name: 'Dr. Lee, re: results' });
      expect(await detailOwner(bobsEntity)).toBe(alice);

      expect(await contents.remove(asAlice, bobsEntity)).toBe(true);
      expect(await stored(bobsEntity)).toBeUndefined();
    });

    it("/v1/things hung Alice's thing off Bob's entity, and her update then renamed it", async () => {
      const bobsEntity = await bareEntity(bob, 'Item');

      await createUnder.Item(bobsEntity);
      await checkDeferredKeys();
      expect(await detailOwner(bobsEntity)).toBe(alice);

      await items.update(asAlice, bobsEntity, { name: 'Renamed by Alice' });

      expect(await stored(bobsEntity)).toMatchObject({ owner_user_id: bob, name: 'Renamed by Alice' });
    });
  });

  describe.each<AggregateType>(['Communication', 'Content', 'Item'])('%s', (entityType) => {
    it.each<[string, () => Promise<string>]>([
      ['another user', () => bareEntity(bob, entityType)],
      // `entities_owner_user_id_fkey` is ON DELETE SET NULL: deleting a user
      // leaves their entities behind with no owner.
      ['no one', () => bareEntity(null, entityType)],
    ])(
      'refuses an id whose base row belongs to %s, and leaves that entity untouched',
      async (_label, arrange) => {
        const entityId = await arrange();
        const before = await stored(entityId);

        await expect(createUnder[entityType](entityId)).rejects.toThrow(`is not owned by ${alice}`);

        expect(await stored(entityId)).toEqual(before);
        expect(await detailOwner(entityId)).toBeUndefined();
        await checkDeferredKeys();
      },
    );

    it('writes under an id the caller names when no entity holds it', async () => {
      const entityId = uuidv7();

      await createUnder[entityType](entityId);
      await checkDeferredKeys();

      expect(await stored(entityId)).toMatchObject({
        entity_type: entityType,
        owner_user_id: alice,
        name: 'Written by Alice',
      });
      expect(await detailOwner(entityId)).toBe(alice);
    });
  });

  it("refuses another owner's entity of another type too, before the deferred key has to", async () => {
    const bobsPerson = await bareEntity(bob, 'Person');
    const before = await stored(bobsPerson);

    await expect(createUnder.Communication(bobsPerson)).rejects.toThrow(`is not owned by ${alice}`);

    expect(await stored(bobsPerson)).toEqual(before);
  });

  it("re-ingests the caller's own record through the conflict, as before", async () => {
    const identity = platformIdentity('gmail', 'msg-18c2a');
    const record: CreateCommunicationDto = {
      time: new Date('2026-09-30T12:00:00Z'),
      communication_type: CommunicationType.EMAIL,
      direction: 'inbound',
      subject: 'Lunch?',
      content: 'Lunch on Friday?',
      source_type: 'email',
      source_system: identity.system,
      source_id: identity.id,
    };

    const [first] = await communications.createMany(asAlice, [record]);
    // The same message again, with its subject edited at the source.
    const [again] = await communications.createMany(asAlice, [{ ...record, subject: 'Lunch on Friday?' }]);
    await checkDeferredKeys();

    expect(again.id).toBe(first.id);
    expect(await stored(first.id)).toMatchObject({ owner_user_id: alice, name: 'Lunch on Friday?' });
  });
});
