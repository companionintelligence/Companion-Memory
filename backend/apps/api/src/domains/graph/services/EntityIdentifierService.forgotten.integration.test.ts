import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { EntityIdentifierEntity } from '../entities/EntityIdentifierEntity';

import { EntityIdentifierService } from './EntityIdentifierService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LIST OF FORGOTTEN IDENTIFIERS, AS THE DATABASE KEEPS IT. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ci.forgotten_identifiers` is what stops a forgotten person being created again from the mail that still
 * names them. The purge writes it and the people-minting paths read it, in two domains, so the digest they
 * agree on is ONE database function, `ci.forgotten_identifier_digest`. This pins the function, the table's
 * own constraints, and the lookup that sits on them (`EntityIdentifierService.findForgottenIdentifiers`)
 * against the real thing, because a mocked query cannot say that the hash the purge wrote is the hash the
 * reader asks for.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your OWN, or run
 * `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[graph/EntityIdentifierService.forgotten.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

describeWithDb(`forgotten identifiers against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: EntityIdentifierService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [EntityIdentifierEntity],
      synchronize: false,
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'graph/EntityIdentifierService.forgotten');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ForgottenIds', userId);
    }

    service = new EntityIdentifierService(dataSource.getRepository(EntityIdentifierEntity), logger());
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.forgotten_identifiers WHERE owner_user_id = ANY($1::uuid[])', [
      [ownerId, strangerId],
    ]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /** Records an identifier the way the purge does: with the database's own function. */
  const forget = (forUser: string, kind: string, value: string) =>
    dataSource.query(
      `INSERT INTO ci.forgotten_identifiers (owner_user_id, kind, identifier_digest)
       VALUES ($1, $2, ci.forgotten_identifier_digest($1::uuid, $2, $3))`,
      [forUser, kind, value],
    );

  const digest = async (forUser: string | null, kind: string | null, value: string | null) =>
    (
      await dataSource.query(
        `SELECT encode(ci.forgotten_identifier_digest($1::uuid, $2, $3), 'hex') AS digest`,
        [forUser, kind, value],
      )
    )[0].digest as string | null;

  it('finds what the purge recorded, for its owner and kind and value only', async () => {
    await forget(ownerId, 'email', 'dana@example.invalid');
    await forget(ownerId, 'phone', '4155550100');
    await forget(ownerId, 'handle', 'x:@dana');

    const found = await service.findForgottenIdentifiers(ownerId, [
      { kind: 'email', valueNormalized: 'dana@example.invalid' },
      { kind: 'phone', valueNormalized: '4155550100' },
      // Not recorded: the same value under another kind, another value, and a name.
      { kind: 'phone', valueNormalized: 'dana@example.invalid' },
      { kind: 'email', valueNormalized: 'sam@example.invalid' },
      { kind: 'name', valueNormalized: 'dana quill' },
    ]);

    expect(found).toEqual(new Set(['email:dana@example.invalid', 'phone:4155550100']));
  });

  it('is the owner’s list: somebody else’s identical address is not on it', async () => {
    await forget(ownerId, 'email', 'dana@example.invalid');

    const key = { kind: 'email' as const, valueNormalized: 'dana@example.invalid' };

    expect(await service.findForgottenIdentifiers(ownerId, [key])).toEqual(
      new Set(['email:dana@example.invalid']),
    );
    expect(await service.findForgottenIdentifiers(strangerId, [key])).toEqual(new Set());
  });

  it('keeps digests: the address is not in the row, and the digest is 32 bytes of it', async () => {
    await forget(ownerId, 'email', 'dana@example.invalid');

    const [row] = await dataSource.query(
      `SELECT kind, length(identifier_digest) AS bytes, identifier_digest::text AS raw
         FROM ci.forgotten_identifiers WHERE owner_user_id = $1`,
      [ownerId],
    );

    expect(row).toMatchObject({ kind: 'email', bytes: 32 });
    expect(row.raw).not.toContain('dana');
  });

  it('digests the same input the same way, and a different owner, kind or value a different way', async () => {
    const base = await digest(ownerId, 'email', 'dana@example.invalid');

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await digest(ownerId, 'email', 'dana@example.invalid')).toBe(base);
    expect(await digest(strangerId, 'email', 'dana@example.invalid')).not.toBe(base);
    expect(await digest(ownerId, 'handle', 'dana@example.invalid')).not.toBe(base);
    expect(await digest(ownerId, 'email', 'sam@example.invalid')).not.toBe(base);
  });

  it('answers NULL for a NULL, rather than a digest of nothing', async () => {
    expect(await digest(null, 'email', 'dana@example.invalid')).toBeNull();
    expect(await digest(ownerId, null, 'dana@example.invalid')).toBeNull();
    expect(await digest(ownerId, 'email', null)).toBeNull();
  });

  it('refuses to record a display name, which is shared by many people', async () => {
    await expect(forget(ownerId, 'name', 'dana quill')).rejects.toThrow(/forgotten_identifiers_kind_check/);
  });

  it('records an identifier once, however many times it is forgotten', async () => {
    await forget(ownerId, 'email', 'dana@example.invalid');

    await expect(forget(ownerId, 'email', 'dana@example.invalid')).rejects.toThrow(
      /forgotten_identifiers_pkey/,
    );
  });

  it('goes with the account', async () => {
    const leaving = uuidv7();

    await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params),
      'ForgottenIdsLeaving',
      leaving,
    );
    await forget(leaving, 'email', 'dana@example.invalid');

    expect(
      await dataSource.query('SELECT 1 FROM ci.forgotten_identifiers WHERE owner_user_id = $1', [leaving]),
    ).toHaveLength(1);

    await dataSource.query('DELETE FROM ci.users WHERE id = $1', [leaving]);

    expect(
      await dataSource.query('SELECT 1 FROM ci.forgotten_identifiers WHERE owner_user_id = $1', [leaving]),
    ).toHaveLength(0);
  });
});
