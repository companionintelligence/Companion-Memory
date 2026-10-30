import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { HbpeNotifyService } from '@ci/common/hbpe';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { CommunicationBaseEntity } from '../../entities/CommunicationBaseEntity';
import { CommunicationEntity } from '../../entities/CommunicationEntity';
import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { CommunicationType } from '../../types';
import { CalendarEventService } from '../CalendarEventService';
import { CommunicationService } from '../CommunicationService';
import { ContentService } from '../ContentService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

import { stubPipelineReopeners } from './harness/pipelineReopeners';

/**
 * A write that names another account's row is refused, in Postgres.
 *
 * Messages, events and content take ids for the people, places, devices,
 * tasks and events they link to, and the keys on those columns only ask that
 * the row exists (the entity columns have no key at all). So a message from
 * another account's person, or an event at another account's place, was stored
 * as sent. An import of the account's own export then refused to restore it
 * (`UserDataPortabilityService.refuseLinksOutOfAccount`). Each case writes as
 * `owner` with an id of `other`'s and checks that the write is refused and
 * nothing landed.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/foreignLinks.integration] SKIPPED — ${availability.reason}`);
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

const refused = (field: string, id: string, table: string, what: string) =>
  `${field} ${id} is a row of ${table} that belongs to another account or to none, so the ${what} was refused.`;

describeWithDb(`Writes that link to another account's rows, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let communications: CommunicationService;
  let events: CalendarEventService;
  let contents: ContentService;

  const ownerId = uuidv7();
  const otherId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;

  const myPerson = uuidv7();
  const theirPerson = uuidv7();
  const theirPlace = uuidv7();
  const theirDevice = uuidv7();
  const theirTask = uuidv7();
  const theirEvent = uuidv7();

  const signalling = { send: jest.fn(async () => []) } as unknown as EventService;
  const hbpe = {
    notifyCommunications: jest.fn(async () => undefined),
    notifyEvents: jest.fn(async () => undefined),
  } as unknown as HbpeNotifyService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [
        BaseEntity,
        UserEntity,
        CommunicationBaseEntity,
        CommunicationEntity,
        ContentBaseEntity,
        ContentEntity,
        EventBaseEntity,
        EventEntity,
      ],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/foreignLinks');

    for (const userId of [ownerId, otherId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ForeignLinks', userId);
    }

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name)
       VALUES ($1, 'Person', $2, 'Me'), ($3, 'Person', $4, 'Them'), ($5, 'Location', $4, 'Their home')`,
      [myPerson, ownerId, theirPerson, otherId, theirPlace],
    );
    await dataSource.query(
      `INSERT INTO ci.devices (device_id, user_id, device_name, device_type) VALUES ($1, $2, 'Their phone', 'phone')`,
      [theirDevice, otherId],
    );
    await dataSource.query(`INSERT INTO ci.tasks (id, user_id, title) VALUES ($1, $2, 'Their task')`, [
      theirTask,
      otherId,
    ]);
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Event', $2, 'Their party')`,
      [theirEvent, otherId],
    );
    await dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, start_time) VALUES ($1, $2, '2026-10-01T18:00:00Z')`,
      [theirEvent, otherId],
    );

    communications = new CommunicationService(
      dataSource.getRepository(CommunicationEntity),
      signalling,
      logger(),
      dataSource,
      new GraphDeltaWriter(dataSource, logger()),
      hbpe,
    );
    events = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      signalling as never,
      dataSource,
      new GraphDeltaWriter(dataSource, logger()),
      hbpe as never,
      stubPipelineReopeners().moduleRef as never,
    );
    contents = new ContentService(
      dataSource.getRepository(ContentEntity),
      dataSource.getRepository(ContentBaseEntity),
      dataSource.getRepository(EventEntity),
      signalling,
      new GraphDeltaWriter(dataSource, logger()),
    );
  });

  afterEach(async () => {
    for (const sql of [
      'DELETE FROM ci.graph_deltas WHERE owner_user_id = $1',
      'DELETE FROM ci.relationships WHERE owner_user_id = $1',
      'DELETE FROM ci.record_sources WHERE user_id = $1',
      'DELETE FROM ci.content WHERE user_id = $1',
      'DELETE FROM ci.communications WHERE user_id = $1',
      'DELETE FROM ci.events WHERE user_id = $1',
    ]) {
      await dataSource.query(sql, [ownerId]);
    }

    // The person every case may link to stays for the next case.
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1 AND entity_id <> $2', [
      ownerId,
      myPerson,
    ]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const users = [ownerId, otherId];

      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.tasks WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.devices WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [users]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const count = async (sql: string): Promise<number> => Number((await dataSource.query(sql, [ownerId]))[0].n);

  const message = (subject: string, link: Record<string, unknown> = {}) => ({
    time: new Date('2026-10-20T09:00:00Z'),
    communication_type: CommunicationType.EMAIL,
    direction: 'inbound' as const,
    subject,
    content: `${subject} body`,
    ...link,
  });

  describe('messages', () => {
    it("refuses a batch with a message from another account's person, and takes one from the account's own", async () => {
      await expect(
        communications.createMany(owner, [
          message('mine', { from_entity_id: myPerson }),
          message('theirs', { from_entity_id: theirPerson }),
        ]),
      ).rejects.toThrow(refused('from_entity_id', theirPerson, 'ci.entities', 'message'));
      expect(await count('SELECT count(*) AS n FROM ci.communications WHERE user_id = $1')).toBe(0);

      const [mine] = await communications.createMany(owner, [message('mine', { from_entity_id: myPerson })]);

      expect(mine.fromEntityId).toBe(myPerson);
    });

    it("refuses a message to another account's person", async () => {
      await expect(
        communications.create(owner, message('to them', { to_entity_ids: [myPerson, theirPerson] })),
      ).rejects.toThrow(refused('to_entity_ids', theirPerson, 'ci.entities', 'message'));
      expect(await count('SELECT count(*) AS n FROM ci.communications WHERE user_id = $1')).toBe(0);
    });

    it("refuses a message sent from another account's device", async () => {
      await expect(
        communications.createMany(owner, [message('from their phone', { device_id: theirDevice })]),
      ).rejects.toThrow(refused('device_id', theirDevice, 'ci.devices', 'message'));
    });

    it("refuses an update that makes another account's person the sender", async () => {
      const [stored] = await communications.createMany(owner, [message('plain')]);

      // An empty body is how a caller leaves the body alone (see updateCommunication).
      await expect(
        communications.update(owner, stored.id, { content: '', from_entity_id: theirPerson }),
      ).rejects.toThrow(refused('from_entity_id', theirPerson, 'ci.entities', 'message'));
      expect((await communications.findById(owner, stored.id))?.fromEntityId ?? null).toBeNull();
    });
  });

  describe('events', () => {
    const event = (title: string, link: Record<string, unknown> = {}) => ({
      title,
      start_time: new Date('2026-10-21T18:00:00Z'),
      end_time: new Date('2026-10-21T19:00:00Z'),
      ...link,
    });

    it("refuses a batch with an event at another account's place", async () => {
      await expect(
        events.create(owner, [event('dinner'), event('their place', { location_entity_id: theirPlace })]),
      ).rejects.toThrow(refused('location_entity_id', theirPlace, 'ci.entities', 'event'));
      expect(await count('SELECT count(*) AS n FROM ci.events WHERE user_id = $1')).toBe(0);
    });

    it("refuses an event whose guests include another account's person", async () => {
      await expect(
        events.create(owner, event('party', { participant_entity_ids: [myPerson, theirPerson] })),
      ).rejects.toThrow(refused('participant_entity_ids', theirPerson, 'ci.entities', 'event'));
      expect(await count('SELECT count(*) AS n FROM ci.events WHERE user_id = $1')).toBe(0);
    });

    it("refuses a planned block for another account's task", async () => {
      await expect(events.create(owner, [event('block', { task_id: theirTask })])).rejects.toThrow(
        refused('task_id', theirTask, 'ci.tasks', 'event'),
      );
    });

    it("refuses an update that makes another account's person the organizer", async () => {
      const [stored] = await events.create(owner, [event('meeting', { organizer_entity_id: myPerson })]);

      await expect(events.update(owner, stored.id, { organizer_entity_id: theirPerson })).rejects.toThrow(
        refused('organizer_entity_id', theirPerson, 'ci.entities', 'event'),
      );
      expect((await events.findById(owner, stored.id))?.organizerEntityId).toBe(myPerson);
    });

    it("refuses an update that files the event under another account's event", async () => {
      const [stored] = await events.create(owner, [event('afterparty')]);

      await expect(events.update(owner, stored.id, { parent_event_id: theirEvent })).rejects.toThrow(
        refused('parent_event_id', theirEvent, 'ci.events', 'event'),
      );
    });
  });

  describe('content', () => {
    it("refuses a batch with content on another account's event", async () => {
      await expect(
        contents.createMany(owner, [
          { type: 'note', text: 'mine' },
          { type: 'note', text: 'theirs', event: { id: theirEvent } },
        ]),
      ).rejects.toThrow(refused('event_id', theirEvent, 'ci.events', 'content'));
      expect(await count('SELECT count(*) AS n FROM ci.content WHERE user_id = $1')).toBe(0);
    });

    it("refuses one piece of content on another account's event", async () => {
      await expect(
        contents.create(owner, { type: 'note', text: 'theirs', event: { id: theirEvent } }),
      ).rejects.toThrow(refused('event_id', theirEvent, 'ci.events', 'content'));
      expect(await count('SELECT count(*) AS n FROM ci.content WHERE user_id = $1')).toBe(0);
    });
  });
});
