import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { PersonEntity } from '../../entities/PersonEntity';
import { PersonService } from '../PersonService';

/**
 * `PersonService.findSelf`, proved against a real Postgres.
 *
 * `PersonService.spec.ts` mocks the repository, so it cannot show what the
 * raw `person.is_self IS TRUE` / `person.merged_into_entity_id IS NULL`
 * QueryBuilder clauses actually do once Postgres evaluates them — including
 * the scoping to `owner_user_id`, which is the property `UserType.avatarUrl`
 * and `PeerLinkType.avatarUrl` both depend on to never cross an owner
 * boundary. This is also what a resolver-level mock cannot check, because it
 * would just be re-asserting the mock's own return value.
 *
 * Opt-in in the same sense as the rest of the DB-backed suites: skips with a
 * clear reason when nothing is listening at `DATABASE_URL` /
 * `MEMORY_TEST_DATABASE_URL` / `DATABASE_HOST` + `DATABASE_PASSWORD`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[PersonService.findSelf.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`PersonService.findSelf — the owner's is_self Person (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: PersonService;
  let ownerA: string;
  let ownerB: string;
  let ownerWithNoSelf: string;

  const send = jest.fn<Promise<string[]>, [string, Record<string, unknown>]>(async () => []);
  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;

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
      entities: [BaseEntity, PersonEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits real ci.entities / ci.users rows, which a
    // migration suite may be altering inside its own transaction. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'PersonService.findSelf');

    const query = (sql: string, params?: unknown[]) => dataSource.query(sql, params);
    ownerA = await createSyntheticTestUser(query, 'PersonService-findSelf-A');
    ownerB = await createSyntheticTestUser(query, 'PersonService-findSelf-B');
    ownerWithNoSelf = await createSyntheticTestUser(query, 'PersonService-findSelf-NoSelf');

    service = new PersonService(dataSource.getRepository(PersonEntity), noopLogger, {
      send,
    } as unknown as EventService);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [
        [ownerA, ownerB, ownerWithNoSelf],
      ]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [
        [ownerA, ownerB, ownerWithNoSelf],
      ]);
      // Before destroy(): the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it("returns the owner's own is_self Person, scoped to that owner alone", async () => {
    const repo = dataSource.getRepository(PersonEntity);

    // A non-self row for owner A, so a query that forgot the `is_self` filter
    // would still (wrongly) have something to return.
    await repo.save(
      repo.create({ id: uuidv7(), name: 'A Friend', userId: ownerA, properties: {}, isSelf: false }),
    );
    await repo.save(
      repo.create({
        id: uuidv7(),
        name: 'Owner A',
        userId: ownerA,
        properties: { avatar_url: 'https://x/owner-a.png' },
        isSelf: true,
      }),
    );
    // Owner B also has an is_self Person — proves the lookup is scoped to the
    // OWNER passed in, not "any is_self row in the table".
    await repo.save(
      repo.create({ id: uuidv7(), name: 'Owner B', userId: ownerB, properties: {}, isSelf: true }),
    );

    const self = await service.findSelf({ userId: ownerA } as UserServiceContext);

    expect(self?.name).toBe('Owner A');
    // `avatar_url` is not one of `NORMALIZED_PERSON_FIELDS`, so it survives on
    // the egress `properties` bag exactly like `PersonType.toType` reads it.
    expect(self?.properties?.avatar_url).toBe('https://x/owner-a.png');
  });

  it('returns null cleanly when the owner has no is_self Person yet', async () => {
    const self = await service.findSelf({ userId: ownerWithNoSelf } as UserServiceContext);

    expect(self).toBeNull();
  });

  it('excludes a merge tombstone even when it still carries is_self: true', async () => {
    const owner = await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params),
      'PersonService-findSelf-Tombstone',
    );
    const repo = dataSource.getRepository(PersonEntity);
    const survivorId = uuidv7();

    await repo.save(repo.create({ id: survivorId, name: 'Survivor', userId: owner, properties: {} }));
    // A merge can leave the OLD self row's `is_self` untouched while pointing
    // it at the canonical survivor — this is exactly the drift `findSelf`
    // exists to not be fooled by.
    await repo.save(
      repo.create({
        id: uuidv7(),
        name: 'Old Self (merged away)',
        userId: owner,
        properties: {},
        isSelf: true,
        mergedIntoEntityId: survivorId,
      }),
    );

    const self = await service.findSelf({ userId: owner } as UserServiceContext);

    expect(self).toBeNull();

    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [owner]);
    await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner]);
  });
});
