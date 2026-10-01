import { DataSource } from 'typeorm';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import type { RequestContext, UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import type { FileService as FileStorageService } from '@ci/domains/files';
import { FileRemovedEvent } from '@ci/domains/files/events';
import {
  BaseEntity,
  CalendarEventService,
  type CommunicationService,
  ContentBaseEntity,
  ContentEntity,
  ContentService,
  EventBaseEntity,
  EventEntity,
  FileService,
  GraphDeltaWriter,
  GraphNodeEntity,
  GraphUtilityService,
  type ItemService,
  RelationshipEntity,
} from '@ci/domains/memory';
import { ContentRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { GRAPH_ENTITY_ENTITIES, graphEntityServices } from '../../../__tests__/support/graphEntityServices';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ForgetKnowledgeTool } from '../ForgetKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `memory.forget` ON A PHOTO'S CONTENT OR EVENT. THE REAL TOOL, THE REAL SERVICES, POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Forgetting a photo's content, or the event it hangs off, deleted the content and left the stored file: its
 * previews, its search rows and its bytes, which are the part that is the photo. The tool said the entity was
 * deleted, and the user believed the photo was gone.
 *
 * The services now delete the file when nothing else uses it, and keep it when something does. The unit suite for
 * the tool proves what it says against doubles. A double cannot say whether the file is then really gone, or really
 * still there, so this file drives the real thing and asks Postgres. Object storage is not Postgres, so it is a
 * stand-in that records what it was asked to delete.
 *
 * The services' own suite is `memory/services/__tests__/WrappedFilePurge.integration.test.ts`; this one is about
 * what the tool does with what they answer, and about the whole round trip a kept file takes: told it was kept,
 * told which File node deletes it anyway, and then deleted by that.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your OWN, or run
 * `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[tools/ForgetKnowledgeTool.wrappedFile.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const BUCKET = 'static';
const DINNER_AT = new Date('2026-08-19T17:00:00Z');

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

describeWithDb(
  `memory.forget on a photo's content or event, against Postgres (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let calendar: CalendarEventService;
    let tool: ForgetKnowledgeTool;

    const ownerId = uuidv7();
    const strangerId = uuidv7();
    const owner = { userId: ownerId } as UserServiceContext;
    const asOwner = { userId: ownerId } as RequestContext;

    /** Every domain event the code under test published, in order. */
    const published: Array<{ name: string; payload: unknown }> = [];
    const signalling = {
      send: jest.fn(async (name: string, payload: unknown) => {
        published.push({ name, payload });

        return [];
      }),
    } as unknown as EventService;

    /** What the object store was asked to delete. */
    const objectCalls: Array<{ bucket: string; keys: string[] }> = [];
    let deleteObjectsImpl: (bucket: string, keys: string[]) => Promise<void> = async () => undefined;
    const storage = {
      deleteObjects: jest.fn((bucket: string, keys: string[]) => {
        objectCalls.push({ bucket, keys: [...keys] });

        return deleteObjectsImpl(bucket, keys);
      }),
    };
    const deletedKeys = (): string[] => objectCalls.flatMap((call) => call.keys).sort();

    function publishedOf(name: string): unknown[] {
      return published.filter((event) => event.name === name).map((event) => event.payload);
    }

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        ...dataSourceConnection(DATABASE_ENV),
        entities: [
          BaseEntity,
          EventEntity,
          EventBaseEntity,
          ContentEntity,
          ContentBaseEntity,
          GraphNodeEntity,
          RelationshipEntity,
          UserEntity,
          ...GRAPH_ENTITY_ENTITIES,
        ],
        synchronize: false,
        extra: { options: '-c search_path=ci,public' },
      });
      await dataSource.initialize();
      schemaLock = await acquireSchemaWriteLock(dataSource, 'tools/ForgetKnowledgeTool.wrappedFile');

      for (const userId of [ownerId, strangerId]) {
        await createSyntheticTestUser(
          (sql, params) => dataSource.query(sql, params),
          'ForgetWrapped',
          userId,
        );
      }

      const deltaWriter = new GraphDeltaWriter(dataSource, logger());
      const store = storage as never;

      calendar = new CalendarEventService(
        dataSource.getRepository(EventEntity),
        dataSource.getRepository(EventBaseEntity),
        signalling,
        dataSource,
        deltaWriter,
        // hbpeNotify and moduleRef, which nothing here needs.
        undefined,
        undefined,
        store,
      );

      const graph = new GraphUtilityService(
        dataSource.getRepository(GraphNodeEntity),
        dataSource.getRepository(RelationshipEntity),
        logger(),
      );
      const contents = new ContentService(
        dataSource.getRepository(ContentEntity),
        dataSource.getRepository(ContentBaseEntity),
        dataSource.getRepository(EventEntity),
        signalling,
        deltaWriter,
        store,
      );
      // `purge` is the one thing this suite calls on the file service, and all it takes of a repository is its
      // manager: the graph's file entity is deliberately not exported from the memory domain.
      const files = new FileService(
        storage as unknown as FileStorageService,
        { manager: dataSource.manager } as never,
        {} as never,
        signalling,
        logger(),
      );

      // A concept named alongside a photo is purged by the real `ConceptService`, as the tool does it.
      const graphEntities = graphEntityServices(dataSource, signalling, logger());

      // No case here names a communication or an item, so the tool never reaches for those.
      tool = new ForgetKnowledgeTool(
        graph,
        signalling,
        calendar,
        contents,
        {} as unknown as CommunicationService,
        {} as unknown as ItemService,
        files,
        graphEntities.people,
        graphEntities.places,
        graphEntities.concepts,
        logger(),
      );
    });

    async function wipe(userId: string): Promise<void> {
      // Both users, whichever one a case pointed at which node: `ci.users.entity_id` is what a case uses
      // to stand in for a table the purge has never heard of, and it would stop this very delete.
      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [
        [ownerId, strangerId],
      ]);
      await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.pipeline_state WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.file_chunks WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.communications WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.content WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.files WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
    }

    beforeEach(() => {
      published.length = 0;
      objectCalls.length = 0;
      storage.deleteObjects.mockClear();
      deleteObjectsImpl = async () => undefined;
    });

    afterEach(async () => {
      await wipe(ownerId);
      await wipe(strangerId);
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
        await schemaLock?.release();
        await dataSource.destroy();
      }
    });

    // ── Fixtures ──────────────────────────────────────────────────────────────

    interface Photo {
      /** The `File` node: what `memory.forget` is given to delete the file itself. */
      nodeId: string;
      /** The `ci.files` row: what a content row's `external_id` holds, and the search rows are keyed by. */
      fileId: string;
      variantId: string;
      originalKey: string;
      variantKey: string;
    }

    /**
     * A stored photo the way the appliance writes one: a `ci.files` row, a preview of it, the `File` node that
     * shadows the first, and the rows that name the file with no foreign key to say so: the pipeline's bookkeeping
     * and the search rows, both keyed by the id of the `ci.files` row.
     */
    async function seedPhoto(name: string, extra: { eventId?: string } = {}): Promise<Photo> {
      const fileId = uuidv7();
      const variantId = uuidv7();
      const nodeId = uuidv7();
      const originalKey = uuidv4();
      const variantKey = uuidv4();

      await dataSource.query(
        `INSERT INTO ci.files (id, filename, content_type, variant, bucket, key, hash, event_id, user_id)
       VALUES ($1, $2, 'image/jpeg', 'ORIGINAL', $3, $4, $5, $6, $7)`,
        [fileId, name, BUCKET, originalKey, `hash-${fileId}`, extra.eventId ?? null, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.files (id, filename, content_type, variant, bucket, key, hash, parent_id, user_id)
       VALUES ($1, $2, 'image/webp', 'PREVIEW', $3, $4, $5, $6, $7)`,
        [variantId, name, BUCKET, variantKey, `hash-${variantId}`, fileId, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'File', $2, '{}'::jsonb, $3, 'files', $4)`,
        [nodeId, name, ownerId, fileId],
      );
      await dataSource.query(
        `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
       VALUES ('file', $1, 'forget_wrapped_spec.stage', 'done', $2)`,
        [fileId, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'file', $1, to_tsvector('simple', $2), $3)`,
        [fileId, name, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.file_chunks (id, file_id, user_id, chunk_index, content, parser_name, parser_version, chunker_version)
       VALUES (gen_random_uuid(), $1, $2, 0, $3, 'forget_wrapped_spec', '1', '1')`,
        [fileId, ownerId, `${name} text`],
      );

      return { nodeId, fileId, variantId, originalKey, variantKey };
    }

    /** The content row an imported photo is the other half of: a `Content` node and its `media` row. */
    async function seedWrapper(
      fileId: string,
      extra: { eventId?: string; title?: string } = {},
    ): Promise<string> {
      const id = uuidv7();

      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
        [id, extra.title ?? 'IMG_0001.jpg', ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.content (id, type, text, mimetype, user_id, event_id, external_id, external_id_kind)
       VALUES ($1, 'media', 'A squirrel on a fence', 'image/jpeg', $2, $3, $4, 'file')`,
        [id, ownerId, extra.eventId ?? null, fileId],
      );

      return id;
    }

    async function seedMessage(fileId: string): Promise<string> {
      const id = uuidv7();

      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Communication', 'a message', '{}'::jsonb, $2, 'communications', $1)`,
        [id, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.communications (id, "time", user_id, communication_type, direction, subject, content, attachments)
       VALUES ($1, now(), $2, 'email', 'inbound', 'photo', 'see attached', $3::jsonb)`,
        [id, ownerId, JSON.stringify([{ type: 'file', id: fileId }])],
      );

      return id;
    }

    async function seedNode(entityType: string, name: string): Promise<string> {
      const id = uuidv7();

      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
        [id, entityType, name, ownerId],
      );

      return id;
    }

    async function seedEvent(title: string): Promise<string> {
      const [created] = await calendar.create(owner, { title, start_time: DINNER_AT });

      return created.id;
    }

    /** Rows of a photo that are still there, by table. */
    async function remains(photo: Photo): Promise<Record<string, number>> {
      const count = async (sql: string, ids: string[]): Promise<number> => {
        const [{ count: n }] = await dataSource.query(sql, [ids]);

        return Number(n);
      };

      const files = [photo.fileId, photo.variantId];

      return {
        node: await count('SELECT count(*) FROM ci.entities WHERE entity_id = ANY($1::uuid[])', [
          photo.nodeId,
        ]),
        files: await count('SELECT count(*) FROM ci.files WHERE id = ANY($1::uuid[])', files),
        chunks: await count('SELECT count(*) FROM ci.file_chunks WHERE file_id = ANY($1::uuid[])', files),
        pipelineState: await count(
          'SELECT count(*) FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])',
          files,
        ),
        vectors: await count(
          'SELECT count(*) FROM ci_search.vectors WHERE entity_id = ANY($1::uuid[])',
          files,
        ),
      };
    }

    const WHOLE = { node: 1, files: 2, chunks: 1, pipelineState: 1, vectors: 1 };
    const GONE = { node: 0, files: 0, chunks: 0, pipelineState: 0, vectors: 0 };

    async function nodeExists(id: string): Promise<boolean> {
      return (await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [id])).length === 1;
    }

    async function forget(
      entityIds: string[],
      mode: 'archive' | 'archive_and_delete' = 'archive_and_delete',
    ) {
      return tool.execute(asOwner, { entityIds, mode });
    }

    // ── Cases ─────────────────────────────────────────────────────────────────

    it('forgets a photo’s content and its stored file with it: rows, previews, search rows and bytes', async () => {
      const photo = await seedPhoto('Trip photo');
      const control = await seedPhoto('Shopping list photo');
      const content = await seedWrapper(photo.fileId, { title: 'Trip photo' });
      const controlContent = await seedWrapper(control.fileId);

      // Precondition: every kind of row is there, so "gone" below means the purge took it.
      expect(await remains(photo)).toEqual(WHOLE);

      const result = await forget([content]);

      expect(result.success).toBe(true);
      expect(result.data?.archivedEntityIds).toEqual([content]);
      expect(await remains(photo)).toEqual(GONE);
      expect(await nodeExists(content)).toBe(false);
      // The bytes went too, which nothing else in the application deletes.
      expect(deletedKeys()).toEqual([photo.originalKey, photo.variantKey].sort());
      // The tool says what went that nobody named: the photo's file, and its preview with it.
      expect(result.data?.warnings).toEqual([
        `Also deleted, along with the content or event that held them, because nothing else used them: stored file(s) ${photo.fileId}, and 1 copy(ies) of them (previews, thumbnails, playback versions).`,
      ]);
      // Search is told by the id of the `ci.files` row, which is what its rows are keyed by.
      expect(
        (publishedOf(FileRemovedEvent) as Array<{ fileId: string }>).map((event) => event.fileId).sort(),
      ).toEqual([photo.fileId, photo.variantId].sort());
      expect(publishedOf(ContentRemovedEvent)).toEqual([{ contentId: content }]);
      // Another photo is exactly as it was.
      expect(await remains(control)).toEqual(WHOLE);
      expect(await nodeExists(controlContent)).toBe(true);
    });

    it('forgets an event’s photos with it, and says so', async () => {
      const trip = await seedEvent('Trip');
      const photo = await seedPhoto('Trip photo');

      await seedWrapper(photo.fileId, { eventId: trip });

      const result = await forget([trip]);

      expect(result.success).toBe(true);
      expect(await remains(photo)).toEqual(GONE);
      expect(deletedKeys()).toEqual([photo.originalKey, photo.variantKey].sort());
      expect(result.data?.warnings).toEqual([
        `Also deleted, along with the content or event that held them, because nothing else used them: stored file(s) ${photo.fileId}, and 1 copy(ies) of them (previews, thumbnails, playback versions).`,
      ]);
    });

    it('forgets a file linked straight to an event, which no content wraps', async () => {
      const screen = await seedEvent('Screen');
      const photo = await seedPhoto('Screenshot', { eventId: screen });

      const result = await forget([screen]);

      expect(result.success).toBe(true);
      expect(await remains(photo)).toEqual(GONE);
      expect(deletedKeys()).toEqual([photo.originalKey, photo.variantKey].sort());
    });

    it('keeps the file when a message still shows it, says what keeps it, and names the File node that deletes it anyway', async () => {
      const photo = await seedPhoto('Photo in a message');
      const content = await seedWrapper(photo.fileId);
      const message = await seedMessage(photo.fileId);

      const result = await forget([content]);

      // A kept file is not a failure: the content is gone, and the call says what is left and why.
      expect(result.success).toBe(true);
      expect(await nodeExists(content)).toBe(false);
      expect(await remains(photo)).toEqual(WHOLE);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
      expect(publishedOf(FileRemovedEvent)).toEqual([]);
      expect(result.data?.warnings).toEqual([
        `Not deleted: stored file ${photo.fileId} is still used by message(s) ${message}. Forget its File node ${photo.nodeId} to delete it anyway.`,
      ]);
      // The message is exactly as it was.
      expect(await nodeExists(message)).toBe(true);

      // The File node the call named is the way to delete it anyway, and that is a call of its own.
      const again = await forget([photo.nodeId]);

      expect(again.success).toBe(true);
      expect(await remains(photo)).toEqual(GONE);
      expect(deletedKeys()).toEqual([photo.originalKey, photo.variantKey].sort());
      expect(await nodeExists(message)).toBe(true);
    });

    it('forgets a photo’s content and its File node named in the same call, and deletes the file once', async () => {
      const photo = await seedPhoto('Trip photo');
      const content = await seedWrapper(photo.fileId);
      const concept = await seedNode('Concept', 'Jazz');

      const result = await forget([content, photo.nodeId, concept]);

      expect(result.success).toBe(true);
      // All three were named and all three are gone.
      expect(result.data?.archivedEntityIds).toEqual([content, photo.nodeId, concept]);
      expect(await remains(photo)).toEqual(GONE);
      expect(await nodeExists(concept)).toBe(false);
      // One call to the store, for one file and its preview: the File node went with its content and was not
      // purged a second time.
      expect(objectCalls).toEqual([{ bucket: BUCKET, keys: [photo.originalKey, photo.variantKey].sort() }]);
    });

    it('does not touch the file in archive mode, which only deactivates the content’s node', async () => {
      const photo = await seedPhoto('Trip photo');
      const content = await seedWrapper(photo.fileId);

      const result = await forget([content], 'archive');

      expect(result.success).toBe(true);
      expect(await remains(photo)).toEqual(WHOLE);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
      expect(publishedOf(FileRemovedEvent)).toEqual([]);
    });

    it('says that nothing was deleted, and that trying again is safe, when the object store fails', async () => {
      const photo = await seedPhoto('Trip photo');
      const content = await seedWrapper(photo.fileId);

      deleteObjectsImpl = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:9000');
      };

      const result = await forget([content]);

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ code: 'EXECUTION_ERROR', retryable: true });
      expect(result.error?.message).toContain('nothing was deleted from the database');
      expect(result.error?.message).toContain('ECONNREFUSED');
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
      expect(result.error?.details).not.toHaveProperty('storedObjectsDeletedFor');
      // The content is still there, and so is every row of the photo.
      expect(await nodeExists(content)).toBe(true);
      expect(await remains(photo)).toEqual(WHOLE);
      expect(publishedOf(FileRemovedEvent)).toEqual([]);

      // The store comes back, and forgetting the content again goes through.
      deleteObjectsImpl = async () => undefined;

      expect((await forget([content])).success).toBe(true);
      expect(await remains(photo)).toEqual(GONE);
    });

    it('names the content whose photo is gone when the database then refuses, and finishes it on a second try', async () => {
      const photo = await seedPhoto('Trip photo');
      const content = await seedWrapper(photo.fileId);

      // `ci.users.entity_id` references ci.entities with no ON DELETE action: a stand-in for a table the purge has
      // never heard of, which refuses the delete of the content node after the objects have gone.
      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [content, strangerId]);

      const result = await forget([content]);

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { constraint: 'users_entity_id_fkey', table: 'users', storedObjectsDeletedFor: [content] },
      });
      // The message says the one thing the caller must not miss: the content is still listed, and its photo will not
      // open. And it does not promise that trying again helps, because what refused is a foreign key.
      expect(result.error?.message).toContain(
        'The stored contents of these were deleted but the entities were not',
      );
      expect(result.error?.message).toContain(
        `Retrying cannot finish the job until what references them is removed: ${content}.`,
      );
      expect(result.error?.details).not.toHaveProperty('deletedEntityIds');

      // The bytes went and the rows did not, so the rows still say where the bytes were.
      expect(deletedKeys()).toEqual([photo.originalKey, photo.variantKey].sort());
      expect(await nodeExists(content)).toBe(true);
      expect(await remains(photo)).toEqual(WHOLE);
      expect(publishedOf(FileRemovedEvent)).toEqual([]);

      // Whatever refused is removed, and forgetting the content again finishes the job.
      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = $1', [strangerId]);
      objectCalls.length = 0;

      const again = await forget([content]);

      expect(again.success).toBe(true);
      expect(await remains(photo)).toEqual(GONE);
      expect(await nodeExists(content)).toBe(false);
      expect(deletedKeys()).toEqual([photo.originalKey, photo.variantKey].sort());
    });

    it('names the event whose photo is gone when the database then refuses', async () => {
      const trip = await seedEvent('Trip');
      const photo = await seedPhoto('Trip photo');

      await seedWrapper(photo.fileId, { eventId: trip });
      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [trip, strangerId]);

      const result = await forget([trip]);

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        code: 'CONSTRAINT_VIOLATION',
        retryable: false,
        details: { storedObjectsDeletedFor: [trip] },
      });
      expect(result.error?.message).toContain(trip);
      expect(await remains(photo)).toEqual(WHOLE);
    });
  },
);
