import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { StagedSourceEntity } from '../entities/StagedSourceEntity';
import { StagedSourceService } from '../services/StagedSourceService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT `registerUpload` ACTUALLY RETURNS, FROM A REAL DRIVER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This exists because the unit test could not have caught the bug it guards.
 *
 * `registerUpload` uses `RETURNING *`, and TypeORM hands back the DRIVER's
 * rows — keyed by COLUMN name (`drop_id`, `expires_at`), not by entity
 * property. The code cast that to the entity, which typechecked and was
 * false: `dropId` came back `undefined`, the upload endpoint answered with a
 * null id, and the very next call — start a run with it — failed with
 * "dropId is required".
 *
 * The unit test mocked `execute()` to return camelCase keys, because that is
 * what I assumed it returned. A mock agrees with whatever the test author
 * believes; only a real driver disagrees.
 */

const IMPORT_DATABASE_ENV = {
  urlEnvVar: 'IMPORT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'IMPORT_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(IMPORT_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[import/stagedSourceRegistry.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`the staged source registry (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: StagedSourceService;

  const userId = randomUUID();
  const created: string[] = [];
  const inboxUsers: string[] = [];

  beforeAll(async () => {
    const connection = resolveConnection(IMPORT_DATABASE_ENV);

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
      entities: [StagedSourceEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    service = new StagedSourceService(dataSource.getRepository(StagedSourceEntity), {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as never);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      for (const dropId of created) {
        await dataSource.query(
          `DELETE FROM ci_import.staged_sources WHERE user_id = $1::uuid AND drop_id = $2`,
          [userId, dropId],
        );
      }

      // Inbox claims carry no drop id; the rebase test inserts them under
      // users nothing else in this spec uses.
      await dataSource.query(`DELETE FROM ci_import.staged_sources WHERE user_id = ANY($1::uuid[])`, [
        inboxUsers,
      ]);

      await dataSource.destroy();
    }
  });

  async function register(filename = 'Amazon.zip') {
    const dropId = randomUUID();

    created.push(dropId);

    return service.registerUpload(
      { userId },
      {
        dropId,
        // Fabricated: this spec exercises the registry SQL, never the
        // filesystem. The staging path is real only in stagedSourceSpine.
        sourcePath: `/nonexistent/uploads/${dropId}/${filename}`,
        originalFilename: filename,
        contentType: 'application/zip',
        sizeBytes: 4096,
      },
    );
  }

  it('returns an upload the caller can immediately start a run with', async () => {
    const source = await register();

    // The field the whole upload → import handoff turns on.
    expect(source.dropId).toEqual(expect.any(String));
    expect(source.dropId).toBe(created[created.length - 1]);
  });

  it('returns every field the upload response advertises', async () => {
    // The upload endpoint maps straight off this object, so an undefined here is
    // a null in the API response.
    const source = await register('Your Orders.zip');

    expect(source.id).toEqual(expect.any(String));
    expect(source.origin).toBe('upload');
    expect(source.originalFilename).toBe('Your Orders.zip');
    expect(source.status).toBe('staged');
    expect(source.expiresAt).toBeInstanceOf(Date);
    expect(source.createdAt).toBeInstanceOf(Date);
    expect(source.userId).toBe(userId);
  });

  it('returns sizeBytes as a number, not the string a bigint column yields', async () => {
    expect(await register().then((source) => source.sizeBytes)).toBe(4096);
  });

  it('round-trips: what registerUpload returned is what findByDropId finds', async () => {
    const registered = await register();
    const found = await service.findByDropId({ userId }, registered.dropId!);

    expect(found?.id).toBe(registered.id);
    expect(found?.sourcePath).toBe(registered.sourcePath);
  });

  it('enforces one row per upload handle', async () => {
    // The (user_id, drop_id) partial unique index — the constraint the whole
    // dropId-as-public-handle contract leans on.
    const first = await register();

    await expect(
      service.registerUpload(
        { userId },
        { dropId: first.dropId!, sourcePath: '/nonexistent/uploads/dup/x.zip', sizeBytes: 1 },
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it("moves one account's live inbox claims onto its new folder and nothing else", async () => {
    // The boot migration renames `<inbox>/a_b_example.com` to `<inbox>/<id>`.
    // Only that account's live inbox claims under that exact folder follow it.
    // `_` is a LIKE wildcard, so `aXb_example.com` is here to prove the match
    // is literal, and `a_b_example.com.old` that it stops at a path segment.
    const owner = randomUUID();
    const other = randomUUID();
    inboxUsers.push(owner, other);

    const base = `/nonexistent/${randomUUID()}/inbox`;
    const fromDir = `${base}/a_b_example.com`;
    const toDir = `${base}/${owner}`;

    const insert = async (user: string, sourcePath: string, status: string) => {
      const [row] = await dataSource.query<Array<{ id: string }>>(
        `INSERT INTO ci_import.staged_sources (user_id, origin, source_path, kind, status)
         VALUES ($1::uuid, 'inbox', $2, 'file', $3)
         RETURNING id`,
        [user, sourcePath, status],
      );

      return row.id;
    };

    const claimed = await insert(owner, `${fromDir}/reddit/export.zip`, 'claimed');
    const moved = await insert(owner, `${fromDir}/takeout.zip`, 'moved');
    const released = await insert(owner, `${fromDir}/released.zip`, 'released');
    const wildcard = await insert(owner, `${base}/aXb_example.com/z.zip`, 'claimed');
    const sibling = await insert(owner, `${fromDir}.old/w.zip`, 'claimed');
    const someoneElse = await insert(other, `${fromDir}/theirs.zip`, 'claimed');

    expect(await service.rebaseInboxClaims(owner, fromDir, toDir)).toBe(2);

    const paths = new Map(
      (
        await dataSource.query<Array<{ id: string; source_path: string }>>(
          `SELECT id, source_path FROM ci_import.staged_sources WHERE user_id = ANY($1::uuid[])`,
          [[owner, other]],
        )
      ).map((row) => [row.id, row.source_path]),
    );

    expect(paths.get(claimed)).toBe(`${toDir}/reddit/export.zip`);
    expect(paths.get(moved)).toBe(`${toDir}/takeout.zip`);
    expect(paths.get(released)).toBe(`${fromDir}/released.zip`);
    expect(paths.get(wildcard)).toBe(`${base}/aXb_example.com/z.zip`);
    expect(paths.get(sibling)).toBe(`${fromDir}.old/w.zip`);
    expect(paths.get(someoneElse)).toBe(`${fromDir}/theirs.zip`);
  });
});
