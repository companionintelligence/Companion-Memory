import { DataSource } from 'typeorm';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { FileRemovedEvent, type FileService as FileStorageService } from '@ci/domains/files';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { FileEntity } from '../../entities/FileEntity';
import { purgeFileAggregates, StoredObjectsDeletedError } from '../filePurge';
import { FileService } from '../FileService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PURGED FILE LEAVES NOTHING BEHIND, BYTES INCLUDED. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.forget`'s `archive_and_delete` deleted a `File` node by deleting its `ci.entities` row, and
 * a `File` node is only the graph's shadow of a stored file: it is joined to the `ci.files` row by a
 * plain `linked_id` column, with no foreign key in either direction. So the delete removed the shadow
 * and never reached the file, its variants, its chunks, its search rows or its bytes, and told the user
 * the file was gone.
 *
 * `FileService.purge` is the teardown that replaces it. Each case here seeds a doomed file and a
 * CONTROL one with a row in every table the purge is meant to clean, and checks that every one of
 * those rows is gone for the first, and that the second did not move. The footprint is asserted
 * non-zero before the purge, in every table, so the test cannot pass because a fixture quietly wrote
 * nothing.
 *
 * The objects live in object storage, not in Postgres, so the storage here is a stand-in that records
 * what it was asked to delete, and what the database looked like when it was asked. The ORDER is the
 * decision under test: the objects go first, while the row locks are held, so a failure leaves a file
 * whose rows still say where its bytes were.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your OWN, or
 * run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/FileService.purge.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const BUCKET = 'static';

/** This run's name for its Postgres connections, which is how a case tells its own from another suite's. */
const APPLICATION_NAME = `file-purge-spec-${uuidv7()}`;

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

/**
 * Polls until `probe` finds something. For waiting on Postgres to show a state, where a fixed sleep is
 * either too short under load or a slow test everywhere else.
 */
async function until<T>(probe: () => Promise<T | null>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const found = await probe();

    if (found !== null) {
      return found;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/** The SQLSTATE of a failed query, wherever the driver put it. */
const sqlState = (error: unknown): string | undefined => {
  const { code, driverError } = (error ?? {}) as { code?: string; driverError?: { code?: string } };

  return code ?? driverError?.code;
};

/** One stored file, a variant of it, and the ids everything that points at them is keyed by. */
interface Aggregate {
  /** The `File` node of the original: what `memory.forget` is given. */
  nodeId: string;
  /** The `ci.files` row of the original. The pipeline and the search index are keyed by it. */
  fileId: string;
  /** A preview of it, a `ci.files` row of its own with its own object. */
  variantId: string;
  /** The `File` node of the preview, which nobody names. */
  variantNodeId: string;
  /** A chunk of the text extracted from the original. The search index has rows keyed by its own id. */
  chunkId: string;
  /** The object each row names. */
  originalKey: string;
  variantKey: string;
}

type IdName = 'nodeId' | 'fileId' | 'variantId' | 'variantNodeId' | 'chunkId';

/**
 * Every place a row can point at a stored file, with how to count them. A probe says which of the
 * aggregate's ids it takes as `$1`, `$2`, … in the order it lists them: a statement that does not use a
 * parameter it is given is an error in Postgres.
 */
const FOOTPRINT: Array<[label: string, sql: string, ...ids: IdName[]]> = [
  ['ci.entities (File node)', `SELECT count(*) FROM ci.entities WHERE entity_id = $1`, 'nodeId'],
  [
    'ci.entities (File node of the variant)',
    `SELECT count(*) FROM ci.entities WHERE entity_id = $1`,
    'variantNodeId',
  ],
  ['ci.files (original)', `SELECT count(*) FROM ci.files WHERE id = $1`, 'fileId'],
  ['ci.files (variant)', `SELECT count(*) FROM ci.files WHERE id = $1`, 'variantId'],
  ['ci.file_chunks', `SELECT count(*) FROM ci.file_chunks WHERE file_id = $1`, 'fileId'],
  ['ci.message_files', `SELECT count(*) FROM ci.message_files WHERE file_id = $1`, 'fileId'],
  [
    'ci.relationships',
    `SELECT count(*) FROM ci.relationships
      WHERE from_entity_id IN ($1, $2) OR to_entity_id IN ($1, $2)`,
    'nodeId',
    'variantNodeId',
  ],
  ['ci.graph_deltas', `SELECT count(*) FROM ci.graph_deltas WHERE entity_id = $1`, 'nodeId'],
  [
    'ci.graph_deltas (of its edges)',
    `SELECT count(*) FROM ci.graph_deltas
      WHERE node_type = 'relationship'
        AND (from_entity_id IN ($1, $2) OR to_entity_id IN ($1, $2))`,
    'nodeId',
    'variantNodeId',
  ],
  ['ci.pipeline_state', `SELECT count(*) FROM ci.pipeline_state WHERE entity_id = $1`, 'fileId'],
  [
    'ci.pipeline_dead_letters',
    `SELECT count(*) FROM ci.pipeline_dead_letters WHERE entity_id = $1`,
    'fileId',
  ],
  ['ci_search.vectors', `SELECT count(*) FROM ci_search.vectors WHERE entity_id = $1`, 'fileId'],
  ['ci_search.embeddings', `SELECT count(*) FROM ci_search.embeddings WHERE entity_id = $1`, 'fileId'],
  ['ci_search.index_skips', `SELECT count(*) FROM ci_search.index_skips WHERE entity_id = $1`, 'fileId'],
  [
    'ci_search.vectors (of its chunks)',
    `SELECT count(*) FROM ci_search.vectors WHERE entity_id = $1`,
    'chunkId',
  ],
  [
    'ci_search.embeddings (of its chunks)',
    `SELECT count(*) FROM ci_search.embeddings WHERE entity_id = $1`,
    'chunkId',
  ],
  [
    'ci_search.entity_tag (by the file’s id)',
    `SELECT count(*) FROM ci_search.entity_tag WHERE entity_id = $1`,
    'fileId',
  ],
  [
    'ci_search.entity_categories (by the file’s id)',
    `SELECT count(*) FROM ci_search.entity_categories WHERE entity_id = $1`,
    'fileId',
  ],
  [
    'ci_search.entity_tag (by the node’s id)',
    `SELECT count(*) FROM ci_search.entity_tag WHERE entity_id = $1`,
    'nodeId',
  ],
  [
    'ci_search.entity_categories (by the node’s id)',
    `SELECT count(*) FROM ci_search.entity_categories WHERE entity_id = $1`,
    'nodeId',
  ],
];

describeWithDb(`FileService.purge against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let files: FileService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const stranger = { userId: strangerId } as UserServiceContext;

  const published: Array<{ name: string; payload: unknown }> = [];

  /** Every id a case seeded, for the tables that carry no owner to wipe by. */
  let seeded: string[] = [];

  /** What the object store was asked to delete, call by call. */
  const objectCalls: Array<{ bucket: string; keys: string[] }> = [];
  let deleteObjectsImpl: (bucket: string, keys: string[]) => Promise<void> = async () => undefined;

  const storage = {
    deleteObjects: jest.fn((bucket: string, keys: string[]) => {
      objectCalls.push({ bucket, keys: [...keys] });

      return deleteObjectsImpl(bucket, keys);
    }),
  };

  const deletedKeys = (): string[] => objectCalls.flatMap((call) => call.keys).sort();

  const signalling = {
    send: jest.fn(async (name: string, payload: unknown) => {
      published.push({ name, payload });

      return [];
    }),
  } as unknown as EventService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, UserEntity, FileEntity, EventBaseEntity, EventEntity],
      synchronize: false,
      // Named after this run, so a case can ask Postgres about its own connections and not another suite's.
      extra: { options: '-c search_path=ci,public', application_name: APPLICATION_NAME },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/FileService.purge');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'FilePurge', userId);
    }

    files = new FileService(
      storage as unknown as FileStorageService,
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(EventEntity),
      signalling,
      logger(),
    );
  });

  async function wipe(): Promise<void> {
    const users = [ownerId, strangerId];

    await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [users]);
    await dataSource.query(
      `DELETE FROM ci_search.entity_tag WHERE tag_id IN (SELECT id FROM ci_search.tags WHERE user_id = ANY($1::uuid[]))`,
      [users],
    );
    await dataSource.query(
      `DELETE FROM ci_search.entity_categories WHERE category_tag_id IN (SELECT id FROM ci_search.tags WHERE user_id = ANY($1::uuid[]))`,
      [users],
    );
    await dataSource.query('DELETE FROM ci_search.tags WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci_search.index_skips WHERE entity_id = ANY($1::uuid[])', [seeded]);
    await dataSource.query('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])', [seeded]);
    await dataSource.query('DELETE FROM ci.pipeline_dead_letters WHERE entity_id = ANY($1::uuid[])', [
      seeded,
    ]);
    await dataSource.query('DELETE FROM ci.receipts WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.object_observations WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.summaries WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.unfurls WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.messages WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.threads WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.file_chunks WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.content WHERE user_id = ANY($1::uuid[]) OR id = ANY($2::uuid[])', [
      users,
      seeded,
    ]);
    // Children before parents is not needed: the foreign key cascades, and a file is gone with its variants.
    await dataSource.query('DELETE FROM ci.files WHERE user_id = ANY($1::uuid[]) OR id = ANY($2::uuid[])', [
      users,
      seeded,
    ]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE entity_id = ANY($1::uuid[])', [seeded]);
    seeded = [];
  }

  beforeEach(() => {
    published.length = 0;
    objectCalls.length = 0;
    storage.deleteObjects.mockClear();
    deleteObjectsImpl = async () => undefined;
  });

  afterEach(wipe);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  async function node(entityType: string, name: string, forUser = ownerId): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
      [id, entityType, name, forUser],
    );
    seeded.push(id);

    return id;
  }

  /** An edge, and the delta that recorded its creation, which names its two endpoints. */
  async function edge(from: string, to: string, type: string, forUser = ownerId): Promise<void> {
    const [{ relationship_id: relationshipId }] = await dataSource.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING relationship_id`,
      [from, to, type, forUser],
    );

    await dataSource.query(
      `INSERT INTO ci.graph_deltas
         (node_type, relationship_id, relationship_type, from_entity_id, to_entity_id, change_type, changed_fields, owner_user_id)
       VALUES ('relationship', $1, $2, $3, $4, 'created', '{}'::jsonb, $5)`,
      [relationshipId, type, from, to, forUser],
    );
  }

  /**
   * A `ci.files` row. `bucket` and `key` are both null for a file that came from a source with an
   * `external_id`: its bytes were never stored here.
   */
  async function fileRow(
    name: string,
    forUser: string | null,
    extra: {
      variant?: string;
      parentId?: string;
      key?: string | null;
      externalId?: string;
      deletedAt?: boolean;
    } = {},
  ): Promise<{ id: string; key: string | null }> {
    const id = uuidv7();
    const external = extra.externalId !== undefined;
    const key = extra.key === undefined ? (external ? null : uuidv4()) : extra.key;

    seeded.push(id);
    await dataSource.query(
      `INSERT INTO ci.files
         (id, filename, content_type, variant, bucket, key, hash, external_id, parent_id, user_id, deleted_at)
       VALUES ($1, $2, 'image/jpeg', $3, $4, $5, $6, $7, $8, $9, ${extra.deletedAt ? 'now()' : 'NULL'})`,
      [
        id,
        name,
        extra.variant ?? 'ORIGINAL',
        key === null ? null : BUCKET,
        key,
        `hash-${id}`,
        extra.externalId ?? null,
        extra.parentId ?? null,
        forUser,
      ],
    );

    return { id, key };
  }

  /** The `File` node that shadows a `ci.files` row: `linked_table = 'files'`, `linked_id` = the row's id. */
  async function fileNode(fileId: string, name: string, forUser: string | null = ownerId): Promise<string> {
    const nodeId = uuidv7();

    seeded.push(nodeId);
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'File', $2, '{}'::jsonb, $3, 'files', $4)`,
      [nodeId, name, forUser, fileId],
    );

    return nodeId;
  }

  /**
   * A stored photo the way the appliance holds one, and then everything it hangs off one: a preview
   * with its own `File` node and object, extracted chunks, a chat attachment link, graph edges in both
   * directions and the delta that carries the filename, pipeline bookkeeping, tags and categories,
   * and search rows. Each table is keyed the way its real writer keys it: the pipeline and the search
   * index by the id of the `ci.files` row, the graph by the id of the node.
   */
  async function storedPhoto(name: string, forUser = ownerId): Promise<Aggregate> {
    const original = await fileRow(name, forUser);
    const variant = await fileRow(name, forUser, { variant: 'PREVIEW', parentId: original.id });
    const nodeId = await fileNode(original.id, name, forUser);
    const variantNodeId = await fileNode(variant.id, name, forUser);
    const chunkId = uuidv7();
    const aggregate: Aggregate = {
      nodeId,
      fileId: original.id,
      variantId: variant.id,
      variantNodeId,
      chunkId,
      originalKey: original.key as string,
      variantKey: variant.key as string,
    };

    seeded.push(chunkId);

    // Graph edges: the variant derives from its parent, and the file is linked to a person and a place.
    const person = await node('Person', `${name} photographer`, forUser);
    const place = await node('Location', `${name} venue`, forUser);

    await edge(variantNodeId, nodeId, 'DERIVED_FROM', forUser);
    await edge(person, nodeId, 'CAPTURED', forUser);
    await edge(nodeId, place, 'TAKEN_AT', forUser);

    // The graph delta the node's creation wrote, with the filename in it.
    await dataSource.query(
      `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, 'File', 'created', jsonb_build_object('name', jsonb_build_object('new', $2::text)), $3)`,
      [nodeId, name, forUser],
    );

    // What hangs off the `ci.files` row with a foreign key: the extracted text, and a chat attachment.
    await dataSource.query(
      `INSERT INTO ci.file_chunks (id, file_id, user_id, chunk_index, content, parser_name, parser_version, chunker_version)
       VALUES ($4, $1, $2, 0, $3, 'file_purge_spec', '1', '1')`,
      [original.id, forUser, `${name} text`, chunkId],
    );

    const [{ thread_id: threadId }] = await dataSource.query(
      `INSERT INTO ci.threads (user_id) VALUES ($1) RETURNING thread_id`,
      [forUser],
    );
    const [{ message_id: messageId }] = await dataSource.query(
      `INSERT INTO ci.messages (thread_id, user_id, role) VALUES ($1, $2, 'user') RETURNING message_id`,
      [threadId, forUser],
    );

    await dataSource.query(`INSERT INTO ci.message_files (message_id, file_id) VALUES ($1, $2)`, [
      messageId,
      original.id,
    ]);

    // Pipeline bookkeeping: its stages are keyed by the file's own id.
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
       VALUES ('file', $1, 'file_purge_spec.stage', 'done', $2)`,
      [original.id, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.pipeline_dead_letters (queue, event_name, entity_type, entity_id, payload, error, user_id)
       VALUES ('pipeline', 'file.uploaded', 'file', $1, '{}'::jsonb, 'boom', $2)`,
      [original.id, forUser],
    );

    // Tags and categories, in the search schema with no foreign key to anything: one on the file's id, as
    // the search tool resolves a file, and one on the node's, as the graph tools do.
    const [{ id: tag }] = await dataSource.query(
      `INSERT INTO ci_search.tags (id, label, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [`file-purge-spec-${name}`, forUser],
    );

    for (const id of [original.id, nodeId]) {
      await dataSource.query(
        `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ('file', $1, $2)`,
        [id, tag],
      );
      await dataSource.query(
        `INSERT INTO ci_search.entity_categories (entity_type, entity_id, category_tag_id, position)
         VALUES ('file', $1, $2, 0)`,
        [id, tag],
      );
    }

    // Search rows, keyed by the id of the `ci.files` row and never by the node's.
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'file', $1, to_tsvector('simple', $2), $3)`,
      [original.id, name, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
       VALUES (gen_random_uuid(), 'file', $1, $2)`,
      [original.id, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci_search.index_skips (entity_type, entity_id, reason) VALUES ('file', $1, 'file_purge_spec')`,
      [original.id],
    );

    // The search rows of the extracted text, keyed by the chunk's own id: the words of the document, and an
    // embedding of them (`FileChunkSearchIndexListener`). The chunk goes by cascade; these do not.
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'file-chunk', $1, to_tsvector('simple', $2), $3)`,
      [chunkId, `${name} text`, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
       VALUES (gen_random_uuid(), 'file-chunk', $1, $2)`,
      [chunkId, forUser],
    );

    return aggregate;
  }

  /** A content row wrapping a file, the way an imported photo has one. */
  async function wrappingContent(
    fileId: string,
    kind: 'file' | 'external_uri' | null,
    forUser: string | null = ownerId,
  ): Promise<string> {
    const id = uuidv7();

    seeded.push(id);
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', 'IMG_0001.jpg', '{}'::jsonb, $2, 'content', $1)`,
      [id, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.content (id, type, text, user_id, external_id, external_id_kind)
       VALUES ($1, 'media', 'A squirrel on a fence', $2, $3, $4)`,
      [id, forUser, fileId, kind],
    );

    return id;
  }

  // ── Probes ────────────────────────────────────────────────────────────────

  async function footprint(aggregate: Aggregate): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const [label, sql, ...ids] of FOOTPRINT) {
      const [{ count }] = await dataSource.query(
        sql,
        ids.map((id) => aggregate[id]),
      );

      counts[label] = Number(count);
    }

    return counts;
  }

  /** What `footprint` reads when every row is gone. */
  const EMPTY = Object.fromEntries(FOOTPRINT.map(([label]) => [label, 0]));

  function expectEveryTableTouched(counts: Record<string, number>): void {
    for (const [label, count] of Object.entries(counts)) {
      // A fixture that wrote nothing here would let the purge "clean" an empty table.
      expect({ label, count: count > 0 }).toEqual({ label, count: true });
    }
  }

  async function exists(sql: string, id: string): Promise<boolean> {
    const [{ count }] = await dataSource.query(sql, [id]);

    return Number(count) > 0;
  }

  const fileExists = (id: string) => exists('SELECT count(*) FROM ci.files WHERE id = $1', id);
  const nodeExists = (id: string) => exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', id);

  /** Everything the purge is supposed to delete, in the order the aggregate holds it. */
  const NOTHING = { nodeIds: [], fileIds: [], copyFileIds: [], deletedObjects: 0, keptObjects: 0 };

  // ── purge ─────────────────────────────────────────────────────────────────

  describe('purge', () => {
    it('removes the file, its variant, their nodes, their objects and every row that points at them, and nothing else', async () => {
      const doomed = await storedPhoto('Trip photo');
      const control = await storedPhoto('Shopping list photo');

      const doomedBefore = await footprint(doomed);
      const controlBefore = await footprint(control);

      expectEveryTableTouched(doomedBefore);
      expectEveryTableTouched(controlBefore);

      const purged = await files.purge(owner, [doomed.nodeId]);

      expect(purged).toMatchObject({
        nodeIds: [doomed.nodeId, doomed.variantNodeId].sort(),
        fileIds: [doomed.fileId, doomed.variantId].sort(),
        // The preview was not named, so it is reported as a copy, and the original is not.
        copyFileIds: [doomed.variantId],
        deletedObjects: 2,
        keptObjects: 0,
        wrappingContentIds: [],
      });
      expect(await footprint(doomed)).toEqual(EMPTY);
      // The control file is exactly as it was, row for row.
      expect(await footprint(control)).toEqual(controlBefore);
      // The objects of the doomed file and its variant went, and the control's did not.
      expect(deletedKeys()).toEqual([doomed.originalKey, doomed.variantKey].sort());
      expect(deletedKeys()).not.toContain(control.originalKey);
    });

    it('deletes the objects of every bucket it names, once each, with the bucket they live in', async () => {
      const doomed = await storedPhoto('Trip photo');

      await files.purge(owner, [doomed.nodeId]);

      expect(objectCalls).toEqual([{ bucket: BUCKET, keys: [doomed.originalKey, doomed.variantKey].sort() }]);
    });

    it('purges several in one call, once each, and leaves the rest', async () => {
      const first = await storedPhoto('Trip photo');
      const second = await storedPhoto('Recipe photo');
      const control = await storedPhoto('Shopping list photo');
      const controlBefore = await footprint(control);

      const purged = await files.purge(owner, [first.nodeId, second.nodeId, first.nodeId]);

      expect(purged.nodeIds.sort()).toEqual(
        [first.nodeId, first.variantNodeId, second.nodeId, second.variantNodeId].sort(),
      );
      expect(await footprint(first)).toEqual(EMPTY);
      expect(await footprint(second)).toEqual(EMPTY);
      expect(await footprint(control)).toEqual(controlBefore);
      expect(objectCalls).toHaveLength(1);
    });

    it('purges only the variant when only the variant’s node is named, and leaves the original', async () => {
      const doomed = await storedPhoto('Trip photo');

      const purged = await files.purge(owner, [doomed.variantNodeId]);

      expect(purged).toMatchObject({
        nodeIds: [doomed.variantNodeId],
        fileIds: [doomed.variantId],
        // It was named, so it is not a copy nobody asked about.
        copyFileIds: [],
        deletedObjects: 1,
      });
      expect(deletedKeys()).toEqual([doomed.variantKey]);
      expect(await fileExists(doomed.variantId)).toBe(false);
      expect(await nodeExists(doomed.variantNodeId)).toBe(false);
      expect(await fileExists(doomed.fileId)).toBe(true);
      expect(await nodeExists(doomed.nodeId)).toBe(true);
    });

    it('does not call a variant a copy nobody asked about when its node is named alongside the original', async () => {
      const doomed = await storedPhoto('Trip photo');

      const purged = await files.purge(owner, [doomed.nodeId, doomed.variantNodeId]);

      expect(purged.nodeIds.sort()).toEqual([doomed.nodeId, doomed.variantNodeId].sort());
      expect(purged.copyFileIds).toEqual([]);
      expect(await footprint(doomed)).toEqual(EMPTY);
    });

    it('takes the variants of a variant, to any depth, with their objects', async () => {
      const doomed = await storedPhoto('Trip photo');
      const thumbnail = await fileRow('Trip photo', ownerId, {
        variant: 'THUMBNAIL',
        parentId: doomed.variantId,
      });

      const purged = await files.purge(owner, [doomed.nodeId]);

      expect(purged.fileIds).toContain(thumbnail.id);
      expect(purged.copyFileIds.sort()).toEqual([doomed.variantId, thumbnail.id].sort());
      expect(await fileExists(thumbnail.id)).toBe(false);
      expect(deletedKeys()).toContain(thumbnail.key);
    });

    it('removes a file that was already soft-deleted, which the app’s own queries no longer show', async () => {
      const original = await fileRow('Old photo', ownerId, { deletedAt: true });
      const nodeId = await fileNode(original.id, 'Old photo');

      const purged = await files.purge(owner, [nodeId]);

      expect(purged.fileIds).toEqual([original.id]);
      expect(await fileExists(original.id)).toBe(false);
      expect(deletedKeys()).toEqual([original.key]);
    });

    it('removes a file whose node is archived, which is the second step of archive then delete', async () => {
      const doomed = await storedPhoto('Trip photo');

      await dataSource.query('UPDATE ci.entities SET is_active = false WHERE entity_id = $1', [
        doomed.nodeId,
      ]);

      const purged = await files.purge(owner, [doomed.nodeId]);

      expect(purged.nodeIds).toContain(doomed.nodeId);
      expect(await footprint(doomed)).toEqual(EMPTY);
    });

    it('deletes no object for a file whose bytes were never stored here', async () => {
      // A file that came from a source with an `external_id` has no bucket and no key.
      const external = await fileRow('Drive photo', ownerId, { externalId: 'drive-1' });
      const nodeId = await fileNode(external.id, 'Drive photo');

      const purged = await files.purge(owner, [nodeId]);

      expect(purged).toMatchObject({ fileIds: [external.id], deletedObjects: 0, keptObjects: 0 });
      expect(await fileExists(external.id)).toBe(false);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });

    it('leaves an object another file row still names, and says so', async () => {
      // Every row is written with a fresh key, so this is data that came in another way. Deleting an
      // object out from under another row is a data-loss bug caused by a privacy feature.
      const doomed = await storedPhoto('Trip photo');
      const shared = await fileRow('Their copy', strangerId, { key: doomed.originalKey });

      const purged = await files.purge(owner, [doomed.nodeId]);

      expect(purged).toMatchObject({ deletedObjects: 1, keptObjects: 1 });
      expect(deletedKeys()).toEqual([doomed.variantKey]);
      expect(await fileExists(shared.id)).toBe(true);
    });

    it('deletes the object once when two of its own rows name the same one', async () => {
      const doomed = await storedPhoto('Trip photo');

      await dataSource.query('UPDATE ci.files SET key = $2 WHERE id = $1', [
        doomed.variantId,
        doomed.originalKey,
      ]);

      const purged = await files.purge(owner, [doomed.nodeId]);

      expect(purged.deletedObjects).toBe(1);
      expect(deletedKeys()).toEqual([doomed.originalKey]);
    });

    it('leaves the records that merely mention the file, and says which content wraps it', async () => {
      const doomed = await storedPhoto('Trip photo');

      // An observation that was read off the photo, a receipt it was extracted from, a period summary that
      // lists it: records in their own right, with no foreign key to the file.
      const [{ observation_id: observationId }] = await dataSource.query(
        `INSERT INTO ci.object_observations (user_id, observed_at, label, file_id)
         VALUES ($1, now(), 'a kettle', $2) RETURNING observation_id`,
        [ownerId, doomed.fileId],
      );
      const [{ receipt_id: receiptId }] = await dataSource.query(
        `INSERT INTO ci.receipts (user_id, source_file_id) VALUES ($1, $2) RETURNING receipt_id`,
        [ownerId, doomed.fileId],
      );
      const [{ summary_id: summaryId }] = await dataSource.query(
        `INSERT INTO ci.summaries (user_id, period_start, period_end, period_type, source_types, related_files_ids)
         VALUES ($1, now(), now(), 'daily', ARRAY['file_purge_spec'], ARRAY[$2]::uuid[]) RETURNING summary_id`,
        [ownerId, doomed.fileId],
      );
      // The content row an imported photo is the other half of, and one that was classified before the kind
      // column existed, which is a file by the shape of its external id.
      const wrapped = await wrappingContent(doomed.fileId, 'file');
      const unclassified = await wrappingContent(doomed.fileId, null);
      // Not a file, whatever it holds: the kind says so.
      const uri = await wrappingContent(doomed.fileId, 'external_uri');
      // Somebody else's.
      const theirs = await wrappingContent(doomed.fileId, 'file', strangerId);

      const purged = await files.purge(owner, [doomed.nodeId]);

      expect(purged.wrappingContentIds.sort()).toEqual([wrapped, unclassified].sort());
      for (const id of [wrapped, unclassified, uri, theirs]) {
        expect(await exists('SELECT count(*) FROM ci.content WHERE id = $1', id)).toBe(true);
        expect(await nodeExists(id)).toBe(true);
      }

      // Both records still name the file, which is gone: the records are not the purge's to rewrite.
      expect(
        await dataSource.query('SELECT file_id FROM ci.object_observations WHERE observation_id = $1', [
          observationId,
        ]),
      ).toEqual([{ file_id: doomed.fileId }]);
      expect(
        await dataSource.query('SELECT source_file_id FROM ci.receipts WHERE receipt_id = $1', [receiptId]),
      ).toEqual([{ source_file_id: doomed.fileId }]);
      expect(
        await dataSource.query('SELECT related_files_ids FROM ci.summaries WHERE summary_id = $1', [
          summaryId,
        ]),
      ).toEqual([{ related_files_ids: [doomed.fileId] }]);
    });

    it('takes the chat attachment link and the chunks with the file, and nulls a link preview’s poster', async () => {
      const doomed = await storedPhoto('Trip photo');
      const [{ id: unfurlId }] = await dataSource.query(
        `INSERT INTO ci.unfurls (user_id, resolve_key, resolver, status, poster_file_id)
         VALUES ($1, $2, 'spec', 'ok', $3) RETURNING id`,
        [ownerId, `https://example.invalid/${doomed.fileId}`, doomed.fileId],
      );
      const [{ message_id: messageId }] = await dataSource.query(
        'SELECT message_id FROM ci.message_files WHERE file_id = $1',
        [doomed.fileId],
      );

      await files.purge(owner, [doomed.nodeId]);

      expect((await footprint(doomed))['ci.message_files']).toBe(0);
      expect((await footprint(doomed))['ci.file_chunks']).toBe(0);
      // The message keeps its text and loses the attachment, and the preview keeps everything but its poster.
      expect(await exists('SELECT count(*) FROM ci.messages WHERE message_id = $1', messageId)).toBe(true);
      expect(
        await dataSource.query('SELECT poster_file_id FROM ci.unfurls WHERE id = $1', [unfurlId]),
      ).toEqual([{ poster_file_id: null }]);
    });

    it('announces each removal after it has committed, by the id of the ci.files row, and nothing for the ids it did not take', async () => {
      const doomed = await storedPhoto('Trip photo');
      const missing = uuidv7();

      published.length = 0;

      await files.purge(owner, [doomed.nodeId, missing]);

      // The search rows are keyed by the `ci.files` id, so that is what the listener is told. The node's
      // id would delete nothing.
      expect(published).toHaveLength(2);
      expect(published.every((event) => event.name === FileRemovedEvent)).toBe(true);
      expect(published.map((event) => (event.payload as { fileId: string }).fileId).sort()).toEqual(
        [doomed.fileId, doomed.variantId].sort(),
      );
    });

    it('announces a removal only once it has committed, so a listener that looks finds the row gone', async () => {
      const doomed = await storedPhoto('Trip photo');
      const found: number[] = [];

      (signalling.send as jest.Mock).mockImplementationOnce(async (name: string, payload: unknown) => {
        // A listener reads on its own connection. Were the delete not committed yet, it would still find the row.
        const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.files WHERE id = $1', [
          doomed.fileId,
        ]);

        found.push(Number(count));
        published.push({ name, payload });

        return [];
      });

      await files.purge(owner, [doomed.nodeId]);

      // Precondition: the listener was asked.
      expect(published.length).toBeGreaterThan(0);
      expect(found).toEqual([0]);
    });

    it('leaves somebody else’s file alone, and ignores ids that do not exist', async () => {
      const theirs = await storedPhoto('Their photo', strangerId);
      const theirsBefore = await footprint(theirs);

      published.length = 0;

      const purged = await files.purge(owner, [theirs.nodeId, uuidv7()]);

      expect(purged).toMatchObject(NOTHING);
      expect(await footprint(theirs)).toEqual(theirsBefore);
      expect(published).toEqual([]);
      expect(storage.deleteObjects).not.toHaveBeenCalled();

      // And in the other direction: the stranger can purge their own.
      expect((await files.purge(stranger, [theirs.nodeId])).fileIds).toContain(theirs.fileId);
      expect(await footprint(theirs)).toEqual(EMPTY);
    });

    it('does not take a node of the caller’s whose file belongs to somebody else', async () => {
      // The node and the row it points at have different owners. The row is not the caller's to destroy.
      const theirs = await fileRow('Their photo', strangerId);
      const nodeId = await fileNode(theirs.id, 'Their photo', ownerId);

      const purged = await files.purge(owner, [nodeId]);

      expect(purged).toMatchObject(NOTHING);
      expect(await fileExists(theirs.id)).toBe(true);
      expect(await nodeExists(nodeId)).toBe(true);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });

    it('does not take a node of somebody else’s whose file is the caller’s', async () => {
      const mine = await fileRow('My photo', ownerId);
      const nodeId = await fileNode(mine.id, 'My photo', strangerId);

      const purged = await files.purge(owner, [nodeId]);

      expect(purged).toMatchObject(NOTHING);
      expect(await fileExists(mine.id)).toBe(true);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });

    it('does not delete the object of a variant that is not the owner’s', async () => {
      // Variants are written under their original's owner, so this row should not exist. The foreign key
      // still removes it with its parent, but its object is not the caller's to destroy.
      const doomed = await storedPhoto('Trip photo');
      const foreign = await fileRow('Foreign copy', strangerId, {
        variant: 'PREVIEW',
        parentId: doomed.fileId,
      });

      const purged = await files.purge(owner, [doomed.nodeId]);

      expect(purged.fileIds).not.toContain(foreign.id);
      expect(deletedKeys()).not.toContain(foreign.key);
    });

    it('leaves a File node with no ci.files row behind it, for the generic delete', async () => {
      // Graph ingest writes these. There is no stored file for anything to be left behind by.
      const graphOnly = await fileNode(uuidv7(), 'Imported without a file');

      published.length = 0;

      expect(await files.purge(owner, [graphOnly])).toMatchObject(NOTHING);
      expect(await nodeExists(graphOnly)).toBe(true);
      expect(published).toEqual([]);
    });

    it('does not take a node that is not a File node, whatever it is linked to', async () => {
      const original = await fileRow('Trip photo', ownerId);
      const imposter = await node('Concept', 'Not a file');

      await dataSource.query(
        `UPDATE ci.entities SET linked_table = 'files', linked_id = $2 WHERE entity_id = $1`,
        [imposter, original.id],
      );

      expect(await files.purge(owner, [imposter])).toMatchObject(NOTHING);
      expect(await fileExists(original.id)).toBe(true);
    });

    it('does nothing for an empty request', async () => {
      expect(await files.purge(owner, [])).toMatchObject(NOTHING);
      expect(published).toEqual([]);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });
  });

  // ── bytes first, and what a failure leaves ─────────────────────────────────

  describe('the objects go first, while the rows are locked', () => {
    it('lets two purges of the same file run at once: the second waits for the first, and finds nothing', async () => {
      const doomed = await storedPhoto('Trip photo');
      const gate = deferred();
      const inCall = deferred();

      deleteObjectsImpl = async () => {
        inCall.resolve();
        await gate.promise;
      };

      // The first holds the locks, waiting on the object store.
      const first = files.purge(owner, [doomed.nodeId]);

      first.catch(() => undefined);
      await inCall.promise;

      const second = files.purge(owner, [doomed.nodeId]);

      second.catch(() => undefined);

      try {
        // Ask Postgres, on this run's own connections, whether anything is waiting for a lock. The second is, at
        // the statement that takes them: it has not asked the object store anything.
        await until(async () => {
          const rows: Array<{ query: string }> = await dataSource.query(
            `SELECT query FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`,
            [APPLICATION_NAME],
          );

          return rows.length > 0 ? rows : null;
        }, 'the second purge to wait for the first');

        expect(objectCalls).toHaveLength(1);
      } finally {
        gate.resolve();
      }

      const [one, two] = await Promise.all([first, second]);

      expect(one.fileIds.sort()).toEqual([doomed.fileId, doomed.variantId].sort());
      // Having waited, the second finds the rows gone: it did not delete the objects a second time, and it
      // does not say it deleted anything.
      expect(two).toMatchObject(NOTHING);
      expect(objectCalls).toHaveLength(1);
      expect(published.filter((event) => event.name === FileRemovedEvent)).toHaveLength(2);
      expect(await footprint(doomed)).toEqual(EMPTY);
    }, 60_000);

    it('deletes the objects while every row is still there and locked, and the rows afterwards', async () => {
      const doomed = await storedPhoto('Trip photo');
      const seen: { files: number; node: number; lockedAgainstOthers: boolean } = {
        files: -1,
        node: -1,
        lockedAgainstOthers: false,
      };

      deleteObjectsImpl = async () => {
        // On other connections, as a listener or another request would see it: nothing is deleted yet...
        seen.files = Number(
          (await dataSource.query('SELECT count(*) FROM ci.files WHERE id = $1', [doomed.fileId]))[0].count,
        );
        seen.node = Number(
          (
            await dataSource.query('SELECT count(*) FROM ci.entities WHERE entity_id = $1', [doomed.nodeId])
          )[0].count,
        );

        // ...and the row is locked, which Postgres says by refusing to wait for it.
        const probe = dataSource.createQueryRunner();

        await probe.connect();
        await probe.startTransaction();

        try {
          await probe.query('SELECT 1 FROM ci.files WHERE id = $1 FOR UPDATE NOWAIT', [doomed.fileId]);
        } catch (error) {
          seen.lockedAgainstOthers = sqlState(error) === '55P03';
        } finally {
          await probe.rollbackTransaction().catch(() => undefined);
          await probe.release();
        }
      };

      await files.purge(owner, [doomed.nodeId]);

      expect(seen).toEqual({ files: 1, node: 1, lockedAgainstOthers: true });
      expect(await fileExists(doomed.fileId)).toBe(false);
    });

    it('keeps a variant that is written while the object store works out until the purge has committed', async () => {
      const doomed = await storedPhoto('Trip photo');
      const gate = deferred();
      const inCall = deferred();

      deleteObjectsImpl = async () => {
        inCall.resolve();
        await gate.promise;
      };

      const purging = files.purge(owner, [doomed.nodeId]);

      purging.catch(() => undefined);
      await inCall.promise;

      const writer = dataSource.createQueryRunner();

      await writer.connect();
      await writer.startTransaction();

      try {
        const [{ pid }] = await writer.query('SELECT pg_backend_pid() AS pid');

        // What the preview stage does for a file it has just rendered a preview of. The insert checks its
        // parent with a key-share lock, which the purge's lock conflicts with.
        const writing = writer.query(
          `INSERT INTO ci.files (id, filename, content_type, variant, bucket, key, parent_id, user_id)
           VALUES ($1, 'late.webp', 'image/webp', 'THUMBNAIL', $2, $3, $4, $5)`,
          [uuidv7(), BUCKET, uuidv4(), doomed.fileId, ownerId],
        );
        const outcome = writing.then(
          () => undefined,
          (error: unknown) => error,
        );

        // Ask Postgres who the insert is waiting for, rather than sleeping. It is the purge, and the purge is
        // not in the middle of a statement: it is idle in its transaction, waiting for the object store.
        const holders = await until(async () => {
          const rows: Array<{ state: string }> = await dataSource.query(
            'SELECT state FROM pg_stat_activity WHERE pid = ANY(pg_blocking_pids($1::int))',
            [pid],
          );

          return rows.length > 0 ? rows : null;
        }, 'the variant insert to block on the purge');

        expect(holders).toEqual([{ state: 'idle in transaction' }]);

        gate.resolve();

        await expect(purging).resolves.toMatchObject({ fileIds: expect.arrayContaining([doomed.fileId]) });

        // The parent is gone, so the insert that waited for it fails, and no object was left without a row.
        expect(sqlState(await outcome)).toBe('23503');
        expect(deletedKeys()).toEqual([doomed.originalKey, doomed.variantKey].sort());
        expect(await footprint(doomed)).toEqual(EMPTY);
      } finally {
        gate.resolve();
        await writer.rollbackTransaction().catch(() => undefined);
        await writer.release();
        await purging.catch(() => undefined);
      }
    }, 60_000);

    it('waits for a variant that is being written when it starts, and takes that one too', async () => {
      const doomed = await storedPhoto('Trip photo');
      const lateId = uuidv7();
      const lateKey = uuidv4();
      const writer = dataSource.createQueryRunner();

      await writer.connect();
      await writer.startTransaction();

      let purging: Promise<unknown> | undefined;

      try {
        const [{ pid }] = await writer.query('SELECT pg_backend_pid() AS pid');

        seeded.push(lateId);
        await writer.query(
          `INSERT INTO ci.files (id, filename, content_type, variant, bucket, key, parent_id, user_id)
           VALUES ($1, 'late.webp', 'image/webp', 'THUMBNAIL', $2, $3, $4, $5)`,
          [lateId, BUCKET, lateKey, doomed.fileId, ownerId],
        );

        purging = files.purge(owner, [doomed.nodeId]);

        // Held at the statement that locks the files, before it has asked the object store anything. Held
        // anywhere later, it would have listed the objects it could see and missed this one.
        const blocked = await until(async () => {
          const rows: Array<{ query: string }> = await dataSource.query(
            'SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [pid],
          );

          return rows.length > 0 ? rows : null;
        }, 'the purge to block on the writer');

        expect(blocked).toHaveLength(1);
        expect(blocked[0].query).toMatch(/\bFOR UPDATE\b/);
        expect(storage.deleteObjects).not.toHaveBeenCalled();

        await writer.commitTransaction();
      } catch (error) {
        await writer.rollbackTransaction().catch(() => undefined);
        await purging?.catch(() => undefined);

        throw error;
      } finally {
        await writer.release();
      }

      // Having waited, the purge finds the variant that just committed, and its object goes with the rest.
      const purged = (await purging) as { fileIds: string[]; copyFileIds: string[] };

      expect(purged.fileIds).toContain(lateId);
      expect(purged.copyFileIds).toContain(lateId);
      expect(deletedKeys()).toEqual([doomed.originalKey, doomed.variantKey, lateKey].sort());
      expect(await fileExists(lateId)).toBe(false);
    }, 60_000);

    it('leaves everything as it was, and says so, when the object store fails', async () => {
      const doomed = await storedPhoto('Trip photo');
      const doomedBefore = await footprint(doomed);

      deleteObjectsImpl = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:9000');
      };

      published.length = 0;

      const failure = await files.purge(owner, [doomed.nodeId]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      // Not the error that says the bytes are gone: nothing was deleted from the database.
      expect(failure).not.toBeInstanceOf(StoredObjectsDeletedError);
      expect((failure as Error).message).toContain('nothing was deleted from the database');
      expect((failure as Error).message).toContain('ECONNREFUSED');
      expect(await footprint(doomed)).toEqual(doomedBefore);
      expect(published).toEqual([]);

      // And it let go of the rows: a purge that failed does not leave them locked.
      const probe = dataSource.createQueryRunner();

      await probe.connect();
      await probe.startTransaction();
      await expect(
        probe.query('SELECT 1 FROM ci.files WHERE id = $1 FOR UPDATE NOWAIT', [doomed.fileId]),
      ).resolves.toBeDefined();
      await probe.rollbackTransaction();
      await probe.release();
    });

    it('gives up on an object store that does not answer, and lets go of the rows', async () => {
      const doomed = await storedPhoto('Trip photo');
      const doomedBefore = await footprint(doomed);

      // Nothing else bounds the wait: the client sets no timeout, and neither does the database.
      const failure = await dataSource
        .transaction((manager) =>
          purgeFileAggregates(
            manager,
            ownerId,
            [doomed.nodeId],
            { deleteObjects: () => new Promise<void>(() => undefined) },
            { deadlineMs: 100 },
          ),
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('did not answer within');
      expect((failure as Error).message).toContain('nothing was deleted from the database');
      expect(await footprint(doomed)).toEqual(doomedBefore);

      const probe = dataSource.createQueryRunner();

      await probe.connect();
      await probe.startTransaction();
      await expect(
        probe.query('SELECT 1 FROM ci.files WHERE id = $1 FOR UPDATE NOWAIT', [doomed.fileId]),
      ).resolves.toBeDefined();
      await probe.rollbackTransaction();
      await probe.release();
    }, 30_000);

    it('keeps the rows, and names the files whose objects are gone, when the database refuses afterwards; forgetting again finishes it', async () => {
      const doomed = await storedPhoto('Trip photo');
      const doomedBefore = await footprint(doomed);

      // `ci.users.entity_id` references ci.entities with no ON DELETE action. Pointing it at the file's node
      // makes the last delete fail, after the objects have gone, as a table this teardown has never heard of
      // would.
      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [doomed.nodeId, strangerId]);
      published.length = 0;

      const failure = await files.purge(owner, [doomed.nodeId]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StoredObjectsDeletedError);

      const gone = failure as StoredObjectsDeletedError;

      // The caller is told which nodes are the ones whose files will not open, and what refused.
      expect(gone.nodeIds).toEqual([doomed.nodeId]);
      expect(sqlState(gone.cause)).toBe('23503');
      expect(gone.message).toContain('The stored objects were deleted but their records could not be');
      // The objects went, the rows did not: every table is as it was, and the rows still say where the bytes were.
      expect(deletedKeys()).toEqual([doomed.originalKey, doomed.variantKey].sort());
      expect(await footprint(doomed)).toEqual(doomedBefore);
      expect(published).toEqual([]);

      // Forgetting it again finds the same rows and the same keys. The object store treats a key that is
      // already gone as deleted, so the second delete is the same call, and then the rows go.
      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = $1', [strangerId]);
      objectCalls.length = 0;

      const purged = await files.purge(owner, [doomed.nodeId]);

      expect(purged.fileIds.sort()).toEqual([doomed.fileId, doomed.variantId].sort());
      expect(deletedKeys()).toEqual([doomed.originalKey, doomed.variantKey].sort());
      expect(await footprint(doomed)).toEqual(EMPTY);
    });

    it('does not claim objects are gone when the file had none, if the database then refuses', async () => {
      const external = await fileRow('Drive photo', ownerId, { externalId: 'drive-1' });
      const nodeId = await fileNode(external.id, 'Drive photo');

      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [nodeId, strangerId]);

      const failure = await files.purge(owner, [nodeId]).catch((error: unknown) => error);

      // Nothing outside the database was destroyed, so this is the plain refusal.
      expect(failure).not.toBeInstanceOf(StoredObjectsDeletedError);
      expect(sqlState(failure)).toBe('23503');
      expect(await fileExists(external.id)).toBe(true);
    });

    it('is refused whole when something it does not know about blocks the delete, and nothing is announced', async () => {
      const doomed = await storedPhoto('Trip photo');
      const doomedBefore = await footprint(doomed);

      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [doomed.nodeId, strangerId]);
      published.length = 0;

      await expect(files.purge(owner, [doomed.nodeId])).rejects.toThrow(/foreign key/i);

      // Every delete that ran before the one that failed was rolled back with it.
      expect(await footprint(doomed)).toEqual(doomedBefore);
      expect(published).toEqual([]);
    });
  });
});
