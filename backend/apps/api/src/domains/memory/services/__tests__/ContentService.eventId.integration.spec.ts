import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { EventService as SignallingEventService } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { ContentService } from '../ContentService';
import type { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * A content row reports the event it links (`ci.content.event_id`).
 *
 * `eventId` used to be read off the `event` relation, which no read joins, so it was null on
 * every row fetched while the column held the id (seen 2026-11-11: a Drive photo's content row
 * linked its EXIF-dated media event, and search, the API and GraphQL's `ContentType.event` all
 * said it had none). The column is now mapped beside the relation, as `userId` is beside `user`,
 * so writes name the same `event_id` twice; pinned against Postgres because only a real insert
 * shows which of the two TypeORM writes.
 */
const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ContentService.eventId.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ContentService reports a content row's event (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let contentService: ContentService;

  const ownerCtx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  const linkedContent = uuidv7();
  const unlinkedContent = uuidv7();
  let eventId: string;

  const signalling = { send: jest.fn(async () => []) } as unknown as SignallingEventService;

  async function seedEvent(): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', 'photo', '{}'::jsonb, $2, 'events', $1)`,
      [id, ownerCtx.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, event_type, source_type, source_system, source_id)
       VALUES ($1::uuid, $2, '2026-04-18T23:20:58Z'::timestamptz, 'media', 'ci.import', 'contentEventId_spec', $1::text)`,
      [id, ownerCtx.userId],
    );

    return id;
  }

  async function seedContent(contentId: string, linkedEventId: string | null) {
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', 'fixture', '{}'::jsonb, $2, 'content', $1)`,
      [contentId, ownerCtx.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.content (id, type, mimetype, user_id, event_id, source_type, source_system, source_id)
       VALUES ($1::uuid, 'media', 'image/jpeg', $2, $3, 'ci.import', 'contentEventId_spec', $1::text)`,
      [contentId, ownerCtx.userId, linkedEventId],
    );
  }

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
      entities: [BaseEntity, UserEntity, ContentBaseEntity, ContentEntity, EventBaseEntity, EventEntity],
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ContentService.eventId.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [ownerCtx.userId, 'Content eventId fixture', `contenteventid.${ownerCtx.userId}@example.invalid`],
    );

    eventId = await seedEvent();
    await seedContent(linkedContent, eventId);
    await seedContent(unlinkedContent, null);

    contentService = new ContentService(
      dataSource.getRepository(ContentEntity),
      dataSource.getRepository(ContentBaseEntity),
      dataSource.getRepository(EventEntity),
      signalling,
      {
        entityCreated: async () => undefined,
        entityUpdated: async () => undefined,
        recordMany: async () => undefined,
      } as unknown as GraphDeltaWriter,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ownerCtx.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ownerCtx.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('findByIds reports the linked event, and null for a row without one', async () => {
    const [linked, unlinked] = await contentService.findByIds(ownerCtx, [linkedContent, unlinkedContent]);

    expect(linked?.eventId).toBe(eventId);
    expect(unlinked?.eventId).toBeNull();
  });

  it('findById reports it too', async () => {
    await expect(contentService.findById(ownerCtx, linkedContent)).resolves.toMatchObject({ eventId });
  });

  // `toDetailFields` hands TypeORM the relation and the column from one value. A write that took
  // the (undefined) column over the relation would store NULL and break every photo's date.
  it('create stores the event it is given and reads it back', async () => {
    const createdEvent = await seedEvent();
    const [created] = await contentService.create(ownerCtx, {
      type: 'media',
      mimetype: 'image/jpeg',
      event: { id: createdEvent },
    });

    expect(created.eventId).toBe(createdEvent);

    const [row] = await dataSource.query('SELECT event_id FROM ci.content WHERE id = $1', [created.id]);

    expect(row.event_id).toBe(createdEvent);
  });

  // The bulk path an import takes: one INSERT for the batch, and the event found by the shared
  // provenance triple when the row does not name one.
  it('createMany stores a named event and a triple-matched one', async () => {
    const namedEvent = await seedEvent();
    const tripleEvent = await seedEvent();
    const [named, matched] = await contentService.createMany(
      ownerCtx,
      [
        { type: 'media', mimetype: 'image/jpeg', event: { id: namedEvent } },
        // seedEvent's triple: source_id is the event's own id.
        {
          type: 'media',
          mimetype: 'image/jpeg',
          source_type: 'ci.import',
          source_system: 'contentEventId_spec' as never,
          source_id: tripleEvent as never,
        },
      ],
      { emitCreated: false },
    );

    expect(named.eventId).toBe(namedEvent);
    expect(matched.eventId).toBe(tripleEvent);

    const rows: { id: string; event_id: string }[] = await dataSource.query(
      'SELECT id, event_id FROM ci.content WHERE id = ANY($1::uuid[])',
      [[named.id, matched.id]],
    );

    expect(Object.fromEntries(rows.map((row) => [row.id, row.event_id]))).toEqual({
      [named.id]: namedEvent,
      [matched.id]: tripleEvent,
    });
  });

  it('create without an event stores none', async () => {
    const [created] = await contentService.create(ownerCtx, { type: 'media', mimetype: 'image/jpeg' });
    const [row] = await dataSource.query('SELECT event_id FROM ci.content WHERE id = $1', [created.id]);

    expect(created.eventId).toBeNull();
    expect(row.event_id).toBeNull();
  });
});
