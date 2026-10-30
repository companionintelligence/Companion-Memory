import { DataSource, type QueryRunner } from 'typeorm';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A FILE THE MESSAGE NAMES IS COUNTED UNDER THE IMPORT THAT MADE IT — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GraphUtilityService.getEntityCountsBySource` files a `File` entity under the importer of the record that names
 * its `ci.files` row. Two records can: the content row an import made over the file (`external_id`), and the message
 * that carries it (`communications.attachments`, `{type: 'file', id}`). A tweet's or DM's media gets no content row
 * when X no longer serves its URL, so for that file the message is the only record, and without that lane the File
 * entity fell through to the bare `linked_table` 'files' and counted as derived.
 *
 * `GraphUtilityService.sourceCounts.test.ts` pins the SQL text; this one runs it. What only Postgres can show: the
 * `jsonb_array_elements` over a real column, a non-array `attachments` value in the same table not failing the
 * whole query, and the earliest arrival winning when two records name one file.
 *
 * Every test runs in one transaction on one connection and rolls back. Opt-in like the sibling suites: skips with
 * the reason when nothing listens at `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[GraphUtilityService.sourceCounts.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = { setContext: () => undefined };

describeWithDb(`GraphUtilityService.getEntityCountsBySource (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let service: GraphUtilityService;
  let owner: string;

  /** A stored file and the `File` node that shadows it, as the media stage leaves them. */
  const storedFile = async (name: string): Promise<string> => {
    const fileId = uuidv7();

    await runner.query(
      `INSERT INTO ci.files (id, filename, content_type, variant, bucket, key, hash, user_id)
       VALUES ($1, $2, 'image/jpeg', 'ORIGINAL', 'static', $3, $4, $5)`,
      [fileId, name, uuidv4(), `hash-${fileId}`, owner],
    );
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'File', $2, '{}'::jsonb, $3, 'files', $4)`,
      [uuidv7(), name, owner, fileId],
    );

    return fileId;
  };

  /** A message with `attachments` stored as given, and a ledger row saying which platform it arrived from. */
  const message = async (attachments: unknown, platform: string, firstSeen = '2026-01-01T00:00:00Z') => {
    const id = uuidv7();

    // No Communication node: it would count too, and its constraint is deferred to commit, which never comes.
    await runner.query(
      `INSERT INTO ci.communications (id, "time", user_id, communication_type, direction, content, attachments)
       VALUES ($1, '2026-01-01T00:00:00Z', $2, 'chat', 'inbound', 'see attached', $3::jsonb)`,
      [id, owner, JSON.stringify(attachments)],
    );
    await runner.query(
      `INSERT INTO ci.record_sources
         (user_id, record_table, record_id, source_type, source_system, source_id, platform, first_seen)
       VALUES ($1, 'communications', $2, 'ci.import', 'import', $3, $4, $5)`,
      [owner, id, `msg-${id}`, platform, firstSeen],
    );

    return id;
  };

  /** The rows for the File entities this test seeded, keyed `source/kind`. The owner has no other entities. */
  const bySource = async (): Promise<Record<string, number>> => {
    const rows = await service.getEntityCountsBySource(owner);

    return Object.fromEntries(rows.map((r) => [`${r.source}/${r.kind}`, r.count]));
  };

  beforeAll(async () => {
    const connection = resolveConnection(ENV);

    if (connection == null) {
      throw new Error('availability said yes but no connection resolved');
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
      entities: [GraphNodeEntity],
      synchronize: false,
    });
    await dataSource.initialize();

    // SHARED: these tests write ci.entities / ci.users inside their transaction.
    // See domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'GraphUtilityService.sourceCounts');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    owner = await createSyntheticTestUser(
      (sql: string, params?: unknown[]) => runner.query(sql, params),
      'GraphUtility-sourceCounts',
    );
    service = new GraphUtilityService(
      runner.manager.getRepository(GraphNodeEntity),
      {} as never,
      logger as never,
    );
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it("counts a file only a message names under that message's platform; an unnamed file stays derived", async () => {
    const photo = await storedFile('photo.jpg');

    await storedFile('uploaded-by-hand.jpg');
    await message([{ type: 'file', id: photo }], 'twitter');

    expect(await bySource()).toEqual({
      'import:twitter/imported': 1,
      'files/derived': 1,
    });
  });

  it('skips a non-array attachments value instead of failing the query', async () => {
    const photo = await storedFile('photo.jpg');

    await message({ type: 'file', id: photo }, 'twitter');
    await message('not a list', 'twitter');
    await message(null, 'twitter');
    await message(
      [
        { type: 'content', id: uuidv7() },
        { type: 'file', id: photo },
      ],
      'twitter',
    );

    expect(await bySource()).toEqual({ 'import:twitter/imported': 1 });
  });

  it('files a file under the earliest message that names it', async () => {
    const photo = await storedFile('photo.jpg');

    await message([{ type: 'file', id: photo }], 'whatsapp', '2026-03-01T00:00:00Z');
    await message([{ type: 'file', id: photo }], 'twitter', '2026-02-01T00:00:00Z');

    expect(await bySource()).toEqual({ 'import:twitter/imported': 1 });
  });
});
