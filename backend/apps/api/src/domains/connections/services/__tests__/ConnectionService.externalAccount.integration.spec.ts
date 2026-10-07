import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ConnectionEntity } from '../../entities/ConnectionEntity';
import { ProviderEntity } from '../../entities/ProviderEntity';
import { ConnectionService } from '../ConnectionService';

/**
 * `externalAccountHeldByAnotherUser` — REAL POSTGRES.
 *
 * Connecting Signal refuses a number another account on the appliance already connected, so two
 * accounts never pull (and split) one person's messages. The check is the one query in the
 * connections service that deliberately looks past the caller, so its shape is pinned against
 * the real schema: another account's row counts, active or not; the caller's own does not; a
 * different number or provider does not.
 *
 * Every test runs in one transaction on one connection and rolls back.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[ConnectionService.externalAccount.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const NUMBER = '+15550001111';

describeWithDb(`ConnectionService.externalAccountHeldByAnotherUser (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let service: ConnectionService;
  let owner: string;
  let member: string;
  let signal: string;
  let other: string;

  const connect = async (userId: string, providerId: string, externalId: string, active = true) => {
    await runner.query(
      `INSERT INTO ci.connections (id, user_id, provider_id, name, active, external_id)
       VALUES ($1, $2, $3, 'Signal', $4, $5)`,
      [uuidv7(), userId, providerId, active, externalId],
    );
  };

  beforeAll(async () => {
    const resolved = resolveConnection(ENV);

    if (resolved == null) {
      throw new Error('availability said yes but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(resolved.url != null
        ? { url: resolved.url }
        : {
            host: resolved.host,
            port: resolved.port,
            username: resolved.username,
            password: resolved.password,
            database: resolved.database,
          }),
      entities: [ConnectionEntity, ProviderEntity, UserEntity],
      synchronize: false,
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'ConnectionService.externalAccount');
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
      (sql, params) => runner.query(sql, params),
      'external-account-owner',
    );
    member = await createSyntheticTestUser(
      (sql, params) => runner.query(sql, params),
      'external-account-member',
    );
    signal = uuidv7();
    other = uuidv7();
    await runner.query(`INSERT INTO ci.providers (id, name) VALUES ($1, 'signal'), ($2, 'other')`, [
      signal,
      other,
    ]);

    service = new ConnectionService(runner.manager.getRepository(ConnectionEntity));
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it("sees another account's connection to the number, active or not", async () => {
    await connect(owner, signal, NUMBER, false);

    expect(await service.externalAccountHeldByAnotherUser(member, signal, NUMBER)).toBe(true);
  });

  it("does not count the caller's own connection", async () => {
    await connect(member, signal, NUMBER);

    expect(await service.externalAccountHeldByAnotherUser(member, signal, NUMBER)).toBe(false);
  });

  it('does not count a different number or a different provider', async () => {
    await connect(owner, signal, '+15550002222');
    await connect(owner, other, NUMBER);

    expect(await service.externalAccountHeldByAnotherUser(member, signal, NUMBER)).toBe(false);
  });
});
