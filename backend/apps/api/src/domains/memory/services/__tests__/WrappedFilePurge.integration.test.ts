import { DataSource } from 'typeorm';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { FileRemovedEvent } from '@ci/domains/files/events';
import { ContentRemovedEvent, EventRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { CalendarEventService } from '../CalendarEventService';
import { purgeContentAggregates } from '../contentPurge';
import { ContentService } from '../ContentService';
import { lockFiles, StoredObjectsDeletedError, type StoredObjects } from '../filePurge';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FORGETTING A PHOTO'S CONTENT OR EVENT FORGETS THE PHOTO. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An imported photo is two rows. `ci.files` holds the bytes, and a `ci.content` row of type `media` points at
 * it through `external_id`. There is no foreign key between them, so purging the content, or the event it hangs
 * off, deleted the content row and left the file, its previews, its node, its search rows and its bytes: the
 * part that is the photo stayed, listed and servable, after the user had been told it was gone.
 *
 * `ContentService.purge` and `CalendarEventService.purge` now delete the file too, when nothing else uses it,
 * and keep it, and say why, when something does. Each case seeds a doomed photo and a CONTROL one with a row in
 * every table the purge is meant to clean, and checks that every one of them is gone for the first and that the
 * second did not move. The footprint is asserted non-zero before the purge, in every table, so the test cannot
 * pass because a fixture quietly wrote nothing.
 *
 * The decision is the user's: delete the file if nothing else uses it. It is measured against the other two
 * answers in `wrappedFilePurge.ts`, and the shared-file cases below are the ones that decide it: on a real
 * corpus 98% of the files a content row wraps are also named by a message's attachments, so the rule that only
 * looked at other content rows would have deleted bytes out from under live messages.
 *
 * The objects live in object storage, not in Postgres, so the storage here is a stand-in that records what it was
 * asked to delete, and what the database looked like when it was asked.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your OWN, or run
 * `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/WrappedFilePurge.integration] SKIPPED — ${availability.reason}`);
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

/** Polls until `probe` finds something. For waiting on Postgres to show a state, where a fixed sleep is a guess. */
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

const sorted = (values: string[]): string[] => [...values].sort();

/** One stored photo, a preview of it, and the ids everything that points at them is keyed by. */
interface Photo {
  /** The `File` node of the original. */
  nodeId: string;
  /** The `ci.files` row of the original: what a content row's `external_id` holds. */
  fileId: string;
  variantId: string;
  variantNodeId: string;
  /** A chunk of the text extracted from the original. The search index has rows keyed by its own id. */
  chunkId: string;
  originalKey: string;
  variantKey: string;
}

type IdName = 'nodeId' | 'fileId' | 'variantId' | 'variantNodeId' | 'chunkId';

/**
 * Every place a row can point at a stored photo, with how to count them. A probe says which of the photo's
 * ids it takes as `$1`, `$2`, … in the order it lists them: a statement that does not use a parameter it is
 * given is an error in Postgres.
 *
 * Not here: `ci.message_files`, the chat attachment link. It is a row that USES a file and so keeps it, which
 * is a case of its own; a photo that had one would not be a doomed photo.
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

describeWithDb(`purging what wraps a stored file, against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let contents: ContentService;
  let calendar: CalendarEventService;
  /** A content service built without an object store, which can purge everything that has no stored bytes. */
  let contentsWithoutStore: ContentService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;

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
      entities: [EventEntity, BaseEntity, EventBaseEntity, ContentEntity, ContentBaseEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/WrappedFilePurge');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'WrappedFile', userId);
    }

    const deltaWriter = new GraphDeltaWriter(dataSource, logger());
    const store = storage as unknown as StoredObjects;

    contents = new ContentService(
      dataSource.getRepository(ContentEntity),
      dataSource.getRepository(ContentBaseEntity),
      dataSource.getRepository(EventEntity),
      signalling,
      deltaWriter,
      store,
    );
    contentsWithoutStore = new ContentService(
      dataSource.getRepository(ContentEntity),
      dataSource.getRepository(ContentBaseEntity),
      dataSource.getRepository(EventEntity),
      signalling,
      deltaWriter,
    );
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
    await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.unfurls WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.messages WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.threads WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.file_chunks WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.communications WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.content WHERE user_id = ANY($1::uuid[]) OR id = ANY($2::uuid[])', [
      users,
      seeded,
    ]);
    await dataSource.query('DELETE FROM ci.events WHERE user_id = ANY($1::uuid[])', [users]);
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
  async function edge(from: string, to: string, type: string): Promise<void> {
    const [{ relationship_id: relationshipId }] = await dataSource.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING relationship_id`,
      [from, to, type, ownerId],
    );

    await dataSource.query(
      `INSERT INTO ci.graph_deltas
         (node_type, relationship_id, relationship_type, from_entity_id, to_entity_id, change_type, changed_fields, owner_user_id)
       VALUES ('relationship', $1, $2, $3, $4, 'created', '{}'::jsonb, $5)`,
      [relationshipId, type, from, to, ownerId],
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
      eventId?: string;
    } = {},
  ): Promise<{ id: string; key: string | null }> {
    const id = uuidv7();
    const external = extra.externalId !== undefined;
    const key = extra.key === undefined ? (external ? null : uuidv4()) : extra.key;

    seeded.push(id);
    await dataSource.query(
      `INSERT INTO ci.files
         (id, filename, content_type, variant, bucket, key, hash, external_id, parent_id, event_id, user_id)
       VALUES ($1, $2, 'image/jpeg', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        name,
        extra.variant ?? 'ORIGINAL',
        key === null ? null : BUCKET,
        key,
        `hash-${id}`,
        extra.externalId ?? null,
        extra.parentId ?? null,
        extra.eventId ?? null,
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
   * A stored photo the way the appliance holds one, and then everything that hangs off one: a preview with
   * its own `File` node and object, extracted chunks, graph edges in both directions and the delta that
   * carries the filename, pipeline bookkeeping, tags and categories, and search rows. Each table is keyed the
   * way its real writer keys it: the pipeline and the search index by the id of the `ci.files` row, the graph
   * by the id of the node.
   */
  async function storedPhoto(name: string, extra: { eventId?: string } = {}): Promise<Photo> {
    const original = await fileRow(name, ownerId, { eventId: extra.eventId });
    const variant = await fileRow(name, ownerId, { variant: 'PREVIEW', parentId: original.id });
    const nodeId = await fileNode(original.id, name);
    const variantNodeId = await fileNode(variant.id, name);
    const chunkId = uuidv7();
    const photo: Photo = {
      nodeId,
      fileId: original.id,
      variantId: variant.id,
      variantNodeId,
      chunkId,
      originalKey: original.key as string,
      variantKey: variant.key as string,
    };

    seeded.push(chunkId);

    const person = await node('Person', `${name} photographer`);
    const place = await node('Location', `${name} venue`);

    await edge(variantNodeId, nodeId, 'DERIVED_FROM');
    await edge(person, nodeId, 'CAPTURED');
    await edge(nodeId, place, 'TAKEN_AT');

    await dataSource.query(
      `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, 'File', 'created', jsonb_build_object('name', jsonb_build_object('new', $2::text)), $3)`,
      [nodeId, name, ownerId],
    );
    await dataSource.query(
      `INSERT INTO ci.file_chunks (id, file_id, user_id, chunk_index, content, parser_name, parser_version, chunker_version)
       VALUES ($4, $1, $2, 0, $3, 'wrapped_file_spec', '1', '1')`,
      [original.id, ownerId, `${name} text`, chunkId],
    );
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
       VALUES ('file', $1, 'wrapped_file_spec.stage', 'done', $2)`,
      [original.id, ownerId],
    );
    await dataSource.query(
      `INSERT INTO ci.pipeline_dead_letters (queue, event_name, entity_type, entity_id, payload, error, user_id)
       VALUES ('pipeline', 'file.uploaded', 'file', $1, '{}'::jsonb, 'boom', $2)`,
      [original.id, ownerId],
    );

    const [{ id: tag }] = await dataSource.query(
      `INSERT INTO ci_search.tags (id, label, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [`wrapped-file-spec-${name}`, ownerId],
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

    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'file', $1, to_tsvector('simple', $2), $3)`,
      [original.id, name, ownerId],
    );
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
       VALUES (gen_random_uuid(), 'file', $1, $2)`,
      [original.id, ownerId],
    );
    await dataSource.query(
      `INSERT INTO ci_search.index_skips (entity_type, entity_id, reason) VALUES ('file', $1, 'wrapped_file_spec')`,
      [original.id],
    );
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'file-chunk', $1, to_tsvector('simple', $2), $3)`,
      [chunkId, `${name} text`, ownerId],
    );
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
       VALUES (gen_random_uuid(), 'file-chunk', $1, $2)`,
      [chunkId, ownerId],
    );

    return photo;
  }

  /** A content row that wraps a file, the way an imported photo has one: a `Content` node and its `media` row. */
  async function wrapper(
    fileId: string,
    kind: 'file' | 'external_uri' | null,
    extra: { forUser?: string | null; eventId?: string; title?: string } = {},
  ): Promise<string> {
    const id = uuidv7();
    const forUser = extra.forUser === undefined ? ownerId : extra.forUser;

    seeded.push(id);
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
      [id, extra.title ?? 'IMG_0001.jpg', forUser ?? ownerId],
    );
    await dataSource.query(
      `INSERT INTO ci.content (id, type, text, mimetype, user_id, event_id, external_id, external_id_kind)
       VALUES ($1, 'media', 'A squirrel on a fence', 'image/jpeg', $2, $3, $4, $5)`,
      [id, forUser, extra.eventId ?? null, fileId, kind],
    );

    return id;
  }

  /** A message whose `attachments` column is whatever the writer gave it. */
  async function message(attachments: unknown, forUser = ownerId): Promise<string> {
    const id = uuidv7();

    seeded.push(id);
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Communication', 'a message', '{}'::jsonb, $2, 'communications', $1)`,
      [id, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.communications (id, "time", user_id, communication_type, direction, subject, content, attachments)
       VALUES ($1, now(), $2, 'email', 'inbound', 'photo', 'see attached', $3::jsonb)`,
      [id, forUser, JSON.stringify(attachments)],
    );

    return id;
  }

  /** What an importer writes for a message that carries a file. */
  const attachmentsOf = (fileId: string): unknown => [{ type: 'file', id: fileId }];

  /** A chat message that attaches a file: the row `ci.message_files` holds, and the foreign keys above it. */
  async function chatAttachment(fileId: string): Promise<string> {
    const [{ thread_id: threadId }] = await dataSource.query(
      `INSERT INTO ci.threads (user_id) VALUES ($1) RETURNING thread_id`,
      [ownerId],
    );
    const [{ message_id: messageId }] = await dataSource.query(
      `INSERT INTO ci.messages (thread_id, user_id, role) VALUES ($1, $2, 'user') RETURNING message_id`,
      [threadId, ownerId],
    );

    await dataSource.query(`INSERT INTO ci.message_files (message_id, file_id) VALUES ($1, $2)`, [
      messageId,
      fileId,
    ]);

    return messageId;
  }

  async function event(title: string): Promise<string> {
    const [created] = await calendar.create(owner, { title, start_time: DINNER_AT });

    return created.id;
  }

  // ── Probes ────────────────────────────────────────────────────────────────

  async function footprint(photo: Photo): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const [label, sql, ...ids] of FOOTPRINT) {
      const [{ count }] = await dataSource.query(
        sql,
        ids.map((id) => photo[id]),
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
  const contentExists = (id: string) => exists('SELECT count(*) FROM ci.content WHERE id = $1', id);
  const eventExists = (id: string) => exists('SELECT count(*) FROM ci.events WHERE event_id = $1', id);

  /** The ids a purge announced, by event name. */
  const announced = (name: string): string[] =>
    published
      .filter((entry) => entry.name === name)
      .map((entry) => Object.values(entry.payload as Record<string, string>)[0])
      .sort();

  // ── content: the file goes with it ────────────────────────────────────────

  describe('purging content that wraps a stored file', () => {
    it('removes the file, its preview, their nodes, their objects and every row that points at them, and nothing else', async () => {
      const doomed = await storedPhoto('Trip photo');
      const control = await storedPhoto('Shopping list photo');
      const doomedContent = await wrapper(doomed.fileId, 'file', { title: 'Trip photo' });
      const controlContent = await wrapper(control.fileId, 'file', { title: 'Shopping list photo' });

      const doomedBefore = await footprint(doomed);
      const controlBefore = await footprint(control);

      expectEveryTableTouched(doomedBefore);
      expectEveryTableTouched(controlBefore);

      const purged = await contents.purge(owner, [doomedContent]);

      expect(purged.contentIds).toEqual([doomedContent]);
      expect(purged.files).toEqual({
        wrappedFileIds: [doomed.fileId],
        fileIds: sorted([doomed.fileId, doomed.variantId]),
        nodeIds: sorted([doomed.nodeId, doomed.variantNodeId]),
        deletedObjects: 2,
        keptObjects: 0,
        kept: [],
      });
      expect(await contentExists(doomedContent)).toBe(false);
      expect(await nodeExists(doomedContent)).toBe(false);
      expect(await footprint(doomed)).toEqual(EMPTY);
      // The control photo and its content are exactly as they were, row for row.
      expect(await footprint(control)).toEqual(controlBefore);
      expect(await contentExists(controlContent)).toBe(true);
      // The objects of the doomed file and its preview went, once each, in one call, and the control's did not.
      expect(objectCalls).toEqual([
        { bucket: BUCKET, keys: sorted([doomed.originalKey, doomed.variantKey]) },
      ]);
      expect(deletedKeys()).not.toContain(control.originalKey);
    });

    it('takes a file whose content was classified before the kind column existed, which is a file by the shape of its id', async () => {
      const doomed = await storedPhoto('Old photo');
      const content = await wrapper(doomed.fileId, null);

      const purged = await contents.purge(owner, [content]);

      expect(purged.files.wrappedFileIds).toEqual([doomed.fileId]);
      expect(await footprint(doomed)).toEqual(EMPTY);
    });

    it('takes the files of several content rows named in one call, and deletes each object once', async () => {
      const first = await storedPhoto('Trip photo');
      const second = await storedPhoto('Recipe photo');
      const control = await storedPhoto('Shopping list photo');
      const controlBefore = await footprint(control);
      const firstContent = await wrapper(first.fileId, 'file');
      const secondContent = await wrapper(second.fileId, 'file');

      await wrapper(control.fileId, 'file');

      const purged = await contents.purge(owner, [firstContent, secondContent, firstContent]);

      expect(sorted(purged.files.wrappedFileIds)).toEqual(sorted([first.fileId, second.fileId]));
      expect(await footprint(first)).toEqual(EMPTY);
      expect(await footprint(second)).toEqual(EMPTY);
      expect(await footprint(control)).toEqual(controlBefore);
      expect(objectCalls).toHaveLength(1);
      expect(deletedKeys()).toEqual(
        sorted([first.originalKey, first.variantKey, second.originalKey, second.variantKey]),
      );
    });

    it('goes on with the content when what it wraps is not a file at all', async () => {
      // `external_id` is text and means a file only when it is a uuid. A content row from a streaming service
      // holds its URI there, and the lookup must not try to read it as a uuid.
      const doomed = await storedPhoto('Trip photo');
      const doomedContent = await wrapper(doomed.fileId, 'file');
      const track = await wrapper('spotify:track:4uLU6hMCjMI75M1A2tKUQC', null);
      const odd = await wrapper('not-a-uuid-1234', 'file');

      const purged = await contents.purge(owner, [doomedContent, track, odd]);

      expect(sorted(purged.contentIds)).toEqual(sorted([doomedContent, track, odd]));
      expect(purged.files.wrappedFileIds).toEqual([doomed.fileId]);
      expect(await footprint(doomed)).toEqual(EMPTY);
    });

    it('does not take a file that a row marked as a URI holds the id of, which is never a file', async () => {
      const photo = await storedPhoto('Trip photo');
      const photoBefore = await footprint(photo);
      const uri = await wrapper(photo.fileId, 'external_uri');

      const purged = await contents.purge(owner, [uri]);

      expect(purged.contentIds).toEqual([uri]);
      expect(purged.files).toEqual({
        wrappedFileIds: [],
        fileIds: [],
        nodeIds: [],
        deletedObjects: 0,
        keptObjects: 0,
        kept: [],
      });
      expect(await footprint(photo)).toEqual(photoBefore);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });

    it('does not take a file that is somebody else’s, whoever the content that names it belongs to', async () => {
      const theirs = await fileRow('Their photo', strangerId);
      const mine = await wrapper(theirs.id, 'file');

      const purged = await contents.purge(owner, [mine]);

      expect(purged.contentIds).toEqual([mine]);
      expect(purged.files.wrappedFileIds).toEqual([]);
      expect(await fileExists(theirs.id)).toBe(true);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });

    it('does not take a file for content that is somebody else’s, which it does not purge', async () => {
      const photo = await storedPhoto('Trip photo');
      const photoBefore = await footprint(photo);
      const theirs = await wrapper(photo.fileId, 'file', { forUser: strangerId });

      const purged = await contents.purge(owner, [theirs]);

      expect(purged.contentIds).toEqual([]);
      expect(await contentExists(theirs)).toBe(true);
      expect(await footprint(photo)).toEqual(photoBefore);
    });

    it('purges a file that came from a source, which has no stored bytes, without asking the object store', async () => {
      const external = await fileRow('Drive photo', ownerId, { externalId: 'drive-1' });
      const nodeId = await fileNode(external.id, 'Drive photo');
      const content = await wrapper(external.id, 'file');

      const purged = await contents.purge(owner, [content]);

      expect(purged.files).toMatchObject({
        wrappedFileIds: [external.id],
        nodeIds: [nodeId],
        deletedObjects: 0,
      });
      expect(await fileExists(external.id)).toBe(false);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });

    it('purges a file that has no File node yet, and has none to offer for one it keeps', async () => {
      // The graph's presence for a file is written by a listener after the upload, so a file can be wrapped before it
      // has a node. It is still a file, and what keeps it is still worth saying.
      const bare = await fileRow('Fresh upload', ownerId);
      const keptBare = await fileRow('Fresh message photo', ownerId);
      const bareContent = await wrapper(bare.id, 'file');
      const keptContent = await wrapper(keptBare.id, 'file');
      const text = await message(attachmentsOf(keptBare.id));

      const purged = await contents.purge(owner, [bareContent, keptContent]);

      expect(purged.files).toMatchObject({
        wrappedFileIds: [bare.id],
        fileIds: [bare.id],
        nodeIds: [],
        deletedObjects: 1,
      });
      expect(await fileExists(bare.id)).toBe(false);
      expect(purged.files.kept).toEqual([
        {
          fileId: keptBare.id,
          nodeId: null,
          usedBy: { contentIds: [], messageIds: [text], chatMessageIds: [], eventId: null },
        },
      ]);
      expect(await fileExists(keptBare.id)).toBe(true);
    });

    it('needs no object store for a file that has no stored bytes, and refuses one that has, before it changes anything', async () => {
      const external = await fileRow('Drive photo', ownerId, { externalId: 'drive-1' });
      const stored = await storedPhoto('Trip photo');
      const storedBefore = await footprint(stored);
      const externalContent = await wrapper(external.id, 'file');
      const storedContent = await wrapper(stored.fileId, 'file');

      // Nothing stored to delete: a service built without a store does it.
      expect((await contentsWithoutStore.purge(owner, [externalContent])).files.wrappedFileIds).toEqual([
        external.id,
      ]);

      // Stored bytes to delete and nowhere to delete them from: refused whole, and nothing is touched.
      await expect(contentsWithoutStore.purge(owner, [storedContent])).rejects.toThrow(/no object store/);
      expect(await contentExists(storedContent)).toBe(true);
      expect(await footprint(stored)).toEqual(storedBefore);
    });

    it('leaves a file’s object alone when another file row of somebody else also names it, and says so', async () => {
      const doomed = await storedPhoto('Trip photo');
      const shared = await fileRow('Their copy', strangerId, { key: doomed.originalKey });
      const content = await wrapper(doomed.fileId, 'file');

      const purged = await contents.purge(owner, [content]);

      expect(purged.files).toMatchObject({ deletedObjects: 1, keptObjects: 1 });
      expect(deletedKeys()).toEqual([doomed.variantKey]);
      expect(await fileExists(shared.id)).toBe(true);
      expect(await fileExists(doomed.fileId)).toBe(false);
    });

    it('does nothing about files for an empty request, or for content that does not exist', async () => {
      expect(await contents.purge(owner, [])).toMatchObject({ contentIds: [] });
      expect(await contents.purge(owner, [uuidv7()])).toMatchObject({ contentIds: [] });
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });
  });

  // ── an event: its photos go with it ───────────────────────────────────────

  describe('purging an event', () => {
    it('removes the files its content wraps, with everything that points at them, and leaves another event’s photo alone', async () => {
      const trip = await event('Trip');
      const other = await event('Dinner');
      const first = await storedPhoto('Trip photo one');
      const second = await storedPhoto('Trip photo two');
      const control = await storedPhoto('Dinner photo');
      const controlBefore = await footprint(control);

      await wrapper(first.fileId, 'file', { eventId: trip });
      await wrapper(second.fileId, null, { eventId: trip });
      const controlContent = await wrapper(control.fileId, 'file', { eventId: other });

      expectEveryTableTouched(await footprint(first));
      expectEveryTableTouched(await footprint(second));

      published.length = 0;

      const purged = await calendar.purge(owner, [trip]);

      expect(purged.eventIds).toEqual([trip]);
      expect(purged.contentIds).toHaveLength(2);
      expect(sorted(purged.files.wrappedFileIds)).toEqual(sorted([first.fileId, second.fileId]));
      expect(purged.files).toMatchObject({ deletedObjects: 4, keptObjects: 0, kept: [] });
      expect(await eventExists(trip)).toBe(false);
      expect(await footprint(first)).toEqual(EMPTY);
      expect(await footprint(second)).toEqual(EMPTY);
      expect(deletedKeys()).toEqual(
        sorted([first.originalKey, first.variantKey, second.originalKey, second.variantKey]),
      );
      // The other event, its content and its photo did not move.
      expect(await eventExists(other)).toBe(true);
      expect(await contentExists(controlContent)).toBe(true);
      expect(await footprint(control)).toEqual(controlBefore);
    });

    it('removes a file that is linked straight to the event, which no content row wraps', async () => {
      // A CI-Capture screenshot: `ci.files.event_id` is `ON DELETE SET NULL`, so the foreign key alone would
      // null the link and keep the file. The user decided it goes with its event.
      const screen = await event('Screen');
      const elsewhere = await event('Another screen');
      const shot = await storedPhoto('Screenshot', { eventId: screen });
      const control = await storedPhoto('Other screenshot', { eventId: elsewhere });
      const controlBefore = await footprint(control);

      expectEveryTableTouched(await footprint(shot));

      const purged = await calendar.purge(owner, [screen]);

      expect(purged.files).toMatchObject({
        wrappedFileIds: [shot.fileId],
        fileIds: sorted([shot.fileId, shot.variantId]),
        deletedObjects: 2,
        kept: [],
      });
      expect(await footprint(shot)).toEqual(EMPTY);
      expect(deletedKeys()).toEqual(sorted([shot.originalKey, shot.variantKey]));
      expect(await footprint(control)).toEqual(controlBefore);
      expect(await fileExists(control.fileId)).toBe(true);
    });

    it('takes a file once when it is both wrapped by the event’s content and linked to the event', async () => {
      const trip = await event('Trip');
      const photo = await storedPhoto('Trip photo', { eventId: trip });

      await wrapper(photo.fileId, 'file', { eventId: trip });

      const purged = await calendar.purge(owner, [trip]);

      expect(purged.files.wrappedFileIds).toEqual([photo.fileId]);
      expect(purged.files.deletedObjects).toBe(2);
      expect(objectCalls).toHaveLength(1);
      expect(await footprint(photo)).toEqual(EMPTY);
    });

    it('does not take a file that is somebody else’s, even when it is linked to the caller’s event', async () => {
      const trip = await event('Trip');
      const theirs = await fileRow('Their photo', strangerId, { eventId: trip });

      const purged = await calendar.purge(owner, [trip]);

      expect(purged.eventIds).toEqual([trip]);
      expect(purged.files.wrappedFileIds).toEqual([]);
      expect(await fileExists(theirs.id)).toBe(true);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });

    it('leaves a file alone when it is not wrapped by the event’s content and not linked to it', async () => {
      const trip = await event('Trip');
      const unrelated = await storedPhoto('Unrelated photo');
      const unrelatedBefore = await footprint(unrelated);

      const purged = await calendar.purge(owner, [trip]);

      expect(purged.files.wrappedFileIds).toEqual([]);
      expect(await footprint(unrelated)).toEqual(unrelatedBefore);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });

    it('does nothing about files for an event that does not exist', async () => {
      expect((await calendar.purge(owner, [uuidv7()])).files.wrappedFileIds).toEqual([]);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    });
  });

  // ── a file that something else uses ───────────────────────────────────────

  describe('a file that something else still uses is kept, and the purge says what keeps it', () => {
    /** The file is untouched, row for row, and the purge asked the object store for nothing. */
    async function expectKept(photo: Photo, before: Record<string, number>): Promise<void> {
      expect(await footprint(photo)).toEqual(before);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    }

    it('keeps it while another content row wraps it, and deletes it with the last one', async () => {
      // The same bytes arrive twice, as two content rows, and an upload dedupes them onto one file.
      const photo = await storedPhoto('Forwarded photo');
      const before = await footprint(photo);
      const first = await wrapper(photo.fileId, 'file', { title: 'From the first message' });
      const second = await wrapper(photo.fileId, 'file', { title: 'From the second message' });

      const one = await contents.purge(owner, [first]);

      expect(one.contentIds).toEqual([first]);
      expect(one.files).toMatchObject({ wrappedFileIds: [], fileIds: [], deletedObjects: 0 });
      expect(one.files.kept).toEqual([
        {
          fileId: photo.fileId,
          nodeId: photo.nodeId,
          usedBy: { contentIds: [second], messageIds: [], chatMessageIds: [], eventId: null },
        },
      ]);
      await expectKept(photo, before);
      // The wrapper that was named is gone, and the other is as it was.
      expect(await contentExists(first)).toBe(false);
      expect(await contentExists(second)).toBe(true);

      // Forgetting the last one finishes what the first could not: the order they go in does not matter.
      const two = await contents.purge(owner, [second]);

      expect(two.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [] });
      expect(await footprint(photo)).toEqual(EMPTY);
      expect(deletedKeys()).toEqual(sorted([photo.originalKey, photo.variantKey]));
    });

    it('deletes it, once, when every content row that wraps it is named in the same call', async () => {
      const photo = await storedPhoto('Forwarded photo');
      const first = await wrapper(photo.fileId, 'file');
      const second = await wrapper(photo.fileId, null);

      const purged = await contents.purge(owner, [first, second]);

      expect(purged.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [], deletedObjects: 2 });
      expect(await footprint(photo)).toEqual(EMPTY);
      expect(objectCalls).toHaveLength(1);
    });

    it('is not kept by a content row marked as a URI that holds its id, which is never a file', async () => {
      const photo = await storedPhoto('Trip photo');
      const content = await wrapper(photo.fileId, 'file');

      await wrapper(photo.fileId, 'external_uri');

      const purged = await contents.purge(owner, [content]);

      expect(purged.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [] });
      expect(await footprint(photo)).toEqual(EMPTY);
    });

    it('keeps it for a message whose attachments name it, and names the message', async () => {
      // On a real corpus this is the common case: 722 of the 739 files a content row wraps are also attached to
      // a message. The message was not named, and loses nothing it still shows.
      const photo = await storedPhoto('Photo in a message');
      const before = await footprint(photo);
      const content = await wrapper(photo.fileId, 'file');
      const text = await message(attachmentsOf(photo.fileId));

      const purged = await contents.purge(owner, [content]);

      expect(purged.files.kept).toEqual([
        {
          fileId: photo.fileId,
          nodeId: photo.nodeId,
          usedBy: { contentIds: [], messageIds: [text], chatMessageIds: [], eventId: null },
        },
      ]);
      await expectKept(photo, before);
      // The message is exactly as it was, and still names the file.
      expect(
        await dataSource.query('SELECT attachments FROM ci.communications WHERE id = $1', [text]),
      ).toEqual([{ attachments: [{ type: 'file', id: photo.fileId }] }]);
    });

    it('keeps it for a message that names it in a shape the importer does not write', async () => {
      // `attachments` is free-form JSON from the API, so the id is looked for anywhere in it. The cost of a
      // shape nobody expected is a file that stays, not a message that loses its attachment.
      const photo = await storedPhoto('Photo in a message');
      const before = await footprint(photo);
      const content = await wrapper(photo.fileId, 'file');
      const text = await message([{ fileId: photo.fileId }, { media: { ref: photo.fileId } }]);

      const purged = await contents.purge(owner, [content]);

      expect(purged.files.kept).toMatchObject([{ usedBy: { messageIds: [text] } }]);
      await expectKept(photo, before);
    });

    it('is not kept by a message that names a different file, and each file is judged on its own', async () => {
      const kept = await storedPhoto('Photo in a message');
      const doomed = await storedPhoto('Photo nobody else has');
      const keptBefore = await footprint(kept);
      const keptContent = await wrapper(kept.fileId, 'file');
      const doomedContent = await wrapper(doomed.fileId, 'file');

      // Names one of the two, and a decoy that shares a prefix with the other.
      const text = await message([
        ...(attachmentsOf(kept.fileId) as unknown[]),
        { type: 'file', id: `${doomed.fileId.slice(0, 20)}${'0'.repeat(16)}` },
      ]);
      // An empty message and one with something else are no reason to keep anything.
      await message([]);
      await message(attachmentsOf(uuidv7()));

      const purged = await contents.purge(owner, [keptContent, doomedContent]);

      expect(purged.files.wrappedFileIds).toEqual([doomed.fileId]);
      expect(purged.files.kept).toMatchObject([{ fileId: kept.fileId, usedBy: { messageIds: [text] } }]);
      expect(await footprint(doomed)).toEqual(EMPTY);
      expect(await footprint(kept)).toEqual(keptBefore);
      expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
    });

    it('keeps it for a message that carries its id in a URL, or in capitals', async () => {
      // Every uuid anywhere in the attachments counts, because the column is free-form and a URL that carries the
      // id still shows the file. Ids are compared without regard to case.
      const inUrl = await storedPhoto('Photo linked by URL');
      const inCapitals = await storedPhoto('Photo named in capitals');
      const urlBefore = await footprint(inUrl);
      const capitalsBefore = await footprint(inCapitals);
      const urlContent = await wrapper(inUrl.fileId, 'file');
      const capitalsContent = await wrapper(inCapitals.fileId, 'file');
      const byUrl = await message([{ url: `https://example.invalid/files/${inUrl.fileId}/content` }]);
      const byCapitals = await message([{ id: inCapitals.fileId.toUpperCase() }]);

      const purged = await contents.purge(owner, [urlContent, capitalsContent]);

      expect(purged.files.wrappedFileIds).toEqual([]);
      expect(sorted(purged.files.kept.map((kept) => kept.fileId))).toEqual(
        sorted([inUrl.fileId, inCapitals.fileId]),
      );
      expect(purged.files.kept.find((kept) => kept.fileId === inUrl.fileId)?.usedBy.messageIds).toEqual([
        byUrl,
      ]);
      expect(purged.files.kept.find((kept) => kept.fileId === inCapitals.fileId)?.usedBy.messageIds).toEqual([
        byCapitals,
      ]);
      await expectKept(inUrl, urlBefore);
      await expectKept(inCapitals, capitalsBefore);
    });

    it('names each message once, and against every file it carries, however many times it carries it', async () => {
      const first = await storedPhoto('First photo');
      const second = await storedPhoto('Second photo');
      const firstContent = await wrapper(first.fileId, 'file');
      const secondContent = await wrapper(second.fileId, 'file');
      // One message carries both, the first twice over, and another carries only the second.
      const both = await message([
        { type: 'file', id: first.fileId },
        { type: 'file', id: first.fileId },
        { type: 'file', id: second.fileId },
      ]);
      const onlySecond = await message(attachmentsOf(second.fileId));

      const purged = await contents.purge(owner, [firstContent, secondContent]);

      const usedBy = (fileId: string) => purged.files.kept.find((kept) => kept.fileId === fileId)?.usedBy;

      expect(usedBy(first.fileId)?.messageIds).toEqual([both]);
      expect(usedBy(second.fileId)?.messageIds).toEqual(sorted([both, onlySecond]));
    });

    it('keeps it for a chat message that attaches it, which would lose the attachment', async () => {
      const photo = await storedPhoto('Photo in a chat');
      const before = await footprint(photo);
      const content = await wrapper(photo.fileId, 'file');
      const chat = await chatAttachment(photo.fileId);

      const purged = await contents.purge(owner, [content]);

      expect(purged.files.kept).toEqual([
        {
          fileId: photo.fileId,
          nodeId: photo.nodeId,
          usedBy: { contentIds: [], messageIds: [], chatMessageIds: [chat], eventId: null },
        },
      ]);
      await expectKept(photo, before);
      expect(await exists('SELECT count(*) FROM ci.message_files WHERE message_id = $1', chat)).toBe(true);
    });

    it('keeps it for an event that is not being forgotten, which it is linked to', async () => {
      const staying = await event('Stays');
      const photo = await storedPhoto('Event photo', { eventId: staying });
      const before = await footprint(photo);
      const content = await wrapper(photo.fileId, 'file');

      const purged = await contents.purge(owner, [content]);

      expect(purged.files.kept).toMatchObject([{ fileId: photo.fileId, usedBy: { eventId: staying } }]);
      await expectKept(photo, before);
    });

    it('keeps a whole file when something still shows its preview', async () => {
      // A preview is deleted with its original by cascade, so a record that still wraps the preview keeps the
      // original too, or the cascade would take the preview out from under it.
      const photo = await storedPhoto('Trip photo');
      const before = await footprint(photo);
      const content = await wrapper(photo.fileId, 'file');
      const showsPreview = await wrapper(photo.variantId, 'file');

      const purged = await contents.purge(owner, [content]);

      expect(purged.files.kept).toMatchObject([
        { fileId: photo.fileId, usedBy: { contentIds: [showsPreview] } },
      ]);
      await expectKept(photo, before);
    });

    it('deletes a preview that something else wraps, when only the preview is what was wrapped', async () => {
      const photo = await storedPhoto('Trip photo');
      const content = await wrapper(photo.variantId, 'file');

      const purged = await contents.purge(owner, [content]);

      expect(purged.files.wrappedFileIds).toEqual([photo.variantId]);
      expect(await fileExists(photo.variantId)).toBe(false);
      expect(await fileExists(photo.fileId)).toBe(true);
      expect(deletedKeys()).toEqual([photo.variantKey]);
    });

    it('is kept by content that is somebody else’s, or has no owner, which still shows the file', async () => {
      const photo = await storedPhoto('Trip photo');
      const before = await footprint(photo);
      const content = await wrapper(photo.fileId, 'file');
      const theirs = await wrapper(photo.fileId, 'file', { forUser: strangerId });
      const legacy = await wrapper(photo.fileId, 'file', { forUser: null });

      const purged = await contents.purge(owner, [content]);

      expect(purged.files.kept).toMatchObject([{ usedBy: { contentIds: sorted([theirs, legacy]) } }]);
      await expectKept(photo, before);
    });

    it('is not kept by records that merely mention it: an observation, a receipt, a summary and a link preview', async () => {
      const photo = await storedPhoto('Photo of a kettle');
      const content = await wrapper(photo.fileId, 'file');
      const [{ observation_id: observationId }] = await dataSource.query(
        `INSERT INTO ci.object_observations (user_id, observed_at, label, file_id)
         VALUES ($1, now(), 'a kettle', $2) RETURNING observation_id`,
        [ownerId, photo.fileId],
      );
      const [{ receipt_id: receiptId }] = await dataSource.query(
        `INSERT INTO ci.receipts (user_id, source_file_id) VALUES ($1, $2) RETURNING receipt_id`,
        [ownerId, photo.fileId],
      );
      const [{ summary_id: summaryId }] = await dataSource.query(
        `INSERT INTO ci.summaries (user_id, period_start, period_end, period_type, source_types, related_files_ids)
         VALUES ($1, now(), now(), 'daily', ARRAY['wrapped_file_spec'], ARRAY[$2]::uuid[]) RETURNING summary_id`,
        [ownerId, photo.fileId],
      );
      const [{ id: unfurlId }] = await dataSource.query(
        `INSERT INTO ci.unfurls (user_id, resolve_key, resolver, status, poster_file_id)
         VALUES ($1, $2, 'spec', 'ok', $3) RETURNING id`,
        [ownerId, `https://example.invalid/${photo.fileId}`, photo.fileId],
      );

      const purged = await contents.purge(owner, [content]);

      expect(purged.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [] });
      expect(await footprint(photo)).toEqual(EMPTY);
      // The records are their own, and the file purge leaves them as it found them: still naming a file that is gone.
      expect(
        await dataSource.query('SELECT file_id FROM ci.object_observations WHERE observation_id = $1', [
          observationId,
        ]),
      ).toEqual([{ file_id: photo.fileId }]);
      expect(
        await dataSource.query('SELECT source_file_id FROM ci.receipts WHERE receipt_id = $1', [receiptId]),
      ).toEqual([{ source_file_id: photo.fileId }]);
      expect(
        await dataSource.query('SELECT related_files_ids FROM ci.summaries WHERE summary_id = $1', [
          summaryId,
        ]),
      ).toEqual([{ related_files_ids: [photo.fileId] }]);
      // The link preview stays, and loses its poster, which is what the foreign key says.
      expect(
        await dataSource.query('SELECT poster_file_id FROM ci.unfurls WHERE id = $1', [unfurlId]),
      ).toEqual([{ poster_file_id: null }]);
    });

    it('keeps a photo that an event shares with a message, and still deletes the event and its content', async () => {
      const trip = await event('Trip');
      const photo = await storedPhoto('Trip photo');
      const before = await footprint(photo);
      const content = await wrapper(photo.fileId, 'file', { eventId: trip });
      const text = await message(attachmentsOf(photo.fileId));

      const purged = await calendar.purge(owner, [trip]);

      expect(purged.eventIds).toEqual([trip]);
      expect(purged.contentIds).toEqual([content]);
      expect(purged.files.kept).toMatchObject([
        { fileId: photo.fileId, nodeId: photo.nodeId, usedBy: { messageIds: [text] } },
      ]);
      expect(await eventExists(trip)).toBe(false);
      expect(await contentExists(content)).toBe(false);
      await expectKept(photo, before);
    });

    it('keeps a photo that two events share until the second goes, and then deletes it', async () => {
      const first = await event('First trip');
      const second = await event('Second trip');
      const photo = await storedPhoto('Shared trip photo');

      await wrapper(photo.fileId, 'file', { eventId: first });
      await wrapper(photo.fileId, 'file', { eventId: second });

      const one = await calendar.purge(owner, [first]);

      expect(one.files.wrappedFileIds).toEqual([]);
      expect(one.files.kept).toHaveLength(1);
      expect(await fileExists(photo.fileId)).toBe(true);

      const two = await calendar.purge(owner, [second]);

      expect(two.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [] });
      expect(await footprint(photo)).toEqual(EMPTY);
    });

    it('keeps a file that is linked to an event being forgotten, and wrapped by content that is not', async () => {
      const trip = await event('Trip');
      const photo = await storedPhoto('Trip photo', { eventId: trip });
      const before = await footprint(photo);
      const stays = await wrapper(photo.fileId, 'file');

      const purged = await calendar.purge(owner, [trip]);

      expect(purged.files.kept).toMatchObject([{ fileId: photo.fileId, usedBy: { contentIds: [stays] } }]);
      // The foreign key nulls the link to the event that went.
      expect(await dataSource.query('SELECT event_id FROM ci.files WHERE id = $1', [photo.fileId])).toEqual([
        { event_id: null },
      ]);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
      expect((await footprint(photo))['ci.files (original)']).toBe(before['ci.files (original)']);
    });
  });

  // ── the objects go first, and what a failure leaves ───────────────────────

  describe('the objects go first, while the rows are locked', () => {
    it('deletes the objects while every row is still there and locked, and the rows afterwards', async () => {
      const doomed = await storedPhoto('Trip photo');
      const content = await wrapper(doomed.fileId, 'file');
      const seen: { files: number; content: number; lockedAgainstOthers: boolean } = {
        files: -1,
        content: -1,
        lockedAgainstOthers: false,
      };

      deleteObjectsImpl = async () => {
        // On other connections, as a listener or another request would see it: nothing is deleted yet...
        seen.files = Number(
          (await dataSource.query('SELECT count(*) FROM ci.files WHERE id = $1', [doomed.fileId]))[0].count,
        );
        seen.content = Number(
          (await dataSource.query('SELECT count(*) FROM ci.content WHERE id = $1', [content]))[0].count,
        );

        // ...and the file is locked, which Postgres says by refusing to wait for it.
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

      await contents.purge(owner, [content]);

      expect(seen).toEqual({ files: 1, content: 1, lockedAgainstOthers: true });
      expect(await fileExists(doomed.fileId)).toBe(false);
    });

    it('keeps a variant that is written while the object store works out until the purge has committed', async () => {
      const doomed = await storedPhoto('Trip photo');
      const content = await wrapper(doomed.fileId, 'file');
      const gate = deferred();
      const inCall = deferred();

      deleteObjectsImpl = async () => {
        inCall.resolve();
        await gate.promise;
      };

      const purging = contents.purge(owner, [content]);

      purging.catch(() => undefined);
      await inCall.promise;

      const writer = dataSource.createQueryRunner();

      await writer.connect();
      await writer.startTransaction();

      try {
        const [{ pid }] = await writer.query('SELECT pg_backend_pid() AS pid');

        // What the preview stage does for a file it has just rendered a preview of: the insert checks its
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

        const holders = await until(async () => {
          const rows: Array<{ state: string }> = await dataSource.query(
            'SELECT state FROM pg_stat_activity WHERE pid = ANY(pg_blocking_pids($1::int))',
            [pid],
          );

          return rows.length > 0 ? rows : null;
        }, 'the variant insert to block on the purge');

        // The purge is not in the middle of a statement: it is idle in its transaction, waiting for the store.
        expect(holders).toEqual([{ state: 'idle in transaction' }]);

        gate.resolve();
        await purging;

        // The parent is gone, so the insert that waited for it fails, and no object was left without a row.
        expect(sqlState(await outcome)).toBe('23503');
        expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
        expect(await footprint(doomed)).toEqual(EMPTY);
      } finally {
        gate.resolve();
        await writer.rollbackTransaction().catch(() => undefined);
        await writer.release();
        await purging.catch(() => undefined);
      }
    }, 60_000);

    it('decides after it holds the lock, so a purge that had to wait sees what the one it waited for committed', async () => {
      // Two content rows wrap one file and two purges run at once, one for each. Whichever holds the file decides;
      // the other waits, and then decides on what the first committed. Were the decision made before the wait,
      // each would see the other's row as a survivor, both would keep the file, and nobody would delete it.
      const photo = await storedPhoto('Forwarded photo');
      const first = await wrapper(photo.fileId, 'file');
      const second = await wrapper(photo.fileId, 'file');
      const other = dataSource.createQueryRunner();

      await other.connect();
      await other.startTransaction();

      let purging: Promise<unknown> | undefined;

      try {
        // The other purge is in the middle of its work: it holds the file.
        await other.query('SELECT 1 FROM ci.files WHERE id = $1 FOR UPDATE', [photo.fileId]);

        const [{ pid }] = await other.query('SELECT pg_backend_pid() AS pid');

        purging = contents.purge(owner, [second]);
        purging.catch(() => undefined);

        // It waits at the statement that locks the files, before it has asked the object store anything.
        const blocked = await until(async () => {
          const rows: Array<{ query: string }> = await dataSource.query(
            'SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [pid],
          );

          return rows.length > 0 ? rows : null;
        }, 'the purge to wait for the lock on the file');

        expect(blocked).toHaveLength(1);
        expect(blocked[0].query).toMatch(/\bFOR UPDATE\b/);
        expect(storage.deleteObjects).not.toHaveBeenCalled();

        // The other purge commits: its content row is gone.
        await other.query('DELETE FROM ci.content WHERE id = $1', [first]);
        await other.query('DELETE FROM ci.entities WHERE entity_id = $1', [first]);
        await other.commitTransaction();
      } catch (error) {
        await other.rollbackTransaction().catch(() => undefined);
        await purging?.catch(() => undefined);

        throw error;
      } finally {
        await other.release();
      }

      const result = (await purging) as Awaited<ReturnType<ContentService['purge']>>;

      // It saw that the other row had gone, and so nothing used the file any more.
      expect(result.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [] });
      expect(await footprint(photo)).toEqual(EMPTY);
      expect(deletedKeys()).toEqual(sorted([photo.originalKey, photo.variantKey]));
    }, 60_000);

    it('leaves everything as it was, and says so, when the object store fails; and finishes when it comes back', async () => {
      const doomed = await storedPhoto('Trip photo');
      const content = await wrapper(doomed.fileId, 'file');
      const doomedBefore = await footprint(doomed);

      deleteObjectsImpl = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:9000');
      };

      published.length = 0;

      const failure = await contents.purge(owner, [content]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      // Not the error that says the bytes are gone: nothing was deleted from the database.
      expect(failure).not.toBeInstanceOf(StoredObjectsDeletedError);
      expect((failure as Error).message).toContain('nothing was deleted from the database');
      expect((failure as Error).message).toContain('ECONNREFUSED');
      expect(await footprint(doomed)).toEqual(doomedBefore);
      expect(await contentExists(content)).toBe(true);
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

      // The store comes back, and forgetting the content again goes through.
      deleteObjectsImpl = async () => undefined;

      expect((await contents.purge(owner, [content])).files.wrappedFileIds).toEqual([doomed.fileId]);
      expect(await footprint(doomed)).toEqual(EMPTY);
    });

    it('gives up on an object store that does not answer, and lets go of the rows', async () => {
      const doomed = await storedPhoto('Trip photo');
      const content = await wrapper(doomed.fileId, 'file');
      const doomedBefore = await footprint(doomed);

      // Nothing else bounds the wait: the client sets no timeout, and neither does the database.
      const failure = await dataSource
        .transaction((manager) =>
          purgeContentAggregates(manager, ownerId, [content], {
            objects: { deleteObjects: () => new Promise<void>(() => undefined) },
            deadlineMs: 100,
          }),
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('did not answer within');
      expect((failure as Error).message).toContain('nothing was deleted from the database');
      expect(await footprint(doomed)).toEqual(doomedBefore);
      expect(await contentExists(content)).toBe(true);

      const probe = dataSource.createQueryRunner();

      await probe.connect();
      await probe.startTransaction();
      await expect(
        probe.query('SELECT 1 FROM ci.files WHERE id = $1 FOR UPDATE NOWAIT', [doomed.fileId]),
      ).resolves.toBeDefined();
      await probe.rollbackTransaction();
      await probe.release();
    }, 30_000);

    it('keeps the rows, and names the content whose photo is gone, when the database refuses afterwards; forgetting again finishes it', async () => {
      const doomed = await storedPhoto('Trip photo');
      const control = await storedPhoto('Recipe photo');
      const withPhoto = await wrapper(doomed.fileId, 'file');
      const withoutPhoto = await wrapper('spotify:track:4uLU6hMCjMI75M1A2tKUQC', null);
      const doomedBefore = await footprint(doomed);

      await wrapper(control.fileId, 'file');

      // `ci.users.entity_id` references ci.entities with no ON DELETE action. Pointing it at a content node makes
      // the delete of that node fail, after the objects have gone, as a table this teardown has never heard of
      // would. The content rows are deleted before the file rows, so this refuses before the file rows are touched.
      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [withPhoto, strangerId]);
      published.length = 0;

      const failure = await contents.purge(owner, [withPhoto, withoutPhoto]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StoredObjectsDeletedError);

      const gone = failure as StoredObjectsDeletedError;

      // Only the content whose photo lost its bytes is named; the other lost nothing.
      expect(gone.nodeIds).toEqual([withPhoto]);
      expect(sqlState(gone.cause)).toBe('23503');
      // The objects went, and went FIRST: the refusal came from the delete of the content node, which a purge that
      // deleted rows before objects would have stopped at without ever asking the store.
      expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
      // The rows did not: every table is as it was, the content still wraps the file, and nothing was announced.
      expect(await footprint(doomed)).toEqual(doomedBefore);
      expect(await contentExists(withPhoto)).toBe(true);
      expect(await contentExists(withoutPhoto)).toBe(true);
      expect(published).toEqual([]);

      // Forgetting it again finds the same file and the same keys. The object store treats a key that is already
      // gone as deleted, so the second delete is the same call, and then the rows go.
      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = $1', [strangerId]);
      objectCalls.length = 0;

      const purged = await contents.purge(owner, [withPhoto, withoutPhoto]);

      expect(purged.files.wrappedFileIds).toEqual([doomed.fileId]);
      expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
      expect(await footprint(doomed)).toEqual(EMPTY);
    });

    it('goes first even when it is the file’s own node that the database then refuses', async () => {
      const doomed = await storedPhoto('Trip photo');
      const content = await wrapper(doomed.fileId, 'file');
      const doomedBefore = await footprint(doomed);

      // The content goes first and the file's rows last, so this refuses after the content node is deleted and the
      // objects are gone. All of it is one transaction, and rolls back whole.
      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [doomed.nodeId, strangerId]);

      const failure = await contents.purge(owner, [content]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StoredObjectsDeletedError);
      expect((failure as StoredObjectsDeletedError).nodeIds).toEqual([content]);
      expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
      expect(await footprint(doomed)).toEqual(doomedBefore);
      expect(await contentExists(content)).toBe(true);
    });

    it('names only the content whose photo lost its bytes, not the content whose file was kept', async () => {
      const doomed = await storedPhoto('Trip photo');
      const kept = await storedPhoto('Photo in a message');
      const doomedContent = await wrapper(doomed.fileId, 'file');
      const keptContent = await wrapper(kept.fileId, 'file');

      await message(attachmentsOf(kept.fileId));
      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [doomedContent, strangerId]);

      const failure = await contents
        .purge(owner, [doomedContent, keptContent])
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StoredObjectsDeletedError);
      // The kept file lost nothing, so the content that wrapped it is not one that wraps a photo that will not open.
      expect((failure as StoredObjectsDeletedError).nodeIds).toEqual([doomedContent]);
      expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
    });

    it('does the same for an event: it names the event, and keeps its content and its photos’ rows', async () => {
      const trip = await event('Trip');
      const doomed = await storedPhoto('Trip photo');
      const content = await wrapper(doomed.fileId, 'file', { eventId: trip });
      const doomedBefore = await footprint(doomed);

      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [trip, strangerId]);
      published.length = 0;

      const failure = await calendar.purge(owner, [trip]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StoredObjectsDeletedError);
      // The event is what the caller named, and what it forgets again: its content goes with it.
      expect((failure as StoredObjectsDeletedError).nodeIds).toEqual([trip]);
      expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
      expect(await eventExists(trip)).toBe(true);
      expect(await contentExists(content)).toBe(true);
      expect(await footprint(doomed)).toEqual(doomedBefore);
      expect(published).toEqual([]);

      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = $1', [strangerId]);

      const purged = await calendar.purge(owner, [trip]);

      expect(purged.files.wrappedFileIds).toEqual([doomed.fileId]);
      expect(await footprint(doomed)).toEqual(EMPTY);
    });

    it('does not claim objects are gone when the file had none, if the database then refuses', async () => {
      const external = await fileRow('Drive photo', ownerId, { externalId: 'drive-1' });
      const content = await wrapper(external.id, 'file');

      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [content, strangerId]);

      const failure = await contents.purge(owner, [content]).catch((error: unknown) => error);

      // Nothing outside the database was destroyed, so this is the plain refusal.
      expect(failure).not.toBeInstanceOf(StoredObjectsDeletedError);
      expect(sqlState(failure)).toBe('23503');
      expect(await fileExists(external.id)).toBe(true);
    });

    it('does not announce a file that was kept, or any removal at all when it is refused whole', async () => {
      const photo = await storedPhoto('Trip photo');
      const content = await wrapper(photo.fileId, 'file');

      await message(attachmentsOf(photo.fileId));
      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [content, strangerId]);
      published.length = 0;

      await expect(contents.purge(owner, [content])).rejects.toThrow(/foreign key/i);

      expect(published).toEqual([]);
    });
  });

  // ── locking a file by its own id ──────────────────────────────────────────

  describe('locking files by their own id', () => {
    it('takes only the caller’s own files, and every variant under them, and skips an id that is not a file', async () => {
      const mine = await storedPhoto('My photo');
      const theirs = await fileRow('Their photo', strangerId);
      const theirsVariant = await fileRow('Their preview', strangerId, {
        variant: 'PREVIEW',
        parentId: theirs.id,
      });

      const locked = await dataSource.transaction((manager) =>
        lockFiles(manager, ownerId, { fileIds: [mine.fileId, theirs.id, theirsVariant.id, uuidv7()] }),
      );

      expect(locked.map((file) => file.id).sort()).toEqual(sorted([mine.fileId, mine.variantId]));
      // What the plan needs to decide: a variant knows its parent, and a linked file its event.
      expect(locked.find((file) => file.id === mine.variantId)?.parentId).toBe(mine.fileId);
    });

    it('does not take a variant that is somebody else’s under a file that is the caller’s', async () => {
      const mine = await storedPhoto('My photo');
      const foreign = await fileRow('Foreign copy', strangerId, {
        variant: 'PREVIEW',
        parentId: mine.fileId,
      });

      const locked = await dataSource.transaction((manager) =>
        lockFiles(manager, ownerId, { fileIds: [mine.fileId] }),
      );

      expect(locked.map((file) => file.id)).not.toContain(foreign.id);
    });
  });

  // ── telling the rest of the app ───────────────────────────────────────────

  describe('announcing what went', () => {
    it('announces each file after it has committed, by the id of the ci.files row, and nothing for one it kept', async () => {
      const doomed = await storedPhoto('Trip photo');
      const kept = await storedPhoto('Photo in a message');
      const content = await wrapper(doomed.fileId, 'file');
      const keptContent = await wrapper(kept.fileId, 'file');

      await message(attachmentsOf(kept.fileId));
      published.length = 0;

      await contents.purge(owner, [content, keptContent]);

      // The search rows are keyed by the `ci.files` id, so that is what a listener is told. The node's id would
      // delete nothing.
      expect(announced(FileRemovedEvent)).toEqual(sorted([doomed.fileId, doomed.variantId]));
      expect(announced(ContentRemovedEvent)).toEqual(sorted([content, keptContent]));
    });

    it('announces an event’s files too, after its content and itself', async () => {
      const trip = await event('Trip');
      const doomed = await storedPhoto('Trip photo');

      await wrapper(doomed.fileId, 'file', { eventId: trip });
      published.length = 0;

      await calendar.purge(owner, [trip]);

      expect(announced(FileRemovedEvent)).toEqual(sorted([doomed.fileId, doomed.variantId]));
      expect(announced(EventRemovedEvent)).toEqual([trip]);
      expect(announced(ContentRemovedEvent)).toHaveLength(1);
    });

    it('announces a removal only once it has committed, so a listener that looks finds the row gone', async () => {
      const doomed = await storedPhoto('Trip photo');
      const content = await wrapper(doomed.fileId, 'file');
      const found: number[] = [];

      (signalling.send as jest.Mock).mockImplementation(async (name: string, payload: unknown) => {
        if (name === FileRemovedEvent) {
          // A listener reads on its own connection. Were the delete not committed yet, it would still find the row.
          const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.files WHERE id = $1', [
            doomed.fileId,
          ]);

          found.push(Number(count));
        }

        published.push({ name, payload });

        return [];
      });

      try {
        await contents.purge(owner, [content]);
      } finally {
        (signalling.send as jest.Mock).mockImplementation(async (name: string, payload: unknown) => {
          published.push({ name, payload });

          return [];
        });
      }

      // Precondition: the listener was asked, for the file and for its preview.
      expect(found).toEqual([0, 0]);
    });
  });
});
