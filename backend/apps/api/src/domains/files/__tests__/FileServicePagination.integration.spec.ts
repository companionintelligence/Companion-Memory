import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { syntheticTestUserEmail } from '../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock } from '../../__tests__/support/schemaLock';
import { FileEntity } from '../entities/FileEntity';
import { FileService } from '../services/FileService';

/**
 * FileService.findPage against real Postgres.
 *
 * The keyset predicate — `(created_at, id) < (:anchor, :id)` row-value
 * comparison, DESC ordering with the id tiebreak, the scope filters — is SQL
 * the driver has to accept and the planner has to honour; a mocked repository
 * agrees with whatever its author believed (this codebase's documented trap),
 * and the whole point of findPage is to stop loading the library per page.
 *
 * Rows are seeded with `bucket` NULL and an `externalId`, which signFile
 * resolves without touching the object store — so no S3 stub is needed.
 */

const describeWithDatabase = databaseAvailability().available ? describe : describe.skip;

if (!databaseAvailability().available) {
  console.warn(`[files/FileServicePagination.integration] SKIPPED — ${databaseAvailability().reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase('FileService.findPage (real database)', () => {
  let dataSource: DataSource;
  let service: FileService;
  let schemaLock: { release: () => Promise<void> };

  const userId = randomUUID();
  const otherUserId = randomUUID();

  // Fixed ids so the created_at TIE between C and D breaks deterministically
  // (id DESC ⇒ D before C).
  const ids = {
    a: '00000000-0000-4000-8000-00000000000a',
    b: '00000000-0000-4000-8000-00000000000b',
    c: '00000000-0000-4000-8000-00000000000c',
    d: '00000000-0000-4000-8000-00000000000d',
    e: '00000000-0000-4000-8000-00000000000e',
    preview: '00000000-0000-4000-8000-0000000000f0',
    foreign: '00000000-0000-4000-8000-0000000000f1',
  };

  beforeAll(async () => {
    const connection = resolveConnection();

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
      entities: [FileEntity],
      synchronize: false,
    });

    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'file pagination spec');

    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    service = new FileService(
      dataSource.getRepository(FileEntity),
      { send: jest.fn() } as never,
      logger as never,
    );

    for (const [id, name] of [
      [userId, 'file-pagination'],
      [otherUserId, 'file-pagination-other'],
    ]) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email) VALUES ($1::uuid, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [id, name, syntheticTestUserEmail(name, id)],
      );
    }

    const seed = async (id: string, owner: string, variant: string, createdAt: string) => {
      await dataSource.query(
        `INSERT INTO ci.files (id, content_type, variant, user_id, external_id, filename, created_at)
              VALUES ($1::uuid, 'image/jpeg', $2, $3::uuid, $4, $5, $6::timestamptz)`,
        [id, variant, owner, `ext-${id}`, `${id}.jpg`, createdAt],
      );
    };

    await seed(ids.a, userId, 'ORIGINAL', '2026-01-01T10:00:00Z');
    await seed(ids.b, userId, 'ORIGINAL', '2026-01-01T10:01:00Z');
    await seed(ids.c, userId, 'ORIGINAL', '2026-01-01T10:02:00Z');
    await seed(ids.d, userId, 'ORIGINAL', '2026-01-01T10:02:00Z'); // tie with c
    await seed(ids.e, userId, 'ORIGINAL', '2026-01-01T10:03:00Z');
    // Excluded by scope: a PREVIEW variant, and another user's ORIGINAL.
    await seed(ids.preview, userId, 'PREVIEW', '2026-01-01T10:04:00Z');
    await seed(ids.foreign, otherUserId, 'ORIGINAL', '2026-01-01T10:05:00Z');
  });

  afterAll(async () => {
    await dataSource.query(`DELETE FROM ci.files WHERE user_id = ANY($1::uuid[])`, [[userId, otherUserId]]);
    await dataSource.query(`DELETE FROM ci.users WHERE id = ANY($1::uuid[])`, [[userId, otherUserId]]);
    await schemaLock.release();
    await dataSource.destroy();
  });

  const context = () => ({ userId }) as never;

  it('walks newest-first pages through the keyset cursor, tiebreaking equal timestamps by id', async () => {
    const first = await service.findPage(context(), { limit: 2 });

    expect(first.totalCount).toBe(5); // never the preview, never the other user's file
    expect(first.hasNextPage).toBe(true);
    expect(first.files.map((f) => f.id)).toEqual([ids.e, ids.d]);

    const second = await service.findPage(context(), { limit: 2, afterId: ids.d });

    expect(second.hasNextPage).toBe(true);
    expect(second.files.map((f) => f.id)).toEqual([ids.c, ids.b]);

    const third = await service.findPage(context(), { limit: 2, afterId: ids.b });

    expect(third.hasNextPage).toBe(false);
    expect(third.files.map((f) => f.id)).toEqual([ids.a]);
  });

  it('treats an unknown cursor as "from the start", like the in-memory paginator did', async () => {
    const page = await service.findPage(context(), { limit: 2, afterId: randomUUID() });

    expect(page.files.map((f) => f.id)).toEqual([ids.e, ids.d]);
  });

  it('signs only the page it returns', async () => {
    const page = await service.findPage(context(), { limit: 1 });

    // bucket is NULL on the fixtures, so signFile resolves url = externalId —
    // presence proves the row went THROUGH signing.
    expect(page.files).toHaveLength(1);
    expect(page.files[0].url).toBe(`ext-${ids.e}`);
  });
});
