import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BlueBubblesConfigEntity } from '../../entities/BlueBubblesConfigEntity';
import { BlueBubblesConfigService } from '../BlueBubblesConfigService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO THE BLUEBUBBLES CONNECTOR BELONGS TO — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The config row is appliance-wide, but the Mac behind it is one person's. The
 * owner is decided in SQL (inside the UPDATE, so two racing saves cannot both
 * claim), and the backfill is SQL, so both are checked against the real schema.
 *
 * Every test runs in one transaction on one connection and rolls back. Opt-in:
 * skips with the reason when nothing listens at `MEMORY_TEST_DATABASE_URL` /
 * `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[BlueBubblesConfigService.owner.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const SAVE = {
  host: 'mac.example.com',
  port: 1234,
  useHttps: false,
  password: 'bb-password',
  hasPrivateApi: false,
  enabled: true,
};

function migrationUp(): string {
  const file = path.resolve(
    __dirname,
    '../../../../../db/postgres/migrations/20261006065617_bluebubbles_config_owner.sql',
  );
  const sql = readFileSync(file, 'utf8');

  return sql.slice(sql.indexOf('-- migrate:up') + '-- migrate:up'.length, sql.indexOf('-- migrate:down'));
}

describeWithDb(`BlueBubbles connector owner (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let service: BlueBubblesConfigService;

  const newUser = async (label: string, fields: { onboarded?: boolean; createdAt?: string } = {}) => {
    const id = await createSyntheticTestUser((sql, params) => runner.query(sql, params), label);
    await runner.query(
      `UPDATE ci.users SET onboarded = $2, created_at = COALESCE($3::timestamptz, created_at) WHERE id = $1`,
      [id, fields.onboarded ?? true, fields.createdAt ?? null],
    );

    return id;
  };

  const ownerOfRow = async () =>
    (
      (await runner.query(`SELECT owner_user_id FROM ci.bluebubbles_config`)) as Array<{
        owner_user_id: string | null;
      }>
    )[0]?.owner_user_id ?? null;

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
      entities: [BlueBubblesConfigEntity],
      synchronize: false,
    });
    await dataSource.initialize();

    // SHARED: these tests write ci.users and the singleton config row inside their transaction.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'BlueBubblesConfigService.owner');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    // The singleton: whatever row the database holds is this transaction's to replace.
    await runner.query(`DELETE FROM ci.bluebubbles_config`);
    service = new BlueBubblesConfigService(runner.manager.getRepository(BlueBubblesConfigEntity));
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it('the administrator who first saves the connection becomes its owner', async () => {
    const admin = await newUser('bb-owner-admin');

    const saved = await service.update(SAVE, admin);

    expect(saved.ownerUserId).toBe(admin);
    expect(await ownerOfRow()).toBe(admin);
    // The cache the tool schemas read from follows the save.
    expect(service.lastKnownOwnerUserId()).toBe(admin);
  });

  it('a second administrator saving the settings does not take the connector over', async () => {
    const owner = await newUser('bb-owner-first');
    const otherAdmin = await newUser('bb-owner-second');

    await service.update(SAVE, owner);
    await service.update({ ...SAVE, enabled: false }, otherAdmin);

    expect(await ownerOfRow()).toBe(owner);
  });

  it("refuses to point the owner's saved password at another server without a new one", async () => {
    const owner = await newUser('bb-owner-password');
    const otherAdmin = await newUser('bb-owner-repoint');

    await service.update(SAVE, owner);

    const { password: _kept, ...withoutPassword } = SAVE;
    await expect(
      service.update({ ...withoutPassword, host: 'someone-elses-server.example' }, otherAdmin),
    ).rejects.toThrow('Enter the BlueBubbles server password again to change the server address.');

    // Same server, password omitted: still "keep the stored one".
    await expect(service.update({ ...withoutPassword, enabled: false }, otherAdmin)).resolves.toMatchObject({
      host: SAVE.host,
      password: SAVE.password,
    });
  });

  it('the next save claims it when the owner account no longer exists', async () => {
    const owner = await newUser('bb-owner-gone');
    const nextAdmin = await newUser('bb-owner-next');

    await service.update(SAVE, owner);
    await runner.query(`UPDATE ci.users SET deleted_at = now() WHERE id = $1`, [owner]);
    await service.update(SAVE, nextAdmin);

    expect(await ownerOfRow()).toBe(nextAdmin);
  });

  it('rotating the webhook secret replaces it, and the old one stops matching', async () => {
    const admin = await newUser('bb-owner-rotate');
    const before = await service.update(SAVE, admin);

    const after = await service.rotateWebhookSecret();

    expect(after.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(after.webhookSecret).not.toBe(before.webhookSecret);
    expect(BlueBubblesConfigService.secretsMatch(before.webhookSecret, after.webhookSecret)).toBe(false);
    expect(after.ownerUserId).toBe(admin);
  });

  describe('the migration backfill', () => {
    it('gives a configured row the account the sync already filed messages under', async () => {
      // The oldest live onboarded account. Dated far back so no committed account from another
      // suite is older.
      const deletedOlder = await newUser('bb-backfill-deleted', { createdAt: '1990-01-01T00:00:00Z' });
      await runner.query(`UPDATE ci.users SET deleted_at = now() WHERE id = $1`, [deletedOlder]);
      await newUser('bb-backfill-not-onboarded', { onboarded: false, createdAt: '1990-06-01T00:00:00Z' });
      const first = await newUser('bb-backfill-first', { createdAt: '1991-01-01T00:00:00Z' });
      await newUser('bb-backfill-later', { createdAt: '1992-01-01T00:00:00Z' });
      await runner.query(
        `INSERT INTO ci.bluebubbles_config (host, port, password, webhook_secret, enabled)
              VALUES ('mac.example.com', 1234, 'bb-password', 'secret', true)`,
      );

      await runner.query(migrationUp());

      expect(await ownerOfRow()).toBe(first);
    });

    it('leaves a row nobody configured for the first administrator to claim', async () => {
      await newUser('bb-backfill-unconfigured', { createdAt: '1990-01-01T00:00:00Z' });
      await runner.query(
        `INSERT INTO ci.bluebubbles_config (host, port, password, webhook_secret) VALUES ('', 0, '', 'secret')`,
      );

      await runner.query(migrationUp());

      expect(await ownerOfRow()).toBeNull();
    });
  });
});
