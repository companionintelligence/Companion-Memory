import { readFileSync } from 'node:fs';
import path from 'node:path';

import { platformIdentity, redditIdentity } from '@ci/domains/memory';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../../__tests__/support/scratchDatabase';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The rows #2561 orphaned are actually repaired — proved against real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * #2561 moved the Reddit connection's records twice over: `source_id` from the
 * raw fullname (`platformIdentity('reddit', 't3_abc')` → `t3_abc`) to the
 * importer's spelling (`redditIdentity('post', 't3_abc')` → `reddit:post:abc`),
 * and the destination from `ci.content` + `ci.events` to `ci.communications`.
 * `source_id` IS the unique key on all three tables, so every row the
 * connection had already written was left under a key nothing will emit again
 * — and the next arrival, from either pipeline, inserts a second row beside it
 * rather than updating it.
 *
 * The writer's own compensating sweep (`RedditRecordWriter.removeLegacyRows`)
 * does not reach them: `ci.providers` gives the Posts and Comments endpoints
 * `"TTL": null`, which makes `SyncOrchestrator.orchestrateHistorical` return
 * early forever once their cursor is exhausted, and the incremental path stops
 * at the first item older than the last sync. An already-stored post is never
 * handed to the writer again, so the sweep only ever runs on records that have
 * no legacy rows.
 *
 * That leaves the migration as the only thing that repairs them, which is what
 * this spec exercises: it reproduces the pre-#2561 state row for row, applies
 * {@link MIGRATION} verbatim from disk, and asserts the state afterwards. A
 * unit test cannot stand in — the defect is in the database, not in a function
 * — and mocking the tables would only assert the fixture.
 *
 * Skips (loudly) when there is no administrative connection; see
 * `domains/__tests__/support/scratchDatabase.ts`.
 */

const MIGRATION = '20260904035958_rekey_reddit_connection_records_onto_shared_identity.sql';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../../db/postgres/migrations');

/** The `-- migrate:up` half of the migration, as dbmate would run it. */
function migrationUpSql(): string {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const down = sql.indexOf('-- migrate:down');

  return down === -1 ? sql : sql.slice(0, down);
}

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[redditIdentityRepair.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

const USER = '11111111-1111-4111-8111-111111111111';

/** Fixed ids, so "the row kept its uuid" is a thing the assertions can state. */
const IDS = {
  postContent: 'a0000000-0000-4000-8000-000000000001',
  postEvent: 'e0000000-0000-4000-8000-000000000001',
  commentContent: 'a0000000-0000-4000-8000-000000000002',
  commentEvent: 'e0000000-0000-4000-8000-000000000002',
  savedContent: 'a0000000-0000-4000-8000-000000000003',
  savedEvent: 'e0000000-0000-4000-8000-000000000003',
  undatedContent: 'a0000000-0000-4000-8000-000000000005',
  contentlessPostEvent: 'e0000000-0000-4000-8000-000000000006',
  contentlessSavedEvent: 'e0000000-0000-4000-8000-000000000007',
  newStyleContent: 'c0000000-0000-4000-8000-000000000009',
  otherSystemEvent: 'c0000000-0000-4000-8000-00000000000a',
};

describeWithDatabase(`Reddit connection identity repair (${availability.target})`, () => {
  let scratch: ScratchDatabase;

  /** The rows the pre-#2561 transforms wrote, in their own shapes. */
  async function seedLegacyRows(): Promise<void> {
    const permalink = (fullname: string) =>
      `https://www.reddit.com/r/test/comments/${fullname.replace(/^t[1-6]_/, '')}/x/`;

    const legacyContent = async (
      id: string,
      fullname: string,
      type: string,
      title: string,
      text: string,
      sourceData: Record<string, unknown>,
    ) => {
      await scratch.dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
         VALUES ($1::uuid, 'Content', $2, $3::uuid, 'content', $1::uuid)`,
        [id, title, USER],
      );
      await scratch.dataSource.query(
        `INSERT INTO ci.content
           (id, type, text, url, source_url, external_id, external_id_kind,
            user_id, source_type, source_system, source_id, source_data)
         VALUES ($1::uuid, $2, $3, $4, $4, $5, 'external_uri', $6::uuid, 'ETL', $7, $5, $8::jsonb)`,
        [
          id,
          type,
          text,
          permalink(fullname),
          fullname,
          USER,
          platformIdentity('reddit', fullname).system,
          JSON.stringify(sourceData),
        ],
      );
      await scratch.dataSource.query(
        `INSERT INTO ci.record_sources
           (user_id, record_table, record_id, source_type, source_system, source_id, platform)
         VALUES ($1::uuid, 'content', $2::uuid, 'ETL', 'reddit', $3, 'reddit')`,
        [USER, id, fullname],
      );
      await scratch.dataSource.query(
        `INSERT INTO ci_search.vectors (id, entity_type, entity_id, user_id, vector)
         VALUES (ci.gen_uuid_v7(), 'content', $1::uuid, $2::uuid, to_tsvector('english', $3))`,
        [id, USER, text],
      );
    };

    const legacyEvent = async (
      id: string,
      fullname: string,
      eventType: string,
      title: string,
      description: string,
      time: string,
    ) => {
      await scratch.dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, description, owner_user_id, linked_table, linked_id)
         VALUES ($1::uuid, 'Event', $2, $3, $4::uuid, 'events', $1::uuid)`,
        [id, title, description, USER],
      );
      await scratch.dataSource.query(
        `INSERT INTO ci.events (event_id, user_id, event_type, start_time, source_type, source_system, source_id)
         VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, 'ETL', $5, $6)`,
        [
          id,
          USER,
          eventType,
          time,
          platformIdentity('reddit', fullname).system,
          platformIdentity('reddit', fullname).id,
        ],
      );
      await scratch.dataSource.query(
        `INSERT INTO ci.record_sources
           (user_id, record_table, record_id, source_type, source_system, source_id, platform)
         VALUES ($1::uuid, 'events', $2::uuid, 'ETL', 'reddit', $3, 'reddit')`,
        [USER, id, fullname],
      );
      await scratch.dataSource.query(
        `INSERT INTO ci_search.vectors (id, entity_type, entity_id, user_id, vector)
         VALUES (ci.gen_uuid_v7(), 'event', $1::uuid, $2::uuid, to_tsvector('english', $3))`,
        [id, USER, description],
      );
    };

    await scratch.dataSource.query(`INSERT INTO ci.users (id, email, name) VALUES ($1::uuid, $2, 'U')`, [
      USER,
      'u@example.com',
    ]);

    // A post the user wrote: TransformPosts wrote both halves.
    await legacyContent(IDS.postContent, 't3_aaa', 'reddit_post', 'Hello world', 'Body of the post', {
      reddit_post_id: 'aaa',
      subreddit: 'test',
      score: 12,
      num_comments: 3,
      is_self: true,
      author: 'me',
    });
    await legacyEvent(
      IDS.postEvent,
      't3_aaa',
      'reddit_post',
      'Posted in r/test: Hello world',
      'Body of the post',
      '2023-11-14T22:13:20Z',
    );

    // A comment the user wrote.
    await legacyContent(
      IDS.commentContent,
      't1_bbb',
      'reddit_comment',
      'Comment on "Hello" in r/test',
      'A comment body',
      { reddit_comment_id: 'bbb', subreddit: 'test', link_title: 'Hello', score: 4, author: 'me' },
    );
    await legacyEvent(
      IDS.commentEvent,
      't1_bbb',
      'reddit_comment',
      'Commented on "Hello" in r/test',
      'A comment body',
      '2023-11-14T22:20:00Z',
    );

    // A saved post: TransformSaved keyed its content row exactly as the
    // authored transforms did, and stamped `saved: true` on source_data.
    await legacyContent(
      IDS.savedContent,
      't3_ccc',
      'reddit_post',
      'Saved post in r/test: Saved title',
      'Saved selftext',
      { reddit_item_id: 'ccc', subreddit: 'test', saved: true, score: 7, author: 'someone' },
    );
    await legacyEvent(
      IDS.savedEvent,
      't3_ccc',
      'reddit_saved_post',
      'Saved post in r/test: Saved title',
      'Saved selftext',
      '2022-01-01T00:00:00Z',
    );

    // A content row whose event never landed: undated, so content is its home.
    await legacyContent(IDS.undatedContent, 't3_eee', 'reddit_post', 'Orphan title', 'Orphan body', {
      reddit_post_id: 'eee',
      subreddit: 'test',
      score: 0,
      author: 'me',
    });

    // A dated post whose content row never landed: everything the communication
    // needs -- the moment, the body, the title and the subreddit -- has to come
    // off the event alone.
    await legacyEvent(
      IDS.contentlessPostEvent,
      't3_fff',
      'reddit_post',
      'Posted in r/test: Eventonly',
      'Event only body',
      '2023-05-05T05:05:05Z',
    );

    // A saved record whose content row is already gone: the one shape a plain
    // "delete the events" repair would drop on the floor.
    await legacyEvent(
      IDS.contentlessSavedEvent,
      't1_kkk',
      'reddit_saved_comment',
      'Saved comment on "K" in r/test',
      'Contentless saved body',
      '2021-03-03T00:00:00Z',
    );

    // Controls: a row already wearing the new key, and a row of another system
    // whose id happens to look like a fullname.
    await scratch.dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Content', 'New style', $2::uuid, 'content', $1::uuid)`,
      [IDS.newStyleContent, USER],
    );
    await scratch.dataSource.query(
      `INSERT INTO ci.content (id, type, text, user_id, source_type, source_system, source_id)
       VALUES ($1::uuid, 'social', 'New style', $2::uuid, 'ETL', 'reddit', $3)`,
      [IDS.newStyleContent, USER, redditIdentity('saved_post', 't3_zzz').id],
    );
    await scratch.dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Event', 'Other system', $2::uuid, 'events', $1::uuid)`,
      [IDS.otherSystemEvent, USER],
    );
    await scratch.dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, event_type, start_time, source_type, source_system, source_id)
       VALUES ($1::uuid, $2::uuid, 'social', '2024-01-01T00:00:00Z'::timestamptz, 'ci-import-tools', 'twitter', 't3_notreddit')`,
      [IDS.otherSystemEvent, USER],
    );
  }

  /** Apply the migration the way dbmate does: the whole up half, one transaction. */
  async function applyMigration(): Promise<void> {
    const runner = scratch.dataSource.createQueryRunner();

    await runner.connect();
    await runner.startTransaction();

    try {
      await runner.query(migrationUpSql());
      await runner.commitTransaction();
    } catch (err) {
      await runner.rollbackTransaction();

      throw err;
    } finally {
      await runner.release();
    }
  }

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({ createdBy: 'reddit identity repair' });
    await seedLegacyRows();
    await applyMigration();
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('leaves no Reddit row under the pre-#2561 fullname key', async () => {
    const rows = await scratch.dataSource.query(
      `SELECT 'content' AS t, source_id FROM ci.content
        WHERE source_system = 'reddit' AND source_id ~ '^t[1-6]_'
        UNION ALL
       SELECT 'events', source_id FROM ci.events
        WHERE source_system = 'reddit' AND source_id ~ '^t[1-6]_'`,
    );

    expect(rows).toEqual([]);
  });

  it('writes no Reddit event at all, the shape both pipelines now agree on', async () => {
    const [{ count }] = await scratch.dataSource.query(
      `SELECT count(*)::int AS count FROM ci.events WHERE source_system = 'reddit'`,
    );

    expect(count).toBe(0);
  });

  it("turns the user's dated post into the communication the writer would have written", async () => {
    const [row] = await scratch.dataSource.query(
      `SELECT m.source_id, m.source_system, m.communication_type::text AS communication_type,
              m.direction::text AS direction, m.thread_id, m.subject, m.content, m."time",
              m.metadata ->> 'kind' AS kind, m.metadata ->> 'reddit_fullname' AS fullname,
              e.name AS label
         FROM ci.communications m
         JOIN ci.entities e ON e.entity_id = m.id AND e.entity_type = 'Communication'
        WHERE m.user_id = $1::uuid AND m.source_id = $2`,
      [USER, redditIdentity('post', 't3_aaa').id],
    );

    expect(row).toMatchObject({
      source_system: 'reddit',
      communication_type: 'post',
      direction: 'outbound',
      thread_id: 'r/test',
      // The old row's title was decorated ("Posted in r/test: …"); the subject
      // is the post's own title, which is what the writer puts there.
      subject: 'Hello world',
      content: 'Body of the post',
      kind: 'post',
      fullname: 't3_aaa',
      label: 'Hello world',
    });
    // The event's start_time was the ONLY record of when the post happened —
    // ci.content has no time column — so losing it is the thing to guard.
    expect(new Date(row.time).toISOString()).toBe('2023-11-14T22:13:20.000Z');
  });

  it('gives a comment no subject, as the writer does — it has no authored title', async () => {
    const [row] = await scratch.dataSource.query(
      `SELECT subject, content, thread_id FROM ci.communications
        WHERE user_id = $1::uuid AND source_id = $2`,
      [USER, redditIdentity('comment', 't1_bbb').id],
    );

    expect(row).toMatchObject({ subject: null, content: 'A comment body', thread_id: 'r/test' });
  });

  it('drops the content + event rows a record replaced with a communication', async () => {
    const rows = await scratch.dataSource.query(
      `SELECT entity_id FROM ci.entities WHERE entity_id = ANY($1::uuid[])`,
      [[IDS.postContent, IDS.postEvent, IDS.commentContent, IDS.commentEvent]],
    );

    expect(rows).toEqual([]);
  });

  it('re-keys a saved record IN PLACE, keeping the uuid its search rows point at', async () => {
    const [row] = await scratch.dataSource.query(
      `SELECT id, type, source_id, source_data ->> 'kind' AS kind,
              source_data ->> 'item_created_at' AS item_created_at
         FROM ci.content WHERE id = $1::uuid`,
      [IDS.savedContent],
    );

    expect(row).toMatchObject({
      id: IDS.savedContent,
      // `contentRow`'s type for a media-less record. It also takes the row out
      // of removeLegacyRows()' LEGACY_CONTENT_TYPES, so a later sweep cannot
      // delete the row this migration just made canonical.
      type: 'social',
      source_id: redditIdentity('saved_post', 't3_ccc').id,
      kind: 'saved_post',
      // The event carried the moment; content has nowhere to put it but here,
      // which is where the writer puts it too.
      item_created_at: '2022-01-01T00:00:00.000Z',
    });

    const [vector] = await scratch.dataSource.query(
      `SELECT entity_id FROM ci_search.vectors WHERE entity_id = $1::uuid`,
      [IDS.savedContent],
    );

    expect(vector).toMatchObject({ entity_id: IDS.savedContent });
  });

  it('keeps an undated authored record as content, under the authored key', async () => {
    const [row] = await scratch.dataSource.query(
      `SELECT id, type, source_id FROM ci.content WHERE id = $1::uuid`,
      [IDS.undatedContent],
    );

    expect(row).toMatchObject({
      id: IDS.undatedContent,
      type: 'social',
      source_id: redditIdentity('post', 't3_eee').id,
    });
  });

  it('builds a communication from the event alone when the content row is missing', async () => {
    const [row] = await scratch.dataSource.query(
      `SELECT subject, content, thread_id, "time" FROM ci.communications
        WHERE user_id = $1::uuid AND source_id = $2`,
      [USER, redditIdentity('post', 't3_fff').id],
    );

    expect(row).toMatchObject({
      // Both recovered from the event's own decorated title.
      subject: 'Eventonly',
      thread_id: 'r/test',
      content: 'Event only body',
    });
    expect(new Date(row.time).toISOString()).toBe('2023-05-05T05:05:05.000Z');
  });

  it('mints the content row a saved record lost, rather than deleting its event', async () => {
    const [row] = await scratch.dataSource.query(
      `SELECT c.type, c.text, c.source_id, c.external_id,
              c.source_data ->> 'item_created_at' AS item_created_at, e.name AS label
         FROM ci.content c
         JOIN ci.entities e ON e.entity_id = c.id AND e.entity_type = 'Content'
        WHERE c.user_id = $1::uuid AND c.source_id = $2`,
      [USER, redditIdentity('saved_comment', 't1_kkk').id],
    );

    expect(row).toMatchObject({
      type: 'social',
      text: 'Contentless saved body',
      external_id: 't1_kkk',
      item_created_at: '2021-03-03T00:00:00.000Z',
      label: 'Saved comment on "K" in r/test',
    });
  });

  it('leaves no ci_search row pointing at a deleted record', async () => {
    const orphans = await scratch.dataSource.query(
      `SELECT v.entity_id FROM ci_search.vectors v
        WHERE NOT EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = v.entity_id)`,
    );

    expect(orphans).toEqual([]);
  });

  it('re-points the provenance ledger at the key the row now wears', async () => {
    const rows = await scratch.dataSource.query(
      `SELECT record_table, source_id FROM ci.record_sources ORDER BY record_table, source_id`,
    );

    expect(rows).toEqual([
      { record_table: 'communications', source_id: redditIdentity('comment', 't1_bbb').id },
      { record_table: 'communications', source_id: redditIdentity('post', 't3_aaa').id },
      { record_table: 'communications', source_id: redditIdentity('post', 't3_fff').id },
      { record_table: 'content', source_id: redditIdentity('post', 't3_eee').id },
      { record_table: 'content', source_id: redditIdentity('saved_comment', 't1_kkk').id },
      { record_table: 'content', source_id: redditIdentity('saved_post', 't3_ccc').id },
    ]);
  });

  it('touches nothing outside the pre-#2561 shape', async () => {
    const [newStyle] = await scratch.dataSource.query(
      `SELECT source_id, type FROM ci.content WHERE id = $1::uuid`,
      [IDS.newStyleContent],
    );
    const [other] = await scratch.dataSource.query(
      `SELECT source_system, source_id FROM ci.events WHERE event_id = $1::uuid`,
      [IDS.otherSystemEvent],
    );

    expect(newStyle).toMatchObject({ source_id: redditIdentity('saved_post', 't3_zzz').id, type: 'social' });
    expect(other).toMatchObject({ source_system: 'twitter', source_id: 't3_notreddit' });
  });

  it('is idempotent — a second run changes nothing', async () => {
    const snapshot = async () =>
      scratch.dataSource.query(
        `SELECT 'communications' AS t, id::text AS id, source_id FROM ci.communications
          UNION ALL
         SELECT 'content', id::text, source_id FROM ci.content
          UNION ALL
         SELECT 'events', event_id::text, source_id FROM ci.events
          ORDER BY 1, 2`,
      );

    const before = await snapshot();
    await applyMigration();

    expect(await snapshot()).toEqual(before);
  });
});
