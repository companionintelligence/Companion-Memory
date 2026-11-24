import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { EntityIdentifierEntity, EntityIdentifierService } from '@ci/domains/graph';

import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { PersonResolver } from '../resolvers/PersonResolver';
import { GlobalUID } from '../types/GlobalUID';

/**
 * `updatePerson`'s refusal of a contact another person holds, against a real
 * `ci.entity_identifiers`.
 *
 * `PersonResolver.contactConflicts.spec.ts` covers the rules over an in-memory
 * table. What only Postgres can confirm is the part that table imitates: the
 * pre-check rides on `findEntityIdsByIdentifiers`, a hand-written row-values
 * `(kind, value_normalized) IN (...)` query, and a value claimed between that
 * read and the write is reported by the real unique index turning the insert
 * into a no-op. The rows are compared column for column before and after.
 *
 * `personService` is a stub: the patch it would apply is asserted on, not run.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a database with
 * the migrations applied — `databaseAvailability` probes it and this suite
 * SKIPS legibly, never fails, when nothing is reachable.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest PersonResolver.contactConflicts.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[graphql/PersonResolver.contactConflicts.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`updatePerson contact conflicts, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let entityIdentifierService: EntityIdentifierService;

  // Fresh ids per run: the table has no FK to ci.users or ci.entities, so the
  // owner scopes every row this suite touches and nothing else needs seeding.
  const owner = uuidv7();
  const dana = uuidv7();
  const sam = uuidv7();
  const context = { userId: owner } as RequestContext;

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });

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
      entities: [EntityIdentifierEntity],
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(
      dataSource,
      'graphql/PersonResolver.contactConflicts.integration',
    );

    entityIdentifierService = new EntityIdentifierService(
      dataSource.getRepository(EntityIdentifierEntity),
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.entity_identifiers WHERE owner_user_id = $1', [owner]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM ci.entity_identifiers WHERE owner_user_id = $1', [owner]);
    await dataSource.query(
      `INSERT INTO ci.entity_identifiers
         (owner_user_id, entity_id, kind, value_normalized, raw_value, label, is_primary, source)
       VALUES ($1, $2, 'email', 'dana@example.com', NULL, 'work', TRUE, 'user'),
              ($1, $2, 'phone', '4155550100', '(415) 555-0100', 'mobile', TRUE, 'user'),
              ($1, $3, 'email', 'sam@example.com', NULL, NULL, FALSE, 'import:google'),
              ($1, $3, 'phone', '4155550199', NULL, NULL, FALSE, 'import:google')`,
      [owner, dana, sam],
    );
  });

  const snapshot = (): Promise<unknown[]> =>
    dataSource.query(
      'SELECT * FROM ci.entity_identifiers WHERE owner_user_id = $1 ORDER BY kind, value_normalized',
      [owner],
    );

  function makeResolver() {
    const person = { id: dana, name: 'Dana Okafor', email: null, properties: {}, addresses: [] };
    const personService = {
      findById: jest.fn(async () => person),
      patch: jest.fn(async () => person),
    };
    const unused = {} as never;

    const resolver = new PersonResolver(
      personService as never,
      unused,
      unused,
      unused,
      unused,
      entityIdentifierService,
      { clear: () => undefined } as never,
      unused,
      unused,
      unused,
    );

    return { resolver, personService };
  }

  it('refuses the edit and leaves every row exactly as it was', async () => {
    const { resolver, personService } = makeResolver();
    const before = await snapshot();

    const attempt = resolver.updatePerson(context, {
      id: GlobalUID.encode('person', dana),
      name: 'Dana Okafor-Reyes',
      contacts: [
        { kind: 'email', value: 'dana@example.com', label: 'work', isPrimary: true },
        { kind: 'email', value: 'SAM@Example.com' },
        { kind: 'phone', value: '+1 (415) 555-0199', label: 'mobile', isPrimary: true },
      ],
    });

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(
      'SAM@Example.com, +1 (415) 555-0199 already belong to another person. ' +
        'Merge the two people instead of re-assigning it.',
    );

    // Dana's old number included: the edit replaced it, and it is still here.
    expect(await snapshot()).toEqual(before);
    expect(personService.patch).not.toHaveBeenCalled();
  });

  it('reports a value claimed between the check and the write, and leaves it with its holder', async () => {
    const { resolver } = makeResolver();

    // Another writer commits a claim just after the read found the value free.
    const findConflicts = entityIdentifierService.findConflicts.bind(entityIdentifierService);
    const spy = jest
      .spyOn(entityIdentifierService, 'findConflicts')
      .mockImplementation(async (...args: Parameters<EntityIdentifierService['findConflicts']>) => {
        const answer = await findConflicts(...args);
        await dataSource.query(
          `INSERT INTO ci.entity_identifiers (owner_user_id, entity_id, kind, value_normalized, source)
           VALUES ($1, $2, 'email', 'sam@work.example', 'import:google')`,
          [owner, sam],
        );

        return answer;
      });

    try {
      await expect(
        resolver.updatePerson(context, {
          id: GlobalUID.encode('person', dana),
          contacts: [
            { kind: 'email', value: 'dana@example.com' },
            { kind: 'email', value: 'sam@work.example' },
          ],
        }),
      ).rejects.toThrow(
        'sam@work.example already belongs to another person. Merge the two people instead of re-assigning it.',
      );
    } finally {
      spy.mockRestore();
    }

    const [holder] = await dataSource.query(
      `SELECT entity_id FROM ci.entity_identifiers
        WHERE owner_user_id = $1 AND kind = 'email' AND value_normalized = 'sam@work.example'`,
      [owner],
    );
    expect(holder).toEqual({ entity_id: sam });
  });

  it("saves an edit whose values are free or already this person's own", async () => {
    const { resolver, personService } = makeResolver();

    await expect(
      resolver.updatePerson(context, {
        id: GlobalUID.encode('person', dana),
        name: 'Dana Okafor-Reyes',
        contacts: [
          { kind: 'email', value: 'Dana@Example.com', label: 'home', isPrimary: true },
          { kind: 'email', value: 'dana.okafor@example.org' },
          { kind: 'phone', value: '+1 415 555 0100', label: 'mobile', isPrimary: true },
        ],
      }),
    ).resolves.toEqual(expect.objectContaining({ success: true }));

    expect(personService.patch).toHaveBeenCalledWith(
      expect.anything(),
      dana,
      expect.objectContaining({ name: 'Dana Okafor-Reyes' }),
      { handEdit: true },
    );

    const rows: Array<{ entity_id: string; kind: string; value_normalized: string; label: string | null }> =
      await dataSource.query(
        'SELECT entity_id, kind, value_normalized, label FROM ci.entity_identifiers WHERE owner_user_id = $1',
        [owner],
      );

    // Sorted in JS: the database's collation is not byte order.
    expect(
      rows
        .filter((row) => row.entity_id === dana)
        .map((row) => [row.kind, row.value_normalized, row.label])
        .sort(),
    ).toEqual([
      ['email', 'dana.okafor@example.org', null],
      ['email', 'dana@example.com', 'home'],
      ['phone', '4155550100', 'mobile'],
    ]);
    expect(rows.filter((row) => row.entity_id === sam)).toHaveLength(2);
  });
});
