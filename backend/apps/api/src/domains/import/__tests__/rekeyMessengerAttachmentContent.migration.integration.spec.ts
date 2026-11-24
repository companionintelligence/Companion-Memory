import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';

import { IMPORT_DATABASE_ENV } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 20261002005332 — MESSENGER ATTACHMENTS MOVE ONTO THEIR MESSAGE'S SYSTEM.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * #2912 keys a Messenger attachment's `ci.content` row under
 * `facebook_messenger`, the system its message is keyed under, instead of the
 * `facebook` data source. The migration moves the rows written before it, in
 * place, and resolves the twins a re-import after upgrading wrote beside them.
 * It is applied here verbatim from disk to a row in every shape it has to tell
 * apart, and each case asserts what it left: which rows moved (a row's `ctid`
 * changes on every UPDATE, so an unmoved one proves it was not rewritten),
 * which twin went, and that the one that went left nothing pointing at it.
 *
 * Everything happens in one transaction, rolled back in `afterAll`. Opt-in like
 * its neighbours: set `IMPORT_TEST_DATABASE_URL` to a migrated database of your
 * OWN, or run `make test-db`, which provides one.
 *
 * Invented throughout: ids, hashes, names.
 */

const MIGRATION = '20261002005332_rekey_messenger_attachment_content.sql';

const availability = databaseAvailability(IMPORT_DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[import/rekeyMessengerAttachmentContent.migration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

/** The `-- migrate:up` half of the migration, as dbmate would run it. */
function migrationUp(): string {
  const file = path.resolve(__dirname, '../../../../db/postgres/migrations', MIGRATION);
  const sql = readFileSync(file, 'utf8');
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');

  if (start < 0 || end < 0) {
    throw new Error(`${file} has no migrate:up / migrate:down markers.`);
  }

  return sql.slice(start + '-- migrate:up'.length, end);
}

/** Older than anything the migration could stamp, so a bump is visible. */
const SEEDED_AT = '2026-01-01T00:00:00Z';

/** A SHA-256 per letter: the bytes' hash is the attachment's identity. */
const sha = (letter: string) => letter.repeat(64);

/** Every place a row can point at a content id, counted by `$1`. */
const FOOTPRINT: Array<[label: string, sql: string]> = [
  ['ci.entities', `SELECT count(*) FROM ci.entities WHERE entity_id = $1`],
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

/** One content row as stored, and its ledger rows. */
interface Stored {
  ctid: string;
  sourceSystem: string;
  sourceId: string;
  externalId: string | null;
  updatedAt: Date;
  ledger: Array<{ ctid: string; sourceSystem: string; sourceId: string; platform: string | null }>;
}

describeWithDb(`re-keying Messenger attachments catalogued under facebook (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let ownerId: string;
  let strangerId: string;

  /** Content ids by case label. */
  const ids = new Map<string, string>();
  /** Message ids by case label. */
  const messages = new Map<string, string>();
  let before: Map<string, Stored>;
  let after: Map<string, Stored>;
  /** Each message's ctid, which moves on every UPDATE. */
  let messagesBefore: Map<string, string>;
  let messagesAfter: Map<string, string>;
  /** The member_count of the HBPE cluster the loser of `twin-named-legacy` was in. */
  let clusterBefore: number;
  let clusterId: string;

  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  function id(label: string): string {
    const found = ids.get(label);

    if (found == null) {
      throw new Error(`no content seeded as "${label}"`);
    }

    return found;
  }

  /** A Messenger message id, as facebook.ts mints it: `facebook:msg:v2:<sha1>`. */
  function messageSourceId(label: string): string {
    return `facebook:msg:v2:${Buffer.from(label).toString('hex').padEnd(40, '0').slice(0, 40)}`;
  }

  /**
   * A message, keyed the way `toFacebookMessengerCommunicationInput` keys one,
   * naming the content rows `names` lists (by case label) in its `attachments`,
   * after the file entry the push writes first.
   */
  async function message(
    label: string,
    names: string[],
    options: { system?: string; forUser?: string; fileId?: string } = {},
  ): Promise<string> {
    const messageId = randomUUID();
    const forUser = options.forUser ?? ownerId;
    const attachments = [
      { type: 'file', id: options.fileId ?? randomUUID() },
      ...names.map((name) => ({ type: 'content', id: id(name) })),
    ];

    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Communication', $2, '{}'::jsonb, $3, 'communications', $1)`,
      [messageId, label, forUser],
    );
    await q(
      `INSERT INTO ci.communications
         (id, "time", user_id, communication_type, direction, content, attachments,
          source_type, source_system, source_id)
       VALUES ($1, '2025-12-31T09:40:22Z', $2, 'chat', 'inbound', '', $3::jsonb,
               'ci-import-tools', $4, $5)`,
      [
        messageId,
        forUser,
        JSON.stringify(attachments),
        options.system ?? 'facebook_messenger',
        messageSourceId(label),
      ],
    );
    messages.set(label, messageId);

    return messageId;
  }

  /**
   * One attachment's content row the way MediaStage writes it, with the ledger
   * row the insert appends, its two search rows and their pipeline state.
   */
  async function attachment(
    label: string,
    seed: { system: string; sourceId: string; fileId: string; forUser?: string },
  ): Promise<string> {
    const contentId = randomUUID();
    const forUser = seed.forUser ?? ownerId;

    ids.set(label, contentId);
    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
      [contentId, `${label}.jpg`, forUser],
    );
    await q(
      `INSERT INTO ci.content
         (id, type, mimetype, external_id, external_id_kind, user_id,
          source_type, source_system, source_id, created_at, updated_at)
       VALUES ($1, 'media', 'image/jpeg', $2, 'file', $3, 'ci-import-tools', $4, $5, $6, $6)`,
      [contentId, seed.fileId, forUser, seed.system, seed.sourceId, SEEDED_AT],
    );
    await q(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id, platform)
       VALUES ($1, 'content', $2, 'ci-import-tools', $3, $4, $5)`,
      // ledgerPlatform of a platform system is the system itself.
      [forUser, contentId, seed.system, seed.sourceId, seed.system],
    );
    await q(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES (gen_random_uuid(), 'content', $1, to_tsvector('simple', $2), $3)`,
      [contentId, label, forUser],
    );
    await q(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, user_id)
       VALUES (gen_random_uuid(), 'content', $1, $2)`,
      [contentId, forUser],
    );

    for (const stage of ['index.vector', 'index.embed']) {
      await q(
        `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, status, user_id)
         VALUES ('content', $1, $2, 'done', $3)`,
        [contentId, stage, forUser],
      );
    }

    return contentId;
  }

  /** An edge, and the delta that recorded it. */
  async function edge(from: string, to: string, type: string): Promise<void> {
    const [{ relationship_id: relationshipId }] = await q<Array<{ relationship_id: string }>>(
      `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING relationship_id`,
      [from, to, type, ownerId],
    );

    await q(
      `INSERT INTO ci.graph_deltas
         (node_type, relationship_id, relationship_type, from_entity_id, to_entity_id, change_type, changed_fields, owner_user_id)
       VALUES ('relationship', $1, $2, $3, $4, 'created', '{}'::jsonb, $5)`,
      [relationshipId, type, from, to, ownerId],
    );
  }

  /**
   * Everything else the appliance hangs off a content row, so a teardown that
   * misses a table is named by it: edges both ways, a dead letter, the node's
   * delta, a tag and a category, a search skip, and HBPE's cluster membership
   * and context (what made a bare delete of clustered content fail).
   */
  async function everythingElse(label: string): Promise<{ clusterId: string }> {
    const contentId = id(label);
    const [{ entity_id: person }] = await q<Array<{ entity_id: string }>>(
      `INSERT INTO ci.entities (entity_type, name, properties, owner_user_id)
       VALUES ('Person', $1, '{}'::jsonb, $2) RETURNING entity_id`,
      [`${label} sender`, ownerId],
    );

    await edge(person, contentId, 'SENT');
    await edge(contentId, person, 'DEPICTS');

    await q(
      `INSERT INTO ci.pipeline_dead_letters (queue, event_name, entity_type, entity_id, payload, error, user_id)
       VALUES ('pipeline', 'content.created', 'content', $1, '{}'::jsonb, 'boom', $2)`,
      [contentId, ownerId],
    );
    await q(
      `INSERT INTO ci.graph_deltas (node_type, entity_id, entity_type, change_type, changed_fields, owner_user_id)
       VALUES ('entity', $1, 'Content', 'created', jsonb_build_object('name', jsonb_build_object('new', $2::text)), $3)`,
      [contentId, label, ownerId],
    );

    const [{ id: tag }] = await q<Array<{ id: string }>>(
      `INSERT INTO ci_search.tags (id, label, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [`messenger-rekey-spec-${label}`, ownerId],
    );

    await q(`INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ('content', $1, $2)`, [
      contentId,
      tag,
    ]);
    await q(
      `INSERT INTO ci_search.entity_categories (entity_type, entity_id, category_tag_id, position)
       VALUES ('content', $1, $2, 0)`,
      [contentId, tag],
    );
    await q(
      `INSERT INTO ci_search.index_skips (entity_type, entity_id, reason) VALUES ('content', $1, 'messenger_rekey_spec')`,
      [contentId],
    );

    // Two members, this row and one other, as HBPE would count them.
    const [{ cluster_id: l1 }] = await q<Array<{ cluster_id: string }>>(
      `INSERT INTO hbpe.l1_clusters (user_id, l0_class, label, member_count) VALUES ($1, 'x', $2, 2) RETURNING cluster_id`,
      [ownerId, `l1 ${label}`],
    );
    const [{ cluster_id: l2 }] = await q<Array<{ cluster_id: string }>>(
      `INSERT INTO hbpe.l2_clusters (user_id, l0_class, l1_cluster_id, label, member_count)
       VALUES ($1, 'x', $2, $3, 2) RETURNING cluster_id`,
      [ownerId, l1, `l2 ${label}`],
    );

    await q(`INSERT INTO hbpe.l2_content_cluster (content_id, cluster_id, similarity) VALUES ($1, $2, 0.9)`, [
      contentId,
      l2,
    ]);
    await q(
      `INSERT INTO hbpe.content_context (content_id, user_id, l0_class, l1_cluster_id) VALUES ($1, $2, 'x', $3)`,
      [contentId, ownerId, l1],
    );

    return { clusterId: l2 };
  }

  async function footprint(contentId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const [label, sql] of FOOTPRINT) {
      const [{ count }] = await q<Array<{ count: string }>>(sql, [contentId]);

      counts[label] = Number(count);
    }

    return counts;
  }

  async function snapshot(): Promise<Map<string, Stored>> {
    const rows = new Map<string, Stored>();

    for (const [label, contentId] of ids) {
      const [content] = await q<
        Array<{
          ctid: string;
          source_system: string;
          source_id: string;
          external_id: string | null;
          updated_at: Date;
        }>
      >(
        `SELECT ctid::text, source_system, source_id, external_id, updated_at FROM ci.content WHERE id = $1`,
        [contentId],
      );

      if (content == null) {
        continue;
      }

      const ledger = await q<
        Array<{ ctid: string; source_system: string; source_id: string; platform: string | null }>
      >(
        `SELECT ctid::text, source_system, source_id, platform
           FROM ci.record_sources
          WHERE record_table = 'content' AND record_id = $1
          ORDER BY source_system, platform`,
        [contentId],
      );

      rows.set(label, {
        ctid: content.ctid,
        sourceSystem: content.source_system,
        sourceId: content.source_id,
        externalId: content.external_id,
        updatedAt: content.updated_at,
        ledger: ledger.map((row) => ({
          ctid: row.ctid,
          sourceSystem: row.source_system,
          sourceId: row.source_id,
          platform: row.platform,
        })),
      });
    }

    return rows;
  }

  async function messageCtids(): Promise<Map<string, string>> {
    const rows = new Map<string, string>();

    for (const [label, messageId] of messages) {
      const [{ ctid }] = await q<Array<{ ctid: string }>>(
        `SELECT ctid::text FROM ci.communications WHERE id = $1`,
        [messageId],
      );

      rows.set(label, ctid);
    }

    return rows;
  }

  async function attachmentsOf(label: string): Promise<unknown> {
    const [{ attachments }] = await q<Array<{ attachments: unknown }>>(
      `SELECT attachments FROM ci.communications WHERE id = $1`,
      [messages.get(label)],
    );

    return attachments;
  }

  function stored(map: Map<string, Stored>, label: string): Stored {
    const row = map.get(label);

    if (row == null) {
      throw new Error(`"${label}" is not stored`);
    }

    return row;
  }

  /** Re-keyed in place: same row id, new system in the column and the ledger, nothing else moved. */
  function expectRekeyed(label: string): void {
    const was = stored(before, label);
    const now = stored(after, label);

    expect(was.sourceSystem).toBe('facebook');
    expect(now).toMatchObject({
      sourceSystem: 'facebook_messenger',
      sourceId: was.sourceId,
      externalId: was.externalId,
    });
    // The explorer browses content by updated_at: a label fix must not move it.
    expect(now.updatedAt).toEqual(was.updatedAt);
    expect(now.ledger).toEqual([
      expect.objectContaining({
        sourceSystem: 'facebook_messenger',
        sourceId: was.sourceId,
        platform: 'facebook_messenger',
      }),
    ]);
  }

  function expectUntouched(label: string): void {
    expect(stored(after, label)).toEqual(stored(before, label));
  }

  beforeAll(async () => {
    const connection = resolveConnection(IMPORT_DATABASE_ENV);

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
      entities: [],
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });
    await dataSource.initialize();

    // The migration row-locks what it repairs, whoever owns it, for as long as
    // this transaction is open.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'import/rekeyMessengerAttachmentContent.migration');

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    ownerId = await createSyntheticTestUser((sql, params) => q(sql, params), 'MessengerRekey');
    strangerId = await createSyntheticTestUser((sql, params) => q(sql, params), 'MessengerRekeyStranger');

    const file = () => randomUUID();
    const shaKey = (label: string, letter: string) => `attachment:${messageSourceId(label)}:${sha(letter)}`;

    // ── Re-keyed in place ─────────────────────────────────────────────────
    // The common case: written before #2912, named by its message.
    await attachment('plain', { system: 'facebook', sourceId: shaKey('plain', 'a'), fileId: file() });
    await message('plain', ['plain']);
    await edge(id('plain'), messages.get('plain')!, 'ATTACHED_TO');

    // The no-hash fallback: `<message source_id>:attachment:<n>`.
    await attachment('fallback', {
      system: 'facebook',
      sourceId: `${messageSourceId('fallback')}:attachment:0`,
      fileId: file(),
    });
    await message('fallback', ['fallback']);

    // A ledger row left under the NEW key by a twin the app's delete removed:
    // without the cleanup, the ledger re-key would collide on its unique key.
    await attachment('dangling-ledger', {
      system: 'facebook',
      sourceId: shaKey('dangling-ledger', 'b'),
      fileId: file(),
    });
    await message('dangling-ledger', ['dangling-ledger']);
    await q(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id, platform)
       VALUES ($1, 'content', $2, 'ci-import-tools', 'facebook_messenger', $3, 'facebook_messenger')`,
      [ownerId, randomUUID(), shaKey('dangling-ledger', 'b')],
    );

    // Its ledger also recorded some other identity under `facebook`: only the
    // arrival of the attachment's own key moves.
    await attachment('other-identity', {
      system: 'facebook',
      sourceId: shaKey('other-identity', '7'),
      fileId: file(),
    });
    await message('other-identity', ['other-identity']);
    await q(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id, platform)
       VALUES ($1, 'content', $2, 'ci-import-tools', 'facebook', 'facebook:photo:10151', 'facebook')`,
      [ownerId, id('other-identity')],
    );

    // Its own ledger already holds the new key beside the old one: the old-key
    // arrival is redundant, and re-keying it would collide on the unique key.
    await attachment('held-ledger', {
      system: 'facebook',
      sourceId: shaKey('held-ledger', '5'),
      fileId: file(),
    });
    await message('held-ledger', ['held-ledger']);
    await q(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id, platform)
       VALUES ($1, 'content', $2, 'ci-import-tools', 'facebook_messenger', $3, 'facebook_messenger')`,
      [ownerId, id('held-ledger'), shaKey('held-ledger', '5')],
    );

    // ── Twins: a re-import after upgrading wrote a second row ─────────────
    // The shape measured on the reference corpus: the message names the old
    // row, the new one is named by nothing. The new one carries everything a
    // row can, so the teardown is checked table by table.
    const twinFile = file();

    await attachment('twin-named-legacy', {
      system: 'facebook',
      sourceId: shaKey('twin-named-legacy', 'c'),
      fileId: twinFile,
    });
    await attachment('twin-named-legacy:new', {
      system: 'facebook_messenger',
      sourceId: shaKey('twin-named-legacy', 'c'),
      fileId: twinFile,
    });
    await message('twin-named-legacy', ['twin-named-legacy'], { fileId: twinFile });
    ({ clusterId } = await everythingElse('twin-named-legacy:new'));

    // The message names the new row: the new row stays as it is.
    await attachment('twin-named-new:old', {
      system: 'facebook',
      sourceId: shaKey('twin-named-new', 'd'),
      fileId: twinFile,
    });
    await attachment('twin-named-new', {
      system: 'facebook_messenger',
      sourceId: shaKey('twin-named-new', 'd'),
      fileId: twinFile,
    });
    await message('twin-named-new', ['twin-named-new']);
    await everythingElse('twin-named-new:old');

    // The message names neither: the old row, which is older, stays.
    await attachment('twin-named-neither', {
      system: 'facebook',
      sourceId: shaKey('twin-named-neither', 'e'),
      fileId: twinFile,
    });
    await attachment('twin-named-neither:new', {
      system: 'facebook_messenger',
      sourceId: shaKey('twin-named-neither', 'e'),
      fileId: twinFile,
    });
    await message('twin-named-neither', []);

    // The message names both: the old row stays, and the message stops naming
    // the one that went.
    await attachment('twin-named-both', {
      system: 'facebook',
      sourceId: shaKey('twin-named-both', 'f'),
      fileId: twinFile,
    });
    await attachment('twin-named-both:new', {
      system: 'facebook_messenger',
      sourceId: shaKey('twin-named-both', 'f'),
      fileId: twinFile,
    });
    await message('twin-named-both', ['twin-named-both', 'twin-named-both:new']);

    // `attachments` is free-form jsonb at the API boundary. A message that is
    // not an array names both rows as text, and must not be taken apart as one.
    await attachment('twin-object-attachments', {
      system: 'facebook',
      sourceId: shaKey('twin-object-attachments', '6'),
      fileId: twinFile,
    });
    await attachment('twin-object-attachments:new', {
      system: 'facebook_messenger',
      sourceId: shaKey('twin-object-attachments', '6'),
      fileId: twinFile,
    });
    await message('twin-object-attachments', []);
    await q(`UPDATE ci.communications SET attachments = $2::jsonb WHERE id = $1`, [
      messages.get('twin-object-attachments'),
      JSON.stringify({ photo: id('twin-object-attachments'), copy: id('twin-object-attachments:new') }),
    ]);

    // ── Left alone ────────────────────────────────────────────────────────
    // Written after #2912: already right.
    await attachment('already-messenger', {
      system: 'facebook_messenger',
      sourceId: shaKey('already-messenger', '1'),
      fileId: file(),
    });
    await message('already-messenger', ['already-messenger']);

    // An attachment whose message is gone: nothing proves it is Messenger's.
    await attachment('no-message', {
      system: 'facebook',
      sourceId: shaKey('no-message', '2'),
      fileId: file(),
    });

    // Its parent is a Facebook record that is not a Messenger message: the
    // system it is keyed under is its parent's, and that is `facebook`.
    await attachment('facebook-parent', {
      system: 'facebook',
      sourceId: shaKey('facebook-parent', '3'),
      fileId: file(),
    });
    await message('facebook-parent', ['facebook-parent'], { system: 'facebook' });

    // The message with that id is someone else's.
    await attachment('stranger-message', {
      system: 'facebook',
      sourceId: shaKey('stranger-message', '4'),
      fileId: file(),
    });
    await message('stranger-message', [], { forUser: strangerId });

    // Not an attachment at all: a Facebook photo keyed on its own id.
    await attachment('facebook-photo', {
      system: 'facebook',
      sourceId: 'facebook:photo:10150',
      fileId: file(),
    });

    // The fallback shape with no message behind it either.
    await attachment('fallback-no-message', {
      system: 'facebook',
      sourceId: `${messageSourceId('fallback-no-message')}:attachment:3`,
      fileId: file(),
    });

    // The CTI foreign keys are DEFERRABLE INITIALLY DEFERRED, and in a
    // transaction that is never committed they would never fire: a fixture the
    // real schema rejects would pass. Check them now.
    await q('SET CONSTRAINTS ALL IMMEDIATE');

    const [{ member_count: count }] = await q<Array<{ member_count: number }>>(
      `SELECT member_count FROM hbpe.l2_clusters WHERE cluster_id = $1`,
      [clusterId],
    );

    clusterBefore = count;
    before = await snapshot();
    messagesBefore = await messageCtids();

    await q(migrationUp());
    await q('SET CONSTRAINTS ALL IMMEDIATE');

    after = await snapshot();
    messagesAfter = await messageCtids();
  });

  afterAll(async () => {
    if (runner?.isTransactionActive) {
      await runner.rollbackTransaction();
    }

    await runner?.release();
    await schemaLock?.release();

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('re-keys a Messenger attachment in place, in the column and the ledger, without moving it in time', async () => {
    expectRekeyed('plain');

    // Everything that names it by id still does.
    expect(await footprint(id('plain'))).toMatchObject({
      'ci.entities': 1,
      'ci.content': 1,
      'ci.relationships': 1,
      'ci.record_sources': 1,
      'ci.pipeline_state': 2,
      'ci_search.vectors': 1,
      'ci_search.embeddings': 1,
    });
    // Nothing indexed for content carries its system, so the search stages are
    // not re-armed: their state is exactly as it was.
    expect(
      await q(`SELECT stage, status FROM ci.pipeline_state WHERE entity_id = $1 ORDER BY stage`, [
        id('plain'),
      ]),
    ).toEqual([
      { stage: 'index.embed', status: 'done' },
      { stage: 'index.vector', status: 'done' },
    ]);
  });

  it('re-keys the no-hash fallback shape, tied to its message the same way', () => {
    expectRekeyed('fallback');
  });

  it('drops an old-key ledger row whose new key the row already holds, instead of colliding', () => {
    expectRekeyed('held-ledger');

    // The row that already held the key is the one kept, untouched: its
    // connection and run are what disconnect and undo-import key on.
    const held = stored(before, 'held-ledger').ledger.find(
      (row) => row.sourceSystem === 'facebook_messenger',
    );

    expect(held).toBeDefined();
    expect(stored(after, 'held-ledger').ledger).toEqual([held]);
  });

  it('re-keys only the ledger rows that recorded the attachment key itself', () => {
    const was = stored(before, 'other-identity');
    const now = stored(after, 'other-identity');

    expect(now.sourceSystem).toBe('facebook_messenger');
    expect(now.ledger).toEqual([
      was.ledger.find((row) => row.sourceId === 'facebook:photo:10151'),
      expect.objectContaining({
        sourceSystem: 'facebook_messenger',
        sourceId: was.sourceId,
        platform: 'facebook_messenger',
      }),
    ]);
  });

  it('clears a stale ledger row holding the new key instead of colliding with it', async () => {
    expectRekeyed('dangling-ledger');

    const [{ count }] = await q<Array<{ count: string }>>(
      `SELECT count(*) FROM ci.record_sources
        WHERE user_id = $1 AND record_table = 'content' AND source_id = $2`,
      [ownerId, stored(before, 'dangling-ledger').sourceId],
    );

    expect(Number(count)).toBe(1);
  });

  describe('a twin a re-import after upgrading wrote', () => {
    it('keeps the row the message names, re-keyed, and tears the other down completely', async () => {
      expectRekeyed('twin-named-legacy');
      expect(after.has('twin-named-legacy:new')).toBe(false);

      const gone = await footprint(id('twin-named-legacy:new'));

      expect(Object.entries(gone).filter(([, count]) => count > 0)).toEqual([]);
      // The membership comes off HBPE's count. The cluster itself is HBPE's.
      expect(await q(`SELECT member_count FROM hbpe.l2_clusters WHERE cluster_id = $1`, [clusterId])).toEqual(
        [{ member_count: clusterBefore - 1 }],
      );
      // The message, and the file both rows wrapped, are as they were.
      expect(await attachmentsOf('twin-named-legacy')).toEqual([
        { type: 'file', id: stored(before, 'twin-named-legacy').externalId },
        { type: 'content', id: id('twin-named-legacy') },
      ]);
    });

    it('keeps the new row when the message names it, and tears the old one down', async () => {
      expectUntouched('twin-named-new');
      expect(after.has('twin-named-new:old')).toBe(false);

      const gone = await footprint(id('twin-named-new:old'));

      expect(Object.entries(gone).filter(([, count]) => count > 0)).toEqual([]);
    });

    it('keeps the older row when the message names neither', async () => {
      expectRekeyed('twin-named-neither');
      expect(after.has('twin-named-neither:new')).toBe(false);
    });

    it('leaves attachments that are not an array as they were', async () => {
      expectRekeyed('twin-object-attachments');
      expect(after.has('twin-object-attachments:new')).toBe(false);
      expect(await attachmentsOf('twin-object-attachments')).toEqual({
        photo: id('twin-object-attachments'),
        copy: id('twin-object-attachments:new'),
      });
    });

    it('keeps the older row when the message names both, and stops the message naming the other', async () => {
      expectRekeyed('twin-named-both');
      expect(after.has('twin-named-both:new')).toBe(false);
      expect(await attachmentsOf('twin-named-both')).toEqual([
        { type: 'file', id: expect.any(String) },
        { type: 'content', id: id('twin-named-both') },
      ]);
    });
  });

  it.each([
    ['already-messenger', 'a row written after #2912'],
    ['no-message', 'an attachment whose message is gone'],
    ['facebook-parent', 'an attachment of a record keyed under facebook'],
    ['stranger-message', "an attachment whose message id is another user's"],
    ['facebook-photo', 'a Facebook row that is not an attachment'],
    ['fallback-no-message', 'the fallback shape with no message'],
  ])('leaves %s alone (%s)', (label) => {
    expectUntouched(label);
  });

  it('rewrites only the message that named both rows of a pair', () => {
    const rewritten = [...messagesBefore].filter(([label, ctid]) => messagesAfter.get(label) !== ctid);

    expect(rewritten.map(([label]) => label)).toEqual(['twin-named-both']);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await q(migrationUp());

    expect(await snapshot()).toEqual(after);
    expect(await messageCtids()).toEqual(messagesAfter);
  });
});
