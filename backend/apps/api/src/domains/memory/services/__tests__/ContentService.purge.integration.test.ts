import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { ContentRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { ContentService } from '../ContentService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PURGED CONTENT LEAVES NOTHING BEHIND. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.forget`'s `archive_and_delete` deleted a `Content` node by deleting its
 * `ci.entities` row and trusting the foreign keys. It failed outright for every
 * content row HBPE had clustered, which is nearly all of them, and where it did go
 * through it left rows pointing at nothing. `ContentService.remove`, the app's own
 * delete, had the same failure.
 *
 * `ContentService.purge` is the teardown that replaces it for `memory.forget`. Each
 * case here seeds a doomed content row and a CONTROL one with a row in every table
 * the purge is meant to clean, and checks that every one of those rows is gone for
 * the first, and that the second did not move. The footprint is asserted non-zero
 * before the purge, in every table, so the test cannot pass because a fixture
 * quietly wrote nothing.
 *
 * `remove` shares only the part that was failing: the HBPE links. It keeps its
 * `deleted` graph delta, so its cases check that and not the rest.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ContentService.purge.integration] SKIPPED — ${availability.reason}`);
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

/**
 * Polls until `probe` finds something. For waiting on Postgres to show a state, where a fixed sleep is
 * either too short under load or a slow test everywhere else.
 */
async function until<T>(probe: () => Promise<T | null>, what: string, timeoutMs = 30_000): Promise<T> {
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

/** One content item and everything that points at it. */
interface Aggregate {
  contentId: string;
  /** The HBPE clusters it was assigned to. They outlive it: the cluster is HBPE's, not the content's. */
  l1ClusterId: string;
  l2ClusterId: string;
}

/** Every place a row can point at a content item, with how to count them. A probe takes its id as `$1`. */
const FOOTPRINT: Array<[label: string, sql: string]> = [
  ['ci.entities (Content)', `SELECT count(*) FROM ci.entities WHERE entity_id = $1`],
  ['ci.content', `SELECT count(*) FROM ci.content WHERE id = $1`],
  [
    'ci.relationships',
    `SELECT count(*) FROM ci.relationships WHERE from_entity_id = $1 OR to_entity_id = $1`,
  ],
  [
    'ci.record_sources',
    `SELECT count(*) FROM ci.record_sources WHERE record_table = 'content' AND record_id = $1`,
  ],
  ['ci.pipeline_state', `SELECT count(*) FROM ci.pipeline_state WHERE entity_id = $1`],
  ['ci.pipeline_dead_letters', `SELECT count(*) FROM ci.pipeline_dead_letters WHERE entity_id = $1`],
  ['ci.graph_deltas', `SELECT count(*) FROM ci.graph_deltas WHERE entity_id = $1`],
  ['ci_search.entity_tag', `SELECT count(*) FROM ci_search.entity_tag WHERE entity_id = $1`],
  ['ci_search.entity_categories', `SELECT count(*) FROM ci_search.entity_categories WHERE entity_id = $1`],
  ['ci_search.vectors', `SELECT count(*) FROM ci_search.vectors WHERE entity_id = $1`],
  ['ci_search.embeddings', `SELECT count(*) FROM ci_search.embeddings WHERE entity_id = $1`],
  ['ci_search.index_skips', `SELECT count(*) FROM ci_search.index_skips WHERE entity_id = $1`],
  ['hbpe.l2_content_cluster', `SELECT count(*) FROM hbpe.l2_content_cluster WHERE content_id = $1`],
  ['hbpe.content_context', `SELECT count(*) FROM hbpe.content_context WHERE content_id = $1`],
];

describeWithDb(`ContentService.purge and remove against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let contents: ContentService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const stranger = { userId: strangerId } as UserServiceContext;

  const published: Array<{ name: string; payload: unknown }> = [];

  /** Every id a case seeded, for the tables that carry no owner to wipe by. */
  let seeded: string[] = [];

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
      entities: [BaseEntity, UserEntity, ContentBaseEntity, ContentEntity, EventBaseEntity, EventEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ContentService.purge');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ContentPurge', userId);
    }

    contents = new ContentService(
      dataSource.getRepository(ContentEntity),
      dataSource.getRepository(ContentBaseEntity),
      dataSource.getRepository(EventEntity),
      signalling,
      new GraphDeltaWriter(dataSource, logger()),
    );
  });

  async function wipe(): Promise<void> {
    const users = [ownerId, strangerId];

    await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [users]);
    await dataSource.query(
      `DELETE FROM hbpe.l1_event_cluster WHERE event_id IN (SELECT event_id FROM ci.events WHERE user_id = ANY($1::uuid[]))`,
      [users],
    );
    await dataSource.query(
      `DELETE FROM hbpe.l2_content_cluster WHERE content_id IN (SELECT id FROM ci.content WHERE user_id = ANY($1::uuid[]) OR id = ANY($2::uuid[]))`,
      [users, seeded],
    );
    await dataSource.query('DELETE FROM hbpe.content_context WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM hbpe.l2_clusters WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM hbpe.l1_clusters WHERE user_id = ANY($1::uuid[])', [users]);
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
    await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.receipts WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.object_observations WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.content WHERE user_id = ANY($1::uuid[]) OR id = ANY($2::uuid[])', [
      users,
      seeded,
    ]);
    await dataSource.query('DELETE FROM ci.events WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE entity_id = ANY($1::uuid[])', [seeded]);
    seeded = [];
  }

  beforeEach(() => {
    published.length = 0;
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

  async function edge(from: string, to: string, type: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
       VALUES ($1, $2, $3, $4)`,
      [from, to, type, ownerId],
    );
  }

  /** A calendar event, for content to hang off. */
  async function event(title: string, forUser = ownerId): Promise<string> {
    const eventId = await node('Event', title, forUser);

    await dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, category, source_type, source_system, source_id)
       VALUES ($1, $2, now(), 'capture', 'ci.import', 'content_purge_spec', $3)`,
      [eventId, forUser, eventId],
    );

    return eventId;
  }

  /** The `ci.entities` base row and `ci.content` detail row of one content item, and nothing else. */
  async function bareContent(
    title: string,
    forUser: string | null,
    extra: { eventId?: string } = {},
  ): Promise<string> {
    const contentId = uuidv7();

    seeded.push(contentId);
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
      [contentId, title, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.content (id, type, text, user_id, event_id) VALUES ($1, 'note', $2, $3, $4)`,
      [contentId, `${title} body`, forUser, extra.eventId ?? null],
    );

    return contentId;
  }

  /**
   * A content item the way the importer writes it, and then everything the appliance hangs off one:
   * edges in both directions, a ledger entry, pipeline bookkeeping, a delta that carries the title,
   * tags and categories, search rows, and HBPE's cluster membership and context.
   */
  async function clusteredNote(
    title: string,
    forUser = ownerId,
    extra: { eventId?: string; tagId?: string } = {},
  ): Promise<Aggregate> {
    const contentId = await bareContent(title, forUser, extra);

    // Graph edges, in both directions.
    const person = await node('Person', `${title} author`, forUser);
    const place = await node('Location', `${title} venue`, forUser);

    await edge(person, contentId, 'AUTHORED');
    await edge(contentId, place, 'MENTIONS');

    // The provenance ledger.
    await dataSource.query(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id)
       VALUES ($1, 'content', $2, 'ci.import', 'content_purge_spec', $3)`,
      [forUser, contentId, `content-${contentId}`],
    );

    // Pipeline bookkeeping.
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
       VALUES ('content', $1, 'content_purge_spec.stage', 'done', $2)`,
      [contentId, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.pipeline_dead_letters (queue, event_name, entity_type, entity_id, payload, error, user_id)
       VALUES ('pipeline', 'content.created', 'content', $1, '{}'::jsonb, 'boom', $2)`,
      [contentId, forUser],
    );

    // The graph delta the content's creation would have written, and the title in it.
    await dataSource.query(
      `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, 'Content', 'created', jsonb_build_object('name', jsonb_build_object('new', $2::text)), $3)`,
      [contentId, title, forUser],
    );

    // Tags and categories, which live in the search schema and have no foreign key to the content.
    const tag =
      extra.tagId ??
      (await dataSource
        .query(
          `INSERT INTO ci_search.tags (id, label, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
          [`content-purge-spec-${title}`, forUser],
        )
        .then((rows: Array<{ id: string }>) => rows[0].id));

    await dataSource.query(
      `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ('content', $1, $2)`,
      [contentId, tag],
    );
    await dataSource.query(
      `INSERT INTO ci_search.entity_categories (entity_type, entity_id, category_tag_id, position)
       VALUES ('content', $1, $2, 0)`,
      [contentId, tag],
    );
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'content', $1, to_tsvector('simple', $2), $3)`,
      [contentId, title, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
       VALUES (gen_random_uuid(), 'content', $1, $2)`,
      [contentId, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci_search.index_skips (entity_type, entity_id, reason) VALUES ('content', $1, 'content_purge_spec')`,
      [contentId],
    );

    // HBPE's cluster membership and context: what made the old delete fail.
    // The L2 cluster counts two members, this content and one other, as HBPE would have it.
    const [{ cluster_id: l1 }] = await dataSource.query(
      `INSERT INTO hbpe.l1_clusters (user_id, l0_class, label, member_count) VALUES ($1, 'x', $2, 2) RETURNING cluster_id`,
      [forUser, `l1 ${title}`],
    );
    const [{ cluster_id: l2 }] = await dataSource.query(
      `INSERT INTO hbpe.l2_clusters (user_id, l0_class, l1_cluster_id, label, member_count) VALUES ($1, 'x', $2, $3, 2) RETURNING cluster_id`,
      [forUser, l1, `l2 ${title}`],
    );

    await dataSource.query(
      `INSERT INTO hbpe.l2_content_cluster (content_id, cluster_id, similarity) VALUES ($1, $2, 0.9)`,
      [contentId, l2],
    );
    await dataSource.query(
      `INSERT INTO hbpe.content_context (content_id, user_id, l0_class, l1_cluster_id) VALUES ($1, $2, 'x', $3)`,
      [contentId, forUser, l1],
    );

    return { contentId, l1ClusterId: l1, l2ClusterId: l2 };
  }

  // ── Probes ────────────────────────────────────────────────────────────────

  async function footprint(aggregate: Aggregate): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const [label, sql] of FOOTPRINT) {
      const [{ count }] = await dataSource.query(sql, [aggregate.contentId]);

      counts[label] = Number(count);
    }

    return counts;
  }

  async function memberCounts(aggregate: Aggregate): Promise<{ l1: number; l2: number }> {
    const [{ member_count: l1 }] = await dataSource.query(
      'SELECT member_count FROM hbpe.l1_clusters WHERE cluster_id = $1',
      [aggregate.l1ClusterId],
    );
    const [{ member_count: l2 }] = await dataSource.query(
      'SELECT member_count FROM hbpe.l2_clusters WHERE cluster_id = $1',
      [aggregate.l2ClusterId],
    );

    return { l1: Number(l1), l2: Number(l2) };
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

  // ── purge ─────────────────────────────────────────────────────────────────

  describe('purge', () => {
    it('removes the content, its node and every row that points at it, and nothing else', async () => {
      const doomed = await clusteredNote('Trip notes');
      const control = await clusteredNote('Shopping list');

      const doomedBefore = await footprint(doomed);
      const controlBefore = await footprint(control);

      expectEveryTableTouched(doomedBefore);
      expectEveryTableTouched(controlBefore);

      const purged = await contents.purge(owner, [doomed.contentId]);

      expect(purged).toEqual({ contentIds: [doomed.contentId] });
      expect(await footprint(doomed)).toEqual(EMPTY);
      // The control content is exactly as it was, row for row.
      expect(await footprint(control)).toEqual(controlBefore);
    });

    it('takes the deleted membership off HBPE’s L2 count, which it only ever increments', async () => {
      const doomed = await clusteredNote('Trip notes');
      const control = await clusteredNote('Shopping list');

      // HBPE ranks each user's top-50 L2 vocabulary by `member_count`.
      expect(await memberCounts(doomed)).toEqual({ l1: 2, l2: 2 });

      await contents.purge(owner, [doomed.contentId]);

      // The L2 cluster lost exactly one member. Content has no L1 membership, only a context that
      // names an L1 cluster, so that count stays. The clusters themselves are HBPE's, so they stay.
      expect(await memberCounts(doomed)).toEqual({ l1: 2, l2: 1 });
      expect(await memberCounts(control)).toEqual({ l1: 2, l2: 2 });
    });

    it('never takes a cluster’s count below zero', async () => {
      const doomed = await clusteredNote('Trip notes');

      // A count that has already drifted below its memberships, as an incrementing-only counter can.
      await dataSource.query('UPDATE hbpe.l2_clusters SET member_count = 0 WHERE cluster_id = $1', [
        doomed.l2ClusterId,
      ]);

      await contents.purge(owner, [doomed.contentId]);

      expect((await memberCounts(doomed)).l2).toBe(0);
    });

    it('purges several in one call, once each, and leaves the rest', async () => {
      const first = await clusteredNote('Trip notes');
      const second = await clusteredNote('Recipe');
      const control = await clusteredNote('Shopping list');
      const controlBefore = await footprint(control);

      const purged = await contents.purge(owner, [first.contentId, second.contentId, first.contentId]);

      expect(purged.contentIds.sort()).toEqual([first.contentId, second.contentId].sort());
      expect(await footprint(first)).toEqual(EMPTY);
      expect(await footprint(second)).toEqual(EMPTY);
      expect(await footprint(control)).toEqual(controlBefore);
    });

    it('removes content that HBPE has not clustered, which a plain delete handled too', async () => {
      const bare = await bareContent('Unlabelled note', ownerId);

      expect(await exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', bare)).toBe(true);
      expect(await exists('SELECT count(*) FROM ci.content WHERE id = $1', bare)).toBe(true);

      expect(await contents.purge(owner, [bare])).toEqual({ contentIds: [bare] });
      expect(await exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', bare)).toBe(false);
      expect(await exists('SELECT count(*) FROM ci.content WHERE id = $1', bare)).toBe(false);
    });

    it('leaves the records that merely mention the content, which have no foreign key to it', async () => {
      const doomed = await clusteredNote('Receipt photo');

      // A receipt's document and an observation's photo and crop: soft pointers by design, because
      // "content and files are purgeable, so a hard FK would block a purge or resurrect a dead pointer".
      const [{ receipt_id: receiptId }] = await dataSource.query(
        `INSERT INTO ci.receipts (user_id, document_content_id) VALUES ($1, $2) RETURNING receipt_id`,
        [ownerId, doomed.contentId],
      );
      const [{ observation_id: observationId }] = await dataSource.query(
        `INSERT INTO ci.object_observations (user_id, observed_at, label, content_id, crop_content_id)
         VALUES ($1, now(), 'a kettle', $2, $2) RETURNING observation_id`,
        [ownerId, doomed.contentId],
      );

      await contents.purge(owner, [doomed.contentId]);

      // Both records are still there, and still name the content. They are records in their own right.
      expect(
        await dataSource.query('SELECT document_content_id FROM ci.receipts WHERE receipt_id = $1', [
          receiptId,
        ]),
      ).toEqual([{ document_content_id: doomed.contentId }]);
      expect(
        await dataSource.query(
          'SELECT content_id, crop_content_id FROM ci.object_observations WHERE observation_id = $1',
          [observationId],
        ),
      ).toEqual([{ content_id: doomed.contentId, crop_content_id: doomed.contentId }]);
    });

    it('purges content attached to an event and leaves the event, its HBPE rows and its other content alone', async () => {
      const eventId = await event('Beach day');
      const doomed = await clusteredNote('Photo caption', ownerId, { eventId });
      const sibling = await clusteredNote('Second caption', ownerId, { eventId });
      const siblingBefore = await footprint(sibling);

      // HBPE has clustered the event too.
      const [{ cluster_id: l1ForEvent }] = await dataSource.query(
        `INSERT INTO hbpe.l1_clusters (user_id, l0_class, label, member_count) VALUES ($1, 'x', 'beach', 1) RETURNING cluster_id`,
        [ownerId],
      );

      await dataSource.query(
        `INSERT INTO hbpe.l1_event_cluster (event_id, cluster_id, similarity) VALUES ($1, $2, 0.9)`,
        [eventId, l1ForEvent],
      );

      const purged = await contents.purge(owner, [doomed.contentId]);

      expect(purged).toEqual({ contentIds: [doomed.contentId] });
      expect(await footprint(doomed)).toEqual(EMPTY);

      // The event is the owner of its own life: purging its content does not touch it.
      expect(await exists('SELECT count(*) FROM ci.events WHERE event_id = $1', eventId)).toBe(true);
      expect(await exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', eventId)).toBe(true);
      expect(await exists('SELECT count(*) FROM hbpe.l1_event_cluster WHERE event_id = $1', eventId)).toBe(
        true,
      );
      expect(await footprint(sibling)).toEqual(siblingBefore);
    });

    it('announces each removal after it has committed, and nothing for the ids it did not take', async () => {
      const doomed = await clusteredNote('Trip notes');
      const missing = uuidv7();

      published.length = 0;

      await contents.purge(owner, [doomed.contentId, missing]);

      expect(published).toEqual([{ name: ContentRemovedEvent, payload: { contentId: doomed.contentId } }]);
    });

    it('announces a removal only once it has committed, so a listener that looks finds the row gone', async () => {
      const doomed = await clusteredNote('Trip notes');
      const found: number[] = [];

      (signalling.send as jest.Mock).mockImplementationOnce(async (name: string, payload: unknown) => {
        // A listener reads on its own connection. Were the delete not committed yet, it would still find the row.
        const [{ count }] = await dataSource.query('SELECT count(*) FROM ci.content WHERE id = $1', [
          doomed.contentId,
        ]);

        found.push(Number(count));
        published.push({ name, payload });

        return [];
      });

      await contents.purge(owner, [doomed.contentId]);

      // Precondition: the listener was asked, and asked once.
      expect(published).toEqual([{ name: ContentRemovedEvent, payload: { contentId: doomed.contentId } }]);
      expect(found).toEqual([0]);
    });

    it('leaves somebody else’s content alone, and ignores ids that do not exist', async () => {
      const theirs = await clusteredNote('Their notes', strangerId);
      const theirsBefore = await footprint(theirs);

      published.length = 0;

      const purged = await contents.purge(owner, [theirs.contentId, uuidv7()]);

      expect(purged).toEqual({ contentIds: [] });
      expect(await footprint(theirs)).toEqual(theirsBefore);
      expect(published).toEqual([]);

      // And in the other direction: the stranger can purge their own.
      expect((await contents.purge(stranger, [theirs.contentId])).contentIds).toEqual([theirs.contentId]);
      expect(await footprint(theirs)).toEqual(EMPTY);
    });

    it('does not take a row it cannot show is the caller’s, which has no owner on its detail row', async () => {
      // Legacy rows can have a NULL `user_id`. HBPE only labels a row for a user, so there is nothing
      // of its to clear, and the generic node delete handles it. This is not the purge’s to guess at.
      const orphan = await bareContent('Legacy note', null);

      expect(await contents.purge(owner, [orphan])).toEqual({ contentIds: [] });
      expect(await exists('SELECT count(*) FROM ci.content WHERE id = $1', orphan)).toBe(true);
      expect(await exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', orphan)).toBe(true);
    });

    it('leaves a Content node with no ci.content row behind it, for the generic delete', async () => {
      // Graph ingest writes these. There is no detail row for HBPE to have clustered.
      const graphOnly = await node('Content', 'Imported without a detail row');

      published.length = 0;

      expect(await contents.purge(owner, [graphOnly])).toEqual({ contentIds: [] });
      expect(await exists('SELECT count(*) FROM ci.entities WHERE entity_id = $1', graphOnly)).toBe(true);
      expect(published).toEqual([]);
    });

    it('does nothing for an empty request', async () => {
      expect(await contents.purge(owner, [])).toEqual({ contentIds: [] });
      expect(published).toEqual([]);
    });

    it('waits for HBPE when it labels the content from another connection at the same moment', async () => {
      const doomed = await clusteredNote('Trip notes');

      // The fixture is already clustered. Take that back, so the membership that matters is the one
      // HBPE writes below, from its own connection, while the purge is running.
      await dataSource.query('DELETE FROM hbpe.l2_content_cluster WHERE content_id = $1', [doomed.contentId]);

      const hbpeConnection = dataSource.createQueryRunner();

      await hbpeConnection.connect();
      await hbpeConnection.startTransaction();

      let purging: Promise<unknown> | undefined;

      try {
        const [{ pid }] = await hbpeConnection.query('SELECT pg_backend_pid() AS pid');

        // What HBPE does to content it labels. The insert takes a key-share lock on the content's row,
        // and the membership is invisible to everyone else until this commits.
        await hbpeConnection.query(
          'INSERT INTO hbpe.l2_content_cluster (content_id, cluster_id, similarity) VALUES ($1, $2, 0.9)',
          [doomed.contentId, doomed.l2ClusterId],
        );

        purging = contents.purge(owner, [doomed.contentId]);

        // Ask Postgres who is waiting on that connection, rather than sleeping, and WHERE: the purge has to
        // be held at the statement that locks the content rows, before it has deleted anything. Held anywhere
        // later, it would have cleared the memberships it could see and then tripped over this one.
        const blocked = await until(async () => {
          const rows: Array<{ query: string }> = await dataSource.query(
            'SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [pid],
          );

          return rows.length > 0 ? rows : null;
        }, 'the purge to block on the HBPE connection');

        expect(blocked).toHaveLength(1);
        expect(blocked[0].query).toMatch(/\bFOR UPDATE\b/);

        await hbpeConnection.commitTransaction();
      } catch (error) {
        await hbpeConnection.rollbackTransaction().catch(() => undefined);
        // Let a purge that was released by the rollback finish, so it cannot run into the next test's clean-up.
        await purging?.catch(() => undefined);

        throw error;
      } finally {
        await hbpeConnection.release();
      }

      // Having waited, the purge sees the membership that just committed and clears it with the rest.
      expect(await purging).toEqual({ contentIds: [doomed.contentId] });
      expect(await footprint(doomed)).toEqual(EMPTY);
    });

    it('is all or nothing when something it does not know about blocks the delete', async () => {
      const doomed = await clusteredNote('Trip notes');
      const doomedBefore = await footprint(doomed);

      // `ci.users.entity_id` references ci.entities with no ON DELETE action. Pointing
      // it at the content's node stands in for a table this teardown has never heard of.
      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [
        doomed.contentId,
        strangerId,
      ]);

      published.length = 0;

      await expect(contents.purge(owner, [doomed.contentId])).rejects.toThrow(/foreign key/i);

      // Every delete that ran before the one that failed was rolled back with it.
      expect(await footprint(doomed)).toEqual(doomedBefore);
      expect(published).toEqual([]);
    });
  });

  // ── remove ────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('deletes content HBPE has clustered, which used to fail on a foreign key', async () => {
      const doomed = await clusteredNote('Trip notes');
      const control = await clusteredNote('Shopping list');
      const controlBefore = await footprint(control);

      // The node, its detail row, and both HBPE tables hold a row for it.
      expect(await footprint(doomed)).toMatchObject({
        'ci.entities (Content)': 1,
        'ci.content': 1,
        'hbpe.l2_content_cluster': 1,
        'hbpe.content_context': 1,
      });

      published.length = 0;

      // It raised `l2_content_cluster_content_id_fkey` here, for every content row HBPE had clustered.
      await expect(contents.remove(owner, doomed.contentId)).resolves.toBe(true);

      const after = await footprint(doomed);

      expect(after).toMatchObject({
        'ci.entities (Content)': 0,
        'ci.content': 0,
        'hbpe.l2_content_cluster': 0,
        'hbpe.content_context': 0,
      });
      // The membership came off the count, as it does for a purge.
      expect((await memberCounts(doomed)).l2).toBe(1);
      expect(published).toEqual([{ name: ContentRemovedEvent, payload: { contentId: doomed.contentId } }]);
      // Another content row's links are not touched.
      expect(await footprint(control)).toEqual(controlBefore);
    });

    it('keeps writing the `deleted` graph delta, which is what separates it from a purge', async () => {
      const doomed = await clusteredNote('Trip notes');

      const deltas = () =>
        dataSource.query(
          `SELECT change_type, changed_fields->'name'->>'old' AS old_name, change_source
             FROM ci.graph_deltas
            WHERE entity_id = $1
            ORDER BY change_type`,
          [doomed.contentId],
        );

      // Precondition: the `created` delta the fixture seeded is there, and nothing else.
      expect((await deltas()).map((delta: { change_type: string }) => delta.change_type)).toEqual([
        'created',
      ]);

      await contents.remove(owner, doomed.contentId);

      // `remove` kept it and added its own, with the old title. A purge would have deleted every
      // delta of the node, and written none.
      expect(await deltas()).toEqual([
        expect.objectContaining({ change_type: 'created' }),
        { change_type: 'deleted', old_name: 'Trip notes', change_source: 'ContentService.remove' },
      ]);
    });

    it('is refused whole when something it does not know about blocks the delete', async () => {
      const doomed = await clusteredNote('Trip notes');
      const doomedBefore = await footprint(doomed);

      await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [
        doomed.contentId,
        strangerId,
      ]);

      published.length = 0;

      await expect(contents.remove(owner, doomed.contentId)).rejects.toThrow(/foreign key/i);

      // The links it had cleared and the delta it had written were rolled back with the delete.
      expect(await footprint(doomed)).toEqual(doomedBefore);
      expect(published).toEqual([]);
    });

    it('answers false, and touches nothing, for content that is not the caller’s', async () => {
      const theirs = await clusteredNote('Their notes', strangerId);
      const theirsBefore = await footprint(theirs);

      await expect(contents.remove(owner, theirs.contentId)).resolves.toBe(false);
      expect(await footprint(theirs)).toEqual(theirsBefore);
    });

    it('waits for HBPE when it labels the content from another connection at the same moment', async () => {
      const doomed = await clusteredNote('Trip notes');

      await dataSource.query('DELETE FROM hbpe.l2_content_cluster WHERE content_id = $1', [doomed.contentId]);

      const hbpeConnection = dataSource.createQueryRunner();

      await hbpeConnection.connect();
      await hbpeConnection.startTransaction();

      let removing: Promise<unknown> | undefined;

      try {
        const [{ pid }] = await hbpeConnection.query('SELECT pg_backend_pid() AS pid');

        await hbpeConnection.query(
          'INSERT INTO hbpe.l2_content_cluster (content_id, cluster_id, similarity) VALUES ($1, $2, 0.9)',
          [doomed.contentId, doomed.l2ClusterId],
        );

        removing = contents.remove(owner, doomed.contentId);

        // Held at the statement that locks the content row, before anything has been deleted.
        const blocked = await until(async () => {
          const rows: Array<{ query: string }> = await dataSource.query(
            'SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [pid],
          );

          return rows.length > 0 ? rows : null;
        }, 'the delete to block on the HBPE connection');

        expect(blocked).toHaveLength(1);
        expect(blocked[0].query).toMatch(/\bFOR UPDATE\b/);

        await hbpeConnection.commitTransaction();
      } catch (error) {
        await hbpeConnection.rollbackTransaction().catch(() => undefined);
        await removing?.catch(() => undefined);

        throw error;
      } finally {
        await hbpeConnection.release();
      }

      // Having waited, it sees the membership that just committed and clears it with the rest.
      await expect(removing).resolves.toBe(true);
      expect(await footprint(doomed)).toMatchObject({
        'ci.entities (Content)': 0,
        'ci.content': 0,
        'hbpe.l2_content_cluster': 0,
      });
    });
  });
});
