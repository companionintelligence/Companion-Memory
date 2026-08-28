import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { ServiceContext, UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService as SignallingEventService } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { CommunicationBaseEntity } from '../../entities/CommunicationBaseEntity';
import { CommunicationEntity } from '../../entities/CommunicationEntity';
import { ConceptEntity } from '../../entities/ConceptEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { ItemBaseEntity } from '../../entities/ItemBaseEntity';
import { ItemEntity } from '../../entities/ItemEntity';
import { CommunicationDirection, CommunicationType } from '../../types';
import { CommunicationService } from '../CommunicationService';
import { ConceptService } from '../ConceptService';
import { EventService } from '../EventService';
import { ItemService } from '../ItemService';

import { noopGraphDeltaWriter } from './harness/noopGraphDeltaWriter';

/**
 * The tenancy-scoping mechanism EVERY non-bulk update/delete in this domain
 * relies on, PROVED against real Postgres.
 *
 * `EntityService.scopeToUser` (the generic base every simple entity service
 * composes) and `CtiAggregate`'s three inline `scopedWhere` closures
 * (ItemService, EventService, CommunicationService — one per composing
 * service, see each constructor) are what turn a plain `findOne`/`update`/
 * `delete` into a user-scoped one. Every unit spec in this slice mocks
 * `findOne` unconditionally, so none of them can tell a correctly-scoped
 * `where` clause from a broken one — a regression that dropped the
 * `userId`/`user.id` clause from any of these closures (e.g. while sharing
 * code between them) would let one user edit or delete another user's
 * Concept/Item/Event/Communication, and nothing would fail.
 *
 * This proves the negative case directly: a stranger's update/remove against
 * another user's row is rejected (returns null/false) AND leaves the row
 * untouched, for all four composing services — the generic `EntityService`
 * path (via `ConceptService`, whose `update`/`remove` call
 * `applyUpdate`/`delete` straight through with no override) and the three
 * `CtiAggregate` closures, including `EventService`'s, which scopes through a
 * `user: { id }` RELATION rather than a flat `userId` column and so exercises
 * a structurally different join than the other two.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a database
 * with the migrations applied — `databaseAvailability` probes it and this
 * suite SKIPS legibly, never fails, when nothing is reachable.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest tenancyScoping.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/tenancyScoping.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(
  `memory-domain tenancy scoping rejects cross-user writes in Postgres (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;

    // Fresh per run, so two concurrent runs cannot collide on ci.users.
    const owner: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
    const strangerId = uuidv7();
    const stranger: ServiceContext = { userId: strangerId } as ServiceContext;

    const noopLogger = {
      setContext: () => undefined,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as LoggerService;

    // The domain event bus is not under test here; every service gets a stub.
    const send = jest.fn<Promise<string[]>, [unknown, unknown]>(async () => []);
    const signalling = { send } as unknown as SignallingEventService;

    let conceptService: ConceptService;
    let itemService: ItemService;
    let eventService: EventService;
    let communicationService: CommunicationService;

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
        entities: [
          BaseEntity,
          UserEntity,
          ConceptEntity,
          ItemBaseEntity,
          ItemEntity,
          EventBaseEntity,
          EventEntity,
          CommunicationBaseEntity,
          CommunicationEntity,
        ],
      });
      await dataSource.initialize();

      // SHARED: this suite commits rows in ci.entities/ci.objects/ci.events/
      // ci.communications/ci.users, which a migration suite may be altering
      // inside its own transaction. See domains/__tests__/support/schemaLock.ts.
      schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/tenancyScoping.integration');

      for (const [id, name] of [
        [owner.userId, 'Owner'],
        [strangerId, 'Stranger'],
      ] as const) {
        await dataSource.query(
          `INSERT INTO ci.users (id, name, email)
              VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
          [id, `${name} spec fixture`, `${name.toLowerCase()}.${id}@example.invalid`],
        );
      }

      conceptService = new ConceptService(dataSource.getRepository(ConceptEntity), noopLogger, signalling);

      itemService = new ItemService(
        dataSource.getRepository(ItemEntity),
        dataSource.getRepository(ItemBaseEntity),
        noopLogger,
        signalling,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        noopGraphDeltaWriter() as any,
      );

      eventService = new EventService(
        dataSource.getRepository(EventEntity),
        dataSource.getRepository(EventBaseEntity),
        signalling,
        dataSource,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        noopGraphDeltaWriter() as any,
      );

      communicationService = new CommunicationService(
        dataSource.getRepository(CommunicationEntity),
        signalling,
        noopLogger,
        dataSource,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        noopGraphDeltaWriter() as any,
      );
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        const users = [owner.userId, strangerId];

        // Deleting the ci.entities row cascades ci.objects/ci.events/
        // ci.communications via their entities FK (see each *BaseEntity's
        // doc comment) — one statement cleans every table this suite touched.
        await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1)', [users]);
        await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
        // Before destroy(): the lock is held on a runner from this pool.
        await schemaLock?.release();
        await dataSource.destroy();
      }
    });

    beforeEach(() => {
      send.mockClear();
    });

    const readEntityName = async (id: string): Promise<string | null> => {
      const [row] = await dataSource.query('SELECT name FROM ci.entities WHERE entity_id = $1', [id]);

      return (row as { name: string | null } | undefined)?.name ?? null;
    };

    it("ConceptService (EntityService.applyUpdate/delete) rejects a stranger's write and accepts the owner's", async () => {
      const concept = await conceptService.create(owner, { name: 'Original Concept' });

      // The stranger's update must not touch the row at all.
      const strangerUpdate = await conceptService.update(stranger, concept.id, { name: 'Hijacked' });
      expect(strangerUpdate).toBeNull();
      expect(await readEntityName(concept.id)).toBe('Original Concept');

      const strangerRemove = await conceptService.remove(stranger, concept.id);
      expect(strangerRemove).toBe(false);
      expect(await readEntityName(concept.id)).toBe('Original Concept');

      // The owner can still do both.
      const ownerUpdate = await conceptService.update(owner, concept.id, { name: 'Renamed by owner' });
      expect(ownerUpdate?.name).toBe('Renamed by owner');

      const ownerRemove = await conceptService.remove(owner, concept.id);
      expect(ownerRemove).toBe(true);
      expect(await readEntityName(concept.id)).toBeNull();
    });

    it("ItemService (CtiAggregate, flat userId column) rejects a stranger's write and accepts the owner's", async () => {
      const item = await itemService.create(owner, { name: 'Original Item' });

      const strangerUpdate = await itemService.update(stranger, item.id, { name: 'Hijacked' });
      expect(strangerUpdate).toBeNull();
      expect(await readEntityName(item.id)).toBe('Original Item');

      const strangerRemove = await itemService.remove(stranger, item.id);
      expect(strangerRemove).toBe(false);
      expect(await readEntityName(item.id)).toBe('Original Item');

      const ownerUpdate = await itemService.update(owner, item.id, { name: 'Renamed by owner' });
      expect(ownerUpdate?.name).toBe('Renamed by owner');

      const ownerRemove = await itemService.remove(owner, item.id);
      expect(ownerRemove).toBe(true);
      expect(await readEntityName(item.id)).toBeNull();
    });

    it("EventService (CtiAggregate, RELATIONAL user:{id} scoping) rejects a stranger's write and accepts the owner's", async () => {
      const [event] = await eventService.create(owner, {
        title: 'Original Event',
        start_time: new Date('2026-08-01T10:00:00.000Z'),
      });

      const strangerUpdate = await eventService.update(stranger, event.id, { title: 'Hijacked' });
      expect(strangerUpdate).toBeNull();
      expect(await readEntityName(event.id)).toBe('Original Event');

      const strangerRemove = await eventService.remove(stranger, event.id);
      expect(strangerRemove).toBe(false);
      expect(await readEntityName(event.id)).toBe('Original Event');

      const ownerUpdate = await eventService.update(owner, event.id, { title: 'Renamed by owner' });
      expect(ownerUpdate?.title).toBe('Renamed by owner');

      const ownerRemove = await eventService.remove(owner, event.id);
      expect(ownerRemove).toBe(true);
      // Events are tombstoned, not destroyed: the base row survives (so the
      // deletion can be undone) but the event is no longer readable, and a
      // second delete finds nothing to remove.
      expect(await eventService.findById(owner, event.id)).toBeNull();
      expect(await eventService.remove(owner, event.id)).toBe(false);

      expect(await eventService.restore(owner, event.id)).not.toBeNull();
      expect(await readEntityName(event.id)).toBe('Renamed by owner');
    });

    it("CommunicationService (CtiAggregate, flat userId column) rejects a stranger's write and accepts the owner's", async () => {
      const communication = await communicationService.create(owner, {
        time: new Date('2026-08-01T10:00:00.000Z'),
        communication_type: CommunicationType.EMAIL,
        direction: CommunicationDirection.INBOUND,
        subject: 'Original Subject',
        content: 'Hello there',
      });

      const strangerUpdate = await communicationService.update(stranger, communication.id, {
        subject: 'Hijacked',
        content: 'Hello there',
      });
      expect(strangerUpdate).toBeNull();
      expect(await readEntityName(communication.id)).toBe('Original Subject');

      const strangerRemove = await communicationService.remove(stranger, communication.id);
      expect(strangerRemove).toBe(false);
      expect(await readEntityName(communication.id)).toBe('Original Subject');

      const ownerUpdate = await communicationService.update(owner, communication.id, {
        subject: 'Renamed by owner',
        content: 'Hello there',
      });
      expect(ownerUpdate?.subject).toBe('Renamed by owner');

      const ownerRemove = await communicationService.remove(owner, communication.id);
      expect(ownerRemove).toBe(true);
      expect(await readEntityName(communication.id)).toBeNull();
    });
  },
);
