import { DataSource } from 'typeorm';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { HbpeNotifyService } from '@ci/common/hbpe';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { FileRemovedEvent } from '@ci/domains/files/events';
import { CommunicationRemovedEvent, ContentRemovedEvent } from '@ci/domains/memory/events';
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
import { CalendarEventService } from '../CalendarEventService';
import { purgeCommunicationAggregates } from '../communicationPurge';
import { CommunicationService } from '../CommunicationService';
import { ContentService } from '../ContentService';
import { StoredObjectsDeletedError, type StoredObjects } from '../filePurge';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FORGETTING A MESSAGE FORGETS WHAT ITS ATTACHMENTS NAME. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ci.communications.attachments` is free-form JSON that the importer fills with `{type: 'file', id}` and
 * `{type: 'content', id}` entries, and nothing in the schema joins it to anything. Purging a message deleted the
 * message and left every photo it carried: the `ci.files` row, its previews, its `File` node, its search rows and
 * the stored bytes, and for Messenger and Discord the content rows over them. A file that #2911 kept because a
 * message named it was never deleted later either, when that message was forgotten.
 *
 * `CommunicationService.purge` now takes what the attachments name. The files go when nothing else uses them, by
 * the rule `wrappedFilePurge.ts` explains and measures; the content rows the attachments name go with the message,
 * unless another message names them or an event holds them. Each case seeds a doomed photo and a CONTROL one with a
 * row in every table the purge is meant to clean, and checks that every one is gone for the first and that the
 * second did not move. The footprint is asserted non-zero before the purge, in every table, so the test cannot pass
 * because a fixture quietly wrote nothing.
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
  console.warn(`[memory/CommunicationAttachmentsPurge.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const BUCKET = 'static';
const DINNER_AT = new Date('2026-08-19T17:00:00Z');
const SENT_ON = new Date('2026-08-19T17:00:00Z');

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
  /** The `ci.files` row of the original: what a message's attachments and a content row's `external_id` hold. */
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

/** Every place a row can point at a content row, with how to count them. A probe takes the content id as `$1`. */
const CONTENT_FOOTPRINT: Array<[label: string, sql: string]> = [
  ['ci.entities (Content node)', `SELECT count(*) FROM ci.entities WHERE entity_id = $1`],
  ['ci.content', `SELECT count(*) FROM ci.content WHERE id = $1`],
  [
    'ci.relationships',
    `SELECT count(*) FROM ci.relationships WHERE from_entity_id = $1 OR to_entity_id = $1`,
  ],
  [
    'ci.graph_deltas (of its edges)',
    `SELECT count(*) FROM ci.graph_deltas
      WHERE node_type = 'relationship' AND (from_entity_id = $1 OR to_entity_id = $1)`,
  ],
  ['ci.graph_deltas', `SELECT count(*) FROM ci.graph_deltas WHERE entity_id = $1`],
  [
    'ci.record_sources',
    `SELECT count(*) FROM ci.record_sources WHERE record_table = 'content' AND record_id = $1`,
  ],
  ['ci.pipeline_state', `SELECT count(*) FROM ci.pipeline_state WHERE entity_id = $1`],
  ['ci_search.vectors', `SELECT count(*) FROM ci_search.vectors WHERE entity_id = $1`],
  ['ci_search.embeddings', `SELECT count(*) FROM ci_search.embeddings WHERE entity_id = $1`],
];

describeWithDb(
  `purging a message and what its attachments name, against Postgres (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let communications: CommunicationService;
    let contents: ContentService;
    let calendar: CalendarEventService;
    /** A service built without an object store, which can purge everything that has no stored bytes. */
    let communicationsWithoutStore: CommunicationService;

    const ownerId = uuidv7();
    const strangerId = uuidv7();
    const owner = { userId: ownerId } as UserServiceContext;

    const published: Array<{ name: string; payload: unknown }> = [];
    const notified: Array<{ userId: string; days: string[] }> = [];

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
    const hbpe = {
      notifyCommunications: jest.fn(async (userId: string, times: Date | Iterable<Date>) => {
        const days = Array.from(times instanceof Date ? [times] : times, (time) =>
          time.toISOString().slice(0, 10),
        );

        notified.push({ userId, days });
      }),
    } as unknown as HbpeNotifyService;

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        ...dataSourceConnection(DATABASE_ENV),
        entities: [
          EventEntity,
          BaseEntity,
          EventBaseEntity,
          ContentEntity,
          ContentBaseEntity,
          CommunicationEntity,
          CommunicationBaseEntity,
          UserEntity,
        ],
        synchronize: false,
        extra: { options: '-c search_path=ci,public' },
      });
      await dataSource.initialize();
      schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/CommunicationAttachmentsPurge');

      for (const userId of [ownerId, strangerId]) {
        await createSyntheticTestUser(
          (sql, params) => dataSource.query(sql, params),
          'MsgAttachments',
          userId,
        );
      }

      const deltaWriter = new GraphDeltaWriter(dataSource, logger());
      const store = storage as unknown as StoredObjects;

      communications = new CommunicationService(
        dataSource.getRepository(CommunicationEntity),
        signalling,
        logger(),
        dataSource,
        deltaWriter,
        hbpe,
        store,
      );
      communicationsWithoutStore = new CommunicationService(
        dataSource.getRepository(CommunicationEntity),
        signalling,
        logger(),
        dataSource,
        deltaWriter,
        hbpe,
      );
      contents = new ContentService(
        dataSource.getRepository(ContentEntity),
        dataSource.getRepository(ContentBaseEntity),
        dataSource.getRepository(EventEntity),
        signalling,
        deltaWriter,
        store,
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
      await dataSource.query('DELETE FROM ci.identifier_claims WHERE owner_user_id = ANY($1::uuid[])', [
        users,
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
      await dataSource.query(
        'DELETE FROM ci.content WHERE user_id = ANY($1::uuid[]) OR id = ANY($2::uuid[])',
        [users, seeded],
      );
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
      notified.length = 0;
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
       VALUES ($4, $1, $2, 0, $3, 'comm_attachments_spec', '1', '1')`,
        [original.id, ownerId, `${name} text`, chunkId],
      );
      await dataSource.query(
        `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
       VALUES ('file', $1, 'comm_attachments_spec.stage', 'done', $2)`,
        [original.id, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.pipeline_dead_letters (queue, event_name, entity_type, entity_id, payload, error, user_id)
       VALUES ('pipeline', 'file.uploaded', 'file', $1, '{}'::jsonb, 'boom', $2)`,
        [original.id, ownerId],
      );

      const [{ id: tag }] = await dataSource.query(
        `INSERT INTO ci_search.tags (id, label, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
        [`comm-attachments-spec-${name}`, ownerId],
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
        `INSERT INTO ci_search.index_skips (entity_type, entity_id, reason) VALUES ('file', $1, 'comm_attachments_spec')`,
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

    /**
     * A content row, with the rows a content row has: its `Content` node, an edge and the deltas, a ledger entry,
     * pipeline bookkeeping and search rows. With a `fileId` it wraps a stored file, the way an imported photo's
     * does; without one it is what Discord writes for an attachment link: a URL and no file.
     */
    async function contentRow(
      fileId: string | null,
      kind: 'file' | 'external_uri' | null,
      extra: { forUser?: string | null; eventId?: string; title?: string } = {},
    ): Promise<string> {
      const id = uuidv7();
      const forUser = extra.forUser === undefined ? ownerId : extra.forUser;
      const title = extra.title ?? 'IMG_0001.jpg';

      seeded.push(id);
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
        [id, title, forUser ?? ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.content (id, type, text, mimetype, url, user_id, event_id, external_id, external_id_kind)
       VALUES ($1, 'media', 'A squirrel on a fence', 'image/jpeg', $6, $2, $3, $4, $5)`,
        [
          id,
          forUser,
          extra.eventId ?? null,
          fileId,
          fileId === null ? null : kind,
          fileId === null ? 'https://cdn.example.invalid/attachments/1/2/squirrel.jpg' : null,
        ],
      );

      const person = await node('Person', `${title} photographer`);

      await edge(person, id, 'CAPTURED');
      await dataSource.query(
        `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, 'Content', 'created', jsonb_build_object('name', jsonb_build_object('new', $2::text)), $3)`,
        [id, title, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id)
       VALUES ($1, 'content', $2, 'ci.import', 'comm_attachments_spec', $3)`,
        [ownerId, id, `content-${id}`],
      );
      await dataSource.query(
        `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
       VALUES ('content', $1, 'comm_attachments_spec.stage', 'done', $2)`,
        [id, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'content', $1, to_tsvector('simple', $2), $3)`,
        [id, title, ownerId],
      );
      await dataSource.query(
        `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
       VALUES (gen_random_uuid(), 'content', $1, $2)`,
        [id, ownerId],
      );

      return id;
    }

    /** A content row that wraps a file the way an imported photo's does. */
    const wrapper = (
      fileId: string,
      kind: 'file' | 'external_uri' | null,
      extra: { forUser?: string | null; eventId?: string; title?: string } = {},
    ): Promise<string> => contentRow(fileId, kind, extra);

    /** A message whose `attachments` column is whatever the writer gave it, or NULL when it is given nothing. */
    async function message(attachments: unknown, forUser = ownerId, time = SENT_ON): Promise<string> {
      const id = uuidv7();

      seeded.push(id);
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Communication', 'a message', '{}'::jsonb, $2, 'communications', $1)`,
        [id, forUser],
      );
      await dataSource.query(
        `INSERT INTO ci.communications (id, "time", user_id, communication_type, direction, subject, content, attachments)
       VALUES ($1, $4, $2, 'email', 'inbound', 'photo', 'see attached', $3::jsonb)`,
        [id, forUser, attachments === undefined ? null : JSON.stringify(attachments), time],
      );

      return id;
    }

    /** What an importer writes for a message that carries a file. */
    const attachmentsOf = (fileId: string): unknown => [{ type: 'file', id: fileId }];

    /** What Messenger writes: each photo's file, and the content row over it. */
    const messengerAttachments = (fileId: string, contentId: string): unknown => [
      { type: 'file', id: fileId },
      { type: 'content', id: contentId },
    ];

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

    async function contentFootprint(contentId: string): Promise<Record<string, number>> {
      const counts: Record<string, number> = {};

      for (const [label, sql] of CONTENT_FOOTPRINT) {
        const [{ count }] = await dataSource.query(sql, [contentId]);

        counts[label] = Number(count);
      }

      return counts;
    }

    /** What `footprint` reads when every row is gone. */
    const EMPTY = Object.fromEntries(FOOTPRINT.map(([label]) => [label, 0]));
    const EMPTY_CONTENT = Object.fromEntries(CONTENT_FOOTPRINT.map(([label]) => [label, 0]));

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
    const contentExists = (id: string) => exists('SELECT count(*) FROM ci.content WHERE id = $1', id);
    const messageExists = (id: string) => exists('SELECT count(*) FROM ci.communications WHERE id = $1', id);
    const nodeExists = (id: string) => exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', id);

    /** The ids a purge announced, by event name. */
    const announced = (name: string): string[] =>
      published
        .filter((entry) => entry.name === name)
        .map((entry) => Object.values(entry.payload as Record<string, string>)[0])
        .sort();

    /** The file is untouched, row for row, and the purge asked the object store for nothing. */
    async function expectKept(photo: Photo, before: Record<string, number>): Promise<void> {
      expect(await footprint(photo)).toEqual(before);
      expect(storage.deleteObjects).not.toHaveBeenCalled();
    }

    // ── a message that names a stored file ────────────────────────────────────

    describe('purging a message whose attachments name a stored file', () => {
      it('removes the file, its preview, their nodes, their objects and every row that points at them, and nothing else', async () => {
        const doomed = await storedPhoto('Trip photo');
        const control = await storedPhoto('Shopping list photo');
        const doomedMessage = await message(attachmentsOf(doomed.fileId));
        const controlMessage = await message(attachmentsOf(control.fileId));

        const doomedBefore = await footprint(doomed);
        const controlBefore = await footprint(control);

        expectEveryTableTouched(doomedBefore);
        expectEveryTableTouched(controlBefore);

        const purged = await communications.purge(owner, [doomedMessage]);

        expect(purged.communicationIds).toEqual([doomedMessage]);
        expect(purged.contentIds).toEqual([]);
        expect(purged.files).toEqual({
          wrappedFileIds: [doomed.fileId],
          fileIds: sorted([doomed.fileId, doomed.variantId]),
          nodeIds: sorted([doomed.nodeId, doomed.variantNodeId]),
          deletedObjects: 2,
          keptObjects: 0,
          kept: [],
        });
        expect(await messageExists(doomedMessage)).toBe(false);
        expect(await nodeExists(doomedMessage)).toBe(false);
        expect(await footprint(doomed)).toEqual(EMPTY);
        // The control photo and its message are exactly as they were, row for row.
        expect(await footprint(control)).toEqual(controlBefore);
        expect(await messageExists(controlMessage)).toBe(true);
        // The objects of the doomed file and its preview went, once each, in one call, and the control's did not.
        expect(objectCalls).toEqual([
          { bucket: BUCKET, keys: sorted([doomed.originalKey, doomed.variantKey]) },
        ]);
        expect(deletedKeys()).not.toContain(control.originalKey);
        // HBPE is still told which day the message was on.
        expect(notified).toEqual([{ userId: ownerId, days: ['2026-08-19'] }]);
      });

      it('takes the files of several messages named in one call, and deletes each object once', async () => {
        const first = await storedPhoto('Trip photo');
        const second = await storedPhoto('Recipe photo');
        const control = await storedPhoto('Shopping list photo');
        const controlBefore = await footprint(control);
        const firstMessage = await message(attachmentsOf(first.fileId));
        const secondMessage = await message(attachmentsOf(second.fileId));

        await message(attachmentsOf(control.fileId));

        const purged = await communications.purge(owner, [firstMessage, secondMessage, firstMessage]);

        expect(sorted(purged.communicationIds)).toEqual(sorted([firstMessage, secondMessage]));
        expect(sorted(purged.files.wrappedFileIds)).toEqual(sorted([first.fileId, second.fileId]));
        expect(await footprint(first)).toEqual(EMPTY);
        expect(await footprint(second)).toEqual(EMPTY);
        expect(await footprint(control)).toEqual(controlBefore);
        expect(objectCalls).toHaveLength(1);
        expect(deletedKeys()).toEqual(
          sorted([first.originalKey, first.variantKey, second.originalKey, second.variantKey]),
        );
      });

      it('takes every file one message carries, and a file it names twice only once', async () => {
        const first = await storedPhoto('First photo');
        const second = await storedPhoto('Second photo');
        const text = await message([
          { type: 'file', id: first.fileId },
          { type: 'file', id: first.fileId },
          { type: 'file', id: second.fileId },
        ]);

        const purged = await communications.purge(owner, [text]);

        expect(sorted(purged.files.wrappedFileIds)).toEqual(sorted([first.fileId, second.fileId]));
        expect(await footprint(first)).toEqual(EMPTY);
        expect(await footprint(second)).toEqual(EMPTY);
        expect(deletedKeys()).toEqual(
          sorted([first.originalKey, first.variantKey, second.originalKey, second.variantKey]),
        );
      });

      it('takes a file that the attachments name in a shape the importer does not write: in a URL, in capitals, under any key', async () => {
        // `attachments` is free-form JSON from the API, and a message that carries an id in a URL shows that file, so
        // the id is looked for anywhere in it, here as it is when the message's survivors are looked for.
        const inUrl = await storedPhoto('Photo linked by URL');
        const inCapitals = await storedPhoto('Photo named in capitals');
        const nested = await storedPhoto('Photo under a key');
        const text = await message([
          { url: `https://example.invalid/files/${inUrl.fileId}/content` },
          { id: inCapitals.fileId.toUpperCase() },
          { media: { ref: nested.fileId } },
        ]);

        const purged = await communications.purge(owner, [text]);

        expect(sorted(purged.files.wrappedFileIds)).toEqual(
          sorted([inUrl.fileId, inCapitals.fileId, nested.fileId]),
        );
        expect(await footprint(inUrl)).toEqual(EMPTY);
        expect(await footprint(inCapitals)).toEqual(EMPTY);
        expect(await footprint(nested)).toEqual(EMPTY);
      });

      it('takes only the files its attachments name: not a decoy that shares a prefix, and not a file nothing names', async () => {
        const named = await storedPhoto('Photo in a message');
        const decoy = await storedPhoto('Photo nobody names');
        const decoyBefore = await footprint(decoy);
        const text = await message([
          ...(attachmentsOf(named.fileId) as unknown[]),
          // The first 20 characters of the decoy's id, then zeros: not its id.
          { type: 'file', id: `${decoy.fileId.slice(0, 20)}${'0'.repeat(16)}` },
        ]);

        const purged = await communications.purge(owner, [text]);

        expect(purged.files.wrappedFileIds).toEqual([named.fileId]);
        expect(await footprint(named)).toEqual(EMPTY);
        expect(await footprint(decoy)).toEqual(decoyBefore);
        expect(deletedKeys()).toEqual(sorted([named.originalKey, named.variantKey]));
      });

      it('goes on with the message when its attachments name nothing that exists, or nothing at all', async () => {
        const gone = await message([
          { type: 'file', id: uuidv7() },
          { type: 'content', id: uuidv7() },
        ]);
        const empty = await message([]);
        const none = await message(undefined);
        const odd = await message({ not: 'a list', n: 3 });

        const purged = await communications.purge(owner, [gone, empty, none, odd]);

        expect(sorted(purged.communicationIds)).toEqual(sorted([gone, empty, none, odd]));
        expect(purged.contentIds).toEqual([]);
        expect(purged.files).toEqual({
          wrappedFileIds: [],
          fileIds: [],
          nodeIds: [],
          deletedObjects: 0,
          keptObjects: 0,
          kept: [],
        });
        expect(storage.deleteObjects).not.toHaveBeenCalled();
      });

      it('does not take a file that is somebody else’s, whoever the message that names it belongs to', async () => {
        const theirs = await fileRow('Their photo', strangerId);
        const mine = await message(attachmentsOf(theirs.id));

        const purged = await communications.purge(owner, [mine]);

        expect(purged.communicationIds).toEqual([mine]);
        expect(purged.files.wrappedFileIds).toEqual([]);
        expect(await fileExists(theirs.id)).toBe(true);
        expect(storage.deleteObjects).not.toHaveBeenCalled();
      });

      it('does not take a file for a message that is somebody else’s, which it does not purge', async () => {
        const photo = await storedPhoto('Trip photo');
        const photoBefore = await footprint(photo);
        const theirs = await message(attachmentsOf(photo.fileId), strangerId);

        const purged = await communications.purge(owner, [theirs]);

        expect(purged.communicationIds).toEqual([]);
        expect(await messageExists(theirs)).toBe(true);
        expect(await footprint(photo)).toEqual(photoBefore);
        expect(storage.deleteObjects).not.toHaveBeenCalled();
      });

      it('purges a file that came from a source, which has no stored bytes, without asking the object store', async () => {
        const external = await fileRow('Drive photo', ownerId, { externalId: 'drive-1' });
        const nodeId = await fileNode(external.id, 'Drive photo');
        const text = await message(attachmentsOf(external.id));

        const purged = await communications.purge(owner, [text]);

        expect(purged.files).toMatchObject({
          wrappedFileIds: [external.id],
          nodeIds: [nodeId],
          deletedObjects: 0,
        });
        expect(await fileExists(external.id)).toBe(false);
        expect(storage.deleteObjects).not.toHaveBeenCalled();
      });

      it('purges a file that has no File node yet, and has none to offer for one it keeps', async () => {
        // The graph's presence for a file is written by a listener after the upload, so a file can be named before it
        // has a node. It is still a file, and what keeps it is still worth saying.
        const bare = await fileRow('Fresh upload', ownerId);
        const keptBare = await fileRow('Fresh shared photo', ownerId);
        const doomedMessage = await message(attachmentsOf(bare.id));
        const keptMessage = await message(attachmentsOf(keptBare.id));
        const stays = await message(attachmentsOf(keptBare.id));

        const purged = await communications.purge(owner, [doomedMessage, keptMessage]);

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
            usedBy: { contentIds: [], messageIds: [stays], chatMessageIds: [], eventId: null },
          },
        ]);
        expect(await fileExists(keptBare.id)).toBe(true);
      });

      it('needs no object store for a message with no stored files, and refuses one that has some, before it changes anything', async () => {
        const external = await fileRow('Drive photo', ownerId, { externalId: 'drive-1' });
        const stored = await storedPhoto('Trip photo');
        const storedBefore = await footprint(stored);
        const plain = await message(undefined);
        const externalMessage = await message(attachmentsOf(external.id));
        const storedMessage = await message(attachmentsOf(stored.fileId));

        // Nothing stored to delete: a service built without a store does it. This is every message with no files.
        const first = await communicationsWithoutStore.purge(owner, [plain, externalMessage]);

        expect(sorted(first.communicationIds)).toEqual(sorted([plain, externalMessage]));
        expect(first.files.wrappedFileIds).toEqual([external.id]);

        // Stored bytes to delete and nowhere to delete them from: refused whole, and nothing is touched.
        await expect(communicationsWithoutStore.purge(owner, [storedMessage])).rejects.toThrow(
          /no object store/,
        );
        expect(await messageExists(storedMessage)).toBe(true);
        expect(await footprint(stored)).toEqual(storedBefore);
      });

      it('leaves a file’s object alone when another file row of somebody else also names it, and says so', async () => {
        const doomed = await storedPhoto('Trip photo');
        const shared = await fileRow('Their copy', strangerId, { key: doomed.originalKey });
        const text = await message(attachmentsOf(doomed.fileId));

        const purged = await communications.purge(owner, [text]);

        expect(purged.files).toMatchObject({ deletedObjects: 1, keptObjects: 1 });
        expect(deletedKeys()).toEqual([doomed.variantKey]);
        expect(await fileExists(shared.id)).toBe(true);
        expect(await fileExists(doomed.fileId)).toBe(false);
      });
    });

    // ── a file that something else uses ───────────────────────────────────────

    describe('a file that something else still uses is kept, and the purge says what keeps it', () => {
      it('keeps it while another message names it, and deletes it with the last one', async () => {
        // A Google Voice image is attached to as many as 150 messages: one forgotten must not take it from the rest.
        const photo = await storedPhoto('Forwarded photo');
        const before = await footprint(photo);
        const first = await message(attachmentsOf(photo.fileId));
        const second = await message(attachmentsOf(photo.fileId));

        const one = await communications.purge(owner, [first]);

        expect(one.communicationIds).toEqual([first]);
        expect(one.files).toMatchObject({ wrappedFileIds: [], fileIds: [], deletedObjects: 0 });
        expect(one.files.kept).toEqual([
          {
            fileId: photo.fileId,
            nodeId: photo.nodeId,
            usedBy: { contentIds: [], messageIds: [second], chatMessageIds: [], eventId: null },
          },
        ]);
        await expectKept(photo, before);
        // The message that was named is gone, and the other is as it was.
        expect(await messageExists(first)).toBe(false);
        expect(await messageExists(second)).toBe(true);

        // Forgetting the last one finishes what the first could not: the order they go in does not matter.
        const two = await communications.purge(owner, [second]);

        expect(two.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [] });
        expect(await footprint(photo)).toEqual(EMPTY);
        expect(deletedKeys()).toEqual(sorted([photo.originalKey, photo.variantKey]));
      });

      it('deletes it, once, when every message that names it is named in the same call', async () => {
        const photo = await storedPhoto('Forwarded photo');
        const first = await message(attachmentsOf(photo.fileId));
        const second = await message(attachmentsOf(photo.fileId));

        const purged = await communications.purge(owner, [first, second]);

        expect(purged.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [], deletedObjects: 2 });
        expect(await footprint(photo)).toEqual(EMPTY);
        expect(objectCalls).toHaveLength(1);
      });

      it('names each message that keeps a file once, however many times it carries it, and against every file it carries', async () => {
        const first = await storedPhoto('First photo');
        const second = await storedPhoto('Second photo');
        const firstMessage = await message(attachmentsOf(first.fileId));
        const secondMessage = await message(attachmentsOf(second.fileId));
        // One message carries both, the first twice over, and another carries only the second.
        const both = await message([
          { type: 'file', id: first.fileId },
          { type: 'file', id: first.fileId },
          { type: 'file', id: second.fileId },
        ]);
        const onlySecond = await message(attachmentsOf(second.fileId));

        const purged = await communications.purge(owner, [firstMessage, secondMessage]);

        const usedBy = (fileId: string) => purged.files.kept.find((kept) => kept.fileId === fileId)?.usedBy;

        expect(usedBy(first.fileId)?.messageIds).toEqual([both]);
        expect(usedBy(second.fileId)?.messageIds).toEqual(sorted([both, onlySecond]));
      });

      it('is kept by a message that is somebody else’s, which still shows the file', async () => {
        const photo = await storedPhoto('Trip photo');
        const before = await footprint(photo);
        const mine = await message(attachmentsOf(photo.fileId));
        const theirs = await message(attachmentsOf(photo.fileId), strangerId);

        const purged = await communications.purge(owner, [mine]);

        expect(purged.files.kept).toMatchObject([{ usedBy: { messageIds: [theirs] } }]);
        await expectKept(photo, before);
      });

      it('keeps it for content that wraps it and no attachment names, which is how WhatsApp stores a photo, and then deletes it with that content', async () => {
        // WhatsApp stages a photo as a standalone media item AND as a message attachment, on purpose: one file, two
        // references. 722 of the 739 files a content row wraps on the review corpus are also named by a message.
        const photo = await storedPhoto('WhatsApp photo');
        const before = await footprint(photo);
        const content = await wrapper(photo.fileId, 'file');
        const text = await message(attachmentsOf(photo.fileId));

        const one = await communications.purge(owner, [text]);

        // No attachment names the content row, so it is not the message's and stays, and it keeps the file.
        expect(one.contentIds).toEqual([]);
        expect(one.files.kept).toEqual([
          {
            fileId: photo.fileId,
            nodeId: photo.nodeId,
            usedBy: { contentIds: [content], messageIds: [], chatMessageIds: [], eventId: null },
          },
        ]);
        await expectKept(photo, before);
        expect(await contentExists(content)).toBe(true);

        // Forgetting the content finishes it, by the rule #2911 gave it: nothing uses the file any more.
        const two = await contents.purge(owner, [content]);

        expect(two.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [] });
        expect(await footprint(photo)).toEqual(EMPTY);
      });

      it('deletes a file that #2911 kept because this very message named it, when the message is forgotten', async () => {
        // The other order, and the case that stayed behind forever: the content went first and the message kept the file.
        const photo = await storedPhoto('WhatsApp photo');
        const before = await footprint(photo);
        const content = await wrapper(photo.fileId, 'file');
        const text = await message(attachmentsOf(photo.fileId));

        const one = await contents.purge(owner, [content]);

        expect(one.files.kept).toMatchObject([{ fileId: photo.fileId, usedBy: { messageIds: [text] } }]);
        await expectKept(photo, before);

        const two = await communications.purge(owner, [text]);

        expect(two.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [], deletedObjects: 2 });
        expect(await footprint(photo)).toEqual(EMPTY);
        expect(deletedKeys()).toEqual(sorted([photo.originalKey, photo.variantKey]));
      });

      it('is not kept by a content row marked as a URI that holds its id, which is never a file', async () => {
        const photo = await storedPhoto('Trip photo');
        const text = await message(attachmentsOf(photo.fileId));

        await wrapper(photo.fileId, 'external_uri');

        const purged = await communications.purge(owner, [text]);

        expect(purged.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [] });
        expect(await footprint(photo)).toEqual(EMPTY);
      });

      it('is kept by content that is somebody else’s, or has no owner, which still shows the file', async () => {
        const photo = await storedPhoto('Trip photo');
        const before = await footprint(photo);
        const text = await message(attachmentsOf(photo.fileId));
        const theirs = await wrapper(photo.fileId, 'file', { forUser: strangerId });
        const legacy = await wrapper(photo.fileId, 'file', { forUser: null });

        const purged = await communications.purge(owner, [text]);

        expect(purged.files.kept).toMatchObject([{ usedBy: { contentIds: sorted([theirs, legacy]) } }]);
        await expectKept(photo, before);
      });

      it('keeps it for a chat message that attaches it, which would lose the attachment', async () => {
        const photo = await storedPhoto('Photo in a chat');
        const before = await footprint(photo);
        const text = await message(attachmentsOf(photo.fileId));
        const chat = await chatAttachment(photo.fileId);

        const purged = await communications.purge(owner, [text]);

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

      it('keeps it for an event that it is linked to', async () => {
        const staying = await event('Stays');
        const photo = await storedPhoto('Event photo', { eventId: staying });
        const before = await footprint(photo);
        const text = await message(attachmentsOf(photo.fileId));

        const purged = await communications.purge(owner, [text]);

        expect(purged.files.kept).toMatchObject([{ fileId: photo.fileId, usedBy: { eventId: staying } }]);
        await expectKept(photo, before);
      });

      it('keeps a whole file when something still shows its preview', async () => {
        // A preview is deleted with its original by cascade, so a record that still wraps the preview keeps the
        // original too, or the cascade would take the preview out from under it.
        const photo = await storedPhoto('Trip photo');
        const before = await footprint(photo);
        const text = await message(attachmentsOf(photo.fileId));
        const showsPreview = await wrapper(photo.variantId, 'file');

        const purged = await communications.purge(owner, [text]);

        expect(purged.files.kept).toMatchObject([
          { fileId: photo.fileId, usedBy: { contentIds: [showsPreview] } },
        ]);
        await expectKept(photo, before);
      });

      it('deletes a preview when only the preview is what the message names', async () => {
        const photo = await storedPhoto('Trip photo');
        const text = await message(attachmentsOf(photo.variantId));

        const purged = await communications.purge(owner, [text]);

        expect(purged.files.wrappedFileIds).toEqual([photo.variantId]);
        expect(await fileExists(photo.variantId)).toBe(false);
        expect(await fileExists(photo.fileId)).toBe(true);
        expect(deletedKeys()).toEqual([photo.variantKey]);
      });

      it('is not kept by records that merely mention it: an observation, a receipt, a summary and a link preview', async () => {
        const photo = await storedPhoto('Photo of a kettle');
        const text = await message(attachmentsOf(photo.fileId));
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
         VALUES ($1, now(), now(), 'daily', ARRAY['comm_attachments_spec'], ARRAY[$2]::uuid[]) RETURNING summary_id`,
          [ownerId, photo.fileId],
        );
        const [{ id: unfurlId }] = await dataSource.query(
          `INSERT INTO ci.unfurls (user_id, resolve_key, resolver, status, poster_file_id)
         VALUES ($1, $2, 'spec', 'ok', $3) RETURNING id`,
          [ownerId, `https://example.invalid/${photo.fileId}`, photo.fileId],
        );

        const purged = await communications.purge(owner, [text]);

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
    });

    // ── the content rows its attachments name ─────────────────────────────────

    describe('the content rows a message’s attachments name go with it', () => {
      it('removes a Messenger photo whole: the message, the file, the content row over it, and every row that points at them', async () => {
        const doomed = await storedPhoto('Messenger photo');
        const control = await storedPhoto('Another chat photo');
        const doomedContent = await wrapper(doomed.fileId, 'file', { title: 'Messenger photo' });
        const controlContent = await wrapper(control.fileId, 'file', { title: 'Another chat photo' });
        const doomedMessage = await message(messengerAttachments(doomed.fileId, doomedContent));
        const controlMessage = await message(messengerAttachments(control.fileId, controlContent));

        const doomedBefore = await footprint(doomed);
        const controlBefore = await footprint(control);
        const contentBefore = await contentFootprint(doomedContent);
        const controlContentBefore = await contentFootprint(controlContent);

        expectEveryTableTouched(doomedBefore);
        expectEveryTableTouched(contentBefore);
        expectEveryTableTouched(controlBefore);
        expectEveryTableTouched(controlContentBefore);

        const purged = await communications.purge(owner, [doomedMessage]);

        expect(purged.communicationIds).toEqual([doomedMessage]);
        expect(purged.contentIds).toEqual([doomedContent]);
        expect(purged.files).toMatchObject({ wrappedFileIds: [doomed.fileId], kept: [], deletedObjects: 2 });
        expect(await messageExists(doomedMessage)).toBe(false);
        expect(await footprint(doomed)).toEqual(EMPTY);
        expect(await contentFootprint(doomedContent)).toEqual(EMPTY_CONTENT);
        // The other chat's photo, its content row and its message are exactly as they were, row for row.
        expect(await footprint(control)).toEqual(controlBefore);
        expect(await contentFootprint(controlContent)).toEqual(controlContentBefore);
        expect(await messageExists(controlMessage)).toBe(true);
        expect(objectCalls).toEqual([
          { bucket: BUCKET, keys: sorted([doomed.originalKey, doomed.variantKey]) },
        ]);
      });

      it('removes the content rows of several messages named in one call', async () => {
        const first = await storedPhoto('First photo');
        const second = await storedPhoto('Second photo');
        const firstContent = await wrapper(first.fileId, 'file');
        const secondContent = await wrapper(second.fileId, 'file');
        const firstMessage = await message(messengerAttachments(first.fileId, firstContent));
        const secondMessage = await message(messengerAttachments(second.fileId, secondContent));

        const purged = await communications.purge(owner, [firstMessage, secondMessage]);

        expect(sorted(purged.contentIds)).toEqual(sorted([firstContent, secondContent]));
        expect(sorted(purged.files.wrappedFileIds)).toEqual(sorted([first.fileId, second.fileId]));
        expect(await footprint(first)).toEqual(EMPTY);
        expect(await footprint(second)).toEqual(EMPTY);
        expect(await contentFootprint(firstContent)).toEqual(EMPTY_CONTENT);
        expect(await contentFootprint(secondContent)).toEqual(EMPTY_CONTENT);
        expect(objectCalls).toHaveLength(1);
      });

      it('removes the link rows Discord writes, which have no file, and leaves another message’s alone', async () => {
        const link = await contentRow(null, null, { title: 'diagram.png' });
        const controlLink = await contentRow(null, null, { title: 'notes.txt' });
        const controlBefore = await contentFootprint(controlLink);
        const text = await message([{ type: 'content', id: link }]);

        await message([{ type: 'content', id: controlLink }]);
        expectEveryTableTouched(await contentFootprint(link));

        const purged = await communications.purge(owner, [text]);

        expect(purged.communicationIds).toEqual([text]);
        expect(purged.contentIds).toEqual([link]);
        expect(purged.files.wrappedFileIds).toEqual([]);
        expect(await contentFootprint(link)).toEqual(EMPTY_CONTENT);
        expect(await contentFootprint(controlLink)).toEqual(controlBefore);
        // There was nothing stored to delete, so nothing was asked of the object store.
        expect(storage.deleteObjects).not.toHaveBeenCalled();
      });

      it('takes the file of a content row the message names, even when the message names the content and not the file', async () => {
        const photo = await storedPhoto('Chat photo');
        const content = await wrapper(photo.fileId, 'file');
        const text = await message([{ type: 'content', id: content }]);

        const purged = await communications.purge(owner, [text]);

        expect(purged.contentIds).toEqual([content]);
        expect(purged.files.wrappedFileIds).toEqual([photo.fileId]);
        expect(await footprint(photo)).toEqual(EMPTY);
        expect(await contentFootprint(content)).toEqual(EMPTY_CONTENT);
      });

      it('takes a content row that the attachments name in a shape the importer does not write', async () => {
        const content = await contentRow(null, null);
        const text = await message([{ link: { to: content.toUpperCase() } }]);

        const purged = await communications.purge(owner, [text]);

        expect(purged.contentIds).toEqual([content]);
        expect(await contentFootprint(content)).toEqual(EMPTY_CONTENT);
      });

      it('keeps a content row that another message also names, and so the file it wraps, until the last of them goes', async () => {
        const photo = await storedPhoto('Shared chat photo');
        const before = await footprint(photo);
        const content = await wrapper(photo.fileId, 'file');
        const first = await message(messengerAttachments(photo.fileId, content));
        const second = await message(messengerAttachments(photo.fileId, content));
        const contentBefore = await contentFootprint(content);

        const one = await communications.purge(owner, [first]);

        expect(one.communicationIds).toEqual([first]);
        expect(one.contentIds).toEqual([]);
        expect(one.files.kept).toMatchObject([
          { fileId: photo.fileId, usedBy: { contentIds: [content], messageIds: [second] } },
        ]);
        await expectKept(photo, before);
        expect(await contentFootprint(content)).toEqual(contentBefore);

        // The order does not matter: the last message to go takes the content row, and then the file.
        const two = await communications.purge(owner, [second]);

        expect(two.contentIds).toEqual([content]);
        expect(two.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [] });
        expect(await footprint(photo)).toEqual(EMPTY);
        expect(await contentFootprint(content)).toEqual(EMPTY_CONTENT);
      });

      it('takes a content row that two messages share, once, when both are named in the same call', async () => {
        const photo = await storedPhoto('Shared chat photo');
        const content = await wrapper(photo.fileId, 'file');
        const first = await message(messengerAttachments(photo.fileId, content));
        const second = await message(messengerAttachments(photo.fileId, content));

        const purged = await communications.purge(owner, [first, second]);

        expect(purged.contentIds).toEqual([content]);
        expect(purged.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [] });
        expect(await footprint(photo)).toEqual(EMPTY);
        expect(await contentFootprint(content)).toEqual(EMPTY_CONTENT);
      });

      it('keeps a content row that an event holds, and the file it wraps, and does not touch the event', async () => {
        const trip = await event('Trip');
        const photo = await storedPhoto('Trip photo');
        const before = await footprint(photo);
        const content = await wrapper(photo.fileId, 'file', { eventId: trip });
        const contentBefore = await contentFootprint(content);
        const text = await message(messengerAttachments(photo.fileId, content));

        const purged = await communications.purge(owner, [text]);

        expect(purged.communicationIds).toEqual([text]);
        expect(purged.contentIds).toEqual([]);
        expect(purged.files.kept).toMatchObject([
          { fileId: photo.fileId, usedBy: { contentIds: [content] } },
        ]);
        await expectKept(photo, before);
        expect(await contentFootprint(content)).toEqual(contentBefore);
        expect(await exists('SELECT count(*) FROM ci.events WHERE event_id = $1', trip)).toBe(true);
      });

      it('keeps a content row that is somebody else’s, and the file it wraps', async () => {
        const photo = await storedPhoto('Trip photo');
        const before = await footprint(photo);
        const theirs = await wrapper(photo.fileId, 'file', { forUser: strangerId });
        const theirsBefore = await contentFootprint(theirs);
        const text = await message(messengerAttachments(photo.fileId, theirs));

        const purged = await communications.purge(owner, [text]);

        expect(purged.contentIds).toEqual([]);
        expect(purged.files.kept).toMatchObject([{ usedBy: { contentIds: [theirs] } }]);
        await expectKept(photo, before);
        expect(await contentFootprint(theirs)).toEqual(theirsBefore);
      });

      it('takes its content row, and leaves the file, when another message that has no content row still names the file', async () => {
        const photo = await storedPhoto('Photo sent twice');
        const before = await footprint(photo);
        const content = await wrapper(photo.fileId, 'file');
        const messenger = await message(messengerAttachments(photo.fileId, content));
        const other = await message(attachmentsOf(photo.fileId));

        const purged = await communications.purge(owner, [messenger]);

        // The content row belongs to the message that was forgotten, so it goes; the file is still shown by the other.
        expect(purged.contentIds).toEqual([content]);
        expect(purged.files.kept).toEqual([
          {
            fileId: photo.fileId,
            nodeId: photo.nodeId,
            usedBy: { contentIds: [], messageIds: [other], chatMessageIds: [], eventId: null },
          },
        ]);
        await expectKept(photo, before);
        expect(await contentFootprint(content)).toEqual(EMPTY_CONTENT);
      });

      it('does not take a standalone content row that no attachment names, even when it wraps the same file', async () => {
        const photo = await storedPhoto('WhatsApp photo');
        const named = await wrapper(photo.fileId, 'file', { title: 'named' });
        const standalone = await wrapper(photo.fileId, 'file', { title: 'standalone' });
        const standaloneBefore = await contentFootprint(standalone);
        const text = await message(messengerAttachments(photo.fileId, named));

        const purged = await communications.purge(owner, [text]);

        expect(purged.contentIds).toEqual([named]);
        expect(purged.files.kept).toMatchObject([{ usedBy: { contentIds: [standalone] } }]);
        expect(await contentFootprint(standalone)).toEqual(standaloneBefore);
        expect(await fileExists(photo.fileId)).toBe(true);
      });
    });

    // ── the objects go first, and what a failure leaves ───────────────────────

    describe('the objects go first, while the rows are locked', () => {
      it('deletes the objects while every row is still there and locked, and the rows afterwards', async () => {
        const doomed = await storedPhoto('Trip photo');
        const content = await wrapper(doomed.fileId, 'file');
        const text = await message(messengerAttachments(doomed.fileId, content));
        const seen: { files: number; content: number; messages: number; lockedAgainstOthers: boolean } = {
          files: -1,
          content: -1,
          messages: -1,
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
          seen.messages = Number(
            (await dataSource.query('SELECT count(*) FROM ci.communications WHERE id = $1', [text]))[0].count,
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

        await communications.purge(owner, [text]);

        expect(seen).toEqual({ files: 1, content: 1, messages: 1, lockedAgainstOthers: true });
        expect(await fileExists(doomed.fileId)).toBe(false);
        expect(await messageExists(text)).toBe(false);
      });

      it('decides after it holds the lock, so a purge that had to wait sees what the one it waited for committed', async () => {
        // Two messages name one file and two purges run at once, one for each. Whichever holds the file decides; the
        // other waits, and then decides on what the first committed. Were the decision made before the wait, each
        // would see the other's message as a survivor, both would keep the file, and nobody would delete it.
        const photo = await storedPhoto('Forwarded photo');
        const first = await message(attachmentsOf(photo.fileId));
        const second = await message(attachmentsOf(photo.fileId));
        const other = dataSource.createQueryRunner();

        await other.connect();
        await other.startTransaction();

        let purging: Promise<unknown> | undefined;

        try {
          // The other purge is in the middle of its work: it holds the file.
          await other.query('SELECT 1 FROM ci.files WHERE id = $1 FOR UPDATE', [photo.fileId]);

          const [{ pid }] = await other.query('SELECT pg_backend_pid() AS pid');

          purging = communications.purge(owner, [second]);
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

          // The other purge commits: its message is gone.
          await other.query('DELETE FROM ci.communications WHERE id = $1', [first]);
          await other.query('DELETE FROM ci.entities WHERE entity_id = $1', [first]);
          await other.commitTransaction();
        } catch (error) {
          await other.rollbackTransaction().catch(() => undefined);
          await purging?.catch(() => undefined);

          throw error;
        } finally {
          await other.release();
        }

        const result = (await purging) as Awaited<ReturnType<CommunicationService['purge']>>;

        // It saw that the other message had gone, and so nothing used the file any more.
        expect(result.files).toMatchObject({ wrappedFileIds: [photo.fileId], kept: [] });
        expect(await footprint(photo)).toEqual(EMPTY);
        expect(deletedKeys()).toEqual(sorted([photo.originalKey, photo.variantKey]));
      }, 60_000);

      it('leaves everything as it was, and says so, when the object store fails; and finishes when it comes back', async () => {
        const doomed = await storedPhoto('Trip photo');
        const content = await wrapper(doomed.fileId, 'file');
        const text = await message(messengerAttachments(doomed.fileId, content));
        const doomedBefore = await footprint(doomed);
        const contentBefore = await contentFootprint(content);

        deleteObjectsImpl = async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:9000');
        };

        published.length = 0;
        notified.length = 0;

        const failure = await communications.purge(owner, [text]).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        // Not the error that says the bytes are gone: nothing was deleted from the database.
        expect(failure).not.toBeInstanceOf(StoredObjectsDeletedError);
        expect((failure as Error).message).toContain('nothing was deleted from the database');
        expect((failure as Error).message).toContain('ECONNREFUSED');
        expect(await footprint(doomed)).toEqual(doomedBefore);
        expect(await contentFootprint(content)).toEqual(contentBefore);
        expect(await messageExists(text)).toBe(true);
        expect(published).toEqual([]);
        expect(notified).toEqual([]);

        // And it let go of the rows: a purge that failed does not leave them locked.
        const probe = dataSource.createQueryRunner();

        await probe.connect();
        await probe.startTransaction();
        await expect(
          probe.query('SELECT 1 FROM ci.files WHERE id = $1 FOR UPDATE NOWAIT', [doomed.fileId]),
        ).resolves.toBeDefined();
        await probe.rollbackTransaction();
        await probe.release();

        // The store comes back, and forgetting the message again goes through.
        deleteObjectsImpl = async () => undefined;

        expect((await communications.purge(owner, [text])).files.wrappedFileIds).toEqual([doomed.fileId]);
        expect(await footprint(doomed)).toEqual(EMPTY);
        expect(await contentFootprint(content)).toEqual(EMPTY_CONTENT);
      });

      it('gives up on an object store that does not answer, and lets go of the rows', async () => {
        const doomed = await storedPhoto('Trip photo');
        const text = await message(attachmentsOf(doomed.fileId));
        const doomedBefore = await footprint(doomed);

        // Nothing else bounds the wait: the client sets no timeout, and neither does the database.
        const failure = await dataSource
          .transaction((manager) =>
            purgeCommunicationAggregates(manager, ownerId, [text], {
              objects: { deleteObjects: () => new Promise<void>(() => undefined) },
              deadlineMs: 100,
            }),
          )
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('did not answer within');
        expect((failure as Error).message).toContain('nothing was deleted from the database');
        expect(await footprint(doomed)).toEqual(doomedBefore);
        expect(await messageExists(text)).toBe(true);

        const probe = dataSource.createQueryRunner();

        await probe.connect();
        await probe.startTransaction();
        await expect(
          probe.query('SELECT 1 FROM ci.files WHERE id = $1 FOR UPDATE NOWAIT', [doomed.fileId]),
        ).resolves.toBeDefined();
        await probe.rollbackTransaction();
        await probe.release();
      }, 30_000);

      it('keeps the rows, and names the messages whose photo is gone, when the database refuses afterwards; forgetting again finishes it', async () => {
        const doomed = await storedPhoto('Trip photo');
        const control = await storedPhoto('Recipe photo');
        const content = await wrapper(doomed.fileId, 'file');
        const withPhoto = await message(messengerAttachments(doomed.fileId, content));
        const withoutPhoto = await message(undefined);
        const doomedBefore = await footprint(doomed);
        const contentBefore = await contentFootprint(content);

        await message(attachmentsOf(control.fileId));

        // `ci.users.entity_id` references ci.entities with no ON DELETE action. Pointing it at a message node makes
        // the delete of that node fail, after the objects have gone, as a table this teardown has never heard of
        // would. The message nodes are deleted before the file rows, so this refuses before the file rows are touched.
        await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [withPhoto, strangerId]);
        published.length = 0;
        notified.length = 0;

        const failure = await communications
          .purge(owner, [withPhoto, withoutPhoto])
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(StoredObjectsDeletedError);

        const gone = failure as StoredObjectsDeletedError;

        // Only the message whose photo lost its bytes is named; the other lost nothing.
        expect(gone.nodeIds).toEqual([withPhoto]);
        expect(sqlState(gone.cause)).toBe('23503');
        // The objects went, and went FIRST: the refusal came from the delete of the message node, which a purge that
        // deleted rows before objects would have stopped at without ever asking the store.
        expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
        // The rows did not: every table is as it was, the message still names the file, and nothing was announced.
        expect(await footprint(doomed)).toEqual(doomedBefore);
        expect(await contentFootprint(content)).toEqual(contentBefore);
        expect(await messageExists(withPhoto)).toBe(true);
        expect(await messageExists(withoutPhoto)).toBe(true);
        expect(published).toEqual([]);
        expect(notified).toEqual([]);

        // Forgetting it again finds the same file and the same keys. The object store treats a key that is already
        // gone as deleted, so the second delete is the same call, and then the rows go.
        await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = $1', [strangerId]);
        objectCalls.length = 0;

        const purged = await communications.purge(owner, [withPhoto, withoutPhoto]);

        expect(purged.files.wrappedFileIds).toEqual([doomed.fileId]);
        expect(purged.contentIds).toEqual([content]);
        expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
        expect(await footprint(doomed)).toEqual(EMPTY);
        expect(await contentFootprint(content)).toEqual(EMPTY_CONTENT);
      });

      it('goes first even when it is the content row the database then refuses', async () => {
        const doomed = await storedPhoto('Trip photo');
        const content = await wrapper(doomed.fileId, 'file');
        const text = await message(messengerAttachments(doomed.fileId, content));
        const doomedBefore = await footprint(doomed);
        const contentBefore = await contentFootprint(content);

        // The content rows are the first rows the purge deletes, so this refuses at the first row there is. A purge
        // that deleted any row before it asked the object store would have stopped here, and deleted no object.
        await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [content, strangerId]);

        const failure = await communications.purge(owner, [text]).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(StoredObjectsDeletedError);
        expect((failure as StoredObjectsDeletedError).nodeIds).toEqual([text]);
        expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
        expect(await footprint(doomed)).toEqual(doomedBefore);
        expect(await contentFootprint(content)).toEqual(contentBefore);
        expect(await messageExists(text)).toBe(true);
      });

      it('goes first even when it is the file’s own node that the database then refuses', async () => {
        const doomed = await storedPhoto('Trip photo');
        const text = await message(attachmentsOf(doomed.fileId));
        const doomedBefore = await footprint(doomed);

        // The file's rows are the last the purge deletes, after the message's. The refusal comes with the objects
        // already gone and everything else deleted in the same transaction, which rolls back whole.
        await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [
          doomed.nodeId,
          strangerId,
        ]);

        const failure = await communications.purge(owner, [text]).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(StoredObjectsDeletedError);
        expect((failure as StoredObjectsDeletedError).nodeIds).toEqual([text]);
        expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
        expect(await footprint(doomed)).toEqual(doomedBefore);
        expect(await messageExists(text)).toBe(true);
      });

      it('names only the messages whose photo lost its bytes, not the messages whose file was kept', async () => {
        const doomed = await storedPhoto('Trip photo');
        const kept = await storedPhoto('Photo in two messages');
        const doomedMessage = await message(attachmentsOf(doomed.fileId));
        const keptMessage = await message(attachmentsOf(kept.fileId));

        await message(attachmentsOf(kept.fileId));
        await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [
          doomedMessage,
          strangerId,
        ]);

        const failure = await communications
          .purge(owner, [doomedMessage, keptMessage])
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(StoredObjectsDeletedError);
        // The kept file lost nothing, so the message that named it is not one that names a photo that will not open.
        expect((failure as StoredObjectsDeletedError).nodeIds).toEqual([doomedMessage]);
        expect(deletedKeys()).toEqual(sorted([doomed.originalKey, doomed.variantKey]));
      });

      it('does not claim objects are gone when the file had none, if the database then refuses', async () => {
        const external = await fileRow('Drive photo', ownerId, { externalId: 'drive-1' });
        const text = await message(attachmentsOf(external.id));

        await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [text, strangerId]);

        const failure = await communications.purge(owner, [text]).catch((error: unknown) => error);

        // Nothing outside the database was destroyed, so this is the plain refusal.
        expect(failure).not.toBeInstanceOf(StoredObjectsDeletedError);
        expect(sqlState(failure)).toBe('23503');
        expect(await fileExists(external.id)).toBe(true);
      });

      it('does not announce a file that was kept, or any removal at all when it is refused whole', async () => {
        const photo = await storedPhoto('Trip photo');
        const text = await message(attachmentsOf(photo.fileId));

        await message(attachmentsOf(photo.fileId));
        await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [text, strangerId]);
        published.length = 0;

        await expect(communications.purge(owner, [text])).rejects.toThrow(/foreign key/i);

        expect(published).toEqual([]);
      });
    });

    // ── telling the rest of the app ───────────────────────────────────────────

    describe('announcing what went', () => {
      it('announces each message, content row and file after it has committed, by the id of the ci.files row, and nothing for one it kept', async () => {
        const doomed = await storedPhoto('Trip photo');
        const kept = await storedPhoto('Photo in another message');
        const content = await wrapper(doomed.fileId, 'file');
        const doomedMessage = await message(messengerAttachments(doomed.fileId, content));
        const keptMessage = await message(attachmentsOf(kept.fileId));

        await message(attachmentsOf(kept.fileId));
        published.length = 0;

        await communications.purge(owner, [doomedMessage, keptMessage]);

        // The search rows are keyed by the `ci.files` id, so that is what a listener is told. The node's id would
        // delete nothing.
        expect(announced(FileRemovedEvent)).toEqual(sorted([doomed.fileId, doomed.variantId]));
        expect(announced(ContentRemovedEvent)).toEqual([content]);
        expect(announced(CommunicationRemovedEvent)).toEqual(sorted([doomedMessage, keptMessage]));
      });

      it('announces a removal only once it has committed, so a listener that looks finds the row gone', async () => {
        const doomed = await storedPhoto('Trip photo');
        const content = await wrapper(doomed.fileId, 'file');
        const text = await message(messengerAttachments(doomed.fileId, content));
        const found: Record<string, number[]> = { file: [], content: [] };

        (signalling.send as jest.Mock).mockImplementation(async (name: string, payload: unknown) => {
          // A listener reads on its own connection. Were the delete not committed yet, it would still find the row.
          if (name === FileRemovedEvent) {
            const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.files WHERE id = $1', [
              doomed.fileId,
            ]);

            found.file.push(Number(count));
          }

          if (name === ContentRemovedEvent) {
            const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.content WHERE id = $1', [
              content,
            ]);

            found.content.push(Number(count));
          }

          published.push({ name, payload });

          return [];
        });

        try {
          await communications.purge(owner, [text]);
        } finally {
          (signalling.send as jest.Mock).mockImplementation(async (name: string, payload: unknown) => {
            published.push({ name, payload });

            return [];
          });
        }

        // Precondition: the listener was asked, for the file and for its preview, and for the content row.
        expect(found).toEqual({ file: [0, 0], content: [0] });
      });
    });
  },
);
