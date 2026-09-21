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
 * `findEventIdsForMedia` is the bridge from "this photo matched" to "show me
 * the event it belongs to". Both legs are SQL over the content row's links —
 * `event_id` for a content hit, `external_id` (kind `'file'`) for a file hit
 * — so they are pinned against Postgres. Opt-in like the sibling specs.
 */
const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ContentService.findEventIdsForMedia.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(
  `ContentService.findEventIdsForMedia maps media hits to events (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let contentService: ContentService;

    const ownerCtx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
    const strangerId = uuidv7();
    const photoEventId = uuidv7();
    const photoContentId = uuidv7();
    const photoFileId = uuidv7();
    const uriEventId = uuidv7();
    const uriContentId = uuidv7();
    const orphanContentId = uuidv7();
    const strangerEventId = uuidv7();
    const strangerContentId = uuidv7();
    const strangerFileId = uuidv7();

    const signalling = { send: jest.fn(async () => []) } as unknown as SignallingEventService;

    async function seedEvent(eventId: string, ownerId: string, name: string): Promise<void> {
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
        [eventId, name, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.events (event_id, user_id, start_time, category, source_type, source_system, source_id)
       VALUES ($1, $2, now(), 'capture', 'ci.import', 'findEventIdsForMedia_spec', $3)`,
        [eventId, ownerId, eventId],
      );
    }

    async function seedContent(args: {
      contentId: string;
      ownerId: string;
      eventId: string | null;
      externalId: string;
      externalIdKind: 'file' | 'external_uri' | null;
    }): Promise<void> {
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', 'fixture', '{}'::jsonb, $2, 'content', $1)`,
        [args.contentId, args.ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.content (id, type, mimetype, external_id, external_id_kind, user_id, event_id, source_type, source_system, source_id)
       VALUES ($1, 'media', 'image/jpeg', $2, $3, $4, $5, 'ci.import', 'findEventIdsForMedia_spec', $6)`,
        [args.contentId, args.externalId, args.externalIdKind, args.ownerId, args.eventId, args.contentId],
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
      schemaLock = await acquireSchemaWriteLock(
        dataSource,
        'memory/ContentService.findEventIdsForMedia.integration',
      );

      for (const [id, name] of [
        [ownerCtx.userId, 'Owner'],
        [strangerId, 'Stranger'],
      ] as const) {
        await dataSource.query(
          `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
          [id, `${name} media-events fixture`, `${name.toLowerCase()}.${id}@example.invalid`],
        );
      }

      for (const [fileId, ownerId] of [
        [photoFileId, ownerCtx.userId],
        [strangerFileId, strangerId],
      ] as const) {
        await dataSource.query(
          `INSERT INTO ci.files (id, filename, content_type, user_id) VALUES ($1, 'fixture.jpg', 'image/jpeg', $2)`,
          [fileId, ownerId],
        );
      }

      await seedEvent(photoEventId, ownerCtx.userId, 'Squirrel on the fence');
      await seedContent({
        contentId: photoContentId,
        ownerId: ownerCtx.userId,
        eventId: photoEventId,
        externalId: photoFileId,
        externalIdKind: 'file',
      });

      await seedEvent(uriEventId, ownerCtx.userId, 'A play');
      await seedContent({
        contentId: uriContentId,
        ownerId: ownerCtx.userId,
        eventId: uriEventId,
        externalId: 'spotify:track:1',
        externalIdKind: 'external_uri',
      });

      await seedContent({
        contentId: orphanContentId,
        ownerId: ownerCtx.userId,
        eventId: null,
        externalId: 'sha256:orphan',
        externalIdKind: null,
      });

      await seedEvent(strangerEventId, strangerId, 'Not yours');
      await seedContent({
        contentId: strangerContentId,
        ownerId: strangerId,
        eventId: strangerEventId,
        externalId: strangerFileId,
        externalIdKind: 'file',
      });

      contentService = new ContentService(
        dataSource.getRepository(ContentEntity),
        dataSource.getRepository(ContentBaseEntity),
        dataSource.getRepository(EventEntity),
        signalling,
        {
          entityCreated: async () => undefined,
          entityUpdated: async () => undefined,
        } as unknown as GraphDeltaWriter,
      );
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        const users = [ownerCtx.userId, strangerId];
        await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1)', [users]);
        await dataSource.query('DELETE FROM ci.files WHERE user_id = ANY($1)', [users]);
        await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
        await schemaLock?.release();
        await dataSource.destroy();
      }
    });

    it('reaches an event through a file hit via the content row that wraps it', async () => {
      await expect(
        contentService.findEventIdsForMedia(ownerCtx, { contentIds: [], fileIds: [photoFileId] }),
      ).resolves.toEqual([photoEventId]);
    });

    it('reaches an event through a content hit directly', async () => {
      await expect(
        contentService.findEventIdsForMedia(ownerCtx, {
          contentIds: [uriContentId, orphanContentId],
          fileIds: [],
        }),
      ).resolves.toEqual([uriEventId]);
    });

    it('returns each event once when both legs land on it', async () => {
      await expect(
        contentService.findEventIdsForMedia(ownerCtx, {
          contentIds: [photoContentId],
          fileIds: [photoFileId],
        }),
      ).resolves.toEqual([photoEventId]);
    });

    it("never crosses into another user's rows", async () => {
      await expect(
        contentService.findEventIdsForMedia(ownerCtx, {
          contentIds: [strangerContentId],
          fileIds: [strangerFileId],
        }),
      ).resolves.toEqual([]);
    });

    it('is a no-op with nothing to look up', async () => {
      await expect(
        contentService.findEventIdsForMedia(ownerCtx, { contentIds: [], fileIds: [] }),
      ).resolves.toEqual([]);
    });
  },
);
