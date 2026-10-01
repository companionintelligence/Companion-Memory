import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { HbpeNotifyService } from '@ci/common/hbpe';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { ContentRemovedEvent, EventRemovedEvent } from '@ci/domains/memory/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { CalendarEventService } from '../CalendarEventService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A PURGED EVENT LEAVES NOTHING BEHIND. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `memory.forget`'s `archive_and_delete` used to delete an event by deleting its
 * `ci.entities` row and trusting the foreign keys. It failed outright for every
 * event HBPE had clustered (98% of the reference corpus), and where it did go
 * through it stranded the event's content's graph node and left rows pointing at
 * nothing.
 *
 * `CalendarEventService.purge` is the teardown that replaces it. Each case here
 * seeds a doomed aggregate and a CONTROL aggregate with a row in every table the
 * purge is meant to clean, and checks that every one of those rows is gone for
 * the first, and that the second did not move. The footprint is asserted
 * non-zero before the purge, in every table, so the test cannot pass because a
 * fixture quietly wrote nothing.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated
 * database of your OWN, or run `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/CalendarEventService.purge.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const PHOTO_TAKEN_AT = new Date('2026-08-19T17:00:00Z');

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

/** One event, the content hanging off it, and everything that points at either. */
interface Aggregate {
  eventId: string;
  contentId: string;
  /** The HBPE clusters it was assigned to. They outlive it: the cluster is HBPE's, not the event's. */
  l1ClusterId: string;
  l2ClusterId: string;
}

/**
 * Every place a row can point at an aggregate, with how to count them. A probe
 * takes the aggregate's event id, its content id, or both, as `$1` and `$2`.
 */
type Subject = 'event' | 'content' | 'both';

const FOOTPRINT: Array<[label: string, subject: Subject, sql: string]> = [
  ['ci.entities (Event)', 'event', `SELECT count(*) FROM ci.entities WHERE entity_id = $1`],
  ['ci.entities (Content)', 'content', `SELECT count(*) FROM ci.entities WHERE entity_id = $1`],
  ['ci.events', 'event', `SELECT count(*) FROM ci.events WHERE event_id = $1`],
  ['ci.content', 'content', `SELECT count(*) FROM ci.content WHERE id = $1`],
  [
    'ci.relationships',
    'both',
    `SELECT count(*) FROM ci.relationships
      WHERE from_entity_id IN ($1, $2) OR to_entity_id IN ($1, $2)`,
  ],
  [
    'ci.record_sources',
    'both',
    `SELECT count(*) FROM ci.record_sources
      WHERE (record_table = 'events' AND record_id = $1) OR (record_table = 'content' AND record_id = $2)`,
  ],
  ['ci.pipeline_state', 'both', `SELECT count(*) FROM ci.pipeline_state WHERE entity_id IN ($1, $2)`],
  [
    'ci.pipeline_dead_letters',
    'both',
    `SELECT count(*) FROM ci.pipeline_dead_letters WHERE entity_id IN ($1, $2)`,
  ],
  ['ci.graph_deltas', 'both', `SELECT count(*) FROM ci.graph_deltas WHERE entity_id IN ($1, $2)`],
  ['ci_search.entity_tag', 'both', `SELECT count(*) FROM ci_search.entity_tag WHERE entity_id IN ($1, $2)`],
  [
    'ci_search.entity_categories',
    'both',
    `SELECT count(*) FROM ci_search.entity_categories WHERE entity_id IN ($1, $2)`,
  ],
  ['ci_search.vectors', 'both', `SELECT count(*) FROM ci_search.vectors WHERE entity_id IN ($1, $2)`],
  ['ci_search.embeddings', 'both', `SELECT count(*) FROM ci_search.embeddings WHERE entity_id IN ($1, $2)`],
  ['ci_search.index_skips', 'both', `SELECT count(*) FROM ci_search.index_skips WHERE entity_id IN ($1, $2)`],
  ['hbpe.l1_event_cluster', 'event', `SELECT count(*) FROM hbpe.l1_event_cluster WHERE event_id = $1`],
  [
    'hbpe.l2_content_cluster',
    'content',
    `SELECT count(*) FROM hbpe.l2_content_cluster WHERE content_id = $1`,
  ],
  ['hbpe.content_context', 'content', `SELECT count(*) FROM hbpe.content_context WHERE content_id = $1`],
];

describeWithDb(`CalendarEventService.purge against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let calendar: CalendarEventService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const stranger = { userId: strangerId } as UserServiceContext;

  const published: Array<{ name: string; payload: unknown }> = [];
  const notified: Array<{ userId: string; times: unknown }> = [];

  /** Every id a case seeded, for the tables that carry no owner to wipe by. */
  let seeded: string[] = [];

  const signalling = {
    send: jest.fn(async (name: string, payload: unknown) => {
      published.push({ name, payload });

      return [];
    }),
  } as unknown as EventService;
  const hbpe = {
    notifyEvents: jest.fn(async (userId: string, times: unknown) => {
      notified.push({ userId, times });
    }),
  } as unknown as HbpeNotifyService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [EventEntity, BaseEntity, EventBaseEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/CalendarEventService.purge');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'EventPurge', userId);
    }

    calendar = new CalendarEventService(
      dataSource.getRepository(EventEntity),
      dataSource.getRepository(EventBaseEntity),
      signalling,
      dataSource,
      new GraphDeltaWriter(dataSource, logger()),
      hbpe,
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
      `DELETE FROM hbpe.l2_content_cluster WHERE content_id IN (SELECT id FROM ci.content WHERE user_id = ANY($1::uuid[]))`,
      [users],
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
    await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.content WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.events WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
    seeded = [];
  }

  beforeEach(() => {
    published.length = 0;
    notified.length = 0;
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

  /**
   * A photo event the way the importer writes it: the event, a `media` content
   * row carrying the photo, and a row in every table that points at either.
   */
  async function photoEvent(title: string, forUser = ownerId, tagId?: string): Promise<Aggregate> {
    const [event] = await calendar.create(
      { userId: forUser },
      { title, start_time: PHOTO_TAKEN_AT, category: 'capture' },
    );
    const eventId = event.id;
    const contentId = uuidv7();

    seeded.push(eventId, contentId);

    // The content: its base row owns the title, the detail row the rest.
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
      [contentId, `${title} (photo)`, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.content (id, type, url, mimetype, user_id, event_id)
       VALUES ($1, 'media', 'file:///photo.jpg', 'image/jpeg', $2, $3)`,
      [contentId, forUser, eventId],
    );

    // Graph edges, in both directions at both nodes.
    const person = await node('Person', `${title} guest`, forUser);
    const place = await node('Location', `${title} venue`, forUser);

    await edge(person, eventId, 'PARTICIPATED_IN');
    await edge(eventId, place, 'LOCATED_AT');
    await edge(contentId, eventId, 'DOCUMENTS');
    await edge(person, contentId, 'ASSOCIATED_WITH');

    // The provenance ledger.
    for (const [table, recordId] of [
      ['events', eventId],
      ['content', contentId],
    ]) {
      await dataSource.query(
        `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id)
         VALUES ($1, $2, $3, 'ci.import', 'purge_spec', $4)`,
        [forUser, table, recordId, `${table}-${recordId}`],
      );
    }

    // Pipeline bookkeeping.
    for (const [entityType, entityId] of [
      ['event', eventId],
      ['content', contentId],
    ]) {
      await dataSource.query(
        `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
         VALUES ($1, $2, 'purge_spec.stage', 'done', $3)`,
        [entityType, entityId, forUser],
      );
    }

    await dataSource.query(
      `INSERT INTO ci.pipeline_dead_letters (queue, event_name, entity_type, entity_id, payload, error, user_id)
       VALUES ('pipeline', 'event.created', 'event', $1, '{}'::jsonb, 'boom', $2)`,
      [eventId, forUser],
    );

    // The graph delta the content's creation would have written, and the title in it.
    await dataSource.query(
      `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, 'Content', 'created', jsonb_build_object('name', jsonb_build_object('new', $2::text)), $3)`,
      [contentId, `${title} (photo)`, forUser],
    );

    // Tags and categories, which live in the search schema and have no foreign key to either.
    const tag =
      tagId ??
      (await dataSource
        .query(
          `INSERT INTO ci_search.tags (id, label, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
          [`purge-spec-${title}`, forUser],
        )
        .then((rows: Array<{ id: string }>) => rows[0].id));

    for (const [entityType, entityId] of [
      ['event', eventId],
      ['content', contentId],
    ]) {
      await dataSource.query(
        `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ($1, $2, $3)`,
        [entityType, entityId, tag],
      );
      await dataSource.query(
        `INSERT INTO ci_search.entity_categories (entity_type, entity_id, category_tag_id, position)
         VALUES ($1, $2, $3, 0)`,
        [entityType, entityId, tag],
      );
      await dataSource.query(
        `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
         VALUES (gen_random_uuid(), $1, $2, to_tsvector('simple', $3), $4)`,
        [entityType, entityId, title, forUser],
      );
      await dataSource.query(
        `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
         VALUES (gen_random_uuid(), $1, $2, $3)`,
        [entityType, entityId, forUser],
      );
      await dataSource.query(
        `INSERT INTO ci_search.index_skips (entity_type, entity_id, reason) VALUES ($1, $2, 'purge_spec')`,
        [entityType, entityId],
      );
    }

    // HBPE's cluster membership: what made the old delete fail.
    // Each cluster counts two members, this event and one other, as HBPE would have it.
    const [{ cluster_id: l1 }] = await dataSource.query(
      `INSERT INTO hbpe.l1_clusters (user_id, l0_class, label, member_count) VALUES ($1, 'x', $2, 2) RETURNING cluster_id`,
      [forUser, `l1 ${title}`],
    );
    const [{ cluster_id: l2 }] = await dataSource.query(
      `INSERT INTO hbpe.l2_clusters (user_id, l0_class, l1_cluster_id, label, member_count) VALUES ($1, 'x', $2, $3, 2) RETURNING cluster_id`,
      [forUser, l1, `l2 ${title}`],
    );

    await dataSource.query(
      `INSERT INTO hbpe.l1_event_cluster (event_id, cluster_id, similarity) VALUES ($1, $2, 0.9)`,
      [eventId, l1],
    );
    await dataSource.query(
      `INSERT INTO hbpe.l2_content_cluster (content_id, cluster_id, similarity) VALUES ($1, $2, 0.9)`,
      [contentId, l2],
    );
    await dataSource.query(
      `INSERT INTO hbpe.content_context (content_id, user_id, l0_class, l1_cluster_id) VALUES ($1, $2, 'x', $3)`,
      [contentId, forUser, l1],
    );

    return { eventId, contentId, l1ClusterId: l1, l2ClusterId: l2 };
  }

  // ── Probes ────────────────────────────────────────────────────────────────

  async function footprint(aggregate: Aggregate): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const [label, subject, sql] of FOOTPRINT) {
      const params =
        subject === 'event'
          ? [aggregate.eventId]
          : subject === 'content'
            ? [aggregate.contentId]
            : [aggregate.eventId, aggregate.contentId];
      const [{ count }] = await dataSource.query(sql, params);

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

  // ── Cases ─────────────────────────────────────────────────────────────────

  it('removes the event, its content and every row that points at them, and nothing else', async () => {
    const doomed = await photoEvent('Beach day');
    const control = await photoEvent('Mountain day');

    const doomedBefore = await footprint(doomed);
    const controlBefore = await footprint(control);

    expectEveryTableTouched(doomedBefore);
    expectEveryTableTouched(controlBefore);

    const purged = await calendar.purge(owner, [doomed.eventId]);

    expect(purged).toEqual({ eventIds: [doomed.eventId], contentIds: [doomed.contentId] });
    expect(await footprint(doomed)).toEqual(EMPTY);
    // The control aggregate is exactly as it was, row for row.
    expect(await footprint(control)).toEqual(controlBefore);
  });

  it('takes the deleted memberships off HBPE’s cluster counts, which it only ever increments', async () => {
    const doomed = await photoEvent('Beach day');
    const control = await photoEvent('Mountain day');

    // HBPE ranks each user's top-50 L1 vocabulary by `member_count`.
    expect(await memberCounts(doomed)).toEqual({ l1: 2, l2: 2 });

    await calendar.purge(owner, [doomed.eventId]);

    // Each cluster lost exactly one member. The clusters themselves are HBPE's, so they stay.
    expect(await memberCounts(doomed)).toEqual({ l1: 1, l2: 1 });
    expect(await memberCounts(control)).toEqual({ l1: 2, l2: 2 });
  });

  it('never takes a cluster’s count below zero', async () => {
    const doomed = await photoEvent('Beach day');

    // A count that has already drifted below its memberships, as an incrementing-only counter can.
    await dataSource.query('UPDATE hbpe.l1_clusters SET member_count = 0 WHERE cluster_id = $1', [
      doomed.l1ClusterId,
    ]);
    await dataSource.query('UPDATE hbpe.l2_clusters SET member_count = 0 WHERE cluster_id = $1', [
      doomed.l2ClusterId,
    ]);

    await calendar.purge(owner, [doomed.eventId]);

    expect(await memberCounts(doomed)).toEqual({ l1: 0, l2: 0 });
  });

  it('purges several events in one call and leaves the rest', async () => {
    const first = await photoEvent('Beach day');
    const second = await photoEvent('Dinner');
    const control = await photoEvent('Mountain day');
    const controlBefore = await footprint(control);

    const purged = await calendar.purge(owner, [first.eventId, second.eventId, first.eventId]);

    expect(purged.eventIds.sort()).toEqual([first.eventId, second.eventId].sort());
    expect(purged.contentIds.sort()).toEqual([first.contentId, second.contentId].sort());
    expect(await footprint(first)).toEqual(EMPTY);
    expect(await footprint(second)).toEqual(EMPTY);
    expect(await footprint(control)).toEqual(controlBefore);
  });

  it('leaves the records that merely mention the event, and un-parents its sub-events', async () => {
    const doomed = await photoEvent('Beach day');
    const [child] = await calendar.create(owner, { title: 'Sunset', start_time: PHOTO_TAKEN_AT });

    seeded.push(child.id);
    await dataSource.query('UPDATE ci.events SET parent_event_id = $1 WHERE event_id = $2', [
      doomed.eventId,
      child.id,
    ]);
    // A receipt for something bought at the event: its foreign key is ON DELETE SET NULL.
    const [{ receipt_id: receiptId }] = await dataSource.query(
      `INSERT INTO ci.receipts (user_id, event_id) VALUES ($1, $2) RETURNING receipt_id`,
      [ownerId, doomed.eventId],
    );

    await calendar.purge(owner, [doomed.eventId]);

    expect(
      await dataSource.query('SELECT event_id FROM ci.receipts WHERE receipt_id = $1', [receiptId]),
    ).toEqual([{ event_id: null }]);
    // The sub-event is a live event in its own right. Its pointer would dangle, so it is cleared.
    expect(
      await dataSource.query('SELECT parent_event_id, is_deleted FROM ci.events WHERE event_id = $1', [
        child.id,
      ]),
    ).toEqual([{ parent_event_id: null, is_deleted: false }]);
  });

  it('announces each removal after it has committed, and tells HBPE which day to redo', async () => {
    const doomed = await photoEvent('Beach day');

    published.length = 0;
    notified.length = 0;

    await calendar.purge(owner, [doomed.eventId]);

    expect(published).toEqual([
      { name: EventRemovedEvent, payload: { eventId: doomed.eventId } },
      { name: ContentRemovedEvent, payload: { contentId: doomed.contentId } },
    ]);
    expect(notified).toEqual([{ userId: ownerId, times: [PHOTO_TAKEN_AT] }]);
  });

  it('purges an event that is already in the trash, which is how the trash is emptied', async () => {
    const doomed = await photoEvent('Beach day');

    await calendar.remove(owner, doomed.eventId);

    expect((await calendar.findDeletedPage(owner, { first: 10 })).entities.map((event) => event.id)).toEqual([
      doomed.eventId,
    ]);

    const purged = await calendar.purge(owner, [doomed.eventId]);

    expect(purged.eventIds).toEqual([doomed.eventId]);
    expect(await footprint(doomed)).toEqual(EMPTY);
    expect((await calendar.findDeletedPage(owner, { first: 10 })).entities).toEqual([]);
  });

  it('leaves somebody else’s event alone, and ignores ids that do not exist', async () => {
    const theirs = await photoEvent('Their beach day', strangerId);
    const theirsBefore = await footprint(theirs);

    published.length = 0;
    notified.length = 0;

    const purged = await calendar.purge(owner, [theirs.eventId, uuidv7()]);

    expect(purged).toEqual({ eventIds: [], contentIds: [] });
    expect(await footprint(theirs)).toEqual(theirsBefore);
    expect(published).toEqual([]);
    expect(notified).toEqual([]);

    // And in the other direction: the stranger can purge their own.
    expect((await calendar.purge(stranger, [theirs.eventId])).eventIds).toEqual([theirs.eventId]);
    expect(await footprint(theirs)).toEqual(EMPTY);
  });

  it('does nothing for an empty request', async () => {
    expect(await calendar.purge(owner, [])).toEqual({ eventIds: [], contentIds: [] });
    expect(notified).toEqual([]);
  });

  it('waits for HBPE when it labels the event from another connection at the same moment', async () => {
    const doomed = await photoEvent('Beach day');

    // The fixture is already clustered. Take that back, so the membership that matters is the one
    // HBPE writes below, from its own connection, while the purge is running.
    await dataSource.query('DELETE FROM hbpe.l1_event_cluster WHERE event_id = $1', [doomed.eventId]);

    const hbpeConnection = dataSource.createQueryRunner();

    await hbpeConnection.connect();
    await hbpeConnection.startTransaction();

    let purging: Promise<unknown> | undefined;

    try {
      const [{ pid }] = await hbpeConnection.query('SELECT pg_backend_pid() AS pid');

      // What HBPE does to an event it labels. The insert takes a key-share lock on the event's row, and
      // the membership is invisible to everyone else until this commits.
      await hbpeConnection.query(
        'INSERT INTO hbpe.l1_event_cluster (event_id, cluster_id, similarity) VALUES ($1, $2, 0.9)',
        [doomed.eventId, doomed.l1ClusterId],
      );

      purging = calendar.purge(owner, [doomed.eventId]);

      // Ask Postgres who is waiting on that connection, rather than sleeping, and WHERE: the purge has to
      // be held at the statement that locks the event rows, before it has deleted anything. Held anywhere
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
    expect(await purging).toEqual({ eventIds: [doomed.eventId], contentIds: [doomed.contentId] });
    expect(await footprint(doomed)).toEqual(EMPTY);
  });

  it('waits for HBPE when it labels the event’s photo from another connection at the same moment', async () => {
    const doomed = await photoEvent('Beach day');

    // The photo is already clustered. Take that back, so the membership that matters is the one HBPE
    // writes below, from its own connection, while the purge is running.
    await dataSource.query('DELETE FROM hbpe.l2_content_cluster WHERE content_id = $1', [doomed.contentId]);

    const hbpeConnection = dataSource.createQueryRunner();

    await hbpeConnection.connect();
    await hbpeConnection.startTransaction();

    let purging: Promise<unknown> | undefined;

    try {
      const [{ pid }] = await hbpeConnection.query('SELECT pg_backend_pid() AS pid');

      // HBPE labels content as it does events, with a key-share lock on the content's row. Nothing holds
      // the event, so the purge gets through its first lock and reaches the content's.
      await hbpeConnection.query(
        'INSERT INTO hbpe.l2_content_cluster (content_id, cluster_id, similarity) VALUES ($1, $2, 0.9)',
        [doomed.contentId, doomed.l2ClusterId],
      );

      purging = calendar.purge(owner, [doomed.eventId]);

      // Held at the statement that locks the content rows, before the content's links are cleared. Held
      // anywhere later, it would have cleared the memberships it could see and tripped over this one.
      const blocked = await until(async () => {
        const rows: Array<{ query: string }> = await dataSource.query(
          'SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [pid],
        );

        return rows.length > 0 ? rows : null;
      }, 'the purge to block on the HBPE connection');

      expect(blocked).toHaveLength(1);
      expect(blocked[0].query).toMatch(/\bci\.content\b[\s\S]*\bFOR UPDATE\b/);

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
    expect(await purging).toEqual({ eventIds: [doomed.eventId], contentIds: [doomed.contentId] });
    expect(await footprint(doomed)).toEqual(EMPTY);
  });

  it('is all or nothing when something it does not know about blocks the delete', async () => {
    const doomed = await photoEvent('Beach day');
    const doomedBefore = await footprint(doomed);

    // `ci.users.entity_id` references ci.entities with no ON DELETE action. Pointing
    // it at the event's node stands in for a table this teardown has never heard of.
    await dataSource.query('UPDATE ci.users SET entity_id = $1 WHERE id = $2', [doomed.eventId, strangerId]);

    published.length = 0;
    notified.length = 0;

    await expect(calendar.purge(owner, [doomed.eventId])).rejects.toThrow(/foreign key/i);

    // Every delete that ran before the one that failed was rolled back with it.
    expect(await footprint(doomed)).toEqual(doomedBefore);
    expect(published).toEqual([]);
    expect(notified).toEqual([]);
  });
});
