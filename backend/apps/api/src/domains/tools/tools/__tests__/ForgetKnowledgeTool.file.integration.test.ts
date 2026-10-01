import { DataSource } from 'typeorm';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { FileRemovedEvent, type FileService as FileStorageService } from '@ci/domains/files';
import {
  BaseEntity,
  type CalendarEventService,
  type CommunicationService,
  type ContentService,
  FileService,
  GraphNodeEntity,
  GraphUtilityService,
  type ItemService,
  RelationshipEntity,
} from '@ci/domains/memory';
import { ConceptRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { GRAPH_ENTITY_ENTITIES, graphEntityServices } from '../../../__tests__/support/graphEntityServices';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ForgetKnowledgeTool } from '../ForgetKnowledgeTool';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `memory.forget` ON A FILE. THE REAL TOOL, THE REAL SERVICES, POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `archive_and_delete` used to delete a `File` node by deleting its `ci.entities` row. A `File` node is
 * only the graph's shadow of a stored file, joined to it by a plain `linked_id` column, so that deleted
 * the shadow and never reached the file, its variants, its chunks, its search rows or its bytes. The tool
 * said the entity was deleted, and the user believed the file was gone.
 *
 * A file is now purged by `FileService.purge`, as an item is by `ItemService.purge`. The unit suite for the
 * tool proves the routing against doubles. A double cannot say whether the file is then really gone, so
 * this file drives the real thing and asks Postgres. Object storage is not Postgres, so it is a stand-in
 * that records what it was asked to delete.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your OWN, or run
 * `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[tools/ForgetKnowledgeTool.file.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const BUCKET = 'static';

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

/** What `remains` reads once every row of the files it was asked about is gone. */
const NOTHING = {
  nodes: 0,
  files: 0,
  chunks: 0,
  relationships: 0,
  graphDeltas: 0,
  pipelineState: 0,
  vectors: 0,
  embeddings: 0,
};

describeWithDb(`memory.forget on a File node, against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let tool: ForgetKnowledgeTool;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const asOwner = { userId: ownerId } as RequestContext;
  const asStranger = { userId: strangerId } as RequestContext;

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
      entities: [BaseEntity, GraphNodeEntity, RelationshipEntity, UserEntity, ...GRAPH_ENTITY_ENTITIES],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'tools/ForgetKnowledgeTool.file');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ForgetFile', userId);
    }

    const graph = new GraphUtilityService(
      dataSource.getRepository(GraphNodeEntity),
      dataSource.getRepository(RelationshipEntity),
      logger(),
    );

    // `purge` is the one thing this suite calls on the file service, and all it takes of a repository is
    // its manager: the graph's file entity is deliberately not exported from the memory domain.
    const files = new FileService(
      storage as unknown as FileStorageService,
      { manager: dataSource.manager } as never,
      {} as never,
      signalling,
      logger(),
    );

    // A concept is purged by the real `ConceptService`, as the tool does it, and announces through the same
    // `signalling` this suite watches.
    const graphEntities = graphEntityServices(dataSource, signalling, logger());

    // No case here names an event, content, a communication or an item, so the tool never reaches for those.
    tool = new ForgetKnowledgeTool(
      graph,
      signalling,
      {} as unknown as CalendarEventService,
      {} as unknown as ContentService,
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
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.file_chunks WHERE user_id = $1', [userId]);
    await dataSource.query('DELETE FROM ci.content WHERE user_id = $1', [userId]);
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

  async function seedNode(entityType: string, name: string, forUser = ownerId): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
      [id, entityType, name, forUser],
    );

    return id;
  }

  async function seedEdge(from: string, to: string, type: string): Promise<string> {
    const [{ relationship_id }] = await dataSource.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING relationship_id`,
      [from, to, type, ownerId],
    );

    return relationship_id;
  }

  interface SeededFile {
    /** The `File` node: what `memory.forget` is given. */
    nodeId: string;
    /** The `ci.files` row. The pipeline and the search index are keyed by it. */
    fileId: string;
    variantId: string;
    originalKey: string;
    variantKey: string;
  }

  /**
   * A stored file the way the appliance writes one: a `ci.files` row, a preview of it, and the `File`
   * node that shadows the first. Neither is joined to the other by a foreign key.
   */
  async function seedFile(
    name: string,
    extra: { forUser?: string; external?: boolean } = {},
  ): Promise<SeededFile> {
    const forUser = extra.forUser ?? ownerId;
    const fileId = uuidv7();
    const variantId = uuidv7();
    const nodeId = uuidv7();
    const originalKey = uuidv4();
    const variantKey = uuidv4();

    await dataSource.query(
      `INSERT INTO ci.files (id, filename, content_type, variant, bucket, key, hash, external_id, user_id)
       VALUES ($1, $2, 'image/jpeg', 'ORIGINAL', $3, $4, $5, $6, $7)`,
      [
        fileId,
        name,
        extra.external ? null : BUCKET,
        extra.external ? null : originalKey,
        `hash-${fileId}`,
        extra.external ? `drive-${fileId}` : null,
        forUser,
      ],
    );
    await dataSource.query(
      `INSERT INTO ci.files (id, filename, content_type, variant, bucket, key, hash, parent_id, user_id)
       VALUES ($1, $2, 'image/webp', 'PREVIEW', $3, $4, $5, $6, $7)`,
      [variantId, name, BUCKET, variantKey, `hash-${variantId}`, fileId, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'File', $2, '{}'::jsonb, $3, 'files', $4)`,
      [nodeId, name, forUser, fileId],
    );

    return { nodeId, fileId, variantId, originalKey, variantKey };
  }

  /**
   * Rows that name a file and have no foreign key to it: the pipeline's bookkeeping and the search rows,
   * both keyed by the id of the `ci.files` row, and the delta that carries the filename, keyed by the node's.
   * The extracted chunks have a foreign key, and are there to be taken by it.
   */
  async function seedTrail(file: SeededFile, name: string, forUser = ownerId): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, 'File', 'created', jsonb_build_object('name', jsonb_build_object('new', $2::text)), $3)`,
      [file.nodeId, name, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
       VALUES ('file', $1, 'forget_file_spec.stage', 'done', $2)`,
      [file.fileId, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'file', $1, to_tsvector('simple', $2), $3)`,
      [file.fileId, name, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
       VALUES (gen_random_uuid(), 'file', $1, $2)`,
      [file.fileId, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.file_chunks (id, file_id, user_id, chunk_index, content, parser_name, parser_version, chunker_version)
       VALUES (gen_random_uuid(), $1, $2, 0, $3, 'forget_file_spec', '1', '1')`,
      [file.fileId, forUser, `${name} text`],
    );
  }

  /** Rows of these files and their nodes that are still there, by table. */
  async function remains(...files: SeededFile[]): Promise<Record<string, number>> {
    const nodeIds = files.map((file) => file.nodeId);
    const fileIds = files.flatMap((file) => [file.fileId, file.variantId]);
    const count = async (sql: string, ids: string[]): Promise<number> => {
      const [{ count: n }] = await dataSource.query(sql, [ids]);

      return Number(n);
    };

    return {
      nodes: await count('SELECT count(*) FROM ci.entities WHERE entity_id = ANY($1::uuid[])', nodeIds),
      files: await count('SELECT count(*) FROM ci.files WHERE id = ANY($1::uuid[])', fileIds),
      chunks: await count('SELECT count(*) FROM ci.file_chunks WHERE file_id = ANY($1::uuid[])', fileIds),
      relationships: await count(
        `SELECT count(*) FROM ci.relationships
          WHERE from_entity_id = ANY($1::uuid[]) OR to_entity_id = ANY($1::uuid[])`,
        nodeIds,
      ),
      graphDeltas: await count(
        'SELECT count(*) FROM ci.graph_deltas WHERE entity_id = ANY($1::uuid[])',
        nodeIds,
      ),
      pipelineState: await count(
        'SELECT count(*) FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])',
        fileIds,
      ),
      vectors: await count(
        'SELECT count(*) FROM ci_search.vectors WHERE entity_id = ANY($1::uuid[])',
        fileIds,
      ),
      embeddings: await count(
        'SELECT count(*) FROM ci_search.embeddings WHERE entity_id = ANY($1::uuid[])',
        fileIds,
      ),
    };
  }

  async function nodeExists(id: string): Promise<boolean> {
    return (await dataSource.query('SELECT 1 FROM ci.entities WHERE entity_id = $1', [id])).length === 1;
  }

  async function forget(
    entityIds: string[],
    mode: 'archive' | 'archive_and_delete' = 'archive_and_delete',
    who: RequestContext = asOwner,
  ) {
    return tool.execute(who, { entityIds, mode });
  }

  // ── Cases ─────────────────────────────────────────────────────────────────

  it('removes a file, its preview, their objects and every row that names them, and announces it', async () => {
    const file = await seedFile('Trip photo');

    await seedEdge(await seedNode('Person', 'Dana'), file.nodeId, 'CAPTURED');
    await seedEdge(file.nodeId, await seedNode('Location', 'The beach'), 'TAKEN_AT');
    await seedTrail(file, 'Trip photo');

    // Precondition: every kind of row is there, so "gone" below means the purge took it.
    expect(await remains(file)).toEqual({
      nodes: 1,
      files: 2,
      chunks: 1,
      relationships: 2,
      graphDeltas: 1,
      pipelineState: 1,
      vectors: 1,
      embeddings: 1,
    });

    const result = await forget([file.nodeId]);

    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([file.nodeId]);
    // The node, the stored file, its preview, the chunks, the edges in both directions and every row that
    // named any of them by id. The generic delete reached none of it but the node and its edges.
    expect(await remains(file)).toEqual(NOTHING);
    // The objects went too, which nothing else in the application deletes.
    expect(deletedKeys()).toEqual([file.originalKey, file.variantKey].sort());
    // The preview is a copy nobody named, so the tool says it went.
    expect(result.data?.warnings).toEqual([
      `Also deleted, because each was a copy (a preview, thumbnail or playback version) of a file named here: ${file.variantId}.`,
    ]);
    // Search is told by the id of the `ci.files` row, which is what its rows are keyed by.
    expect(
      (publishedOf(FileRemovedEvent) as Array<{ fileId: string }>).map((event) => event.fileId).sort(),
    ).toEqual([file.fileId, file.variantId].sort());
  });

  it('removes a file and a concept named in one call', async () => {
    const file = await seedFile('Trip photo');
    const concept = await seedNode('Concept', 'Jazz');

    await seedTrail(file, 'Trip photo');

    const result = await forget([file.nodeId, concept]);

    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([file.nodeId, concept]);
    expect(await remains(file)).toEqual(NOTHING);
    expect(await nodeExists(concept)).toBe(false);
    expect(publishedOf(ConceptRemovedEvent)).toEqual([{ conceptId: concept }]);
  });

  it('does not purge a file in archive mode, which only deactivates its node', async () => {
    const file = await seedFile('Trip photo');

    await seedTrail(file, 'Trip photo');

    const result = await forget([file.nodeId], 'archive');

    expect(result.success).toBe(true);
    // The stored file, its objects, its chunks and its search rows are as they were, and nobody is told that
    // anything was deleted: archiving a file's node does not make the file go away.
    expect(await remains(file)).toMatchObject({ nodes: 1, files: 2, chunks: 1, vectors: 1, embeddings: 1 });
    expect(storage.deleteObjects).not.toHaveBeenCalled();
    expect(publishedOf(FileRemovedEvent)).toEqual([]);
  });

  it('removes a file whose node was archived earlier, which is what archive then delete means', async () => {
    const file = await seedFile('Trip photo');

    await seedTrail(file, 'Trip photo');
    expect((await forget([file.nodeId], 'archive')).success).toBe(true);

    const result = await forget([file.nodeId]);

    expect(result.success).toBe(true);
    expect(await remains(file)).toEqual(NOTHING);
    expect(deletedKeys()).toEqual([file.originalKey, file.variantKey].sort());
  });

  it('removes a file that came from a source, which has no stored bytes, without asking the object store', async () => {
    const file = await seedFile('Drive photo', { external: true });

    const result = await forget([file.nodeId]);

    expect(result.success).toBe(true);
    expect((await remains(file)).files).toBe(0);
    // Only the preview had an object. The original's bytes were never stored here.
    expect(deletedKeys()).toEqual([file.variantKey]);
  });

  it('says which content wraps the file, and leaves it, so that it can be forgotten on its own', async () => {
    const file = await seedFile('IMG_0001.jpg');
    const contentId = uuidv7();

    // An imported photo is two rows. The content one is what the user sees, and carries the description the
    // image describer wrote.
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', 'IMG_0001.jpg', '{}'::jsonb, $2, 'content', $1)`,
      [contentId, ownerId],
    );
    await dataSource.query(
      `INSERT INTO ci.content (id, type, text, user_id, external_id, external_id_kind)
       VALUES ($1, 'media', 'A squirrel on a fence', $2, $3, 'file')`,
      [contentId, ownerId, file.fileId],
    );

    const result = await forget([file.nodeId]);

    expect(result.success).toBe(true);
    expect(await nodeExists(contentId)).toBe(true);
    expect(result.data?.warnings).toContain(
      `Not deleted: content that wraps a deleted file, and still shows its filename and description: ${contentId}. Forget it separately to remove it.`,
    );
    expect((await remains(file)).files).toBe(0);
  });

  it('removes a File node that has no ci.files row, and says nothing about storage', async () => {
    // Graph ingest writes these. There is nothing to purge, so the generic delete takes the node.
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'File', 'Imported without a file', '{}'::jsonb, $2, 'files', $3)`,
      [id, ownerId, uuidv7()],
    );

    const result = await forget([id]);

    expect(result.success).toBe(true);
    expect(await nodeExists(id)).toBe(false);
    expect(result.data?.warnings).toBeUndefined();
    expect(storage.deleteObjects).not.toHaveBeenCalled();
  });

  it('refuses to delete somebody else’s file, and leaves its objects alone', async () => {
    const theirs = await seedFile('Their photo', { forUser: strangerId });

    await seedTrail(theirs, 'Their photo', strangerId);

    const result = await forget([theirs.nodeId]);

    // The node is not the caller's, so the tool does not even find it.
    expect(result.success).toBe(true);
    expect(result.data?.archivedEntityIds).toEqual([]);
    expect(result.data?.warnings).toEqual([`Entity ${theirs.nodeId} not found or not owned by user`]);
    expect(await remains(theirs)).toMatchObject({ nodes: 1, files: 2, chunks: 1 });
    expect(storage.deleteObjects).not.toHaveBeenCalled();

    // And the stranger can forget their own.
    expect((await forget([theirs.nodeId], 'archive_and_delete', asStranger)).success).toBe(true);
    expect(await remains(theirs)).toEqual(NOTHING);
  });

  it('says that nothing was deleted, and that trying again is safe, when the object store fails', async () => {
    const file = await seedFile('Trip photo');

    await seedTrail(file, 'Trip photo');
    deleteObjectsImpl = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9000');
    };

    const result = await forget([file.nodeId]);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'EXECUTION_ERROR', retryable: true });
    expect(result.error?.message).toContain('nothing was deleted from the database');
    expect(result.error?.message).toContain('ECONNREFUSED');
    expect(result.error?.details).not.toHaveProperty('deletedEntityIds');
    expect(result.error?.details).not.toHaveProperty('storedObjectsDeletedFor');
    // Every row is as it was, and nobody is told anything was deleted.
    expect(await remains(file)).toEqual({
      nodes: 1,
      files: 2,
      chunks: 1,
      relationships: 0,
      graphDeltas: 1,
      pipelineState: 1,
      vectors: 1,
      embeddings: 1,
    });
    expect(publishedOf(FileRemovedEvent)).toEqual([]);

    // The store comes back, and forgetting the file again goes through.
    deleteObjectsImpl = async () => undefined;

    expect((await forget([file.nodeId])).success).toBe(true);
    expect(await remains(file)).toEqual(NOTHING);
  });

  it('names the file whose stored contents are gone when the database then refuses, and finishes it on a second try', async () => {
    const file = await seedFile('Trip photo');

    await seedTrail(file, 'Trip photo');
    // `ci.users.entity_id` references ci.entities with no ON DELETE action: a stand-in for a table the purge
    // has never heard of, which refuses the last delete after the objects have gone.
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [file.nodeId, strangerId]);

    const result = await forget([file.nodeId]);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: {
        constraint: 'users_entity_id_fkey',
        table: 'users',
        storedObjectsDeletedFor: [file.nodeId],
      },
    });
    // The message says the one thing the caller must not miss: the file is still listed, and will not open.
    expect(result.error?.message).toContain(
      'The stored contents of these were deleted but the entities were not',
    );
    expect(result.error?.message).toContain(file.nodeId);
    expect(result.error?.details).not.toHaveProperty('deletedEntityIds');

    // The objects went and the rows did not, so the rows still say where the bytes were.
    expect(deletedKeys()).toEqual([file.originalKey, file.variantKey].sort());
    expect(await remains(file)).toMatchObject({ nodes: 1, files: 2, chunks: 1, vectors: 1 });
    expect(publishedOf(FileRemovedEvent)).toEqual([]);

    // Whatever refused is removed, and forgetting the file again finishes the job.
    await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = $1', [strangerId]);
    objectCalls.length = 0;

    const again = await forget([file.nodeId]);

    expect(again.success).toBe(true);
    expect(await remains(file)).toEqual(NOTHING);
    expect(deletedKeys()).toEqual([file.originalKey, file.variantKey].sort());
  });

  it('names the file it had already destroyed when it is the rest of the call that is refused', async () => {
    const file = await seedFile('Trip photo');
    // A node of a type nothing purges, so it is the generic delete that the foreign key stops, after the
    // file has gone. A `Person` goes through `PersonService.purge`, which refuses the user's own node
    // before anything else in the call is destroyed.
    const me = await seedNode('Organization', 'Me');

    await seedTrail(file, 'Trip photo');
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [me, ownerId]);

    // The purge commits first, and cannot be undone. Then the node the foreign key protects is refused.
    const result = await forget([file.nodeId, me]);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      retryable: false,
      details: { constraint: 'users_entity_id_fkey', deletedEntityIds: [file.nodeId] },
    });
    expect(result.error?.message).toContain(`Already deleted: ${file.nodeId}.`);

    expect(await remains(file)).toEqual(NOTHING);
    expect(await nodeExists(me)).toBe(true);
    expect(deletedKeys()).toEqual([file.originalKey, file.variantKey].sort());
  });
});
